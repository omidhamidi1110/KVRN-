-- KVRN Migration 028 — Product catalog CMS (Admin Product Editor)
--
-- Additive only. Nothing in 001–027 is altered, dropped or replaced. Idempotent: every
-- statement is IF NOT EXISTS / CREATE OR REPLACE of THIS migration's own objects / guarded.
-- Safe to re-run. NOT applied to production by the implementation batch.
-- Requires 001–027 (uses the 027 CMS foundation: content_entities / content_versions /
-- cms_publish / media_assets / content_redirects / collection_products).
--
-- DESIGN (read before changing)
-- -----------------------------
-- * Commerce truth stays in products / product_variants (price_cents, sku, size, color,
--   stock, shipping weight/dimensions). The CMS only versions PRESENTATION/CONTENT, held as
--   an immutable JSON snapshot in content_versions (entity_type='product',
--   entity_id = products.id::text). The snapshot ALSO carries a `commerce` block (price,
--   variant matrix, shipping, origin/HS) which is an INTENT applied to the canonical tables
--   at publish time, inside the same transaction as the publish.
-- * Inventory (stock_on_hand / reserved_quantity) is NEVER written by anything here. New
--   variants are inserted with stock 0; stock changes go through the existing inventory
--   workflows (FIFO layers, cost basis).
-- * One trigger (catalog_entity_sync) on content_entities is the single enforcement point
--   for EVERY way a product can go live (publish, rollback, scheduler cms_apply_due): it
--   re-runs the blocker list, applies the canonical changes, syncs published media usages
--   and writes the audit row, all in the publish transaction. A failing blocker raises
--   CATALOG_BLOCKED|<json> and nothing is half-applied. Unpublish/archive deactivate the
--   product (products.active = false) so it can no longer be bought.
-- * ROLLBACK is content-only: it restores presentation (copy, media, slug, SEO, ...) but
--   never reverts price, variants, shipping or origin/HS (money and sellability must not
--   change because someone restored page copy).
-- * Historical orders snapshot unit price / product name / sku at purchase time; nothing in
--   this migration touches orders, order_items, cost batches or inventory movements.
--
-- Snapshot schema (version 1) — see lib/product-model.ts for the TypeScript twin:
--   slug, name, eyebrow, productType, presentation, founderNote, shortDescription,
--   constructionDetails[], description, fitNote, features[], specs[], shippingReturns{},
--   sizeGuide{}, sections{}, media{hero, gallery[5]}, colors[], commerce{priceCents,
--   shipping{}, originCountry, hsCode, variants[]}, shop{listed, sortPosition},
--   completeTheSet{enabled, pairedProductId}, bundle (reserved for the bundle module), seo{}.
--
-- Error vocabulary: CATALOG_BLOCKED|<json array>, CATALOG_INVALID|<CODE>, CATALOG_NOT_FOUND|<id>.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Additive columns on products (all nullable / defaulted; no frozen function reads them)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type      TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS country_of_origin TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS hs_code           TEXT;
-- NULL = pre-028 product ('legacy' after bootstrap). 'editor' = created in the Product Editor;
-- only those keep products.slug mirrored to the public slug (legacy Neon slugs never change).
ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_origin    TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_type_fmt') THEN
    ALTER TABLE products ADD CONSTRAINT products_type_fmt
      CHECK (product_type IS NULL OR (product_type ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(product_type) <= 40));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_origin_fmt') THEN
    ALTER TABLE products ADD CONSTRAINT products_origin_fmt
      CHECK (country_of_origin IS NULL OR country_of_origin ~ '^[A-Z]{2}$');
  END IF;
  -- HS / tariff code: 6–10 digits, optional dots (e.g. 6110.20, 6110.20.20, 611020).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_hs_fmt') THEN
    ALTER TABLE products ADD CONSTRAINT products_hs_fmt
      CHECK (hs_code IS NULL OR hs_code ~ '^[0-9]{4}[.]?[0-9]{2}([.]?[0-9]{2}){0,2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_catalog_origin_chk') THEN
    ALTER TABLE products ADD CONSTRAINT products_catalog_origin_chk
      CHECK (catalog_origin IS NULL OR catalog_origin IN ('legacy','editor'));
  END IF;
END $$;

-- Product code is the permanent human identity used inside new SKUs (KVRN-<CODE>-...).
-- The unique index covers only catalog-managed rows (catalog_origin set by the editor or by
-- catalog_bootstrap_products()), so rows that predate the catalog CMS are never constrained
-- retroactively (and a migration can never fail on production data). catalog_create_product
-- additionally checks the code against EVERY product row, so a new editor product can never
-- reuse a legacy code.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_products_product_code_ci')
     AND NOT EXISTS (SELECT 1 FROM products WHERE catalog_origin IS NOT NULL
                      GROUP BY lower(product_code) HAVING COUNT(*) > 1) THEN
    CREATE UNIQUE INDEX uq_products_product_code_ci ON products (lower(product_code))
      WHERE catalog_origin IS NOT NULL;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Small pure helpers
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION catalog__is_uuid(p TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

CREATE OR REPLACE FUNCTION catalog__issue(p_code TEXT, p_field TEXT, p_message TEXT) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('code', p_code, 'field', p_field, 'message', p_message)
$$;

-- Returns NULL when the image reference is usable, else a short problem code.
CREATE OR REPLACE FUNCTION catalog__ref_problem(p_ref JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE v_kind TEXT;
BEGIN
  IF p_ref IS NULL OR jsonb_typeof(p_ref) <> 'object' THEN RETURN 'MISSING'; END IF;
  v_kind := p_ref->>'kind';
  IF v_kind = 'static' THEN
    IF COALESCE(p_ref->>'src','') !~ '^/images/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$' OR (p_ref->>'src') LIKE '%..%' THEN
      RETURN 'BAD_STATIC';
    END IF;
    RETURN NULL;
  ELSIF v_kind = 'media' THEN
    IF NOT catalog__is_uuid(p_ref->>'assetId') THEN RETURN 'BAD_ASSET'; END IF;
    IF NOT EXISTS (SELECT 1 FROM media_assets WHERE id = (p_ref->>'assetId')::uuid) THEN RETURN 'ASSET_MISSING'; END IF;
    IF NOT EXISTS (SELECT 1 FROM media_assets WHERE id = (p_ref->>'assetId')::uuid AND status = 'active') THEN
      RETURN 'ASSET_ARCHIVED';
    END IF;
    RETURN NULL;
  END IF;
  RETURN 'BAD_KIND';
END $$;

-- Every image slot in a snapshot: hero, gallery positions, per-colour media. `kind` is
-- 'hero' | 'gallery'; `field` is the dotted path used in blocker messages.
CREATE OR REPLACE FUNCTION catalog__slots_all(p JSONB)
RETURNS TABLE (field TEXT, kind TEXT, slot JSONB) LANGUAGE sql IMMUTABLE AS $$
  SELECT 'media.hero'::text, 'hero'::text, p#>'{media,hero}'
   WHERE jsonb_typeof(p#>'{media,hero}') = 'object'
  UNION ALL
  SELECT 'media.gallery.' || g.i, 'gallery', g.e
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p#>'{media,gallery}') = 'array' THEN p#>'{media,gallery}' ELSE '[]'::jsonb END)
         WITH ORDINALITY AS g(e, i)
  UNION ALL
  SELECT 'colors.' || ci.i || '.media.hero', 'hero', ci.e#>'{media,hero}'
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'colors') = 'array' THEN p->'colors' ELSE '[]'::jsonb END)
         WITH ORDINALITY AS ci(e, i)
   WHERE jsonb_typeof(ci.e#>'{media,hero}') = 'object'
  UNION ALL
  SELECT 'colors.' || ci.i || '.media.gallery.' || g.j, 'gallery', g.e
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'colors') = 'array' THEN p->'colors' ELSE '[]'::jsonb END)
         WITH ORDINALITY AS ci(e, i),
         LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ci.e#>'{media,gallery}') = 'array'
                                           THEN ci.e#>'{media,gallery}' ELSE '[]'::jsonb END)
         WITH ORDINALITY AS g(e, j)
