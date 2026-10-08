-- KVRN Migration 029 — Bundles ("Complete the Set"): publish-time projection, bundle-aware
-- reservation, and order accounting snapshots.
--
-- Additive only. Nothing in 001–028 is altered, dropped or replaced. Every function created here is
-- NEW (reserve_inventory_v2, bundle_*); reserve_inventory(), finalize_paid_order() and every other
-- existing function are untouched. Idempotent: IF NOT EXISTS / CREATE OR REPLACE of THIS migration's
-- own objects / guarded DO blocks. Safe to re-run. NOT applied to production by the implementation batch.
-- Requires 001–028 (content_entities / content_versions / cms_audit from 027, products and the
-- reservation / order tables from 002).
--
-- DESIGN (read before changing)
-- -----------------------------
-- * SINGLE SOURCE OF TRUTH. The editable bundle definition lives in the product CMS snapshot
--   (content_versions.snapshot->'bundle': draft / publish / rollback / history for free). The tables
--   `bundles` + `bundle_components` are a PUBLISH-TIME PROJECTION of the published version, written in
--   the same transaction as the publish by trigger zz_bundle_entity_sync_trg (it sorts after 028's
--   catalog_entity_sync_trg, so products.price_cents is already applied when it runs). Checkout and
--   the storefront read only the projection: a draft can never reach a customer, and the editor and
--   the checkout can never hold two different definitions.
-- * One definition per product (UNIQUE owner_product_id). A product may be a component of many
--   bundles. A product cannot offer a set that includes a product whose own set includes it back
--   (BUNDLE_CONFLICT): that would be two definitions of the same set. Self-inclusion as a component is
--   rejected (the owner is included with include_owner instead).
-- * Pricing rule = bundles.pricing_mode / pricing_value (cents, or basis points for percent). The
--   per-line allocation is computed by the server (lib/bundle-pricing.ts) and RE-VALIDATED here in
--   reserve_inventory_v2: per-line 0 <= allocated unit price <= canonical price, and the total
--   discount must equal the configured rule EXACTLY. A bundle is only ever sold if the rule is
--   still valid at the current canonical prices (fail closed).
-- * Inventory is never duplicated: no bundle stock row exists. A bundle reservation is an ordinary
--   reservation of its real component SKUs (same row locks, same order, same availability rule, same
--   error codes as reserve_inventory). order_items therefore carry the ALLOCATED NET unit price, so
--   refund / return / dispute / affiliate / revenue math (which reads order_items) is unchanged.
-- * Accounting snapshots: reservation_bundles / reservation_bundle_items are written inside
--   reserve_inventory_v2; AFTER INSERT triggers on orders and order_items copy them into the
--   immutable order_bundles / order_bundle_items when finalize_paid_order creates the order, WITHOUT
--   modifying finalize_paid_order. A snapshot failure never blocks a paid order (the order_items
--   money is already correct); bundle_snapshot_gaps() lists any order that lacks its snapshot.
--
-- Error vocabulary (reserve_inventory_v2, same KVRN_RESERVATION|CODE|detail format as v1, plus):
--   BUNDLE_UNAVAILABLE | BUNDLE_SELECTION_INVALID | BUNDLE_PRICE_MISMATCH | BUNDLE_QUANTITY
-- Publish blockers (BUNDLE_BLOCKED|<json array>): see bundle_blockers().

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Publish-time projection
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bundles (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_product_id   UUID        NOT NULL REFERENCES products(id),
  enabled            BOOLEAN     NOT NULL DEFAULT FALSE,
  include_owner      BOOLEAN     NOT NULL DEFAULT TRUE,
  pricing_mode       TEXT        NOT NULL,
  pricing_value      INTEGER     NOT NULL,
  presentation       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_version_no  INTEGER,
  revision           INTEGER     NOT NULL DEFAULT 1,
  published_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bundles_owner_uq UNIQUE (owner_product_id),
  CONSTRAINT bundles_mode_chk CHECK (pricing_mode IN ('set_price','fixed_discount','percent_discount')),
  CONSTRAINT bundles_value_chk CHECK (pricing_value >= 0
                                      AND (pricing_mode <> 'percent_discount' OR pricing_value < 10000))
);

