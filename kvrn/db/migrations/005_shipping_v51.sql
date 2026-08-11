-- KVRN Migration 005 — Shipment Uniqueness + Shipping Email + mark_order_shipped()
-- Run AFTER migrations 001–004.
--
-- Test database FIRST:
--   set -a && source .env.local && set +a
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/005_shipping_v51.sql
--
-- Production (PRODUCTION_MIGRATION_URL only — never DATABASE_URL):
--   psql "$PRODUCTION_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/005_shipping_v51.sql
--
-- PREFLIGHT: verify no duplicate order_id rows exist in shipments:
--   SELECT order_id, COUNT(*) FROM shipments GROUP BY order_id HAVING COUNT(*) > 1;
-- If any rows are returned, resolve duplicates manually before applying this migration.

BEGIN;

-- ── 1. Extend transactional_emails email_type to include shipping_confirmation ─

-- Drop and recreate CHECK constraint (PostgreSQL cannot ALTER a check constraint)
ALTER TABLE transactional_emails
  DROP CONSTRAINT IF EXISTS te_v51_email_type_chk;

ALTER TABLE transactional_emails
  ADD CONSTRAINT te_v51_email_type_chk
  CHECK (email_type IN ('order_confirmation', 'shipping_confirmation'));

-- ── 2. Enforce exactly one shipment per order ─────────────────────────────────

-- Safety guard: fail migration cleanly if duplicate order_ids exist
DO $$
DECLARE dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT order_id FROM shipments
    GROUP BY order_id HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'MIGRATION_BLOCKED: % order_id(s) have multiple shipment rows. '
      'Resolve duplicates before running migration 005.', dup_count;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shipments_v51_order_uq'
      AND conrelid = 'shipments'::regclass
  ) THEN
    ALTER TABLE shipments
      ADD CONSTRAINT shipments_v51_order_uq UNIQUE (order_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipments_v51_order ON shipments(order_id);

-- ── 3. mark_order_shipped() — atomic ship + email insertion ───────────────────
--
-- All seven steps commit together or all roll back:
--   lock order → validate transition → create shipment (UNIQUE guard) →
--   update order status → insert email outbox → return typed outcome

CREATE OR REPLACE FUNCTION mark_order_shipped(
  p_order_id       UUID,
  p_carrier        TEXT,
  p_tracking_number TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_ord       RECORD;
  v_ship_id   UUID;
  v_cust_email TEXT;
BEGIN
  -- Lock the order row
  SELECT id, fulfillment_status, customer_email
  INTO v_ord
  FROM orders WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Idempotent: already shipped with same carrier+tracking → return safely
  IF v_ord.fulfillment_status = 'shipped' THEN
    SELECT id INTO v_ship_id FROM shipments WHERE order_id = p_order_id LIMIT 1;
    RETURN jsonb_build_object(
      'outcome',    'already_shipped',
      'shipment_id', v_ship_id
    );
  END IF;

  -- Only processing → shipped is permitted in V51.3
  IF v_ord.fulfillment_status <> 'processing' THEN
    RETURN jsonb_build_object(
      'outcome',        'invalid_transition',
      'current_status', v_ord.fulfillment_status
    );
  END IF;

  -- Validate inputs (server-side guard; caller also validates)
  IF p_carrier IS NULL OR trim(p_carrier) = '' THEN
    RAISE EXCEPTION 'KVRN_SHIPPING|CARRIER_REQUIRED';
  END IF;
  IF p_tracking_number IS NULL OR trim(p_tracking_number) = '' THEN
    RAISE EXCEPTION 'KVRN_SHIPPING|TRACKING_REQUIRED';
  END IF;

  -- Create shipment — UNIQUE(order_id) prevents concurrent duplicates
  INSERT INTO shipments (order_id, carrier, tracking_number, shipped_at)
  VALUES (p_order_id, trim(p_carrier), trim(p_tracking_number), NOW())
  RETURNING id INTO v_ship_id;

  -- Update order status
  UPDATE orders
  SET fulfillment_status = 'shipped', updated_at = NOW()
  WHERE id = p_order_id;

  -- Insert shipping_confirmation email outbox row — same transaction
  -- Only when customer_email is present; skip silently if missing
  v_cust_email := v_ord.customer_email;
  IF v_cust_email IS NOT NULL AND v_cust_email <> '' THEN
    INSERT INTO transactional_emails
      (order_id, email_type, recipient_email, status, idempotency_key)
    VALUES
      (p_order_id, 'shipping_confirmation', v_cust_email,
       'pending', 'shipping-confirmation/' || p_order_id)
    ON CONFLICT (order_id, email_type) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'outcome',    'shipped',
    'shipment_id', v_ship_id
  );
END;
$$;

COMMIT;

-- Verify
SELECT 'email_type_chk updated' AS step,
  pg_get_constraintdef(c.oid) AS constraint_def
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
WHERE t.relname = 'transactional_emails' AND c.conname = 'te_v51_email_type_chk';

SELECT 'shipments_order_uq added' AS step,
  COUNT(*) AS constraint_count
FROM pg_constraint
WHERE conname = 'shipments_v51_order_uq';