$$;

-- Media assets a snapshot references, as (usage slot, asset id) — used for media_usages.
CREATE OR REPLACE FUNCTION catalog_media_refs(p JSONB)
RETURNS TABLE (slot TEXT, asset_id UUID) LANGUAGE sql STABLE AS $$
  SELECT regexp_replace(replace(s.field, '.', '-'), '^media-', ''), (s.slot#>>'{ref,assetId}')::uuid
    FROM catalog__slots_all(p) s
   WHERE s.slot#>>'{ref,kind}' = 'media' AND catalog__is_uuid(s.slot#>>'{ref,assetId}')
  UNION ALL
  SELECT 'seo-og', (p#>>'{seo,ogImage,assetId}')::uuid
   WHERE p#>>'{seo,ogImage,kind}' = 'media' AND catalog__is_uuid(p#>>'{seo,ogImage,assetId}')
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Blockers: the ONE implementation of "can this product go live?"
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns {"blockers":[{code,field,message}], "warnings":[...]}.
--   p_snapshot NULL  -> the working draft (else the live version) of the product.
--   p_mode 'publish' -> everything (content + commerce).
--   p_mode 'rollback'-> content only (rollback never applies price/variants/shipping).
-- Called by the Admin editor (exact blocker list), by publish_catalog_product, by the
-- schedule action and by the go-live trigger, so they can never disagree.
CREATE OR REPLACE FUNCTION catalog_product_blockers(
  p_product_id UUID, p_snapshot JSONB DEFAULT NULL, p_mode TEXT DEFAULT 'publish'
) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_prod     products%ROWTYPE;
  v_snap     JSONB := p_snapshot;
  v_b        JSONB := '[]'::jsonb;
  v_w        JSONB := '[]'::jsonb;
  v_full     BOOLEAN := (COALESCE(p_mode, 'publish') <> 'rollback');
  v_slug     TEXT;
  v_name     TEXT;
  v_txt      TEXT;
  v_num      NUMERIC;
  r          RECORD;
  v_sku      TEXT;
  v_active   INTEGER := 0;
  v_ncolors  INTEGER := 0;
  v_ngallery INTEGER;
  v_pair     TEXT;
  v_prefix   TEXT;
  v_codes    TEXT[] := '{}';
  v_keys     TEXT[] := '{}';
  v_pairs    TEXT[] := '{}';
  v_skus     TEXT[] := '{}';
  v_ids      UUID[] := '{}';
  v_problem  TEXT;
BEGIN
  SELECT * INTO v_prod FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('blockers', jsonb_build_array(catalog__issue('PRODUCT_NOT_FOUND', 'product', 'Product not found.')),
                              'warnings', '[]'::jsonb);
  END IF;

  IF v_snap IS NULL THEN
    SELECT v.snapshot INTO v_snap
      FROM content_entities e
      JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id
                             AND v.version_no = COALESCE(e.draft_version_no, e.published_version_no)
     WHERE e.entity_type = 'product' AND e.entity_id = p_product_id::text;
  END IF;
  IF v_snap IS NULL OR jsonb_typeof(v_snap) <> 'object' THEN
    RETURN jsonb_build_object('blockers', jsonb_build_array(catalog__issue('NO_DRAFT', 'product', 'There is no draft to publish.')),
                              'warnings', '[]'::jsonb);
  END IF;

  -- ── identity ────────────────────────────────────────────────────────────
  v_name := btrim(COALESCE(v_snap->>'name', ''));
  IF v_name = '' THEN v_b := v_b || catalog__issue('NAME_REQUIRED', 'name', 'Add a product name.');
  ELSIF char_length(v_name) > 120 THEN v_b := v_b || catalog__issue('NAME_TOO_LONG', 'name', 'Product name is longer than 120 characters.');
  ELSIF char_length(v_name) > 60 THEN v_w := v_w || catalog__issue('NAME_LONG', 'name', 'Long names may wrap awkwardly. Check the preview.');
  END IF;

  v_txt := v_snap->>'productType';
  IF v_txt IS NULL OR v_txt = '' THEN
    v_b := v_b || catalog__issue('TYPE_REQUIRED', 'productType', 'Choose a product type.');
  ELSIF v_txt !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(v_txt) > 40 THEN
    v_b := v_b || catalog__issue('TYPE_INVALID', 'productType', 'Product type can use lowercase letters, numbers and hyphens only.');
  END IF;

  v_slug := lower(btrim(COALESCE(v_snap->>'slug', '')));
  IF v_slug = '' THEN
    v_b := v_b || catalog__issue('SLUG_REQUIRED', 'slug', 'Add a URL slug.');
  ELSIF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(v_slug) > 80 THEN
    v_b := v_b || catalog__issue('SLUG_INVALID', 'slug', 'Slug can use lowercase letters, numbers and hyphens only (max 80).');
  ELSE
    -- Slugs of the coded catalog are reserved for their own products.
    IF (v_slug IN ('kvrn-heavyweight-hoodie', 'kvrn-heavyweight-sweatpants'))
       OR (v_slug = 'kvrn-phantom-hoodie'     AND v_prod.product_code IS DISTINCT FROM 'PKHH')
       OR (v_slug = 'kvrn-phantom-sweatpants' AND v_prod.product_code IS DISTINCT FROM 'PKHSP') THEN
      v_b := v_b || catalog__issue('SLUG_RESERVED', 'slug', 'That URL is reserved for an existing page.');
    END IF;
    IF EXISTS (SELECT 1 FROM content_entities e
                WHERE e.entity_type = 'product' AND e.entity_id <> p_product_id::text
                  AND lower(e.slug) = v_slug AND e.status IN ('published', 'scheduled')) THEN
      v_b := v_b || catalog__issue('SLUG_TAKEN', 'slug', 'Another product already uses this URL.');
    ELSIF EXISTS (SELECT 1 FROM products p2 WHERE p2.id <> p_product_id AND lower(p2.slug) = v_slug) THEN
      v_b := v_b || catalog__issue('SLUG_TAKEN', 'slug', 'Another product already uses this URL.');
    END IF;
    IF EXISTS (SELECT 1 FROM content_redirects cr
                WHERE cr.from_path = '/products/' || v_slug
                  AND (cr.entity_type IS DISTINCT FROM 'product' OR cr.entity_id IS DISTINCT FROM p_product_id::text)) THEN
      v_w := v_w || catalog__issue('SLUG_WAS_REDIRECT', 'slug', 'This URL used to redirect elsewhere. Publishing replaces that redirect.');
    END IF;
  END IF;

  -- ── copy ────────────────────────────────────────────────────────────────
  IF COALESCE((v_snap#>>'{sections,description}'), 'true') <> 'false'
     AND btrim(COALESCE(v_snap->>'description', '')) = '' THEN
    v_b := v_b || catalog__issue('DESCRIPTION_REQUIRED', 'description', 'Add a product description (or hide the Description section).');
  END IF;
  IF char_length(COALESCE(v_snap->>'description', '')) > 4000 THEN
    v_b := v_b || catalog__issue('DESCRIPTION_TOO_LONG', 'description', 'Description is longer than 4000 characters.');
  END IF;
  IF COALESCE((v_snap#>>'{sections,details}'), 'true') <> 'false' THEN
    IF jsonb_typeof(v_snap->'constructionDetails') IS DISTINCT FROM 'array'
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_snap->'constructionDetails') x WHERE btrim(x) <> '') THEN
      v_b := v_b || catalog__issue('DETAILS_REQUIRED', 'constructionDetails', 'Add at least one detail line (or hide the Details section).');
    END IF;
  END IF;
  IF char_length(COALESCE(v_snap->>'eyebrow', '')) > 40 THEN
    v_w := v_w || catalog__issue('EYEBROW_LONG', 'eyebrow', 'Eyebrow is long. Check the preview.');
  END IF;
  IF char_length(COALESCE(v_snap->>'founderNote', '')) > 200 THEN
    v_w := v_w || catalog__issue('FOUNDER_NOTE_LONG', 'founderNote', 'Pricing message is long. Check the preview.');
  END IF;
  IF char_length(COALESCE(v_snap->>'fitNote', '')) > 200 THEN
    v_w := v_w || catalog__issue('FIT_NOTE_LONG', 'fitNote', 'Fit note is long. Check the preview.');
  END IF;
  IF char_length(COALESCE(v_snap#>>'{seo,title}', '')) > 70 THEN
    v_w := v_w || catalog__issue('SEO_TITLE_LONG', 'seo.title', 'Search titles over 70 characters may be cut off.');
  END IF;
  IF char_length(COALESCE(v_snap#>>'{seo,description}', '')) > 170 THEN
    v_w := v_w || catalog__issue('SEO_DESC_LONG', 'seo.description', 'Search descriptions over 170 characters may be cut off.');
  END IF;
  IF COALESCE(v_snap#>>'{seo,title}', '') = '' OR COALESCE(v_snap#>>'{seo,description}', '') = '' THEN
    v_w := v_w || catalog__issue('SEO_MISSING', 'seo', 'Search title and description are empty. Defaults will be used.');
  END IF;

  -- ── media: hero + exactly five shared gallery images ────────────────────
  IF jsonb_typeof(v_snap#>'{media,hero}') IS DISTINCT FROM 'object' THEN
    v_b := v_b || catalog__issue('HERO_REQUIRED', 'media.hero', 'Choose a hero image.');
  END IF;
  v_ngallery := CASE WHEN jsonb_typeof(v_snap#>'{media,gallery}') = 'array' THEN jsonb_array_length(v_snap#>'{media,gallery}') ELSE 0 END;
  IF v_ngallery <> 5 THEN
    v_b := v_b || catalog__issue('GALLERY_COUNT', 'media.gallery',
                                 'The gallery needs exactly 5 images (currently ' || v_ngallery || ').');
  END IF;
  FOR r IN SELECT * FROM catalog__slots_all(v_snap) LOOP
    v_problem := catalog__ref_problem(r.slot->'ref');
    IF v_problem = 'MISSING' THEN
      v_b := v_b || catalog__issue('MEDIA_MISSING', r.field, 'This image slot is empty.');
    ELSIF v_problem IS NOT NULL THEN
      v_b := v_b || catalog__issue('MEDIA_' || v_problem, r.field,
               CASE v_problem WHEN 'ASSET_ARCHIVED' THEN 'This image is archived in the Media Library.'
                              WHEN 'ASSET_MISSING'  THEN 'This image no longer exists in the Media Library.'
                              ELSE 'This image reference is not valid.' END);
    ELSIF COALESCE(btrim(r.slot->>'alt'), '') = '' THEN
      v_w := v_w || catalog__issue('ALT_MISSING', r.field, 'Add alt text for accessibility.');
    END IF;
    -- focal points: each device independently, normalised 0..1
    FOR v_txt IN SELECT unnest(ARRAY['mobile', 'desktop']) LOOP
      IF jsonb_typeof(r.slot#>ARRAY['focal', v_txt]) = 'object' THEN
        IF jsonb_typeof(r.slot#>ARRAY['focal', v_txt, 'x']) IS DISTINCT FROM 'number'
           OR jsonb_typeof(r.slot#>ARRAY['focal', v_txt, 'y']) IS DISTINCT FROM 'number'
           OR (r.slot#>>ARRAY['focal', v_txt, 'x'])::numeric NOT BETWEEN 0 AND 1
           OR (r.slot#>>ARRAY['focal', v_txt, 'y'])::numeric NOT BETWEEN 0 AND 1 THEN
          v_b := v_b || catalog__issue('FOCAL_INVALID', r.field, 'The ' || v_txt || ' focal point must be between 0 and 1.');
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  IF jsonb_typeof(v_snap#>'{seo,ogImage}') = 'object' THEN
    v_problem := catalog__ref_problem(v_snap#>'{seo,ogImage}');
    IF v_problem IS NOT NULL THEN
      v_b := v_b || catalog__issue('SHARE_IMAGE_' || v_problem, 'seo.ogImage', 'The share image is not usable.');
    END IF;
  END IF;

  -- ── colours ─────────────────────────────────────────────────────────────
  IF jsonb_typeof(v_snap->'colors') IS DISTINCT FROM 'array' OR jsonb_array_length(v_snap->'colors') = 0 THEN
    v_b := v_b || catalog__issue('COLOR_REQUIRED', 'colors', 'Add at least one colour.');
  ELSE
    FOR r IN SELECT e, i FROM jsonb_array_elements(v_snap->'colors') WITH ORDINALITY AS t(e, i) LOOP
      v_ncolors := v_ncolors + 1;
      IF COALESCE(r.e->>'key', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
        v_b := v_b || catalog__issue('COLOR_KEY_INVALID', 'colors.' || r.i, 'Colour key is not valid.');
      ELSIF r.e->>'key' = ANY (v_keys) THEN
        v_b := v_b || catalog__issue('COLOR_DUPLICATE', 'colors.' || r.i, 'Colour keys must be unique.');
      END IF;
      v_keys := v_keys || COALESCE(r.e->>'key', '');
      IF COALESCE(r.e->>'code', '') !~ '^[A-Z0-9]{2,6}$' THEN
        v_b := v_b || catalog__issue('COLOR_CODE_INVALID', 'colors.' || r.i, 'Colour code needs 2–6 capital letters or digits.');
      ELSIF r.e->>'code' = ANY (v_codes) THEN
        v_b := v_b || catalog__issue('COLOR_DUPLICATE', 'colors.' || r.i, 'Colour codes must be unique.');
      END IF;
      v_codes := v_codes || COALESCE(r.e->>'code', '');
      IF btrim(COALESCE(r.e->>'name', '')) = '' OR char_length(r.e->>'name') > 40 THEN
        v_b := v_b || catalog__issue('COLOR_NAME_INVALID', 'colors.' || r.i, 'Colour name is required (max 40).');
      END IF;
      IF COALESCE(r.e->>'hex', '') !~ '^#[0-9A-Fa-f]{6}$' THEN
        v_b := v_b || catalog__issue('COLOR_HEX_INVALID', 'colors.' || r.i, 'Swatch needs a hex value like #111111.');
      END IF;
      IF jsonb_typeof(r.e->'media') = 'object' THEN
        IF jsonb_typeof(r.e#>'{media,hero}') IS DISTINCT FROM 'object'
           OR jsonb_typeof(r.e#>'{media,gallery}') IS DISTINCT FROM 'array'
           OR jsonb_array_length(r.e#>'{media,gallery}') <> 5 THEN
          v_b := v_b || catalog__issue('COLOR_MEDIA_INCOMPLETE', 'colors.' || r.i || '.media',
                   'A colour with its own media needs a hero and exactly 5 gallery images (or clear it to inherit).');
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- ── Complete the Set pairing ────────────────────────────────────────────
  IF v_full AND COALESCE(v_snap#>>'{completeTheSet,enabled}', 'false') = 'true' THEN
    v_pair := v_snap#>>'{completeTheSet,pairedProductId}';
    IF NOT catalog__is_uuid(v_pair) THEN
      v_b := v_b || catalog__issue('PAIR_REQUIRED', 'completeTheSet', 'Choose the product to pair with, or turn Complete the Set off.');
    ELSIF lower(v_pair) = p_product_id::text THEN
      v_b := v_b || catalog__issue('PAIR_SELF', 'completeTheSet', 'A product cannot be paired with itself.');
    ELSIF NOT EXISTS (SELECT 1 FROM content_entities e
                       WHERE e.entity_type = 'product' AND e.entity_id = lower(v_pair) AND e.status = 'published') THEN
      v_b := v_b || catalog__issue('PAIR_NOT_LIVE', 'completeTheSet', 'The paired product must be live.');
    END IF;
  END IF;

  -- ── commerce (price, shipping, origin/HS, variant matrix) ───────────────
  IF v_full THEN
    v_txt := v_snap#>>'{commerce,priceCents}';
    IF v_txt IS NULL OR v_txt !~ '^[0-9]{1,7}$' OR v_txt::bigint < 1 OR v_txt::bigint > 1000000 THEN
      v_b := v_b || catalog__issue('PRICE_REQUIRED', 'commerce.priceCents', 'Set the price (whole cents, $0.01 – $10,000).');
    END IF;

    FOR r IN SELECT * FROM (VALUES ('weightLb', 'Shipping weight (lb)', 150), ('lengthIn', 'Package length (in)', 120),
                                   ('widthIn', 'Package width (in)', 120), ('heightIn', 'Package height (in)', 120)) AS x(k, label, mx) LOOP
      v_txt := v_snap#>>ARRAY['commerce', 'shipping', r.k];
      IF v_txt IS NULL OR v_txt !~ '^[0-9]+(\.[0-9]+)?$' OR v_txt::numeric <= 0 OR v_txt::numeric > r.mx THEN
        v_b := v_b || catalog__issue('SHIPPING_REQUIRED', 'commerce.shipping.' || r.k,
                 r.label || ' is required so rates use real parcel data.');
      END IF;
    END LOOP;

    v_txt := NULLIF(btrim(COALESCE(v_snap#>>'{commerce,originCountry}', '')), '');
    IF v_txt IS NOT NULL AND v_txt !~ '^[A-Z]{2}$' THEN
      v_b := v_b || catalog__issue('ORIGIN_INVALID', 'commerce.originCountry', 'Country of origin must be a 2-letter ISO code like US.');
    END IF;
    v_txt := NULLIF(btrim(COALESCE(v_snap#>>'{commerce,hsCode}', '')), '');
    IF v_txt IS NOT NULL AND v_txt !~ '^[0-9]{4}[.]?[0-9]{2}([.]?[0-9]{2}){0,2}$' THEN
      v_b := v_b || catalog__issue('HS_INVALID', 'commerce.hsCode', 'HS code needs 6–10 digits, dots optional (e.g. 6110.20).');
    END IF;

    IF jsonb_typeof(v_snap#>'{commerce,variants}') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_snap#>'{commerce,variants}') = 0 THEN
      v_b := v_b || catalog__issue('VARIANT_REQUIRED', 'commerce.variants', 'Add at least one variant.');
    ELSE
      v_prefix := 'KVRN-' || upper(v_prod.product_code) || '-';
      FOR r IN SELECT e, i FROM jsonb_array_elements(v_snap#>'{commerce,variants}') WITH ORDINALITY AS t(e, i) LOOP
        v_sku := COALESCE(r.e->>'sku', '');
        IF v_sku = '' THEN
          v_b := v_b || catalog__issue('SKU_REQUIRED', 'commerce.variants.' || r.i, 'Every variant needs a SKU.');
        ELSE
          IF v_sku !~ '^KVRN-[A-Z0-9]+(-[A-Z0-9]+)*$' OR char_length(v_sku) > 60 THEN
            v_b := v_b || catalog__issue('SKU_INVALID', 'commerce.variants.' || r.i,
                     'SKU ' || left(v_sku, 40) || ' must start with KVRN- and use capital letters, digits and hyphens.');
          END IF;
          IF v_sku = ANY (v_skus) THEN
            v_b := v_b || catalog__issue('SKU_DUPLICATE', 'commerce.variants.' || r.i, 'SKU ' || left(v_sku, 40) || ' appears more than once.');
          END IF;
          v_skus := v_skus || v_sku;
          IF EXISTS (SELECT 1 FROM product_variants x WHERE x.sku = v_sku AND x.product_id <> p_product_id) THEN
            v_b := v_b || catalog__issue('SKU_TAKEN', 'commerce.variants.' || r.i, 'SKU ' || left(v_sku, 40) || ' belongs to another product.');
          END IF;
          IF NOT EXISTS (SELECT 1 FROM product_variants x WHERE x.sku = v_sku AND x.product_id = p_product_id)
             AND left(v_sku, char_length(v_prefix)) <> v_prefix THEN
            v_b := v_b || catalog__issue('SKU_PREFIX', 'commerce.variants.' || r.i,
                     'New SKUs for this product must start with ' || v_prefix);
          END IF;
        END IF;
        IF catalog__is_uuid(r.e->>'id') THEN
          IF NOT EXISTS (SELECT 1 FROM product_variants x WHERE x.id = (r.e->>'id')::uuid AND x.product_id = p_product_id) THEN
            v_b := v_b || catalog__issue('VARIANT_UNKNOWN', 'commerce.variants.' || r.i, 'This variant does not belong to the product.');
          ELSIF EXISTS (SELECT 1 FROM product_variants x WHERE x.id = (r.e->>'id')::uuid AND x.sku <> v_sku) THEN
            v_b := v_b || catalog__issue('SKU_CHANGED', 'commerce.variants.' || r.i, 'Existing SKUs are permanent and cannot be renamed.');
          END IF;
          v_ids := v_ids || (r.e->>'id')::uuid;
        END IF;
        IF btrim(COALESCE(r.e->>'size', '')) = '' OR char_length(r.e->>'size') > 20 THEN
          v_b := v_b || catalog__issue('SIZE_INVALID', 'commerce.variants.' || r.i, 'Size label is required (max 20).');
        END IF;
        IF COALESCE(r.e->>'sizeSort', '') !~ '^[0-9]{1,3}$' THEN
          v_b := v_b || catalog__issue('SIZE_SORT_INVALID', 'commerce.variants.' || r.i, 'Size order must be a whole number 0–999.');
        END IF;
        IF NOT ((r.e->>'colorCode') = ANY (v_codes)) THEN
          v_b := v_b || catalog__issue('VARIANT_COLOR_UNKNOWN', 'commerce.variants.' || r.i, 'Variant colour is not in the colour list.');
        END IF;
        IF (COALESCE(r.e->>'colorCode', '') || '|' || lower(COALESCE(r.e->>'size', ''))) = ANY (v_pairs) THEN
          v_b := v_b || catalog__issue('VARIANT_DUPLICATE', 'commerce.variants.' || r.i, 'Each colour and size combination can appear once.');
        END IF;
        v_pairs := v_pairs || (COALESCE(r.e->>'colorCode', '') || '|' || lower(COALESCE(r.e->>'size', '')));
        IF COALESCE(r.e->>'active', 'true') <> 'false' THEN v_active := v_active + 1; END IF;
      END LOOP;
      IF v_active = 0 THEN
        v_b := v_b || catalog__issue('NO_ACTIVE_VARIANT', 'commerce.variants', 'At least one variant must be active.');
      END IF;
      -- A variant held by an in-flight checkout cannot be removed or switched off right now.
      FOR r IN SELECT pv.id, pv.sku FROM product_variants pv
                WHERE pv.product_id = p_product_id AND pv.reserved_quantity > 0
                  AND (NOT (pv.sku = ANY (v_skus))
                       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_snap#>'{commerce,variants}') e
                                   WHERE e->>'sku' = pv.sku AND COALESCE(e->>'active', 'true') = 'false')) LOOP
        v_b := v_b || catalog__issue('VARIANT_RESERVED', 'commerce.variants',
                 'SKU ' || r.sku || ' is reserved by an open checkout. Try again after it clears.');
      END LOOP;
    END IF;

    -- product code is the SKU namespace; legacy codes are accepted as they are
    IF v_prod.product_code !~ '^[A-Z0-9]{2,12}$' THEN
      v_b := v_b || catalog__issue('PRODUCT_CODE_INVALID', 'productCode', 'Product code needs 2–12 capital letters or digits.');
    END IF;
  END IF;

  RETURN jsonb_build_object('blockers', v_b, 'warnings', v_w);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Apply a published snapshot to the canonical tables
-- ═══════════════════════════════════════════════════════════════════════════
-- p_full = TRUE  : price, shipping, origin/HS and the variant matrix are applied.
-- p_full = FALSE : (rollback) presentation-level canonical fields only (name, type, slug mirror).
-- Never writes stock_on_hand / reserved_quantity. Existing SKUs are never renamed. Variants
-- missing from the matrix are DEACTIVATED, never deleted (they may carry orders, layers, costs).
CREATE OR REPLACE FUNCTION catalog_apply_product(p_product_id UUID, p_snapshot JSONB, p_full BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_prod     products%ROWTYPE;
  v_slug     TEXT := lower(btrim(p_snapshot->>'slug'));
  v_added    INTEGER := 0;
  v_updated  INTEGER := 0;
  v_deact    INTEGER := 0;
  r          RECORD;
  v_color    JSONB;
  v_exist    UUID;
  v_skus     TEXT[] := '{}';
  v_price    INTEGER;
  v_cnt      INTEGER;
BEGIN
  SELECT * INTO v_prod FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_NOT_FOUND|%', p_product_id; END IF;

  UPDATE products
     SET name         = btrim(p_snapshot->>'name'),
         product_type = p_snapshot->>'productType',
         description  = NULLIF(btrim(COALESCE(p_snapshot->>'description', '')), ''),
         slug         = CASE WHEN v_prod.catalog_origin = 'editor' AND v_slug IS NOT NULL AND v_slug <> '' THEN v_slug ELSE slug END,
         active       = TRUE
   WHERE id = p_product_id;

  IF p_full THEN
    v_price := (p_snapshot#>>'{commerce,priceCents}')::integer;
    UPDATE products
       SET price_cents        = v_price,
           shipping_weight_lb = (p_snapshot#>>'{commerce,shipping,weightLb}')::numeric,
           package_length_in  = (p_snapshot#>>'{commerce,shipping,lengthIn}')::numeric,
           package_width_in   = (p_snapshot#>>'{commerce,shipping,widthIn}')::numeric,
           package_height_in  = (p_snapshot#>>'{commerce,shipping,heightIn}')::numeric,
           country_of_origin  = NULLIF(btrim(COALESCE(p_snapshot#>>'{commerce,originCountry}', '')), ''),
           hs_code            = NULLIF(btrim(COALESCE(p_snapshot#>>'{commerce,hsCode}', '')), '')
     WHERE id = p_product_id;

    FOR r IN SELECT e FROM jsonb_array_elements(p_snapshot#>'{commerce,variants}') AS t(e) LOOP
      v_skus := v_skus || (r.e->>'sku');
      v_color := NULL; v_exist := NULL;
      SELECT c INTO v_color FROM jsonb_array_elements(p_snapshot->'colors') c WHERE c->>'code' = r.e->>'colorCode' LIMIT 1;
      SELECT id INTO v_exist FROM product_variants WHERE sku = r.e->>'sku' AND product_id = p_product_id;
      IF v_exist IS NULL THEN
        INSERT INTO product_variants
          (product_id, sku, color_name, color_code, size, size_sort, stock_on_hand, reserved_quantity, active, image_set)
        VALUES
          (p_product_id, r.e->>'sku', v_color->>'name', r.e->>'colorCode', btrim(r.e->>'size'),
           (r.e->>'sizeSort')::integer, 0, 0, COALESCE((r.e->>'active')::boolean, TRUE), v_color->>'key');
        v_added := v_added + 1;
      ELSE
        UPDATE product_variants
           SET color_name = v_color->>'name', color_code = r.e->>'colorCode', size = btrim(r.e->>'size'),
               size_sort = (r.e->>'sizeSort')::integer, active = COALESCE((r.e->>'active')::boolean, TRUE),
               image_set = v_color->>'key'
         WHERE id = v_exist
           AND (color_name, color_code, size, size_sort, active, image_set) IS DISTINCT FROM
               (v_color->>'name', r.e->>'colorCode', btrim(r.e->>'size'), (r.e->>'sizeSort')::integer,
                COALESCE((r.e->>'active')::boolean, TRUE), v_color->>'key');
        GET DIAGNOSTICS v_cnt = ROW_COUNT;
        v_updated := v_updated + v_cnt;
      END IF;
    END LOOP;

    UPDATE product_variants SET active = FALSE, updated_at = NOW()
     WHERE product_id = p_product_id AND active AND NOT (sku = ANY (v_skus));
    GET DIAGNOSTICS v_deact = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('previous_price_cents', v_prod.price_cents, 'price_cents', CASE WHEN p_full THEN v_price ELSE v_prod.price_cents END,
                            'variants_added', v_added, 'variants_updated', v_updated, 'variants_deactivated', v_deact,
                            'full', p_full);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. The go-live trigger: ONE enforcement point for publish / rollback / scheduler
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION catalog_entity_sync() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_snap   JSONB;
  v_rb     INTEGER;
  v_mode   TEXT;
  v_res    JSONB;
  v_apply  JSONB;
  v_pid    UUID;
  v_action TEXT;
BEGIN
  IF NEW.entity_type <> 'product' OR NOT catalog__is_uuid(NEW.entity_id) THEN RETURN NULL; END IF;
  v_pid := NEW.entity_id::uuid;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = v_pid) THEN RETURN NULL; END IF;     -- generic CMS use, not catalog-managed
  IF current_setting('kvrn.catalog_bootstrap', true) = 'on' THEN RETURN NULL; END IF;  -- migration bootstrap only

  IF NEW.status = 'published'
     AND (OLD.status IS DISTINCT FROM 'published' OR OLD.published_version_no IS DISTINCT FROM NEW.published_version_no) THEN
    SELECT snapshot, rolled_back_from INTO v_snap, v_rb FROM content_versions
     WHERE entity_type = 'product' AND entity_id = NEW.entity_id AND version_no = NEW.published_version_no;
    v_mode := CASE WHEN v_rb IS NOT NULL THEN 'rollback' ELSE 'publish' END;
    v_res := catalog_product_blockers(v_pid, v_snap, v_mode);
    IF jsonb_array_length(v_res->'blockers') > 0 THEN
      RAISE EXCEPTION 'CATALOG_BLOCKED|%', (v_res->'blockers')::text;
    END IF;
    v_apply := catalog_apply_product(v_pid, v_snap, v_mode = 'publish');

    -- published media usages (replace)
    DELETE FROM media_usages WHERE owner_type = 'product' AND owner_id = NEW.entity_id AND scope = 'published';
    INSERT INTO media_usages (asset_id, owner_type, owner_id, slot, scope)
      SELECT DISTINCT m.asset_id, 'product', NEW.entity_id, m.slot, 'published' FROM catalog_media_refs(v_snap) m
        JOIN media_assets a ON a.id = m.asset_id
      ON CONFLICT DO NOTHING;

    v_action := CASE WHEN v_rb IS NOT NULL THEN 'product.rollback'
                     WHEN NEW.updated_by = 'system@kvrn.internal' THEN 'product.scheduled_publish'
                     ELSE 'product.publish' END;
    PERFORM cms_audit(COALESCE(NEW.updated_by, 'system@kvrn.internal'), v_action, 'product', NEW.entity_id,
      jsonb_build_object('version_no', NEW.published_version_no, 'slug', NEW.slug, 'rolled_back_from', v_rb,
                         'warnings', jsonb_array_length(v_res->'warnings')) || v_apply);
  ELSIF OLD.status = 'published' AND NEW.status <> 'published' THEN
    UPDATE products SET active = FALSE WHERE id = v_pid AND active;
    DELETE FROM media_usages WHERE owner_type = 'product' AND owner_id = NEW.entity_id AND scope = 'published';
  END IF;
  RETURN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'catalog_entity_sync_trg') THEN
    CREATE TRIGGER catalog_entity_sync_trg
      AFTER UPDATE ON content_entities
      FOR EACH ROW
      WHEN (NEW.entity_type = 'product'
            AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.published_version_no IS DISTINCT FROM NEW.published_version_no))
      EXECUTE FUNCTION catalog_entity_sync();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Create / publish entry points (atomic: one statement = one transaction on Neon HTTP)
-- ═══════════════════════════════════════════════════════════════════════════
-- Creates the canonical products row (inactive, price 0 = "not configured": validateLineItem
-- refuses price 0, and the row stays inactive until the first publish) and the draft entity.
CREATE OR REPLACE FUNCTION catalog_create_product(
  p_actor TEXT, p_code TEXT, p_name TEXT, p_slug TEXT, p_type TEXT, p_snapshot JSONB
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_id UUID := gen_random_uuid(); v_code TEXT := upper(btrim(COALESCE(p_code, ''))); v_res JSONB;
BEGIN
  IF v_code !~ '^[A-Z0-9]{2,12}$' OR v_code ~ '^D[0-9]{3}$' THEN RAISE EXCEPTION 'CATALOG_INVALID|PRODUCT_CODE'; END IF;
  IF btrim(COALESCE(p_name, '')) = '' OR char_length(p_name) > 120 THEN RAISE EXCEPTION 'CATALOG_INVALID|NAME'; END IF;
  IF COALESCE(p_slug, '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(p_slug) > 80 THEN RAISE EXCEPTION 'CATALOG_INVALID|SLUG'; END IF;
  IF p_type IS NOT NULL AND (p_type !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(p_type) > 40) THEN RAISE EXCEPTION 'CATALOG_INVALID|TYPE'; END IF;
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN RAISE EXCEPTION 'CATALOG_INVALID|SNAPSHOT'; END IF;
  IF EXISTS (SELECT 1 FROM products WHERE lower(product_code) = lower(v_code)) THEN RAISE EXCEPTION 'CATALOG_INVALID|PRODUCT_CODE_TAKEN'; END IF;

  INSERT INTO products (id, drop_code, product_code, name, slug, price_cents, currency, active, product_type, catalog_origin)
  VALUES (v_id, 'CMS', v_code, btrim(p_name), 'draft-' || substr(replace(v_id::text, '-', ''), 1, 12), 0, 'usd', FALSE, p_type, 'editor');

  v_res := cms_save_draft('product', v_id::text, p_snapshot, 0, p_actor, 'Created');
  PERFORM cms_audit(p_actor, 'product.create', 'product', v_id::text,
                    jsonb_build_object('product_code', v_code, 'slug', p_slug, 'type', p_type));
  RETURN v_res || jsonb_build_object('product_id', v_id);
END $$;

-- Validate + publish in one transaction. The go-live trigger re-validates and applies the
-- canonical changes, so a failure here (or there) leaves nothing half-applied.
CREATE OR REPLACE FUNCTION publish_catalog_product(p_product_id UUID, p_expected_revision INTEGER, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_e content_entities%ROWTYPE; v_res JSONB; v_snap JSONB;
BEGIN
  SELECT * INTO v_e FROM content_entities WHERE entity_type = 'product' AND entity_id = p_product_id::text FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|product|%', p_product_id; END IF;
  IF v_e.status = 'archived' THEN RAISE EXCEPTION 'CMS_ARCHIVED|product|%', p_product_id; END IF;
  IF p_expected_revision IS DISTINCT FROM v_e.revision THEN RAISE EXCEPTION 'CMS_STALE_REVISION|product|%', p_product_id; END IF;
  IF v_e.draft_version_no IS NULL THEN RAISE EXCEPTION 'CMS_NO_DRAFT|product|%', p_product_id; END IF;
  SELECT snapshot INTO v_snap FROM content_versions
   WHERE entity_type = 'product' AND entity_id = p_product_id::text AND version_no = v_e.draft_version_no;
  v_res := catalog_product_blockers(p_product_id, v_snap, 'publish');
  IF jsonb_array_length(v_res->'blockers') > 0 THEN
    RAISE EXCEPTION 'CATALOG_BLOCKED|%', (v_res->'blockers')::text;
  END IF;
  RETURN cms_publish('product', p_product_id::text, p_expected_revision, p_actor, '/products')
         || jsonb_build_object('warnings', v_res->'warnings');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Bootstrap: the two live KVRN products become Admin-managed WITHOUT touching commerce
-- ═══════════════════════════════════════════════════════════════════════════
-- Content below is copied verbatim from data/products.ts (phantom hoodie / sweatpants) with
-- static image refs, so the CMS rendering inputs equal the coded data. Existing product and
-- variant ids, SKUs, stock, shipping and cost associations are NOT modified; the snapshot only
-- REFERENCES them (variant ids + SKUs read from product_variants). Idempotent: a product that
-- already has a content entity is skipped. Never fails the migration: each product is guarded.
CREATE OR REPLACE FUNCTION catalog_bootstrap_products() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  d        RECORD;
  v_prod   products%ROWTYPE;
  v_snap   JSONB;
  v_vars   JSONB;
  v_code   TEXT;
  v_pair   UUID;
  v_done   JSONB := '[]'::jsonb;
  v_static JSONB;
  v_stub   JSONB;
  i        INTEGER;
  v_gal    JSONB;
  v_alt    TEXT;
  v_folder TEXT;
BEGIN
  PERFORM set_config('kvrn.catalog_bootstrap', 'on', TRUE);

  FOR d IN SELECT * FROM (VALUES
    ('PKHH', 'kvrn-phantom-hoodie', 'project-kvrn-heavyweight-hoodie', 'hoodie', 'PKHSP',
     $j$ {
       "name": "Project KVRN Heavyweight Hoodie",
       "eyebrow": "Project KVRN",
       "founderNote": "Founder pricing — permanently increases after initial release.",
       "shortDescription": "500 GSM French terry blend. Oversized, cropped.",
       "constructionDetails": ["500 GSM French terry blend.", "70% cotton, 30% polyester.", "Enzyme washed. Pre-shrunk.", "Oversized cropped proportion.", "Immediate softness from first wear."],
       "description": "A heavier French terry blend with an oversized, cropped proportion. Enzyme washed for a softer hand feel and finished for everyday wear.",
       "fitNote": "Cropped oversized fit. Size up for more length.",
       "features": [
         {"title": "500 GSM French Terry Blend", "description": "70% cotton, 30% polyester. Heavier than the standard collection."},
         {"title": "Enzyme Washed", "description": "Washed before shipping for immediate softness. No break-in period."},
         {"title": "Pre-Shrunk", "description": "Holds its shape through regular wear and washing."}],
       "specs": [
         {"label": "Material", "value": "70% Cotton, 30% Polyester"}, {"label": "Weight", "value": "500 GSM"},
         {"label": "Construction", "value": "French terry blend"}, {"label": "Finish", "value": "Enzyme washed, wrinkle-resistant"},
         {"label": "Pre-shrunk", "value": "Yes"}, {"label": "Fit", "value": "Oversized, cropped"},
         {"label": "Care", "value": "Machine wash cold. Tumble dry low."}],
       "seo": {"title": "Project KVRN Heavyweight Hoodie | 500 GSM French Terry | Founder Price $80",
               "description": "Project KVRN Heavyweight Hoodie. 500 GSM French terry blend, enzyme washed, pre-shrunk. Cropped oversized fit. Black. Founder price $80."}
     } $j$::jsonb),
    ('PKHSP', 'kvrn-phantom-sweatpants', 'project-kvrn-heavyweight-sweatpants', 'sweatpants', 'PKHH',
     $j$ {
       "name": "Project KVRN Heavyweight Sweatpants",
       "eyebrow": "Project KVRN",
       "founderNote": "Founder pricing — permanently increases after initial release.",
       "shortDescription": "500 GSM French terry blend. Relaxed oversized fit.",
       "constructionDetails": ["500 GSM French terry blend.", "70% cotton, 30% polyester.", "Enzyme washed. Pre-shrunk.", "Relaxed oversized fit.", "Concealed elastic waistband."],
       "description": "The same 500 GSM French terry blend with a relaxed oversized fit. Pre-shrunk, enzyme washed, and finished for a clean daily silhouette.",
       "fitNote": "Relaxed oversized fit. True to size.",
       "features": [
         {"title": "500 GSM French Terry Blend", "description": "70% cotton, 30% polyester. Same blend as the Project KVRN Heavyweight Hoodie."},
         {"title": "Enzyme Washed", "description": "Immediate softness from first wear."},
         {"title": "Pre-Shrunk", "description": "Holds its shape through regular wear and washing."}],
       "specs": [
         {"label": "Material", "value": "70% Cotton, 30% Polyester"}, {"label": "Weight", "value": "500 GSM"},
         {"label": "Construction", "value": "French terry blend"}, {"label": "Finish", "value": "Enzyme washed, wrinkle-resistant"},
         {"label": "Pre-shrunk", "value": "Yes"}, {"label": "Waist", "value": "Elastic with internal drawcord"},
         {"label": "Fit", "value": "Relaxed oversized"}, {"label": "Care", "value": "Machine wash cold. Tumble dry low."}],
       "seo": {"title": "Project KVRN Heavyweight Sweatpants | 500 GSM French Terry | Founder Price $80",
               "description": "Project KVRN Heavyweight Sweatpants. 500 GSM French terry blend. Enzyme washed, pre-shrunk. Relaxed oversized fit. Black. Founder price $80."}
     } $j$::jsonb)
  ) AS x(product_code, public_slug, neon_slug, ptype, pair_code, content)
  LOOP
    BEGIN
      SELECT * INTO v_prod FROM products WHERE product_code = d.product_code AND slug = d.neon_slug;
      CONTINUE WHEN NOT FOUND;
      CONTINUE WHEN EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'product' AND entity_id = v_prod.id::text);

      SELECT jsonb_agg(jsonb_build_object('id', pv.id, 'sku', pv.sku, 'colorCode', pv.color_code, 'size', pv.size,
                                          'sizeSort', pv.size_sort, 'active', pv.active) ORDER BY pv.size_sort, pv.sku),
             MIN(pv.color_code)
        INTO v_vars, v_code FROM product_variants pv WHERE pv.product_id = v_prod.id;
      v_vars := COALESCE(v_vars, '[]'::jsonb);
      v_code := COALESCE(v_code, 'BLK');
      SELECT id INTO v_pair FROM products WHERE product_code = d.pair_code AND catalog_origin IS DISTINCT FROM 'editor' LIMIT 1;

      v_folder := d.neon_slug;                    -- /images/products/<neon slug>/1.webp … 5.webp
      v_alt := (d.content->>'name') || ' — Black — view ';
      v_gal := '[]'::jsonb;
      FOR i IN 1..5 LOOP
        v_gal := v_gal || jsonb_build_object(
          'ref', jsonb_build_object('kind', 'static', 'src', '/images/products/' || v_folder || '/' || i || '.webp'),
          'alt', v_alt || i, 'focal', jsonb_build_object('mobile', NULL, 'desktop', NULL));
      END LOOP;

      v_snap := jsonb_build_object(
        'schema', 1, 'slug', d.public_slug, 'productType', d.ptype, 'presentation', 'standard',
        'sections', jsonb_build_object('description', TRUE, 'details', TRUE, 'shippingReturns', TRUE, 'sizeGuideLink', TRUE, 'stickyAddToBag', TRUE),
        'shippingReturns', jsonb_build_object('mode', 'global', 'lines', '[]'::jsonb),
        'sizeGuide', jsonb_build_object('mode', 'global', 'entityId', NULL, 'body', NULL),
        'media', jsonb_build_object('hero', v_gal->0, 'gallery', v_gal),
        'colors', jsonb_build_array(jsonb_build_object('key', 'black', 'code', v_code, 'name', 'Black', 'hex', '#0A0A0A', 'media', NULL)),
        'commerce', jsonb_build_object(
          'priceCents', v_prod.price_cents,
          'shipping', jsonb_build_object('weightLb', v_prod.shipping_weight_lb, 'lengthIn', v_prod.package_length_in,
                                         'widthIn', v_prod.package_width_in, 'heightIn', v_prod.package_height_in),
          'originCountry', v_prod.country_of_origin, 'hsCode', v_prod.hs_code, 'variants', v_vars),
        'shop', jsonb_build_object('listed', TRUE, 'sortPosition', CASE d.product_code WHEN 'PKHH' THEN 1 ELSE 2 END),
        'completeTheSet', jsonb_build_object('enabled', v_pair IS NOT NULL, 'pairedProductId', v_pair),
        'bundle', NULL)
        || d.content
        || jsonb_build_object('seo', (d.content->'seo') || jsonb_build_object('ogImage', v_gal->0->'ref', 'canonicalUrl', NULL, 'ogTitle', NULL, 'ogDescription', NULL));

      UPDATE products SET product_type = d.ptype, catalog_origin = 'legacy' WHERE id = v_prod.id;
      PERFORM cms_save_draft('product', v_prod.id::text, v_snap, 0, 'system@kvrn.internal', 'Imported from the coded catalog');
      PERFORM cms_publish('product', v_prod.id::text, 1, 'system@kvrn.internal', '/products');

      -- The Neon catalog slug was an accepted alias for inventory; keep its page URL working too.
      INSERT INTO content_redirects (from_path, to_path, status_code, entity_type, entity_id, created_by)
      VALUES ('/products/' || d.neon_slug, '/products/' || d.public_slug, 301, 'product', v_prod.id::text, 'system@kvrn.internal')
      ON CONFLICT (from_path) DO NOTHING;

      v_done := v_done || to_jsonb(d.product_code);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'catalog bootstrap skipped % (%)', d.product_code, SQLERRM;
    END;
  END LOOP;

  PERFORM set_config('kvrn.catalog_bootstrap', 'off', TRUE);
  RETURN v_done;
END $$;

SELECT catalog_bootstrap_products();

COMMIT;

-- VERIFICATION QUERIES (run manually after applying; they change nothing):
--   SELECT product_code, slug, product_type, catalog_origin, price_cents, active FROM products ORDER BY product_code;
--   SELECT entity_id, status, slug, published_version_no FROM content_entities WHERE entity_type = 'product';
--   SELECT jsonb_pretty(catalog_product_blockers(id)) FROM products WHERE product_code = 'PKHH';
--   SELECT from_path, to_path FROM content_redirects WHERE entity_type = 'product';