CREATE TABLE IF NOT EXISTS bundle_components (
  id                    UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id             UUID    NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  component_product_id  UUID    NOT NULL REFERENCES products(id),
  is_owner              BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_variant_ids   UUID[],
  view_separately       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT bundle_components_uq UNIQUE (bundle_id, component_product_id)
);
CREATE INDEX IF NOT EXISTS idx_bundle_components_product ON bundle_components(component_product_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_bundles_updated_at') THEN
    CREATE TRIGGER set_bundles_updated_at BEFORE UPDATE ON bundles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Reservation + order snapshots
-- ═══════════════════════════════════════════════════════════════════════════
-- Written inside reserve_inventory_v2 (same transaction as the reservation).
CREATE TABLE IF NOT EXISTS reservation_bundles (
  reservation_id            UUID        PRIMARY KEY REFERENCES reservations(id) ON DELETE CASCADE,
  bundle_id                 UUID        NOT NULL,
  owner_product_id          UUID        NOT NULL,
  set_quantity              INTEGER     NOT NULL CHECK (set_quantity BETWEEN 1 AND 10),
  pricing_mode              TEXT        NOT NULL,
  pricing_value             INTEGER     NOT NULL,
  component_subtotal_cents  INTEGER     NOT NULL CHECK (component_subtotal_cents >= 1),
  bundle_discount_cents     INTEGER     NOT NULL CHECK (bundle_discount_cents >= 0),
  bundle_net_cents          INTEGER     NOT NULL CHECK (bundle_net_cents >= 1),
  config                    JSONB       NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reservation_bundles_math_chk
    CHECK (component_subtotal_cents - bundle_discount_cents = bundle_net_cents)
);

CREATE TABLE IF NOT EXISTS reservation_bundle_items (
  reservation_id                UUID    NOT NULL REFERENCES reservation_bundles(reservation_id) ON DELETE CASCADE,
  sku                           TEXT    NOT NULL,
  variant_id                    UUID    NOT NULL,
  product_id                    UUID    NOT NULL,
  quantity                      INTEGER NOT NULL CHECK (quantity >= 1),
  original_unit_price_cents     INTEGER NOT NULL CHECK (original_unit_price_cents >= 1),
  allocated_discount_per_unit_cents INTEGER NOT NULL CHECK (allocated_discount_per_unit_cents >= 0),
  net_unit_price_cents          INTEGER NOT NULL CHECK (net_unit_price_cents >= 0),
  PRIMARY KEY (reservation_id, sku),
  CONSTRAINT reservation_bundle_items_math_chk
    CHECK (original_unit_price_cents - allocated_discount_per_unit_cents = net_unit_price_cents)
);

-- Immutable accounting record, one per order (one bundle per checkout).
CREATE TABLE IF NOT EXISTS order_bundles (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reservation_id            UUID,
  bundle_id                 UUID        NOT NULL,
  owner_product_id          UUID        NOT NULL,
  set_quantity              INTEGER     NOT NULL CHECK (set_quantity >= 1),
  pricing_mode              TEXT        NOT NULL,
  pricing_value             INTEGER     NOT NULL,
  component_subtotal_cents  INTEGER     NOT NULL CHECK (component_subtotal_cents >= 1),
  bundle_discount_cents     INTEGER     NOT NULL CHECK (bundle_discount_cents >= 0),
  bundle_net_cents          INTEGER     NOT NULL CHECK (bundle_net_cents >= 1),
  config                    JSONB       NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_bundles_order_uq UNIQUE (order_id),
  CONSTRAINT order_bundles_math_chk
    CHECK (component_subtotal_cents - bundle_discount_cents = bundle_net_cents)
);

CREATE TABLE IF NOT EXISTS order_bundle_items (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_bundle_id             UUID        NOT NULL REFERENCES order_bundles(id) ON DELETE CASCADE,
  order_item_id               UUID        NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  sku                         TEXT        NOT NULL,
  variant_id                  UUID,
  product_id                  UUID        NOT NULL,
  product_name                TEXT        NOT NULL,
  quantity                    INTEGER     NOT NULL CHECK (quantity >= 1),
  original_unit_price_cents   INTEGER     NOT NULL CHECK (original_unit_price_cents >= 1),
  allocated_discount_cents    INTEGER     NOT NULL CHECK (allocated_discount_cents >= 0),
  net_line_cents              INTEGER     NOT NULL CHECK (net_line_cents >= 0),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_bundle_items_item_uq UNIQUE (order_item_id),
  CONSTRAINT order_bundle_items_math_chk
    CHECK (original_unit_price_cents * quantity - allocated_discount_cents = net_line_cents)
);
CREATE INDEX IF NOT EXISTS idx_order_bundle_items_bundle ON order_bundle_items(order_bundle_id);
CREATE INDEX IF NOT EXISTS idx_reservation_bundles_bundle ON reservation_bundles(bundle_id);
CREATE INDEX IF NOT EXISTS idx_order_bundles_bundle ON order_bundles(bundle_id);

-- Historical orders never change: no UPDATE, and no direct DELETE (an order's own cascade is allowed).
CREATE OR REPLACE FUNCTION bundle_snapshot_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'BUNDLE_SNAPSHOT_IMMUTABLE|%', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'BUNDLE_SNAPSHOT_IMMUTABLE|%', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'order_bundles_immutable_trg') THEN
    CREATE TRIGGER order_bundles_immutable_trg BEFORE UPDATE OR DELETE ON order_bundles
      FOR EACH ROW EXECUTE FUNCTION bundle_snapshot_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'order_bundle_items_immutable_trg') THEN
    CREATE TRIGGER order_bundle_items_immutable_trg BEFORE UPDATE OR DELETE ON order_bundle_items
      FOR EACH ROW EXECUTE FUNCTION bundle_snapshot_immutable();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Pricing rule (SQL twin of lib/bundle-pricing.ts computeSetDiscount)
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns {ok, discount_cents} or {ok:false, code, message}. Integer math only. Percent rounds DOWN.
CREATE OR REPLACE FUNCTION bundle_set_discount(p_mode TEXT, p_value INTEGER, p_subtotal INTEGER)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_d INTEGER;
BEGIN
  IF p_subtotal IS NULL OR p_subtotal < 1 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_COMPONENT_PRICE', 'message', 'The set has no valid price.');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('set_price','fixed_discount','percent_discount') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_MODE', 'message', 'Choose a pricing rule.');
  END IF;
  IF p_value IS NULL OR p_value < 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_VALUE', 'message', 'Enter a whole, non-negative amount.');
  END IF;
  IF p_mode = 'set_price' THEN
    IF p_value < 1 THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'NET_TOO_LOW', 'message', 'The set price must be at least $0.01.');
    END IF;
    IF p_value > p_subtotal THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_A_DISCOUNT',
        'message', 'The set price is higher than the products cost separately, so it is not a discount.');
    END IF;
    v_d := p_subtotal - p_value;
  ELSIF p_mode = 'fixed_discount' THEN
    IF p_value >= p_subtotal THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'DISCOUNT_TOO_LARGE',
        'message', 'The discount must be less than the products combined price.');
    END IF;
    v_d := p_value;
  ELSE
    IF p_value >= 10000 THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'DISCOUNT_TOO_LARGE', 'message', 'The percentage must be below 100%.');
    END IF;
    v_d := ((p_subtotal::bigint * p_value::bigint) / 10000)::integer;
  END IF;
  IF v_d < 0 OR v_d > p_subtotal OR p_subtotal - v_d < 1 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'NET_TOO_LOW', 'message', 'The set price must stay above $0.00.');
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'discount_cents', v_d);
END $$;

