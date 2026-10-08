-- KVRN Migration 030 — Site content CMS (policies, size guides, FAQ, pages, shell, SEO)
--
-- Additive only. Nothing in 001–027 is altered or dropped. The ONLY pre-existing function this
-- file replaces is cms_path_prefix (027), keeping every existing case and adding 'page'.
-- Idempotent: CREATE ... IF NOT EXISTS, CREATE OR REPLACE of OUR OWN functions, guarded seeds.
-- Safe to re-run. Run after 001–027. NOT applied to production by the implementation batch.
--
-- WHAT THIS ADDS
--   product_size_guides        which Size Guide each product shows (one guide per product, a guide
--                              can be shared by many products; duplicates are independent entities)
--   content_block_usages       where a reusable content block is referenced (pages, policies, FAQ,
--                              products) so archive/delete can show usage first
--   content_policy_path()      the public path of a policy (legacy URLs preserved)
--   content_policy_go_live()   atomic publish/rollback of a policy INCLUDING its slug-change
--                              redirects (old path -> new path), in one transaction
--   cms_path_prefix()          registers '/pages' for generic pages (scheduler redirects)
--   seeds                      the CURRENT coded storefront content (policies, FAQ, size guides,
--                              size-guide page copy, About, Contact, announcement, navigation,
--                              footer, global SEO, the Project KVRN collection) so that turning
--                              CMS_PUBLIC_CONTENT on changes nothing visually.
--
-- Public content is edited through content_entities / content_versions (027). Nothing here
-- touches commerce, orders, inventory or financial tables.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SIZE GUIDE ASSIGNMENT
-- ═══════════════════════════════════════════════════════════════════════════
-- PRIMARY KEY (product_id): a product shows exactly one guide. Many products may point at the
-- same guide (they then share its updates). The composite FK pins size_guide_id to an entity
-- of type 'size_guide' (entities are never deleted — they are archived).
CREATE TABLE IF NOT EXISTS product_size_guides (
  product_id     UUID        PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  size_guide_id  TEXT        NOT NULL,
  entity_type    TEXT        NOT NULL DEFAULT 'size_guide' CHECK (entity_type = 'size_guide'),
  assigned_by    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_size_guides_guide_fk
    FOREIGN KEY (entity_type, size_guide_id) REFERENCES content_entities (entity_type, entity_id)
    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_product_size_guides_guide ON product_size_guides(size_guide_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- REUSABLE CONTENT BLOCK USAGE
-- ═══════════════════════════════════════════════════════════════════════════
-- Blocks are referenced BY ID (no copies, no per-use overrides: an override would make the
-- block's meaning ambiguous). owner_type is 'page' | 'policy' | 'faq' | 'product' ...;
-- scope separates what a draft references from what is live.
CREATE TABLE IF NOT EXISTS content_block_usages (
  block_id    TEXT        NOT NULL,
  owner_type  TEXT        NOT NULL,
  owner_id    TEXT        NOT NULL,
  scope       TEXT        NOT NULL DEFAULT 'published',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (block_id, owner_type, owner_id, scope),
  CONSTRAINT content_block_usages_scope_chk CHECK (scope IN ('draft', 'published'))
);
CREATE INDEX IF NOT EXISTS idx_content_block_usages_owner ON content_block_usages(owner_type, owner_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- Registers '/pages' for generic pages (cms_apply_due uses it for scheduled slug changes).
-- Existing cases are unchanged.
CREATE OR REPLACE FUNCTION cms_path_prefix(p_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type WHEN 'product' THEN '/products' WHEN 'collection' THEN '/collections'
                     WHEN 'page' THEN '/pages' ELSE NULL END
$$;

-- Public path of a policy. The four seeded policies keep their existing URLs while they keep
-- their slug; any other policy (or a renamed seeded one) lives under /legal/<slug>.
CREATE OR REPLACE FUNCTION content_policy_path(p_entity_id TEXT, p_slug TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_entity_id = 'terms'            AND p_slug = 'terms'            THEN '/terms'
    WHEN p_entity_id = 'privacy'          AND p_slug = 'privacy'          THEN '/privacy'
    WHEN p_entity_id = 'cookies'          AND p_slug = 'cookies'          THEN '/cookies'
    WHEN p_entity_id = 'shipping-returns' AND p_slug = 'shipping-returns' THEN '/support/shipping-returns'
    ELSE '/legal/' || p_slug
  END
$$;

-- Atomic publish (p_rollback_to NULL) or rollback of a policy, with slug-change redirects.
-- The generic cms_publish/cms_rollback are called WITHOUT a path prefix (a policy's path is not
-- "prefix/slug"), then this function maintains content_redirects using content_policy_path():
--   * the new live path is never a redirect source (no loops),
--   * the previous live path redirects (301) to the new path,
--   * every earlier path of this policy is flattened to point straight at the new path.
-- One statement = one transaction: a failure leaves neither a half-published policy nor a
-- missing redirect.
CREATE OR REPLACE FUNCTION content_policy_go_live(
  p_id TEXT, p_expected_revision INTEGER, p_actor TEXT, p_rollback_to INTEGER DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_r        JSONB;
  v_new      TEXT;
  v_old      TEXT;
  v_new_path TEXT;
  v_old_path TEXT;
  v_redirect BOOLEAN := FALSE;
BEGIN
  IF p_rollback_to IS NULL THEN
    v_r := cms_publish('policy', p_id, p_expected_revision, p_actor, NULL);
  ELSE
    v_r := cms_rollback('policy', p_id, p_rollback_to, p_expected_revision, p_actor, NULL);
  END IF;

  v_new := v_r->>'slug';
  IF v_new IS NULL OR v_new = '' THEN RAISE EXCEPTION 'CMS_INVALID|SLUG_REQUIRED'; END IF;
  v_new_path := content_policy_path(p_id, v_new);
  DELETE FROM content_redirects WHERE from_path = v_new_path;

  v_old := NULLIF(v_r->>'previous_slug', '');
  IF v_old IS NOT NULL AND v_old <> v_new THEN
    v_old_path := content_policy_path(p_id, v_old);
    IF v_old_path <> v_new_path THEN
      INSERT INTO content_redirects (from_path, to_path, status_code, entity_type, entity_id, created_by)
      VALUES (v_old_path, v_new_path, 301, 'policy', p_id, p_actor)
      ON CONFLICT (from_path) DO UPDATE
        SET to_path = EXCLUDED.to_path, entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id;
      v_redirect := TRUE;
    END IF;
  END IF;

  UPDATE content_redirects SET to_path = v_new_path
   WHERE entity_type = 'policy' AND entity_id = p_id AND to_path <> v_new_path;

  RETURN v_r || jsonb_build_object('path', v_new_path, 'previous_path', v_old_path, 'redirect_created', v_redirect);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- COLLECTIONS (basic editor, no versions): atomic save / product assignment / archive.
-- Optimistic concurrency uses a "version" = updated_at in epoch milliseconds: a save must
-- present the version it loaded; any intervening change (including a product assignment, which
-- bumps updated_at) makes it fail with CMS_STALE_REVISION instead of overwriting.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION content_collection_version(p_ts TIMESTAMPTZ) RETURNS BIGINT
LANGUAGE sql IMMUTABLE AS $$ SELECT (EXTRACT(EPOCH FROM date_trunc('milliseconds', p_ts)) * 1000)::bigint $$;

CREATE OR REPLACE FUNCTION content_collection_save(
  p_id UUID, p_expected_version BIGINT, p_slug TEXT, p_name TEXT, p_description TEXT,
  p_hero UUID, p_is_active BOOLEAN, p_sort INTEGER, p_seo JSONB, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_old   collections%ROWTYPE;
  v_new   collections%ROWTYPE;
  v_redirect BOOLEAN := FALSE;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'CMS_INVALID|NAME'; END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN RAISE EXCEPTION 'CMS_INVALID|SLUG'; END IF;
  IF p_hero IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets WHERE id = p_hero AND status = 'active') THEN
    RAISE EXCEPTION 'CMS_INVALID|HERO_MEDIA';
  END IF;

  IF p_id IS NULL THEN
    BEGIN
      INSERT INTO collections (slug, name, description, hero_media_id, is_active, sort_order, seo, created_by)
      VALUES (p_slug, btrim(p_name), p_description, p_hero, COALESCE(p_is_active, TRUE), COALESCE(p_sort, 0), COALESCE(p_seo, '{}'::jsonb), p_actor)
      RETURNING * INTO v_new;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'CMS_SLUG_TAKEN|collection|%', p_slug;
    END;
    DELETE FROM content_redirects WHERE from_path = '/collections/' || v_new.slug;
    PERFORM cms_audit(p_actor, 'collection.create', 'collection', v_new.id::text, jsonb_build_object('slug', v_new.slug));
    RETURN jsonb_build_object('id', v_new.id, 'slug', v_new.slug, 'previous_slug', NULL, 'redirect_created', FALSE,
                              'version', content_collection_version(v_new.updated_at), 'created', TRUE);
  END IF;

  SELECT * INTO v_old FROM collections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|collection|%', p_id; END IF;
  IF v_old.archived_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_ARCHIVED|collection|%', p_id; END IF;
  IF p_expected_version IS DISTINCT FROM content_collection_version(v_old.updated_at) THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|collection|%', p_id;
  END IF;

  BEGIN
    UPDATE collections
       SET slug = p_slug, name = btrim(p_name), description = p_description, hero_media_id = p_hero,
           is_active = COALESCE(p_is_active, is_active), sort_order = COALESCE(p_sort, sort_order),
           seo = COALESCE(p_seo, seo)
     WHERE id = p_id
     RETURNING * INTO v_new;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'CMS_SLUG_TAKEN|collection|%', p_slug;
  END;

  IF v_old.slug <> v_new.slug THEN
    -- the new live path is never a redirect source; the old path redirects (301) to it;
    -- every earlier slug of this collection is flattened to the new path.
    DELETE FROM content_redirects WHERE from_path = '/collections/' || v_new.slug;
    INSERT INTO content_redirects (from_path, to_path, status_code, entity_type, entity_id, created_by)
    VALUES ('/collections/' || v_old.slug, '/collections/' || v_new.slug, 301, 'collection', p_id::text, p_actor)
    ON CONFLICT (from_path) DO UPDATE
      SET to_path = EXCLUDED.to_path, entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id;
    UPDATE content_redirects SET to_path = '/collections/' || v_new.slug
     WHERE entity_type = 'collection' AND entity_id = p_id::text AND to_path <> '/collections/' || v_new.slug;
    v_redirect := TRUE;
  END IF;

  PERFORM cms_audit(p_actor, 'collection.update', 'collection', p_id::text,
    jsonb_build_object('slug', v_new.slug, 'previous_slug', v_old.slug, 'is_active', v_new.is_active,
                       'redirect_created', v_redirect));
  RETURN jsonb_build_object('id', p_id, 'slug', v_new.slug, 'previous_slug', v_old.slug, 'redirect_created', v_redirect,
                            'version', content_collection_version(v_new.updated_at), 'created', FALSE);
END $$;

-- Replace the ordered product list of a collection in one transaction. Only existing products
-- are referenced (collection_products never copies product data). Order = array order.
CREATE OR REPLACE FUNCTION content_collection_set_products(
  p_id UUID, p_expected_version BIGINT, p_product_ids UUID[], p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_c collections%ROWTYPE; v_missing INTEGER; v_n INTEGER;
BEGIN
  SELECT * INTO v_c FROM collections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|collection|%', p_id; END IF;
  IF v_c.archived_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_ARCHIVED|collection|%', p_id; END IF;
  IF p_expected_version IS DISTINCT FROM content_collection_version(v_c.updated_at) THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|collection|%', p_id;
  END IF;
  p_product_ids := COALESCE(p_product_ids, ARRAY[]::uuid[]);
  IF (SELECT COUNT(DISTINCT x) FROM UNNEST(p_product_ids) x) <> COALESCE(array_length(p_product_ids, 1), 0) THEN
    RAISE EXCEPTION 'CMS_INVALID|DUPLICATE_PRODUCT';
  END IF;
  SELECT COUNT(*) INTO v_missing FROM UNNEST(p_product_ids) x WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = x);
  IF v_missing > 0 THEN RAISE EXCEPTION 'CMS_INVALID|UNKNOWN_PRODUCT'; END IF;

  DELETE FROM collection_products WHERE collection_id = p_id;
  INSERT INTO collection_products (collection_id, product_id, position)
  SELECT p_id, x.pid, (x.ord - 1)::int FROM UNNEST(p_product_ids) WITH ORDINALITY AS x(pid, ord);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE collections SET updated_at = clock_timestamp() WHERE id = p_id RETURNING * INTO v_c;
  PERFORM cms_audit(p_actor, 'collection.products', 'collection', p_id::text, jsonb_build_object('count', v_n));
  RETURN jsonb_build_object('version', content_collection_version(v_c.updated_at), 'count', v_n);
END $$;

-- Archive (hide + stop serving) or restore. Restore never re-activates by itself.
CREATE OR REPLACE FUNCTION content_collection_archive(
  p_id UUID, p_expected_version BIGINT, p_archive BOOLEAN, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_c collections%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM collections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|collection|%', p_id; END IF;
  IF p_expected_version IS DISTINCT FROM content_collection_version(v_c.updated_at) THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|collection|%', p_id;
  END IF;
  IF p_archive THEN
    UPDATE collections SET archived_at = NOW(), is_active = FALSE WHERE id = p_id RETURNING * INTO v_c;
  ELSE
    UPDATE collections SET archived_at = NULL WHERE id = p_id RETURNING * INTO v_c;
  END IF;
  PERFORM cms_audit(p_actor, CASE WHEN p_archive THEN 'collection.archive' ELSE 'collection.restore' END,
                    'collection', p_id::text, jsonb_build_object('slug', v_c.slug));
  RETURN jsonb_build_object('version', content_collection_version(v_c.updated_at), 'slug', v_c.slug);
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SEEDS (each runs only if its entity does not exist yet)
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;
-- BEGIN GENERATED SEED (lib/content-seed.ts — do not edit by hand)
DO $kvrn_seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'policy' AND entity_id = 'terms') THEN
    PERFORM cms_save_draft('policy', 'terms', $kvrn${"slug":"terms","title":"Terms of Service","heroTitle":"Terms","heroBreadcrumb":"Terms","effectiveDate":"2026-08-12","lastUpdatedLabel":"Last updated","style":"legal","seo":{},"body":{"v":1,"blocks":[{"t":"h2","c":[{"t":"text","text":"Who you are contracting with"}]},{"t":"p","c":[{"t":"text","text":"These terms govern your use of kvrn.shop and any purchase you make from KVRN, operated by Omid Hamidi as a sole proprietor in the United States. By using the site or placing an order, you agree to these terms."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Orders and contract formation"}]},{"t":"p","c":[{"t":"text","text":"Placing an order is an offer to buy. A contract between you and KVRN is formed when we confirm your order by email — not at the point of placing it."}]},{"t":"p","c":[{"t":"text","text":"We reserve the right to cancel any order before dispatch. If we cancel your order, we will refund you in full within 5 business days. We will notify you by email."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Pricing and payment"}]},{"t":"ul","items":[[{"t":"text","text":"All prices are displayed in GBP and include UK VAT at 20%."}],[{"t":"text","text":"International orders may be subject to import duties and taxes payable by you."}],[{"t":"text","text":"We accept payment via Stripe (card, Apple Pay, Google Pay)."}],[{"t":"text","text":"Payment is taken immediately on order confirmation."}],[{"t":"text","text":"If a pricing error occurs, we will notify you and give you the option to reorder at the correct price or cancel."}]]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Delivery"}]},{"t":"p","c":[{"t":"text","text":"Delivery timescales are estimates and not guaranteed. We are not liable for delays caused by customs, weather, carrier issues, or events outside our control."}]},{"t":"p","c":[{"t":"text","text":"Risk of loss passes to you when the carrier accepts the parcel. If your order is lost in transit, contact us and we will investigate with the carrier."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Returns and consumer rights"}]},{"t":"p","c":[{"t":"text","text":"You have the right to cancel your order within 14 days of delivery under the Consumer Contracts Regulations 2013. Our 30-day returns window exceeds this statutory minimum."}]},{"t":"p","c":[{"t":"text","text":"Faulty or incorrectly shipped goods are covered regardless of our returns window. Contact us at "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":" for all warranty and fault claims."}]},{"t":"p","c":[{"t":"text","text":"See our full "},{"t":"link","href":"/support/shipping-returns","text":"Shipping & Returns policy"},{"t":"text","text":"."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Intellectual property"}]},{"t":"p","c":[{"t":"text","text":"All content on this site — including text, photography, design, and brand elements — is owned by or licensed to KVRN. You may not reproduce, distribute, or use any content without our prior written permission."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Limitation of liability"}]},{"t":"p","c":[{"t":"text","text":"To the maximum extent permitted by law, KVRN's liability for any claim arising from your use of this site or any purchase is limited to the value of the goods you purchased. We are not liable for indirect, consequential, or economic losses."}]},{"t":"p","c":[{"t":"text","text":"Nothing in these terms affects your statutory rights as a consumer."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Governing law"}]},{"t":"p","c":[{"t":"text","text":"These terms are governed by the laws of England and Wales. Any disputes will be subject to the exclusive jurisdiction of the courts of England and Wales."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"SMS marketing program"}]},{"t":"p","c":[{"t":"text","text":"By affirmatively opting in to the KVRN SMS program, you agree to receive recurring automated marketing text messages about KVRN product launches, drops, restocks, early access, and promotional offers at the mobile number you provide."}]},{"t":"p","c":[{"t":"text","text":"Message frequency varies. Msg & data rates may apply. Consent to receive marketing text messages is not a condition of purchasing goods or services from KVRN."}]},{"t":"p","c":[{"t":"text","text":"Reply STOP at any time to cancel. Reply HELP for help or contact "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":"."}]},{"t":"p","c":[{"t":"text","text":"Mobile carriers are not responsible for delayed or undelivered messages. See our "},{"t":"link","href":"/privacy","text":"Privacy Policy"},{"t":"text","text":" for information about how we handle mobile information."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Contact"}]},{"t":"p","c":[{"t":"text","text":"For any queries relating to these terms, contact us at "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":"."}]}]}}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('policy', 'terms', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'policy' AND entity_id = 'privacy') THEN
    PERFORM cms_save_draft('policy', 'privacy', $kvrn${"slug":"privacy","title":"Privacy Policy","heroTitle":"Privacy Policy","heroBreadcrumb":"Privacy Policy","effectiveDate":"2026-08-12","lastUpdatedLabel":"Last updated","style":"legal","seo":{"description":"How KVRN collects, uses, and protects your personal data."},"body":{"v":1,"blocks":[{"t":"h2","c":[{"t":"text","text":"Who we are"}]},{"t":"p","c":[{"t":"text","text":"KVRN is operated by Omid Hamidi as a sole proprietor in the United States. We are responsible for the personal information we collect through kvrn.shop and the KVRN SMS program."}]},{"t":"p","c":[{"t":"text","text":"For questions about this policy, contact us at "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":"."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"What data we collect and why"}]},{"t":"defs","items":[{"title":"Name, email address, shipping address","lines":["To process and fulfil your order.","Contract — processing is necessary to deliver what you ordered."]},{"title":"Payment details (card number, CVV)","lines":["To take payment.","Contract — processed and tokenised by Stripe. We never see or store your card number."]},{"title":"Phone number (optional)","lines":["To send shipping notifications or drop alerts by SMS, if you opt in.","Consent — you can opt out at any time by replying STOP."]},{"title":"Email address (waitlist)","lines":["To notify you when new drops go live.","Consent — you can unsubscribe at any time via any email we send."]},{"title":"IP address, device type, browser, pages visited","lines":["To understand how our site is used (via Google Analytics 4 and Microsoft Clarity).","Consent — only collected if you accept analytics cookies."]},{"title":"IP address (fraud signals)","lines":["To detect and prevent fraudulent orders.","Legitimate interest — protecting our business and genuine customers."]}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Who we share data with"}]},{"t":"p","c":[{"t":"text","text":"We never sell your personal data. We share it only with the services required to operate:"}]},{"t":"table","label":"Service providers","headers":[],"rows":[[[{"t":"text","text":"Stripe"}],[{"t":"text","text":"Payment processing (PCI DSS Level 1 certified)"}]],[[{"t":"text","text":"Shipping partner"}],[{"t":"text","text":"Shipping label generation and order tracking"}]],[[{"t":"text","text":"Email service"}],[{"t":"text","text":"Transactional email delivery"}]],[[{"t":"text","text":"SMS service"}],[{"t":"text","text":"SMS notifications (opt-in only)"}]],[[{"t":"text","text":"Neon"}],[{"t":"text","text":"Database hosting (encrypted at rest)"}]],[[{"t":"text","text":"Cloudflare"}],[{"t":"text","text":"Hosting, CDN, and security"}]],[[{"t":"text","text":"Google Analytics 4"}],[{"t":"text","text":"Anonymous website analytics (consent-gated)"}]],[[{"t":"text","text":"Microsoft Clarity"}],[{"t":"text","text":"Session recordings (consent-gated)"}]]]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"SMS and mobile information"}]},{"t":"p","c":[{"t":"text","text":"If you opt in to the KVRN SMS program, we may use your mobile number and SMS consent information to send recurring automated marketing text messages about product launches, drops, restocks, early access, and promotional offers."}]},{"t":"p","c":[{"t":"text","text":"Message frequency varies. Msg & data rates may apply. Reply STOP to cancel or HELP for help. Consent to receive marketing text messages is not a condition of purchase."}]},{"t":"p","c":[{"t":"text","text":"We do not sell or share mobile phone numbers, SMS opt-in data, or SMS consent information with third parties or affiliates for their marketing or promotional purposes. Mobile information may be provided to service providers only as necessary to operate and deliver the KVRN SMS program."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"How long we keep data"}]},{"t":"ul","items":[[{"t":"text","text":"Order data: 7 years (required by HMRC for tax purposes)"}],[{"t":"text","text":"Marketing preferences (email/SMS consent): Until you withdraw consent"}],[{"t":"text","text":"Analytics data: 14 months (Google Analytics default)"}],[{"t":"text","text":"Session recordings: 30 days (Microsoft Clarity default)"}]]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Your rights"}]},{"t":"p","c":[{"t":"text","text":"Under UK GDPR, you have the right to:"}]},{"t":"ul","items":[[{"t":"text","text":"Access the personal data we hold about you"}],[{"t":"text","text":"Correct inaccurate data"}],[{"t":"text","text":"Request erasure of your data (subject to legal retention obligations)"}],[{"t":"text","text":"Restrict or object to how we process your data"}],[{"t":"text","text":"Data portability — receive your data in a structured format"}],[{"t":"text","text":"Withdraw consent at any time (for consent-based processing)"}]]},{"t":"p","c":[{"t":"text","text":"To exercise any of these rights, email "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":". We will respond within 30 days. If you are unhappy with our response, you may contact the ICO: "},{"t":"link","href":"https://ico.org.uk","text":"ico.org.uk"},{"t":"text","text":"."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Cookies"}]},{"t":"p","c":[{"t":"text","text":"We use essential cookies (required for the site to function) and optional analytics cookies (only with your consent). See our "},{"t":"link","href":"/cookies","text":"Cookie Policy"},{"t":"text","text":" for full details."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Changes to this policy"}]},{"t":"p","c":[{"t":"text","text":"We may update this policy. We will notify customers of material changes by email. The “Last updated” date at the top of this page reflects the most recent revision."}]}]}}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('policy', 'privacy', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'policy' AND entity_id = 'cookies') THEN
    PERFORM cms_save_draft('policy', 'cookies', $kvrn${"slug":"cookies","title":"Cookie Policy","heroTitle":"Cookie Policy","heroBreadcrumb":"Cookies","effectiveDate":"2025-01-01","lastUpdatedLabel":"Last updated","style":"legal","seo":{},"body":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"This policy explains what cookies are, what we use them for, and how to control them. Under PECR (Privacy and Electronic Communications Regulations), we need your consent before placing non-essential cookies on your device."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Essential cookies"}]},{"t":"p","c":[{"t":"text","text":"Required for the site to function. Cannot be opted out of."}]},{"t":"table","label":"Essential cookies","headers":["Cookie","Purpose","Expires"],"mono":true,"rows":[[[{"t":"text","text":"kvrn_cart"}],[{"t":"text","text":"Stores your shopping bag contents"}],[{"t":"text","text":"30 days"}]],[[{"t":"text","text":"kvrn_cookie_consent"}],[{"t":"text","text":"Remembers your cookie preferences"}],[{"t":"text","text":"1 year"}]]]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Analytics cookies (optional)"}]},{"t":"p","c":[{"t":"text","text":"Only set if you accept. Used to understand how visitors use our site."}]},{"t":"table","label":"Analytics cookies","headers":["Cookie","Provider","Purpose","Expires"],"mono":true,"rows":[[[{"t":"text","text":"_ga, _ga_*"}],[{"t":"text","text":"Google Analytics 4"}],[{"t":"text","text":"Distinguishes users and sessions"}],[{"t":"text","text":"2 years"}]],[[{"t":"text","text":"_clck, _clsk"}],[{"t":"text","text":"Microsoft Clarity"}],[{"t":"text","text":"Session recordings"}],[{"t":"text","text":"1 year / 1 day"}]]]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Advertising cookies"}]},{"t":"p","c":[{"t":"text","text":"We do not use advertising or tracking cookies. KVRN does not run paid advertising."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Manage your preferences"}]},{"t":"embed","kind":"cookie-controls"},{"t":"hr"},{"t":"p","c":[{"t":"text","text":"For more information, see our "},{"t":"link","href":"/privacy","text":"Privacy Policy"},{"t":"text","text":". Questions? Email "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":"."}]}]}}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('policy', 'cookies', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'policy' AND entity_id = 'shipping-returns') THEN
    PERFORM cms_save_draft('policy', 'shipping-returns', $kvrn${"slug":"shipping-returns","title":"Shipping & Returns","heroTitle":"Shipping & Returns","heroBreadcrumb":"Shipping & Returns","effectiveDate":null,"style":"support","seo":{"description":"KVRN shipping and returns policy. Store credit returns. Orders ship within 1–3 business days."},"body":{"v":1,"blocks":[{"t":"h2","c":[{"t":"text","text":"Shipping"}]},{"t":"p","c":[{"t":"text","text":"Orders are processed within approximately "},{"t":"text","text":"1–3 business days","b":true},{"t":"text","text":" of payment confirmation. Products are not available for preorder unless explicitly stated on the product page."}]},{"t":"p","c":[{"t":"text","text":"Shipping costs depend on your destination and the shipping method selected at checkout. Actual costs are calculated at checkout before payment."}]},{"t":"cards","items":[{"label":"Domestic","text":"2–7 business days (approx.)"},{"label":"International","text":"5–14+ business days (approx.)"}]},{"t":"p","c":[{"t":"text","text":"Delivery estimates are not guarantees. Carrier delays and customs processing can affect timelines."}]},{"t":"p","c":[{"t":"text","text":"All orders include tracking. You will receive a shipping confirmation with tracking information when your order dispatches."}]},{"t":"hr"},{"t":"h2","c":[{"t":"text","text":"Returns"}]},{"t":"p","c":[{"t":"text","text":"We accept returns for "},{"t":"text","text":"store credit","b":true},{"t":"text","text":" on eligible items within our return window."}]},{"t":"callout","title":"Why store credit?","paras":[[{"t":"text","text":"Store credit allows us to continue investing in product quality. You retain full value to use on any future order."}]]},{"t":"p","c":[{"t":"text","text":"To be eligible for return, items must be:"}]},{"t":"ul","items":[[{"t":"text","text":"Unworn and unwashed"}],[{"t":"text","text":"In original condition with tags attached"}],[{"t":"text","text":"Returned within 14 days of delivery"}]]},{"t":"p","c":[{"t":"text","text":"Customer is responsible for return shipping costs unless the item arrives damaged, faulty, or incorrect."}]},{"t":"p","c":[{"t":"text","text":"Final sale items are not eligible for return."}]},{"t":"p","c":[{"t":"text","text":"To initiate a return, email "},{"t":"link","href":"mailto:returns@kvrn.shop","text":"returns@kvrn.shop"},{"t":"text","text":" with your order number."}]},{"t":"p","c":[{"t":"text","text":"Questions?","b":true}]},{"t":"p","c":[{"t":"text","text":"Email "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":" we respond within 1–2 business days."}]}]}}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('policy', 'shipping-returns', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'size_guide' AND entity_id = 'kvrn-hoodie') THEN
    PERFORM cms_save_draft('size_guide', 'kvrn-hoodie', $kvrn${"name":"Hoodie","garment":"Hoodie","shopLink":{"label":"Shop Hoodies","href":"/shop?type=hoodies"},"unit":"cm","rowHeader":"Size","columns":[{"id":"length","label":"Length"},{"id":"chest","label":"Chest"},{"id":"shoulder","label":"Shoulder"},{"id":"sleeve","label":"Sleeve"}],"rows":[{"id":"r1","label":"XS","values":{"length":"62","chest":"62","shoulder":"64","sleeve":"52"}},{"id":"r2","label":"S","values":{"length":"65","chest":"65","shoulder":"67","sleeve":"55"}},{"id":"r3","label":"M","values":{"length":"68","chest":"68","shoulder":"70","sleeve":"58"}},{"id":"r4","label":"L","values":{"length":"70.5","chest":"70.5","shoulder":"72.5","sleeve":"60.5"}},{"id":"r5","label":"XL","values":{"length":"73","chest":"73","shoulder":"75","sleeve":"63"}},{"id":"r6","label":"2XL","values":{"length":"75.5","chest":"75.5","shoulder":"77.5","sleeve":"65.5"}},{"id":"r7","label":"3XL","values":{"length":"78","chest":"78","shoulder":"80","sleeve":"68"}}],"notes":["Chest measured flat across the chest under the arms.","Length from highest point of shoulder to hem."],"fit":{"v":1,"blocks":[]},"showOnGuidePage":true,"order":1}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('size_guide', 'kvrn-hoodie', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'size_guide' AND entity_id = 'kvrn-sweatpants') THEN
    PERFORM cms_save_draft('size_guide', 'kvrn-sweatpants', $kvrn${"name":"Sweatpants","garment":"Sweatpants","shopLink":{"label":"Shop Sweatpants","href":"/shop?type=sweatpants"},"unit":"cm","rowHeader":"Size","columns":[{"id":"waist","label":"Waist"},{"id":"hip","label":"Hip"},{"id":"length","label":"Length"}],"rows":[{"id":"r1","label":"XS","values":{"waist":"66","hip":"112","length":"97"}},{"id":"r2","label":"S","values":{"waist":"70","hip":"114","length":"99"}},{"id":"r3","label":"M","values":{"waist":"74","hip":"116","length":"101"}},{"id":"r4","label":"L","values":{"waist":"78","hip":"118","length":"103"}},{"id":"r5","label":"XL","values":{"waist":"82","hip":"120","length":"105"}},{"id":"r6","label":"2XL","values":{"waist":"86","hip":"122","length":"107"}},{"id":"r7","label":"3XL","values":{"waist":"90","hip":"124","length":"109"}}],"notes":["Waist measured flat across the waistband.","Length measured from waistband to hem."],"fit":{"v":1,"blocks":[]},"showOnGuidePage":true,"order":2}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('size_guide', 'kvrn-sweatpants', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'faq' AND entity_id = 'main') THEN
    PERFORM cms_save_draft('faq', 'main', $kvrn${"heroTitle":"FAQ","footerTitle":"Still have a question?","footerBody":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"Email "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":" and we will get back to you within 1 to 2 business days."}]}]},"seo":{"description":"Frequently asked questions about KVRN products, sizing, shipping and returns."},"categories":[{"id":"products","heading":"Products","active":true,"items":[{"id":"gsm","question":"What does GSM mean?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"GSM stands for grams per square metre. It measures how dense and heavy a fabric is. The higher the number, the heavier the material."}]},{"t":"p","c":[{"t":"text","text":"Most hoodies on the market sit around 280 to 320 GSM. At that weight the fabric feels light. At 400 GSM and above the structure changes noticeably — the garment holds its shape, drapes differently, and has real weight when you hold it."}]},{"t":"p","c":[{"t":"text","text":"Full material specifications are listed on each product page."}]}]}},{"id":"no-drawstring","question":"Why is there no drawstring on the hoodie?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"The Heavyweight hood is structured across three panels so it holds its shape on its own. A drawstring is usually needed because the hood collapses without it. The construction here eliminates that problem. There is nothing to pull, nothing to lose, and nothing to interrupt the silhouette."}]}]}},{"id":"zippers","question":"How do the hidden interior pockets work?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"The kangaroo pocket has two concealed zippers running inside it, one on each side. From the outside they are invisible. Open the zip and you access a secure interior compartment. They work in all positions and stay closed without looking closed."}]}]}},{"id":"project-kvrn","question":"What is the Project KVRN collection?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"The Project KVRN collection uses a 500 GSM French terry blend rather than the brushed fleece of the Heavyweight collection. Both are heavy. The difference is in the construction and the proportion."}]},{"t":"p","c":[{"t":"text","text":"Project KVRN pieces are enzyme washed and pre-shrunk before shipping, so they arrive with immediate softness and a more relaxed hand feel. They are also cut with a cropped, oversized proportion rather than a longer oversized one."}]}]}},{"id":"care","question":"How do I care for the garments?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"Machine wash cold, inside out, gentle cycle. Air dry. Do not tumble dry on high heat."}]},{"t":"p","c":[{"t":"text","text":"The fleece will continue to soften over the first few washes. This is normal and expected. The structure of the hood and the zippers are not affected by regular washing."}]}]}}]},{"id":"sizing","heading":"Sizing","active":true,"items":[{"id":"fit","question":"How does KVRN fit?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"KVRN is designed to be oversized. The proportions are intentional, not incidental. If you want the intended silhouette, order your usual size. If you want a slightly cleaner look, size down by one."}]},{"t":"p","c":[{"t":"link","href":"/support/size-guide","text":"View the size guide"}]}]}},{"id":"measurements","question":"Where can I find measurements?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"The size guide has full measurements for both the hoodie and sweatpants, in centimetres and inches."}]},{"t":"p","c":[{"t":"link","href":"/support/size-guide","text":"Open size guide"}]}]}}]},{"id":"shipping","heading":"Shipping","active":true,"items":[{"id":"processing","question":"How long does processing take?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"Orders are processed within approximately 1 to 3 business days of payment. Products are in stock and ship promptly unless a product page states otherwise."}]}]}},{"id":"delivery","question":"How long does delivery take?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"Domestic orders typically arrive within 2 to 7 business days after dispatch. International orders typically take 5 to 14 business days or more, depending on the destination and customs."}]},{"t":"p","c":[{"t":"text","text":"Delivery estimates are not guarantees. All orders include tracking, sent when your order dispatches."}]}]}},{"id":"free-shipping","question":"Is there free shipping?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"Complimentary shipping is available on U.S. orders over $150. Shipping costs for all other orders are calculated at checkout based on destination and method selected."}]}]}},{"id":"tracking","question":"How do I track my order?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"You will receive a tracking number by email once your order ships. You can also use the track order page."}]},{"t":"p","c":[{"t":"link","href":"/support/track","text":"Track your order"}]}]}}]},{"id":"returns","heading":"Returns","active":true,"items":[{"id":"returns","question":"What is the returns policy?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"We accept returns for store credit on unworn, unwashed items with tags still attached, within our return window. The return window is shown in your order confirmation."}]},{"t":"p","c":[{"t":"text","text":"Customer covers return shipping unless the item arrives damaged, faulty, or incorrect."}]},{"t":"p","c":[{"t":"link","href":"/support/shipping-returns#returns","text":"Full returns policy"}]}]}},{"id":"initiate-return","question":"How do I start a return?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"Email "},{"t":"link","href":"mailto:returns@kvrn.shop","text":"returns@kvrn.shop"},{"t":"text","text":" with your order number and the items you would like to return. We will respond within 24 hours with next steps."}]}]}},{"id":"wrong-item","question":"What if my order arrived wrong or damaged?","active":true,"answer":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"Email "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":" with your order number and photos. If the item is faulty, incorrect, or damaged on arrival, we will cover the return shipping and resolve it at no cost to you."}]}]}}]}]}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('faq', 'main', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'support_page' AND entity_id = 'size-guide') THEN
    PERFORM cms_save_draft('support_page', 'size-guide', $kvrn${"heroTitle":"Size Guide","intro":"All measurements refer to the garment, not body size. KVRN is designed oversized. Order your usual size for the intended silhouette. Size down if you prefer a slightly closer fit.","tip":{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"If you are between sizes, we recommend sizing down for a cleaner oversized fit. Questions about fit can be sent to "},{"t":"link","href":"mailto:support@kvrn.shop","text":"support@kvrn.shop"},{"t":"text","text":"."}]}]},"links":[{"id":"hoodies","label":"Shop Hoodies","href":"/shop?type=hoodies"},{"id":"sweatpants","label":"Shop Sweatpants","href":"/shop?type=sweatpants"}],"seo":{}}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('support_page', 'size-guide', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'about' AND entity_id = 'main') THEN
    PERFORM cms_save_draft('about', 'main', $kvrn${"heroTitle":"About","brandEyebrow":"The brand","lead":"KVRN is built around weight, structure, and restraint.","brandParagraphs":["Every piece starts from the fabric — not from a trend. We work with fleece heavy enough to hold its shape, cut to proportions that make sense without needing to be adjusted.","There is no branding on the outside. No drawstrings to pull. No visible hardware unless it serves a purpose. The goal is a garment you stop thinking about because it works."],"approachEyebrow":"The approach","approach":[{"id":"weight","title":"Weight","description":"Dense enough to feel structural. GSM is a starting point, not a selling point."},{"id":"construction","title":"Construction","description":"Every detail serves a purpose. What you see is what it does."},{"id":"longevity","title":"Longevity","description":"Built to be worn daily without showing it. No decoration that fades."},{"id":"restraint","title":"Restraint","description":"Nothing added that should not be there."}],"ctaLabel":"Shop the collection","ctaHref":"/shop","seo":{"description":"KVRN is built around weight, structure, and restraint. Quiet garments designed for daily wear."}}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('about', 'main', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'contact' AND entity_id = 'main') THEN
    PERFORM cms_save_draft('contact', 'main', $kvrn${"heroTitle":"Contact","intro":"","successTitle":"Message sent.","successBody":"We will respond within 1–2 business days.","supportHours":"","helpNote":"","seo":{}}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('contact', 'main', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'announcement' AND entity_id = 'main') THEN
    PERFORM cms_save_draft('announcement', 'main', $kvrn${"enabled":true,"messages":[{"id":"m1","text":"Complimentary U.S. shipping on orders over $150"},{"id":"m2","text":"New arrivals available now"},{"id":"m3","text":"Join the list for $10 off your first order"}],"startsAt":null,"endsAt":null}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('announcement', 'main', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'navigation' AND entity_id = 'main') THEN
    PERFORM cms_save_draft('navigation', 'main', $kvrn${"desktop":[{"id":"d-shop-all","label":"Shop All","href":"/shop","i18nKey":"shopAll","i18nEn":"Shop All"},{"id":"d-hoodies","label":"Hoodies","href":"/shop?type=hoodies","i18nKey":"hoodies","i18nEn":"Hoodies"},{"id":"d-sweatpants","label":"Sweatpants","href":"/shop?type=sweatpants","i18nKey":"sweatpants","i18nEn":"Sweatpants"},{"id":"d-track","label":"Track Order","href":"/support/track","i18nKey":"trackOrder","i18nEn":"Track Order"},{"id":"d-about","label":"About","href":"/about","i18nKey":"about","i18nEn":"About"},{"id":"d-contact","label":"Contact","href":"/contact","i18nKey":"contact","i18nEn":"Contact"}],"mobile":[{"id":"m-shop-all","label":"Shop All","href":"/shop","i18nKey":"shopAll","i18nEn":"Shop All"},{"id":"m-hoodies","label":"Hoodies","href":"/shop?type=hoodies","i18nKey":"hoodies","i18nEn":"Hoodies"},{"id":"m-sweatpants","label":"Sweatpants","href":"/shop?type=sweatpants","i18nKey":"sweatpants","i18nEn":"Sweatpants"},{"id":"m-about","label":"About","href":"/about","i18nKey":"about","i18nEn":"About"},{"id":"m-size-guide","label":"Size Guide","href":"/support/size-guide","i18nKey":"sizeGuide","i18nEn":"Size Guide"},{"id":"m-track","label":"Track Order","href":"/support/track","i18nKey":"trackOrder","i18nEn":"Track Order"},{"id":"m-faq","label":"FAQ","href":"/support/faq","i18nKey":"faq","i18nEn":"FAQ"},{"id":"m-shipping","label":"Shipping & Returns","href":"/support/shipping-returns","i18nKey":"shippingReturns","i18nEn":"Shipping & Returns"},{"id":"m-contact","label":"Contact","href":"/contact","i18nKey":"contact","i18nEn":"Contact"}]}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('navigation', 'main', 1, 'seed@kvrn.internal', NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = 'footer' AND entity_id = 'main') THEN
    PERFORM cms_save_draft('footer', 'main', $kvrn${"brandName":"KVRN","taglines":["Quiet garments.","Built with intention."],"groups":[{"id":"shop","heading":"Shop","i18nKey":"shop","i18nEn":"Shop","links":[{"id":"f-shop-all","label":"Shop All","href":"/shop"},{"id":"f-hoodies","label":"Hoodies","href":"/shop?type=hoodies"},{"id":"f-sweatpants","label":"Sweatpants","href":"/shop?type=sweatpants"}]},{"id":"support","heading":"Support","i18nKey":"support","i18nEn":"Support","links":[{"id":"f-shipping","label":"Shipping & Returns","href":"/support/shipping-returns"},{"id":"f-track","label":"Track Order","href":"/support/track"},{"id":"f-contact","label":"Contact","href":"/contact"}]},{"id":"legal","heading":"Legal","i18nKey":"legal","i18nEn":"Legal","links":[{"id":"f-privacy","label":"Privacy","href":"/privacy"},{"id":"f-terms","label":"Terms","href":"/terms"},{"id":"f-cookies","label":"Cookies","href":"/cookies"}]}],"social":[{"id":"instagram","platform":"instagram","label":"KVRN on Instagram","href":"https://instagram.com/thekvrn"},{"id":"tiktok","platform":"tiktok","label":"KVRN on TikTok","href":"https://tiktok.com/@thekvrn"}],"copyrightHolder":"KVRN","copyrightSuffix":""}$kvrn$::jsonb, 0, 'seed@kvrn.internal', 'Seeded from the coded storefront content');
    PERFORM cms_publish('footer', 'main', 1, 'seed@kvrn.internal', NULL);
  END IF;
  DELETE FROM admin_audit_logs WHERE actor_email = 'seed@kvrn.internal';
  INSERT INTO collections (slug, name, description, is_active, sort_order, seo, created_by)
  VALUES ('project-kvrn', 'Project KVRN', 'Shop the Project KVRN collection. 500 GSM French terry, enzyme washed, pre-shrunk.', TRUE, 1,
          $kvrn${"title":"Project KVRN — Available Now","description":"Shop the Project KVRN collection. 500 GSM French terry, enzyme washed, pre-shrunk."}$kvrn$::jsonb, 'seed@kvrn.internal')
  ON CONFLICT (slug) DO NOTHING;
  INSERT INTO collection_products (collection_id, product_id, position)
  SELECT c.id, p.id, ROW_NUMBER() OVER (ORDER BY p.product_code)::int
    FROM collections c JOIN products p ON p.product_code IN ('PKHH', 'PKHSP')
   WHERE c.slug = 'project-kvrn'
     AND NOT EXISTS (SELECT 1 FROM collection_products cp WHERE cp.collection_id = c.id)
  ON CONFLICT DO NOTHING;
END
$kvrn_seed$;
-- END GENERATED SEED
COMMIT;
