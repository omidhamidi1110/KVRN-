-- KVRN Migration 031 — Order tags + Stripe Radar fraud review / fulfillment hold
--
-- Additive only. Nothing in 001–027 is altered, dropped or replaced (no existing function,
-- table, column or constraint is modified). Idempotent: re-applying is a no-op (tables and
-- indexes are IF NOT EXISTS, functions are CREATE OR REPLACE of THIS migration's own
-- functions only, triggers are guarded, and the example tags are seeded exactly once — on
-- the run that creates order_tags — so a tag an admin later deletes is never resurrected).
-- Run after 001–027. NOT applied to production by the implementation batch.
--
-- WHAT THIS ADDS
-- --------------
-- 1. ORDER TAGS — internal labels (Hold, VIP, UGC, Replacement, Manual Review, ...).
--      order_tags, order_tag_assignments + atomic, audited functions order_tag_*().
--    Tags are INTERNAL organisation only. They never change payment, accounting, inventory or
--    fulfillment, and a tag named "Hold" is just a label — it is NOT a fraud hold.
--
-- 2. FRAUD REVIEW — what Stripe/Radar told us about a successful payment, and the KVRN
--    fulfillment-review HOLD that can follow from it.
--      order_fraud_reviews   one CURRENT row per order (UNIQUE order_id)
--      order_fraud_events    append-only history (hold created/released, review opened/closed,
--                            confirmed-fraud, sync results, Stripe event ids)
--    A hold is ADDITIVE: the order stays PAID. It touches no payment status, total, inventory,
--    financial event or reconciliation input. Its only effect is to refuse fulfillment, and it is
--    enforced HERE, in the database, so no caller can route around it:
--      * BEFORE UPDATE trigger on orders   — fulfillment_status may not change INTO
--                                            processing / shipped / delivered while a hold is
--                                            active (this also covers mark_order_shipped()).
--                                            'cancelled' (025, pre-shipment cancellation) stays allowed.
--      * BEFORE INSERT/UPDATE trigger on shipments — no shipment / label record while held.
--    Refusals raise   KVRN_FRAUD_HOLD|FRAUD_HOLD_ACTIVE|<order id>
--
-- Whether a hold is CREATED is decided by the caller (feature flag RADAR_FULFILLMENT_HOLDS is read
-- in application code at call time and passed in as p_holds_enabled); the database never reads
-- an environment variable. Releasing a hold is always possible regardless of the flag.
--
-- DESIGN NOTES
--   * Unknown is never zero or "safe": risk_level / risk_score are NULL when Stripe supplied
--     nothing, and the Admin shows "Unknown".
--   * signals JSONB holds ONLY whitelisted, non-sensitive fields chosen by lib/fraud-review.ts
--     (check results, country codes, 3DS result, outcome type/reason). No card number, last4,
--     fingerprint, IP address, e-mail, name or street address is ever stored.
--   * Idempotent webhook ingestion: order_fraud_events has a unique index on
--     (stripe_event_id, event_type, order) so a redelivered Stripe event is a no-op.
--   * Staleness: a review signal older than the one already recorded (by Stripe's event time)
--     is ignored, so out-of-order delivery cannot reopen a closed review.
--   * After an admin RELEASES a hold the same Stripe signal cannot re-hold the order: outcome
--     based triggers fire only if the order was never held; review/early-fraud-warning triggers
--     are remembered per Stripe object id (released_trigger_keys).

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. ORDER TAGS
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('order_tags') IS NULL THEN
    CREATE TABLE order_tags (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name         TEXT        NOT NULL,
      color        TEXT        NOT NULL DEFAULT 'neutral',
      archived_at  TIMESTAMPTZ,
      created_by   TEXT        NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT order_tags_name_chk  CHECK (char_length(name) BETWEEN 1 AND 32
                                             AND name = btrim(name)
                                             AND name !~ '[[:cntrl:]]'),
      CONSTRAINT order_tags_color_chk CHECK (color IN ('neutral','red','amber','green','blue','violet'))
    );
    -- Case-insensitive uniqueness: "vip" and "VIP" are the same tag.
    CREATE UNIQUE INDEX order_tags_name_ci_uq ON order_tags (lower(name));

    -- Example tags, as ordinary rows (an admin can rename, archive, or delete them when unused).
    INSERT INTO order_tags (name, color, created_by) VALUES
      ('Hold',          'amber',   'system'),
      ('VIP',           'violet',  'system'),
      ('UGC',           'blue',    'system'),
      ('Replacement',   'neutral', 'system'),
      ('Manual Review', 'red',     'system');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_tag_assignments (
  order_id     UUID        NOT NULL REFERENCES orders(id)     ON DELETE CASCADE,
  -- RESTRICT: a tag that is still on an order cannot be deleted (archive it instead).
  tag_id       UUID        NOT NULL REFERENCES order_tags(id) ON DELETE RESTRICT,
  assigned_by  TEXT        NOT NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_order_tag_assignments_tag ON order_tag_assignments (tag_id, order_id);

-- Validation helpers (own functions) -------------------------------------------------------

CREATE OR REPLACE FUNCTION order_tag_actor_check(p_actor TEXT, p_code_prefix TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v TEXT := btrim(COALESCE(p_actor, ''));
BEGIN
  IF v = '' THEN RAISE EXCEPTION '%|ACTOR_REQUIRED', p_code_prefix; END IF;
  IF char_length(v) > 254 OR v ~ '[[:cntrl:]]' THEN RAISE EXCEPTION '%|ACTOR_INVALID', p_code_prefix; END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION order_tag_normalize_name(p_name TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v TEXT := regexp_replace(btrim(COALESCE(p_name, '')), '\s+', ' ', 'g');
BEGIN
  IF v = '' THEN RAISE EXCEPTION 'KVRN_TAG|NAME_REQUIRED'; END IF;
  IF char_length(v) > 32 THEN RAISE EXCEPTION 'KVRN_TAG|NAME_TOO_LONG'; END IF;
  IF v ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'KVRN_TAG|NAME_INVALID'; END IF;
  RETURN v;
END $$;

-- order_tag_create ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION order_tag_create(p_name TEXT, p_color TEXT, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_actor TEXT := order_tag_actor_check(p_actor, 'KVRN_TAG');
  v_name  TEXT := order_tag_normalize_name(p_name);
  v_color TEXT := COALESCE(NULLIF(btrim(p_color), ''), 'neutral');
  v_tag   order_tags%ROWTYPE;
BEGIN
  IF v_color NOT IN ('neutral','red','amber','green','blue','violet') THEN
    RAISE EXCEPTION 'KVRN_TAG|COLOR_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('order_tag_name:' || lower(v_name)));
  IF EXISTS (SELECT 1 FROM order_tags WHERE lower(name) = lower(v_name)) THEN
    RAISE EXCEPTION 'KVRN_TAG|DUPLICATE';
  END IF;
  INSERT INTO order_tags (name, color, created_by) VALUES (v_name, v_color, v_actor) RETURNING * INTO v_tag;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'order_tag.create', 'order_tag', v_tag.id::text,
          jsonb_build_object('name', v_tag.name, 'color', v_tag.color));
  RETURN jsonb_build_object('outcome', 'created', 'id', v_tag.id, 'name', v_tag.name,
                            'color', v_tag.color, 'archived', false);
END $$;

-- order_tag_update (rename / recolour / archive / restore) -----------------------------------------
CREATE OR REPLACE FUNCTION order_tag_update(
  p_tag_id UUID, p_name TEXT, p_color TEXT, p_archived BOOLEAN, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_actor TEXT := order_tag_actor_check(p_actor, 'KVRN_TAG');
  v_old   order_tags%ROWTYPE;
  v_new   order_tags%ROWTYPE;
  v_name  TEXT;
  v_color TEXT;
  v_arch  TIMESTAMPTZ;
BEGIN
  IF p_tag_id IS NULL THEN RAISE EXCEPTION 'KVRN_TAG|TAG_REQUIRED'; END IF;
  SELECT * INTO v_old FROM order_tags WHERE id = p_tag_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_TAG|TAG_NOT_FOUND'; END IF;

  v_name  := CASE WHEN p_name IS NULL THEN v_old.name ELSE order_tag_normalize_name(p_name) END;
  v_color := COALESCE(NULLIF(btrim(p_color), ''), v_old.color);
  IF v_color NOT IN ('neutral','red','amber','green','blue','violet') THEN
    RAISE EXCEPTION 'KVRN_TAG|COLOR_INVALID';
  END IF;
  v_arch := CASE WHEN p_archived IS NULL THEN v_old.archived_at
                 WHEN p_archived THEN COALESCE(v_old.archived_at, NOW())
                 ELSE NULL END;

  IF lower(v_name) <> lower(v_old.name) THEN
    PERFORM pg_advisory_xact_lock(hashtext('order_tag_name:' || lower(v_name)));
    IF EXISTS (SELECT 1 FROM order_tags WHERE lower(name) = lower(v_name) AND id <> p_tag_id) THEN
      RAISE EXCEPTION 'KVRN_TAG|DUPLICATE';
    END IF;
  END IF;

  IF v_name = v_old.name AND v_color = v_old.color AND v_arch IS NOT DISTINCT FROM v_old.archived_at THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'id', v_old.id, 'name', v_old.name,
                              'color', v_old.color, 'archived', v_old.archived_at IS NOT NULL);
  END IF;

  UPDATE order_tags SET name = v_name, color = v_color, archived_at = v_arch, updated_at = NOW()
   WHERE id = p_tag_id RETURNING * INTO v_new;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'order_tag.update', 'order_tag', p_tag_id::text,
          jsonb_build_object(
            'before', jsonb_build_object('name', v_old.name, 'color', v_old.color, 'archived', v_old.archived_at IS NOT NULL),
            'after',  jsonb_build_object('name', v_new.name, 'color', v_new.color, 'archived', v_new.archived_at IS NOT NULL)));
  RETURN jsonb_build_object('outcome', 'updated', 'id', v_new.id, 'name', v_new.name,
                            'color', v_new.color, 'archived', v_new.archived_at IS NOT NULL);
END $$;

-- order_tag_delete: refused while the tag is on any order -----------------------------------------
CREATE OR REPLACE FUNCTION order_tag_delete(p_tag_id UUID, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_actor TEXT := order_tag_actor_check(p_actor, 'KVRN_TAG');
  v_tag   order_tags%ROWTYPE;
  v_n     INTEGER;
BEGIN
  IF p_tag_id IS NULL THEN RAISE EXCEPTION 'KVRN_TAG|TAG_REQUIRED'; END IF;
  SELECT * INTO v_tag FROM order_tags WHERE id = p_tag_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_TAG|TAG_NOT_FOUND'; END IF;
  SELECT COUNT(*) INTO v_n FROM order_tag_assignments WHERE tag_id = p_tag_id;
  IF v_n > 0 THEN RAISE EXCEPTION 'KVRN_TAG|IN_USE|%', v_n; END IF;
  DELETE FROM order_tags WHERE id = p_tag_id;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'order_tag.delete', 'order_tag', p_tag_id::text,
          jsonb_build_object('name', v_tag.name));
  RETURN jsonb_build_object('outcome', 'deleted', 'id', p_tag_id);
END $$;

-- order_tag_assign: idempotent; max 10 tags per order; archived tags cannot be newly assigned -------
CREATE OR REPLACE FUNCTION order_tag_assign(p_order_id UUID, p_tag_id UUID, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_actor TEXT := order_tag_actor_check(p_actor, 'KVRN_TAG');
  v_order RECORD;
  v_tag   order_tags%ROWTYPE;
  v_n     INTEGER;
  v_ins   INTEGER;
BEGIN
  IF p_order_id IS NULL OR p_tag_id IS NULL THEN RAISE EXCEPTION 'KVRN_TAG|TAG_REQUIRED'; END IF;
  SELECT id, order_number INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_TAG|ORDER_NOT_FOUND'; END IF;
  -- FOR SHARE: a concurrent order_tag_delete (FOR UPDATE) waits for this assignment, then refuses (IN_USE);
  -- and if the delete wins, this reports TAG_NOT_FOUND instead of a raw foreign-key error.
  SELECT * INTO v_tag FROM order_tags WHERE id = p_tag_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_TAG|TAG_NOT_FOUND'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('order_tag_order:' || p_order_id::text));
  IF EXISTS (SELECT 1 FROM order_tag_assignments WHERE order_id = p_order_id AND tag_id = p_tag_id) THEN
    RETURN jsonb_build_object('outcome', 'already_assigned', 'order_id', p_order_id, 'tag_id', p_tag_id);
  END IF;
  IF v_tag.archived_at IS NOT NULL THEN RAISE EXCEPTION 'KVRN_TAG|TAG_ARCHIVED'; END IF;
  SELECT COUNT(*) INTO v_n FROM order_tag_assignments WHERE order_id = p_order_id;
  IF v_n >= 10 THEN RAISE EXCEPTION 'KVRN_TAG|TOO_MANY'; END IF;

  INSERT INTO order_tag_assignments (order_id, tag_id, assigned_by) VALUES (p_order_id, p_tag_id, v_actor)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  IF v_ins = 0 THEN
    RETURN jsonb_build_object('outcome', 'already_assigned', 'order_id', p_order_id, 'tag_id', p_tag_id);
  END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'order.tag_add', 'order', p_order_id::text,
          jsonb_build_object('tag_id', p_tag_id, 'tag', v_tag.name, 'order_number', v_order.order_number));
  RETURN jsonb_build_object('outcome', 'assigned', 'order_id', p_order_id, 'tag_id', p_tag_id);
END $$;

-- order_tag_remove: idempotent ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION order_tag_remove(p_order_id UUID, p_tag_id UUID, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_actor TEXT := order_tag_actor_check(p_actor, 'KVRN_TAG');
  v_order RECORD;
  v_tag   order_tags%ROWTYPE;
  v_del   INTEGER;
BEGIN
  IF p_order_id IS NULL OR p_tag_id IS NULL THEN RAISE EXCEPTION 'KVRN_TAG|TAG_REQUIRED'; END IF;
  SELECT id, order_number INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_TAG|ORDER_NOT_FOUND'; END IF;
  SELECT * INTO v_tag FROM order_tags WHERE id = p_tag_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_TAG|TAG_NOT_FOUND'; END IF;
  DELETE FROM order_tag_assignments WHERE order_id = p_order_id AND tag_id = p_tag_id;
  GET DIAGNOSTICS v_del = ROW_COUNT;
  IF v_del = 0 THEN
    RETURN jsonb_build_object('outcome', 'not_assigned', 'order_id', p_order_id, 'tag_id', p_tag_id);
  END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'order.tag_remove', 'order', p_order_id::text,
          jsonb_build_object('tag_id', p_tag_id, 'tag', v_tag.name, 'order_number', v_order.order_number));
  RETURN jsonb_build_object('outcome', 'removed', 'order_id', p_order_id, 'tag_id', p_tag_id);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. FRAUD REVIEW
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_fraud_reviews (
  id                           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                     UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_intent_id            TEXT,
  charge_id                    TEXT,
  -- Stripe Radar outcome. NULL = Stripe supplied nothing (Unknown — never zero, never "safe").
  risk_level                   TEXT,
  risk_score                   INTEGER,
  outcome_type                 TEXT,
  outcome_reason               TEXT,
  seller_message               TEXT,
  -- Whitelisted, non-sensitive signals only (see header). Written by lib/fraud-review.ts.
  signals                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Stripe Review object (Radar). state: 'open' | 'closed'.
  stripe_review_id             TEXT,
  stripe_review_state          TEXT,
  stripe_review_reason         TEXT,
  stripe_review_closed_reason  TEXT,
  stripe_review_event_at       TIMESTAMPTZ,
  -- KVRN fulfillment hold (additive; payment stays PAID).
  hold_state                   TEXT        NOT NULL DEFAULT 'none',
  hold_reason                  TEXT,
  hold_source                  TEXT,
  hold_trigger_key             TEXT,
  hold_created_at              TIMESTAMPTZ,
  released_trigger_keys        TEXT[]      NOT NULL DEFAULT '{}',
  released_by                  TEXT,
  released_at                  TIMESTAMPTZ,
  release_note                 TEXT,
  -- Owner decision that the payment is fraud (routes to the EXISTING refund / cancel flow).
  fraud_confirmed_by           TEXT,
  fraud_confirmed_at           TIMESTAMPTZ,
  fraud_confirmed_note         TEXT,
  last_synced_at               TIMESTAMPTZ,
  sync_error                   TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_fraud_reviews_order_uq      UNIQUE (order_id),
  CONSTRAINT order_fraud_reviews_hold_chk      CHECK (hold_state IN ('none','active','released')),
  CONSTRAINT order_fraud_reviews_risk_chk      CHECK (risk_level IS NULL OR risk_level IN ('normal','elevated','highest','not_assessed','unknown')),
  CONSTRAINT order_fraud_reviews_score_chk     CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
  CONSTRAINT order_fraud_reviews_rstate_chk    CHECK (stripe_review_state IS NULL OR stripe_review_state IN ('open','closed')),
  CONSTRAINT order_fraud_reviews_reason_chk    CHECK (hold_reason IS NULL OR hold_reason ~ '^[a-z_]{3,60}$'),
  CONSTRAINT order_fraud_reviews_active_chk    CHECK (hold_state <> 'active'   OR (hold_reason IS NOT NULL AND hold_created_at IS NOT NULL)),
  CONSTRAINT order_fraud_reviews_released_chk  CHECK (hold_state <> 'released' OR (released_by IS NOT NULL AND released_at IS NOT NULL)),
  CONSTRAINT order_fraud_reviews_note_chk      CHECK (release_note IS NULL OR char_length(release_note) <= 500),
  CONSTRAINT order_fraud_reviews_fnote_chk     CHECK (fraud_confirmed_note IS NULL OR char_length(fraud_confirmed_note) <= 500),
  CONSTRAINT order_fraud_reviews_syncerr_chk   CHECK (sync_error IS NULL OR char_length(sync_error) <= 80)
);
CREATE INDEX IF NOT EXISTS idx_order_fraud_reviews_hold   ON order_fraud_reviews (order_id) WHERE hold_state = 'active';
CREATE INDEX IF NOT EXISTS idx_order_fraud_reviews_pi     ON order_fraud_reviews (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_order_fraud_reviews_updated_at') THEN
    CREATE TRIGGER set_order_fraud_reviews_updated_at BEFORE UPDATE ON order_fraud_reviews
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Append-only history. order_id has NO foreign key on purpose: the log must outlive anything, and an
-- unmatched Stripe signal (the order does not exist yet) is stored with order_id NULL until it can be applied.
CREATE TABLE IF NOT EXISTS order_fraud_events (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID,
  payment_intent_id  TEXT,
  charge_id          TEXT,
  event_type         TEXT        NOT NULL,
  actor              TEXT        NOT NULL,
  source             TEXT        NOT NULL,
  stripe_event_id    TEXT,
  stripe_review_id   TEXT,
  detail             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_fraud_events_type_chk CHECK (event_type IN (
    'review_opened','review_closed','charge_outcome','early_fraud_warning',
    'hold_created','hold_released','hold_not_applied','confirmed_fraud',
    'synced','sync_failed','unmatched_signal'))
);
-- Duplicate Stripe delivery = no-op. COALESCE so an UNMATCHED row (order_id NULL) and its later MATCHED
-- replay (order_id set) are distinct keys.
CREATE UNIQUE INDEX IF NOT EXISTS order_fraud_events_stripe_evt_uq
  ON order_fraud_events (stripe_event_id, event_type, (COALESCE(order_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE stripe_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_fraud_events_order ON order_fraud_events (order_id, created_at DESC) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_fraud_events_pi    ON order_fraud_events (payment_intent_id) WHERE order_id IS NULL;

CREATE OR REPLACE FUNCTION order_fraud_events_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_fraud_events is append-only';
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'order_fraud_events_no_mutation') THEN
    CREATE TRIGGER order_fraud_events_no_mutation BEFORE UPDATE OR DELETE ON order_fraud_events
      FOR EACH ROW EXECUTE FUNCTION order_fraud_events_append_only();
  END IF;
END $$;

-- ── Server-enforced hold ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION order_fraud_hold_active(p_order_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM order_fraud_reviews r WHERE r.order_id = p_order_id AND r.hold_state = 'active');
$$;

CREATE OR REPLACE FUNCTION order_fraud_hold_orders_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fulfillment_status IN ('processing','shipped','delivered')
     AND NEW.fulfillment_status IS DISTINCT FROM OLD.fulfillment_status
     AND order_fraud_hold_active(NEW.id) THEN
    RAISE EXCEPTION 'KVRN_FRAUD_HOLD|FRAUD_HOLD_ACTIVE|%', NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION order_fraud_hold_shipments_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF order_fraud_hold_active(NEW.order_id) THEN
    RAISE EXCEPTION 'KVRN_FRAUD_HOLD|FRAUD_HOLD_ACTIVE|%', NEW.order_id;
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_fraud_hold_guard') THEN
    CREATE TRIGGER orders_fraud_hold_guard BEFORE UPDATE OF fulfillment_status ON orders
      FOR EACH ROW WHEN (NEW.fulfillment_status IS DISTINCT FROM OLD.fulfillment_status)
      EXECUTE FUNCTION order_fraud_hold_orders_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'shipments_fraud_hold_guard') THEN
    CREATE TRIGGER shipments_fraud_hold_guard
      BEFORE INSERT OR UPDATE OF tracking_number, carrier, shipped_at, label_cost_cents, label_purchased_at ON shipments
      FOR EACH ROW EXECUTE FUNCTION order_fraud_hold_shipments_guard();
  END IF;
END $$;

-- ── Applying a Stripe signal (atomic; the only writer of risk / review / hold-creation) ──────────────
--
--   p_event_type    review_opened | review_closed | early_fraud_warning | charge_outcome | synced
--   p_patch         JSONB, whitelisted by lib/fraud-review.ts. Keys (all optional):
--                     payment_intent_id, charge_id,
--                     risk_level, risk_score, outcome_type, outcome_reason, seller_message   (charge outcome;
--                       key PRESENT with null = Stripe supplied nothing => stored as NULL/Unknown)
--                     signals  (object, merged into signals)
--                     review   {id, open, reason, closed_reason}
--   p_hold_reason   NULL = this signal does not recommend a hold
--   p_trigger_key   'review:<id>' | 'outcome:<charge>' | 'efw:<id>' | 'case:...' identifies the cause
--   p_holds_enabled the RADAR_FULFILLMENT_HOLDS flag, read by the caller at call time
--   p_source        webhook | order_created | refresh | pending_replay
--   p_stripe_event_id  Stripe event id (idempotency) or NULL (refresh / order creation)
--   p_event_at      Stripe event time (staleness) or NULL = now
CREATE OR REPLACE FUNCTION fraud_review_apply_signal(
  p_order_id        UUID,
  p_event_type      TEXT,
  p_patch           JSONB,
  p_hold_reason     TEXT,
  p_trigger_key     TEXT,
  p_holds_enabled   BOOLEAN,
  p_source          TEXT,
  p_actor           TEXT,
  p_stripe_event_id TEXT,
  p_event_at        TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  o          RECORD;
  r          order_fraud_reviews%ROWTYPE;
  b          order_fraud_reviews%ROWTYPE;   -- row BEFORE this signal (to detect a material change)
  v_patch    JSONB := COALESCE(p_patch, '{}'::jsonb);
  v_at       TIMESTAMPTZ := COALESCE(p_event_at, NOW());
  v_rev      JSONB := v_patch -> 'review';
  v_rev_id   TEXT;
  v_stale    BOOLEAN := FALSE;
  v_hold     TEXT := 'none';
  v_reason   TEXT := p_hold_reason;
  v_ins      INTEGER;
  v_changed  BOOLEAN;
  v_why      TEXT;
BEGIN
  IF p_event_type NOT IN ('review_opened','review_closed','early_fraud_warning','charge_outcome','synced') THEN
    RAISE EXCEPTION 'KVRN_FRAUD|EVENT_TYPE_INVALID';
  END IF;
  IF p_source IS NULL OR p_source !~ '^[a-z_]{3,40}$' THEN RAISE EXCEPTION 'KVRN_FRAUD|SOURCE_INVALID'; END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' OR char_length(p_actor) > 254 THEN RAISE EXCEPTION 'KVRN_FRAUD|ACTOR_INVALID'; END IF;
  IF p_hold_reason IS NOT NULL AND p_hold_reason !~ '^[a-z_]{3,60}$' THEN RAISE EXCEPTION 'KVRN_FRAUD|REASON_INVALID'; END IF;

  -- Serialise with mark_order_shipped() and the admin PATCH: they lock the same row.
  SELECT id, fulfillment_status, payment_status, stripe_payment_intent_id INTO o
    FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'order_not_found'); END IF;

  -- Idempotency: the first thing recorded is the event itself.
  IF p_stripe_event_id IS NOT NULL THEN
    INSERT INTO order_fraud_events (order_id, payment_intent_id, charge_id, event_type, actor, source,
                                    stripe_event_id, stripe_review_id, detail)
    VALUES (p_order_id, COALESCE(v_patch->>'payment_intent_id', o.stripe_payment_intent_id), v_patch->>'charge_id',
            p_event_type, p_actor, p_source, p_stripe_event_id, v_rev->>'id',
            jsonb_build_object('hold_reason', p_hold_reason, 'trigger_key', p_trigger_key))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    IF v_ins = 0 THEN RETURN jsonb_build_object('outcome', 'duplicate', 'order_id', p_order_id); END IF;
  END IF;

  INSERT INTO order_fraud_reviews (order_id, payment_intent_id) VALUES (p_order_id, o.stripe_payment_intent_id)
  ON CONFLICT (order_id) DO NOTHING;
  SELECT * INTO r FROM order_fraud_reviews WHERE order_id = p_order_id FOR UPDATE;
  b := r;

  -- identifiers
  r.payment_intent_id := COALESCE(v_patch->>'payment_intent_id', r.payment_intent_id, o.stripe_payment_intent_id);
  r.charge_id         := COALESCE(v_patch->>'charge_id', r.charge_id);

  -- charge outcome (key present => authoritative, including an explicit null = Unknown)
  IF v_patch ? 'risk_level'     THEN r.risk_level     := v_patch->>'risk_level'; END IF;
  IF v_patch ? 'risk_score'     THEN r.risk_score     := NULLIF(v_patch->>'risk_score','')::INTEGER; END IF;
  IF v_patch ? 'outcome_type'   THEN r.outcome_type   := v_patch->>'outcome_type'; END IF;
  IF v_patch ? 'outcome_reason' THEN r.outcome_reason := v_patch->>'outcome_reason'; END IF;
  IF v_patch ? 'seller_message' THEN r.seller_message := v_patch->>'seller_message'; END IF;
  IF jsonb_typeof(v_patch->'signals') = 'object' THEN r.signals := r.signals || (v_patch->'signals'); END IF;

  -- Stripe review (staleness by Stripe's own event time)
  IF jsonb_typeof(v_rev) = 'object' THEN
    v_rev_id := v_rev->>'id';
    IF r.stripe_review_event_at IS NOT NULL AND v_at < r.stripe_review_event_at THEN
      v_stale := TRUE;
    ELSIF r.stripe_review_state = 'closed' AND r.stripe_review_id IS NOT DISTINCT FROM v_rev_id
          AND (v_rev->>'open')::boolean IS TRUE THEN
      -- A Stripe review never re-opens. Event times have 1-second resolution, so an 'opened' delivered after
      -- the 'closed' of the SAME review within the same second (or a refresh that read the review just before
      -- it closed) is older news, not a new review.
      v_stale := TRUE;
    ELSE
      r.stripe_review_id            := COALESCE(v_rev_id, r.stripe_review_id);
      -- 'open' is always supplied by lib/fraud-review.ts; if it were ever missing the state is left as it was.
      r.stripe_review_state         := CASE WHEN (v_rev->>'open')::boolean IS TRUE  THEN 'open'
                                            WHEN (v_rev->>'open')::boolean IS FALSE THEN 'closed'
                                            ELSE r.stripe_review_state END;
      r.stripe_review_reason        := v_rev->>'reason';
      r.stripe_review_closed_reason := v_rev->>'closed_reason';
      r.stripe_review_event_at      := v_at;
    END IF;
  END IF;
  -- A stale review signal must not create a hold either (including a stale review read by a refresh/sync,
  -- whose hold cause is the review).
  IF v_stale AND (p_event_type IN ('review_opened','review_closed') OR p_trigger_key LIKE 'review:%') THEN v_reason := NULL; END IF;

  -- Hold decision --------------------------------------------------------------------------------
  IF v_reason IS NOT NULL THEN
    IF r.hold_state = 'active' THEN
      v_hold := 'already_active';
    ELSIF NOT COALESCE(p_holds_enabled, FALSE) THEN
      v_hold := 'disabled';
    ELSIF o.fulfillment_status NOT IN ('unfulfilled','processing') THEN
      v_hold := 'not_applicable'; v_why := 'order_' || o.fulfillment_status;
    ELSIF o.payment_status NOT IN ('paid','pending') THEN
      v_hold := 'not_applicable'; v_why := 'payment_' || o.payment_status;
    ELSIF p_trigger_key IS NOT NULL AND p_trigger_key = ANY (r.released_trigger_keys) THEN
      v_hold := 'previously_released';
    ELSIF p_trigger_key LIKE 'outcome:%' AND (cardinality(r.released_trigger_keys) > 0 OR r.hold_created_at IS NOT NULL) THEN
      -- The Radar outcome of a charge never changes. Once this order has been held (and released),
      -- the same historical outcome must not hold it again.
      v_hold := 'previously_released';
    ELSE
      r.hold_state := 'active'; r.hold_reason := v_reason; r.hold_source := p_source;
      r.hold_trigger_key := p_trigger_key; r.hold_created_at := NOW();
      r.released_by := NULL; r.released_at := NULL; r.release_note := NULL;
      v_hold := 'created';
    END IF;
  END IF;

  r.last_synced_at := NOW();
  r.sync_error := NULL;

  UPDATE order_fraud_reviews SET
    payment_intent_id = r.payment_intent_id, charge_id = r.charge_id,
    risk_level = r.risk_level, risk_score = r.risk_score, outcome_type = r.outcome_type,
    outcome_reason = r.outcome_reason, seller_message = r.seller_message, signals = r.signals,
    stripe_review_id = r.stripe_review_id, stripe_review_state = r.stripe_review_state,
    stripe_review_reason = r.stripe_review_reason, stripe_review_closed_reason = r.stripe_review_closed_reason,
    stripe_review_event_at = r.stripe_review_event_at,
    hold_state = r.hold_state, hold_reason = r.hold_reason, hold_source = r.hold_source,
    hold_trigger_key = r.hold_trigger_key, hold_created_at = r.hold_created_at,
    released_by = r.released_by, released_at = r.released_at, release_note = r.release_note,
    last_synced_at = r.last_synced_at, sync_error = NULL
  WHERE order_id = p_order_id;

  v_changed := (b.risk_level, b.risk_score, b.stripe_review_state, b.stripe_review_id, b.hold_state, b.outcome_type)
               IS DISTINCT FROM
               (r.risk_level, r.risk_score, r.stripe_review_state, r.stripe_review_id, r.hold_state, r.outcome_type);

  IF v_hold = 'created' THEN
    INSERT INTO order_fraud_events (order_id, payment_intent_id, charge_id, event_type, actor, source,
                                    stripe_event_id, stripe_review_id, detail)
    VALUES (p_order_id, r.payment_intent_id, r.charge_id, 'hold_created', p_actor, p_source,
            p_stripe_event_id, r.stripe_review_id,
            jsonb_build_object('reason', v_reason, 'trigger_key', p_trigger_key))
    ON CONFLICT DO NOTHING;
    -- Visible in the Admin audit trail too (a system action, not an Admin click).
    INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
    VALUES ('system@kvrn.internal', 'order.fraud_hold_created', 'order', p_order_id::text,
            jsonb_build_object('reason', v_reason, 'source', p_source, 'stripe_review_id', r.stripe_review_id,
                               'stripe_event_id', p_stripe_event_id));
  ELSIF v_hold IN ('disabled','not_applicable') AND p_stripe_event_id IS NOT NULL THEN
    INSERT INTO order_fraud_events (order_id, payment_intent_id, charge_id, event_type, actor, source,
                                    stripe_event_id, stripe_review_id, detail)
    VALUES (p_order_id, r.payment_intent_id, r.charge_id, 'hold_not_applied', p_actor, p_source,
            p_stripe_event_id, r.stripe_review_id,
            jsonb_build_object('why', CASE WHEN v_hold = 'disabled' THEN 'holds_disabled' ELSE v_why END,
                               'reason', v_reason))
    ON CONFLICT DO NOTHING;
  ELSIF p_stripe_event_id IS NULL AND v_changed AND p_event_type = 'synced' THEN
    INSERT INTO order_fraud_events (order_id, payment_intent_id, charge_id, event_type, actor, source,
                                    stripe_review_id, detail)
    VALUES (p_order_id, r.payment_intent_id, r.charge_id, 'synced', p_actor, p_source, r.stripe_review_id,
            jsonb_build_object('risk_level', r.risk_level, 'review_state', r.stripe_review_state, 'hold', v_hold));
  END IF;

  IF p_source = 'refresh' THEN
    INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
    VALUES (p_actor, 'order.fraud_refresh', 'order', p_order_id::text,
            jsonb_build_object('changed', v_changed, 'hold', v_hold));
  END IF;

  RETURN jsonb_build_object('outcome', 'applied', 'order_id', p_order_id, 'hold', v_hold,
                            'hold_state', r.hold_state, 'stale_review', v_stale, 'changed', v_changed);
END $$;

-- A Stripe lookup failed: keep the order's risk state Unknown and retryable ------------------------
CREATE OR REPLACE FUNCTION fraud_review_record_sync_failure(
  p_order_id UUID, p_code TEXT, p_source TEXT, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_code TEXT := left(regexp_replace(COALESCE(p_code, 'unknown'), '[^A-Za-z0-9_]', '', 'g'), 60);
  v_pi   TEXT;
BEGIN
  IF p_source IS NULL OR p_source !~ '^[a-z_]{3,40}$' THEN RAISE EXCEPTION 'KVRN_FRAUD|SOURCE_INVALID'; END IF;
  SELECT stripe_payment_intent_id INTO v_pi FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'order_not_found'); END IF;
  INSERT INTO order_fraud_reviews (order_id, payment_intent_id, sync_error) VALUES (p_order_id, v_pi, COALESCE(NULLIF(v_code,''), 'unknown'))
  ON CONFLICT (order_id) DO UPDATE SET sync_error = EXCLUDED.sync_error, updated_at = NOW();
  INSERT INTO order_fraud_events (order_id, payment_intent_id, event_type, actor, source, detail)
  VALUES (p_order_id, v_pi, 'sync_failed', COALESCE(NULLIF(btrim(p_actor), ''), 'system'), p_source,
          jsonb_build_object('code', COALESCE(NULLIF(v_code,''), 'unknown')));
  RETURN jsonb_build_object('outcome', 'recorded', 'order_id', p_order_id);
END $$;

-- A review / early-fraud-warning arrived before its order exists: park it, append-only ----------------
CREATE OR REPLACE FUNCTION fraud_review_record_unmatched(
  p_payment_intent_id TEXT, p_charge_id TEXT, p_event_type TEXT, p_stripe_event_id TEXT,
  p_stripe_review_id TEXT, p_detail JSONB
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_ins INTEGER;
BEGIN
  IF p_stripe_event_id IS NULL OR btrim(p_stripe_event_id) = '' THEN RAISE EXCEPTION 'KVRN_FRAUD|EVENT_ID_REQUIRED'; END IF;
  IF p_payment_intent_id IS NULL AND p_charge_id IS NULL THEN RAISE EXCEPTION 'KVRN_FRAUD|REFERENCE_REQUIRED'; END IF;
  INSERT INTO order_fraud_events (order_id, payment_intent_id, charge_id, event_type, actor, source,
                                  stripe_event_id, stripe_review_id, detail)
  VALUES (NULL, p_payment_intent_id, p_charge_id, 'unmatched_signal', 'stripe:webhook', 'webhook',
          p_stripe_event_id, p_stripe_review_id,
          COALESCE(p_detail, '{}'::jsonb) || jsonb_build_object('event_type', p_event_type))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  RETURN jsonb_build_object('outcome', CASE WHEN v_ins = 1 THEN 'parked' ELSE 'duplicate' END);
END $$;

-- Replay parked signals once the order exists (idempotent: each Stripe event applies at most once) -----
CREATE OR REPLACE FUNCTION fraud_review_apply_pending(p_order_id UUID, p_holds_enabled BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  o   RECORD;
  e   RECORD;
  v_n INTEGER := 0;
  d   JSONB;
BEGIN
  SELECT id, stripe_payment_intent_id, stripe_charge_id INTO o FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'order_not_found', 'applied', 0); END IF;
  FOR e IN
    SELECT * FROM order_fraud_events
     WHERE order_id IS NULL AND event_type = 'unmatched_signal'
       AND ((o.stripe_payment_intent_id IS NOT NULL AND payment_intent_id = o.stripe_payment_intent_id)
         OR (o.stripe_charge_id IS NOT NULL AND charge_id = o.stripe_charge_id))
     ORDER BY created_at, id
  LOOP
    d := e.detail;
    PERFORM fraud_review_apply_signal(
      p_order_id, d->>'event_type', d->'patch', d->>'hold_reason', d->>'trigger_key',
      p_holds_enabled, 'pending_replay', 'stripe:webhook', e.stripe_event_id,
      NULLIF(d->>'event_at','')::timestamptz);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('outcome', 'ok', 'applied', v_n);
END $$;

-- Admin: release the hold (explicit, audited, optional note). Allowed regardless of the feature flag. --------
CREATE OR REPLACE FUNCTION fraud_hold_release(p_order_id UUID, p_actor TEXT, p_note TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_actor TEXT := btrim(COALESCE(p_actor, ''));
  v_note  TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  r       order_fraud_reviews%ROWTYPE;
BEGIN
  IF v_actor = '' THEN RAISE EXCEPTION 'KVRN_FRAUD|ACTOR_REQUIRED'; END IF;
  IF char_length(v_actor) > 254 OR v_actor ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'KVRN_FRAUD|ACTOR_INVALID'; END IF;
  IF v_note IS NOT NULL AND (char_length(v_note) > 500 OR v_note ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'KVRN_FRAUD|NOTE_INVALID'; END IF;
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'KVRN_FRAUD|ORDER_REQUIRED'; END IF;

  PERFORM 1 FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_FRAUD|ORDER_NOT_FOUND'; END IF;
  SELECT * INTO r FROM order_fraud_reviews WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND OR r.hold_state = 'none' THEN RETURN jsonb_build_object('outcome', 'not_held', 'order_id', p_order_id); END IF;
  IF r.hold_state = 'released' THEN RETURN jsonb_build_object('outcome', 'already_released', 'order_id', p_order_id); END IF;

  UPDATE order_fraud_reviews SET
    hold_state = 'released', released_by = v_actor, released_at = NOW(), release_note = v_note,
    released_trigger_keys = CASE WHEN r.hold_trigger_key IS NULL OR r.hold_trigger_key = ANY (r.released_trigger_keys)
                                 THEN r.released_trigger_keys ELSE array_append(r.released_trigger_keys, r.hold_trigger_key) END
  WHERE order_id = p_order_id;
  INSERT INTO order_fraud_events (order_id, payment_intent_id, charge_id, event_type, actor, source, stripe_review_id, detail)
  VALUES (p_order_id, r.payment_intent_id, r.charge_id, 'hold_released', v_actor, 'admin', r.stripe_review_id,
          jsonb_build_object('reason', r.hold_reason, 'trigger_key', r.hold_trigger_key, 'has_note', v_note IS NOT NULL));
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'order.fraud_hold_release', 'order', p_order_id::text,
          jsonb_build_object('reason', r.hold_reason, 'source', r.hold_source, 'stripe_review_id', r.stripe_review_id,
                             'has_note', v_note IS NOT NULL, 'stripe_changed', false));
  RETURN jsonb_build_object('outcome', 'released', 'order_id', p_order_id);
END $$;

-- Admin: record that the payment is confirmed fraud. Keeps/creates the hold (when holds are enabled) so the
-- order cannot ship, and routes the money side to the EXISTING Stripe refund -> cancel flow. It does not
-- refund, cancel or restock anything itself. ----------------------------------------------------------
CREATE OR REPLACE FUNCTION fraud_mark_confirmed(
  p_order_id UUID, p_actor TEXT, p_note TEXT, p_holds_enabled BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_actor TEXT := btrim(COALESCE(p_actor, ''));
  v_note  TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  o       RECORD;
  r       order_fraud_reviews%ROWTYPE;
  v_hold  TEXT := 'none';
BEGIN
  IF v_actor = '' THEN RAISE EXCEPTION 'KVRN_FRAUD|ACTOR_REQUIRED'; END IF;
  IF char_length(v_actor) > 254 OR v_actor ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'KVRN_FRAUD|ACTOR_INVALID'; END IF;
  IF v_note IS NOT NULL AND (char_length(v_note) > 500 OR v_note ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'KVRN_FRAUD|NOTE_INVALID'; END IF;
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'KVRN_FRAUD|ORDER_REQUIRED'; END IF;

  SELECT id, fulfillment_status, payment_status, stripe_payment_intent_id INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_FRAUD|ORDER_NOT_FOUND'; END IF;
  INSERT INTO order_fraud_reviews (order_id, payment_intent_id) VALUES (p_order_id, o.stripe_payment_intent_id)
  ON CONFLICT (order_id) DO NOTHING;
  SELECT * INTO r FROM order_fraud_reviews WHERE order_id = p_order_id FOR UPDATE;
  IF r.fraud_confirmed_at IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'already_confirmed', 'order_id', p_order_id); END IF;

  IF r.hold_state = 'active' THEN
    v_hold := 'already_active';
  ELSIF COALESCE(p_holds_enabled, FALSE) AND o.fulfillment_status IN ('unfulfilled','processing') AND o.payment_status IN ('paid','pending') THEN
    UPDATE order_fraud_reviews SET hold_state = 'active', hold_reason = 'confirmed_fraud', hold_source = 'admin',
      hold_trigger_key = 'confirmed:' || p_order_id::text, hold_created_at = NOW(),
      released_by = NULL, released_at = NULL, release_note = NULL
    WHERE order_id = p_order_id;
    INSERT INTO order_fraud_events (order_id, payment_intent_id, charge_id, event_type, actor, source, stripe_review_id, detail)
    VALUES (p_order_id, r.payment_intent_id, r.charge_id, 'hold_created', v_actor, 'admin', r.stripe_review_id,
            jsonb_build_object('reason', 'confirmed_fraud'));
    v_hold := 'created';
  END IF;

  UPDATE order_fraud_reviews SET fraud_confirmed_by = v_actor, fraud_confirmed_at = NOW(), fraud_confirmed_note = v_note
   WHERE order_id = p_order_id;
  INSERT INTO order_fraud_events (order_id, payment_intent_id, charge_id, event_type, actor, source, stripe_review_id, detail)
  VALUES (p_order_id, r.payment_intent_id, r.charge_id, 'confirmed_fraud', v_actor, 'admin', r.stripe_review_id,
          jsonb_build_object('has_note', v_note IS NOT NULL, 'hold', v_hold));
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'order.fraud_confirmed', 'order', p_order_id::text,
          jsonb_build_object('has_note', v_note IS NOT NULL, 'hold', v_hold, 'stripe_review_id', r.stripe_review_id));
  RETURN jsonb_build_object('outcome', 'confirmed', 'order_id', p_order_id, 'hold', v_hold);
END $$;

COMMIT;