CREATE OR REPLACE FUNCTION bundle__is_uuid(p TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

CREATE OR REPLACE FUNCTION bundle__issue(p_code TEXT, p_field TEXT, p_message TEXT) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('code', p_code, 'field', p_field, 'message', p_message)
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Publish blockers (the ONE implementation of "may this bundle go live?")
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns a JSON array of {code, field, message}. A bundle that is absent or switched OFF never
-- blocks anything. p_use_snapshot_price TRUE (Admin pre-publish check) prices the owner from the
-- snapshot's intended price; FALSE (the projection trigger, which runs after 028 applied the price)
-- uses the canonical products.price_cents.
CREATE OR REPLACE FUNCTION bundle_blockers(p_owner UUID, p_snapshot JSONB, p_use_snapshot_price BOOLEAN DEFAULT TRUE)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_b        JSONB := p_snapshot -> 'bundle';
  v_out      JSONB := '[]'::jsonb;
  v_include  BOOLEAN;
  r          RECORD;
  v_pid      UUID;
  v_ids      UUID[] := '{}';
  v_members  INTEGER := 0;
  v_price    INTEGER;
  v_sub      INTEGER := 0;
  v_calc     JSONB;
  v_name     TEXT;
  v_cons     JSONB;
  v_vid      TEXT;
  v_n_act    INTEGER;
  v_prod     products%ROWTYPE;
BEGIN
  IF v_b IS NULL OR jsonb_typeof(v_b) <> 'object' OR COALESCE(v_b ->> 'enabled', 'false') <> 'true' THEN
    RETURN '[]'::jsonb;
  END IF;
  v_include := COALESCE(v_b ->> 'includeOwner', 'true') <> 'false';

  IF jsonb_typeof(v_b -> 'components') <> 'array' OR jsonb_array_length(v_b -> 'components') = 0 THEN
    v_out := v_out || bundle__issue('BUNDLE_NO_COMPONENTS', 'bundle.components', 'Add at least one product to the set.');
  END IF;

  -- owner (when part of the set)
  IF v_include THEN
    SELECT * INTO v_prod FROM products WHERE id = p_owner;
    IF NOT FOUND THEN
      v_out := v_out || bundle__issue('BUNDLE_OWNER_MISSING', 'bundle', 'Product not found.');
    ELSE
      v_members := v_members + 1;
      IF p_use_snapshot_price THEN
        v_price := NULLIF(p_snapshot #>> '{commerce,priceCents}', '')::integer;
      ELSE
        v_price := v_prod.price_cents;
      END IF;
      IF v_price IS NULL OR v_price < 1 THEN
        v_out := v_out || bundle__issue('BUNDLE_OWNER_PRICE', 'bundle', 'Set this product’s price before turning on a set.');
      ELSE
        v_sub := v_sub + v_price;
      END IF;
      v_cons := v_b -> 'ownerAllowedVariantIds';
      IF v_cons IS NOT NULL AND jsonb_typeof(v_cons) = 'array' AND jsonb_array_length(v_cons) > 0 THEN
        FOR v_vid IN SELECT jsonb_array_elements_text(v_cons) LOOP
          IF NOT bundle__is_uuid(v_vid) OR NOT EXISTS (
               SELECT 1 FROM product_variants x WHERE x.id = v_vid::uuid AND x.product_id = p_owner) THEN
            v_out := v_out || bundle__issue('BUNDLE_VARIANT_UNKNOWN', 'bundle.ownerAllowedVariantIds',
                     'A size or colour choice no longer belongs to this product.');
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  -- components
  IF jsonb_typeof(v_b -> 'components') = 'array' THEN
    FOR r IN SELECT e, i FROM jsonb_array_elements(v_b -> 'components') WITH ORDINALITY AS t(e, i) LOOP
      IF jsonb_typeof(r.e) <> 'object' OR NOT bundle__is_uuid(r.e ->> 'productId') THEN
        v_out := v_out || bundle__issue('BUNDLE_COMPONENT_INVALID', 'bundle.components.' || r.i, 'Choose a product for this slot.');
        CONTINUE;
      END IF;
      v_pid := (r.e ->> 'productId')::uuid;
      IF v_pid = p_owner THEN
        v_out := v_out || bundle__issue('BUNDLE_SELF', 'bundle.components.' || r.i,
                 'A product cannot be added to its own set. Turn on “Include this product” instead.');
        CONTINUE;
      END IF;
      IF v_pid = ANY (v_ids) THEN
        v_out := v_out || bundle__issue('BUNDLE_COMPONENT_DUPLICATE', 'bundle.components.' || r.i,
                 'Each product can be in a set only once.');
        CONTINUE;
      END IF;
      v_ids := v_ids || v_pid;
      v_members := v_members + 1;

      SELECT * INTO v_prod FROM products WHERE id = v_pid;
      IF NOT FOUND THEN
        v_out := v_out || bundle__issue('BUNDLE_COMPONENT_MISSING', 'bundle.components.' || r.i, 'This product no longer exists.');
        CONTINUE;
      END IF;
      v_name := COALESCE((SELECT v.snapshot ->> 'name' FROM content_entities e
                            JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id
                                 AND v.version_no = COALESCE(e.published_version_no, e.draft_version_no)
                           WHERE e.entity_type = 'product' AND e.entity_id = v_pid::text), v_prod.name);
      IF NOT v_prod.active OR NOT EXISTS (
           SELECT 1 FROM content_entities e WHERE e.entity_type = 'product' AND e.entity_id = v_pid::text AND e.status = 'published') THEN
        v_out := v_out || bundle__issue('BUNDLE_COMPONENT_UNAVAILABLE', 'bundle.components.' || r.i,
                 v_name || ' is not live. Publish it first, or remove it from the set.');
      END IF;
      IF v_prod.price_cents IS NULL OR v_prod.price_cents < 1 THEN
        v_out := v_out || bundle__issue('BUNDLE_COMPONENT_PRICE', 'bundle.components.' || r.i, v_name || ' has no price yet.');
      ELSE
        v_sub := v_sub + v_prod.price_cents;
      END IF;

      v_cons := r.e -> 'allowedVariantIds';
      IF v_cons IS NOT NULL AND jsonb_typeof(v_cons) = 'array' AND jsonb_array_length(v_cons) > 0 THEN
        v_n_act := 0;
        FOR v_vid IN SELECT jsonb_array_elements_text(v_cons) LOOP
          IF NOT bundle__is_uuid(v_vid) OR NOT EXISTS (
               SELECT 1 FROM product_variants x WHERE x.id = v_vid::uuid AND x.product_id = v_pid) THEN
            v_out := v_out || bundle__issue('BUNDLE_VARIANT_UNKNOWN', 'bundle.components.' || r.i,
                     'A size or colour choice no longer belongs to ' || v_name || '.');
          ELSIF EXISTS (SELECT 1 FROM product_variants x WHERE x.id = v_vid::uuid AND x.active) THEN
            v_n_act := v_n_act + 1;
          END IF;
        END LOOP;
        IF v_n_act = 0 THEN
          v_out := v_out || bundle__issue('BUNDLE_NO_VARIANT', 'bundle.components.' || r.i,
                   'None of the allowed sizes for ' || v_name || ' is active.');
        END IF;
      ELSIF NOT EXISTS (SELECT 1 FROM product_variants x WHERE x.product_id = v_pid AND x.active) THEN
        v_out := v_out || bundle__issue('BUNDLE_NO_VARIANT', 'bundle.components.' || r.i, v_name || ' has no active size.');
      END IF;

      -- one definition per set: this component must not already offer a set that includes the owner
      IF EXISTS (SELECT 1 FROM bundles b2 JOIN bundle_components bc ON bc.bundle_id = b2.id
                  WHERE b2.enabled AND b2.owner_product_id = v_pid AND b2.owner_product_id <> p_owner
                    AND bc.component_product_id = p_owner) THEN
        v_out := v_out || bundle__issue('BUNDLE_CONFLICT', 'bundle.components.' || r.i,
                 v_name || ' already offers a set that includes this product. Keep one definition per set.');
      END IF;
    END LOOP;
  END IF;

  IF v_members > 6 THEN
    v_out := v_out || bundle__issue('BUNDLE_TOO_MANY', 'bundle.components', 'A set can have up to 6 products.');
  END IF;

  -- pricing rule against the canonical prices
  IF jsonb_array_length(v_out) = 0 THEN
    v_calc := bundle_set_discount(v_b #>> '{pricing,mode}', NULLIF(v_b #>> '{pricing,value}', '')::integer, v_sub);
    IF NOT (v_calc ->> 'ok')::boolean THEN
      v_out := v_out || bundle__issue('BUNDLE_PRICE_' || (v_calc ->> 'code'), 'bundle.pricing.value', v_calc ->> 'message');
    END IF;
  END IF;
  RETURN v_out;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_array(bundle__issue('BUNDLE_VALUE', 'bundle.pricing.value', 'Enter a whole, non-negative amount.'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Projection (called by the go-live trigger; also callable directly in tests)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION bundle_project(p_owner UUID, p_snapshot JSONB, p_version_no INTEGER, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_b       JSONB := p_snapshot -> 'bundle';
  v_issues  JSONB;
  v_id      UUID;
  v_include BOOLEAN;
  v_owner_c JSONB;
  r         RECORD;
  v_n       INTEGER := 0;
  v_was     BOOLEAN;
BEGIN
  -- serialise projections so the one-definition-per-set check cannot race with another publish
  PERFORM pg_advisory_xact_lock(hashtext('kvrn.bundle.project'));

  IF v_b IS NULL OR jsonb_typeof(v_b) <> 'object' OR COALESCE(v_b ->> 'enabled', 'false') <> 'true' THEN
    SELECT enabled INTO v_was FROM bundles WHERE owner_product_id = p_owner;
    IF FOUND AND v_was THEN
      UPDATE bundles SET enabled = FALSE, revision = revision + 1, source_version_no = p_version_no WHERE owner_product_id = p_owner;
      PERFORM cms_audit(p_actor, 'bundle.disable', 'product', p_owner::text, jsonb_build_object('version_no', p_version_no));
    END IF;
    RETURN jsonb_build_object('projected', FALSE);
  END IF;

  v_issues := bundle_blockers(p_owner, p_snapshot, FALSE);
  IF jsonb_array_length(v_issues) > 0 THEN
    RAISE EXCEPTION 'BUNDLE_BLOCKED|%', v_issues::text;
  END IF;
  v_include := COALESCE(v_b ->> 'includeOwner', 'true') <> 'false';

  INSERT INTO bundles (owner_product_id, enabled, include_owner, pricing_mode, pricing_value, presentation,
                       source_version_no, published_at)
  VALUES (p_owner, TRUE, v_include, v_b #>> '{pricing,mode}', (v_b #>> '{pricing,value}')::integer,
          COALESCE(v_b -> 'presentation', '{}'::jsonb), p_version_no, NOW())
  ON CONFLICT (owner_product_id) DO UPDATE
     SET enabled = TRUE, include_owner = EXCLUDED.include_owner, pricing_mode = EXCLUDED.pricing_mode,
         pricing_value = EXCLUDED.pricing_value, presentation = EXCLUDED.presentation,
         source_version_no = EXCLUDED.source_version_no, published_at = NOW(),
         revision = bundles.revision + 1
  RETURNING id INTO v_id;

  DELETE FROM bundle_components WHERE bundle_id = v_id;
  IF v_include THEN
    INSERT INTO bundle_components (bundle_id, component_product_id, is_owner, allowed_variant_ids, view_separately, sort_order)
    VALUES (v_id, p_owner, TRUE,
            CASE WHEN jsonb_typeof(v_b -> 'ownerAllowedVariantIds') = 'array' AND jsonb_array_length(v_b -> 'ownerAllowedVariantIds') > 0
                 THEN ARRAY(SELECT jsonb_array_elements_text(v_b -> 'ownerAllowedVariantIds')::uuid) END,
            FALSE, 0);
    v_n := 1;
  END IF;
  FOR r IN SELECT e FROM jsonb_array_elements(v_b -> 'components') AS t(e) LOOP
    INSERT INTO bundle_components (bundle_id, component_product_id, is_owner, allowed_variant_ids, view_separately, sort_order)
    VALUES (v_id, (r.e ->> 'productId')::uuid, FALSE,
            CASE WHEN jsonb_typeof(r.e -> 'allowedVariantIds') = 'array' AND jsonb_array_length(r.e -> 'allowedVariantIds') > 0
                 THEN ARRAY(SELECT jsonb_array_elements_text(r.e -> 'allowedVariantIds')::uuid) END,
            COALESCE(r.e ->> 'viewSeparately', 'true') <> 'false', v_n);
    v_n := v_n + 1;
  END LOOP;

  PERFORM cms_audit(p_actor, 'bundle.project', 'product', p_owner::text,
    jsonb_build_object('bundle_id', v_id, 'version_no', p_version_no, 'mode', v_b #>> '{pricing,mode}',
                       'value', (v_b #>> '{pricing,value}')::integer, 'members', v_n));
  RETURN jsonb_build_object('projected', TRUE, 'bundle_id', v_id, 'members', v_n);
END $$;

-- The go-live trigger. Fires for publish, rollback and the scheduler (all update content_entities),
-- after catalog_entity_sync_trg (name order). A bundle that fails its blockers aborts the WHOLE
-- publish (BUNDLE_BLOCKED), so a product can never go live with a broken set.
CREATE OR REPLACE FUNCTION bundle_entity_sync() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_snap JSONB; v_pid UUID;
BEGIN
  IF NEW.entity_type <> 'product' OR NOT bundle__is_uuid(NEW.entity_id) THEN RETURN NULL; END IF;
  v_pid := NEW.entity_id::uuid;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = v_pid) THEN RETURN NULL; END IF;
  IF current_setting('kvrn.catalog_bootstrap', true) = 'on' THEN RETURN NULL; END IF;

  IF NEW.status = 'published'
     AND (OLD.status IS DISTINCT FROM 'published' OR OLD.published_version_no IS DISTINCT FROM NEW.published_version_no) THEN
    SELECT snapshot INTO v_snap FROM content_versions
     WHERE entity_type = 'product' AND entity_id = NEW.entity_id AND version_no = NEW.published_version_no;
    PERFORM bundle_project(v_pid, COALESCE(v_snap, '{}'::jsonb), NEW.published_version_no,
                           COALESCE(NEW.updated_by, 'system@kvrn.internal'));
  ELSIF OLD.status = 'published' AND NEW.status <> 'published' THEN
    -- unpublished / archived: the set stops selling immediately (fail closed)
    UPDATE bundles SET enabled = FALSE, revision = revision + 1 WHERE owner_product_id = v_pid AND enabled;
  END IF;
  RETURN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_bundle_entity_sync_trg') THEN
    CREATE TRIGGER zz_bundle_entity_sync_trg
      AFTER UPDATE ON content_entities
      FOR EACH ROW
      WHEN (NEW.entity_type = 'product'
            AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.published_version_no IS DISTINCT FROM NEW.published_version_no))
      EXECUTE FUNCTION bundle_entity_sync();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. reserve_inventory_v2 — reserve_inventory() + per-line bundle prices
-- ═══════════════════════════════════════════════════════════════════════════
-- Identical reservation semantics to reserve_inventory() (002): same input validation, same
-- one-row-per-SKU lock order (ORDER BY sku, FOR UPDATE), same availability rule, same RESERVE
-- movements, same reservation_items rows, same error codes. Differences, all additive:
--   p_items[i].bundle = true marks a bundle component line; it MUST carry unit_price_cents (the
--     server's allocated NET unit price). Plain lines MUST NOT carry a price (canonical is used).
--   p_bundle = {bundle_id, quantity}: the rule is read from `bundles` (never from the caller).
--   After locking, the allocation is validated against the canonical prices read under the lock:
--     every component of the bundle matched exactly once (allowed variants honoured), every bundle
--     line quantity = set quantity, 0 <= allocated <= canonical, and sum(canonical - allocated)
--     equals the rule's discount for one set EXACTLY. Any failure aborts the whole transaction.
--   The same SKU cannot appear both inside and outside the bundle (DUPLICATE_SKU, as in v1).
-- With p_bundle NULL it behaves exactly like reserve_inventory().
CREATE OR REPLACE FUNCTION reserve_inventory_v2(
  p_items      JSONB,
  p_expires_at TIMESTAMPTZ,
  p_bundle     JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_reservation_id UUID;
  v_item           JSONB;
  v_variant        RECORD;
  v_available      INTEGER;
  v_qty            INTEGER;
  v_sku            TEXT;
  v_is_bundle      BOOLEAN;
  v_unit           INTEGER;
  v_has_bundle     BOOLEAN := (p_bundle IS NOT NULL AND jsonb_typeof(p_bundle) = 'object');
  v_b              bundles%ROWTYPE;
  v_bq             INTEGER;
  v_blines         JSONB := '[]'::jsonb;
  v_n_bundle       INTEGER := 0;
  v_comp           RECORD;
  v_line           JSONB;
  v_cnt            INTEGER;
  v_sub            INTEGER := 0;
  v_alloc          INTEGER := 0;
  v_calc           JSONB;
  v_config         JSONB;
  v_comps_json     JSONB := '[]'::jsonb;
BEGIN
  -- Defensive JSON validation (same as v1)
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_INPUT|ITEMS_EMPTY';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= NOW() THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_INPUT|EXPIRES_IN_PAST';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_INPUT|ITEM_NOT_OBJECT';
    END IF;
    v_sku := v_item->>'sku';
    IF v_sku IS NULL OR v_sku = '' OR v_sku NOT LIKE 'KVRN-%' THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_SKU|%', COALESCE(v_sku,'null');
    END IF;
    IF (v_item->>'quantity') IS NULL OR (v_item->>'quantity') !~ '^\d+$'
       OR (v_item->>'quantity')::INTEGER < 1 OR (v_item->>'quantity')::INTEGER > 10 THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_QUANTITY|%', v_sku;
    END IF;
    v_is_bundle := COALESCE(v_item->>'bundle', 'false') = 'true';
    IF v_is_bundle THEN
      IF NOT v_has_bundle THEN RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_SELECTION_INVALID|%', v_sku; END IF;
      IF (v_item->>'unit_price_cents') IS NULL OR (v_item->>'unit_price_cents') !~ '^\d{1,9}$' THEN
        RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_PRICE_MISMATCH|%', v_sku;
      END IF;
      v_n_bundle := v_n_bundle + 1;
    ELSIF v_item ? 'unit_price_cents' AND jsonb_typeof(v_item->'unit_price_cents') <> 'null' THEN
      -- plain lines are always sold at the canonical price; a caller cannot name one
      RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_PRICE_MISMATCH|%', v_sku;
    END IF;
  END LOOP;
  IF (SELECT COUNT(*) FROM (
        SELECT j->>'sku' AS s FROM jsonb_array_elements(p_items) j
        GROUP BY 1 HAVING COUNT(*) > 1
      ) t) > 0 THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|DUPLICATE_SKU|MULTIPLE';
  END IF;

  -- Bundle header checks (cheap, before any lock is taken)
  IF v_has_bundle THEN
    IF NOT bundle__is_uuid(p_bundle->>'bundle_id') THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_UNAVAILABLE|invalid';
    END IF;
    IF (p_bundle->>'quantity') IS NULL OR (p_bundle->>'quantity') !~ '^\d+$'
       OR (p_bundle->>'quantity')::INTEGER < 1 OR (p_bundle->>'quantity')::INTEGER > 10 THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_QUANTITY|%', p_bundle->>'bundle_id';
    END IF;
    v_bq := (p_bundle->>'quantity')::INTEGER;
    -- Cheap early refusal WITHOUT a lock. The row lock (FOR SHARE) is taken only AFTER the variant rows
    -- are locked (see below): a publish (028 -> 029) locks the product's variants first and the
    -- `bundles` row second, so taking them in the opposite order here would be a lock-order
    -- inversion (deadlock, 40P01) between a checkout and a bundle publish.
    SELECT * INTO v_b FROM bundles WHERE id = (p_bundle->>'bundle_id')::uuid AND enabled;
    IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_UNAVAILABLE|%', p_bundle->>'bundle_id'; END IF;
    IF v_n_bundle = 0 THEN RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_SELECTION_INVALID|%', p_bundle->>'bundle_id'; END IF;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      IF COALESCE(v_item->>'bundle', 'false') = 'true' AND (v_item->>'quantity')::INTEGER <> v_bq THEN
        RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_QUANTITY|%', v_item->>'sku';
      END IF;
    END LOOP;
  END IF;

  INSERT INTO reservations (status, expires_at)
  VALUES ('creating', p_expires_at)
  RETURNING id INTO v_reservation_id;

  FOR v_item IN
    SELECT * FROM jsonb_array_elements(p_items) ORDER BY value->>'sku'
  LOOP
    v_sku := v_item->>'sku';
    v_qty := (v_item->>'quantity')::INTEGER;
    v_is_bundle := COALESCE(v_item->>'bundle', 'false') = 'true';

    SELECT pv.id, pv.sku, pv.active, pv.stock_on_hand, pv.reserved_quantity, pv.product_id,
           p.name AS product_name, p.price_cents, p.currency,
           p.active AS product_active, pv.size, pv.color_name
    INTO v_variant
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.sku = v_sku
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_RESERVATION|INVALID_SKU|%', v_sku; END IF;
    IF NOT v_variant.product_active OR NOT v_variant.active THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|INACTIVE_VARIANT|%', v_sku;
    END IF;
    IF v_variant.currency <> 'usd' THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|CURRENCY_NOT_SUPPORTED|%', v_sku;
    END IF;

    v_available := v_variant.stock_on_hand - v_variant.reserved_quantity;
    IF v_available < v_qty THEN
      IF v_available <= 0 THEN RAISE EXCEPTION 'KVRN_RESERVATION|OUT_OF_STOCK|%', v_sku;
      ELSE RAISE EXCEPTION 'KVRN_RESERVATION|INSUFFICIENT_STOCK|%', v_sku; END IF;
    END IF;

    IF v_is_bundle THEN
      v_unit := (v_item->>'unit_price_cents')::INTEGER;
      IF v_variant.price_cents < 1 OR v_unit < 0 OR v_unit > v_variant.price_cents THEN
        RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_PRICE_MISMATCH|%', v_sku;
      END IF;
      v_blines := v_blines || jsonb_build_array(jsonb_build_object(
        'sku', v_sku, 'variant_id', v_variant.id, 'product_id', v_variant.product_id, 'quantity', v_qty,
        'original', v_variant.price_cents, 'unit', v_unit, 'name', v_variant.product_name,
        'size', v_variant.size, 'color', v_variant.color_name));
    ELSE
      v_unit := v_variant.price_cents;
    END IF;

    UPDATE product_variants
    SET reserved_quantity = reserved_quantity + v_qty, updated_at = NOW()
    WHERE id = v_variant.id;

    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, reservation_id)
    VALUES
      (v_variant.id, v_qty, 'RESERVE', 'checkout_reservation',
       'reservation:' || v_reservation_id, 'system@kvrn.internal', v_reservation_id);

    INSERT INTO reservation_items
      (reservation_id, variant_id, sku, product_name, size, color, quantity, unit_price_cents)
    VALUES
      (v_reservation_id, v_variant.id, v_sku,
       v_variant.product_name, v_variant.size, v_variant.color_name,
       v_qty, v_unit);
  END LOOP;

  -- Validate the allocation against the canonical prices read under the row locks above.
  IF v_has_bundle THEN
    -- FOR SHARE (after the variant locks, same order as a publish): a concurrent re-projection of this
    -- bundle waits until this reservation commits. Re-read under the lock, so the rule and the
    -- components validated below are the committed ones; a bundle switched off meanwhile is refused.
    SELECT * INTO v_b FROM bundles WHERE id = (p_bundle->>'bundle_id')::uuid AND enabled FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_UNAVAILABLE|%', p_bundle->>'bundle_id'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM bundle_components WHERE bundle_id = v_b.id;
    IF v_cnt = 0 OR v_cnt <> jsonb_array_length(v_blines) THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_SELECTION_INVALID|%', v_b.id;
    END IF;
    FOR v_comp IN SELECT * FROM bundle_components WHERE bundle_id = v_b.id ORDER BY sort_order LOOP
      SELECT COUNT(*) INTO v_cnt FROM jsonb_array_elements(v_blines) l
       WHERE (l->>'product_id')::uuid = v_comp.component_product_id;
      IF v_cnt <> 1 THEN RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_SELECTION_INVALID|%', v_comp.component_product_id; END IF;
      SELECT l INTO v_line FROM jsonb_array_elements(v_blines) l
       WHERE (l->>'product_id')::uuid = v_comp.component_product_id;
      IF v_comp.allowed_variant_ids IS NOT NULL
         AND NOT ((v_line->>'variant_id')::uuid = ANY (v_comp.allowed_variant_ids)) THEN
        RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_SELECTION_INVALID|%', v_line->>'sku';
      END IF;
    END LOOP;

    SELECT COALESCE(SUM((l->>'original')::integer), 0), COALESCE(SUM((l->>'original')::integer - (l->>'unit')::integer), 0)
      INTO v_sub, v_alloc FROM jsonb_array_elements(v_blines) l;
    v_calc := bundle_set_discount(v_b.pricing_mode, v_b.pricing_value, v_sub);
    IF NOT (v_calc->>'ok')::boolean THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_UNAVAILABLE|%', v_b.id;
    END IF;
    IF v_alloc <> (v_calc->>'discount_cents')::integer THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|BUNDLE_PRICE_MISMATCH|%', v_b.id;
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
             'product_id', l->>'product_id', 'variant_id', l->>'variant_id', 'sku', l->>'sku',
             'name', l->>'name', 'size', l->>'size', 'color', l->>'color',
             'original_unit_price_cents', (l->>'original')::integer,
             'allocated_discount_per_unit_cents', (l->>'original')::integer - (l->>'unit')::integer,
             'net_unit_price_cents', (l->>'unit')::integer) ORDER BY l->>'sku')
      INTO v_comps_json FROM jsonb_array_elements(v_blines) l;
    v_config := jsonb_build_object(
      'bundle_id', v_b.id, 'owner_product_id', v_b.owner_product_id, 'bundle_revision', v_b.revision,
      'include_owner', v_b.include_owner, 'set_quantity', v_bq,
      'pricing', jsonb_build_object('mode', v_b.pricing_mode, 'value', v_b.pricing_value),
      'presentation', v_b.presentation, 'components', v_comps_json);

    INSERT INTO reservation_bundles
      (reservation_id, bundle_id, owner_product_id, set_quantity, pricing_mode, pricing_value,
       component_subtotal_cents, bundle_discount_cents, bundle_net_cents, config)
    VALUES
      (v_reservation_id, v_b.id, v_b.owner_product_id, v_bq, v_b.pricing_mode, v_b.pricing_value,
       v_sub * v_bq, (v_calc->>'discount_cents')::integer * v_bq, (v_sub - (v_calc->>'discount_cents')::integer) * v_bq,
       v_config);
    INSERT INTO reservation_bundle_items
      (reservation_id, sku, variant_id, product_id, quantity, original_unit_price_cents,
       allocated_discount_per_unit_cents, net_unit_price_cents)
    SELECT v_reservation_id, l->>'sku', (l->>'variant_id')::uuid, (l->>'product_id')::uuid, (l->>'quantity')::integer,
           (l->>'original')::integer, (l->>'original')::integer - (l->>'unit')::integer, (l->>'unit')::integer
      FROM jsonb_array_elements(v_blines) l;
  END IF;

  UPDATE reservations SET status='open', updated_at=NOW() WHERE id=v_reservation_id;

  RETURN (
    SELECT jsonb_build_object(
      'reservation_id', v_reservation_id,
      'expires_at', p_expires_at,
      'bundle', CASE WHEN v_has_bundle THEN v_config END,
      'items', jsonb_agg(
        jsonb_build_object(
          'variant_id',      ri.variant_id,
          'sku',             ri.sku,
          'product_name',    ri.product_name,
          'size',            ri.size,
          'color',           ri.color,
          'unit_price_cents', ri.unit_price_cents,
          'original_unit_price_cents', COALESCE(rbi.original_unit_price_cents, ri.unit_price_cents),
          'bundle_id',       CASE WHEN rbi.sku IS NOT NULL THEN v_b.id END,
          'quantity',        ri.quantity
        ) ORDER BY ri.sku
      )
    )
    FROM reservation_items ri
    LEFT JOIN reservation_bundle_items rbi ON rbi.reservation_id = ri.reservation_id AND rbi.sku = ri.sku
    WHERE ri.reservation_id = v_reservation_id
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Order snapshot triggers (finalize_paid_order is NOT modified)
-- ═══════════════════════════════════════════════════════════════════════════
-- When the order row appears, freeze the reservation's bundle header. Never blocks a paid order.
CREATE OR REPLACE FUNCTION bundle_snapshot_order() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reservation_id IS NULL THEN RETURN NULL; END IF;
  BEGIN
    INSERT INTO order_bundles
      (order_id, reservation_id, bundle_id, owner_product_id, set_quantity, pricing_mode, pricing_value,
       component_subtotal_cents, bundle_discount_cents, bundle_net_cents, config)
    SELECT NEW.id, rb.reservation_id, rb.bundle_id, rb.owner_product_id, rb.set_quantity, rb.pricing_mode, rb.pricing_value,
           rb.component_subtotal_cents, rb.bundle_discount_cents, rb.bundle_net_cents, rb.config
      FROM reservation_bundles rb WHERE rb.reservation_id = NEW.reservation_id
    ON CONFLICT (order_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'bundle_snapshot_order failed for order %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;

-- As each order line is inserted, link it to the frozen allocation (matched by SKU).
CREATE OR REPLACE FUNCTION bundle_snapshot_order_item() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_ob order_bundles%ROWTYPE;
BEGIN
  SELECT * INTO v_ob FROM order_bundles WHERE order_id = NEW.order_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  BEGIN
    INSERT INTO order_bundle_items
      (order_bundle_id, order_item_id, sku, variant_id, product_id, product_name, quantity,
       original_unit_price_cents, allocated_discount_cents, net_line_cents)
    SELECT v_ob.id, NEW.id, NEW.sku, NEW.variant_id, rbi.product_id, NEW.product_name, NEW.quantity,
           rbi.original_unit_price_cents, rbi.allocated_discount_per_unit_cents * NEW.quantity, NEW.line_total_cents
      FROM reservation_bundle_items rbi
     WHERE rbi.reservation_id = v_ob.reservation_id AND rbi.sku = NEW.sku
    ON CONFLICT (order_item_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'bundle_snapshot_order_item failed for order item %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bundle_snapshot_order_trg') THEN
    CREATE TRIGGER bundle_snapshot_order_trg AFTER INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION bundle_snapshot_order();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bundle_snapshot_order_item_trg') THEN
    CREATE TRIGGER bundle_snapshot_order_item_trg AFTER INSERT ON order_items
      FOR EACH ROW EXECUTE FUNCTION bundle_snapshot_order_item();
  END IF;
END $$;

-- Reconciliation: orders whose reservation was a bundle but whose frozen snapshot is missing or
-- incomplete. Empty = every bundle order has its full accounting record.
CREATE OR REPLACE FUNCTION bundle_snapshot_gaps()
RETURNS TABLE (order_id UUID, reason TEXT) LANGUAGE sql STABLE AS $$
  SELECT o.id, 'missing_order_bundle'::text
    FROM orders o JOIN reservation_bundles rb ON rb.reservation_id = o.reservation_id
   WHERE NOT EXISTS (SELECT 1 FROM order_bundles ob WHERE ob.order_id = o.id)
  UNION ALL
  SELECT ob.order_id, 'item_count_mismatch'::text
    FROM order_bundles ob
   WHERE (SELECT COUNT(*) FROM order_bundle_items i WHERE i.order_bundle_id = ob.id)
      <> (SELECT COUNT(*) FROM reservation_bundle_items r WHERE r.reservation_id = ob.reservation_id)
  UNION ALL
  SELECT ob.order_id, 'amount_mismatch'::text
    FROM order_bundles ob
   WHERE ob.bundle_net_cents <> (SELECT COALESCE(SUM(i.net_line_cents), 0) FROM order_bundle_items i WHERE i.order_bundle_id = ob.id)
$$;

COMMIT;
