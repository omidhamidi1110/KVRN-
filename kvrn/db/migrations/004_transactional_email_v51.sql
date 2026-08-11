-- KVRN Migration 004 — Transactional Email Outbox
-- Run AFTER migrations 001–003.
--
-- Test database first:
--   set -a && source .env.local && set +a
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/004_transactional_email_v51.sql
--
-- Production (use PRODUCTION_MIGRATION_URL, never DATABASE_URL):
--   psql "$PRODUCTION_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/004_transactional_email_v51.sql

BEGIN;

CREATE TABLE IF NOT EXISTS transactional_emails (
  id                  UUID        CONSTRAINT te_v51_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  email_type          TEXT        NOT NULL
    CONSTRAINT te_v51_email_type_chk
    CHECK (email_type IN ('order_confirmation')),
  recipient_email     TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'pending'
    CONSTRAINT te_v51_status_chk
    CHECK (status IN ('pending','sending','sent','failed')),
  attempt_count       INTEGER     NOT NULL DEFAULT 0
    CONSTRAINT te_v51_attempt_count_chk CHECK (attempt_count >= 0),
  provider_message_id TEXT,
  provider            TEXT,
  idempotency_key     TEXT        NOT NULL
    CONSTRAINT te_v51_idempotency_key_uq UNIQUE,
  last_error          TEXT,
  next_attempt_at     TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One email job per order per type — prevents duplicate jobs on replay
  CONSTRAINT te_v51_order_type_uq UNIQUE (order_id, email_type)
);

CREATE INDEX IF NOT EXISTS idx_te_v51_status          ON transactional_emails(status);
CREATE INDEX IF NOT EXISTS idx_te_v51_next_attempt    ON transactional_emails(next_attempt_at)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_te_v51_order_id        ON transactional_emails(order_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='set_te_v51_updated_at') THEN
    CREATE TRIGGER set_te_v51_updated_at BEFORE UPDATE ON transactional_emails
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;

SELECT 'transactional_emails' AS tbl, COUNT(*) FROM transactional_emails;

-- Update finalize_paid_order to insert outbox row in the same transaction.
-- This replaces the version from migration 003.

BEGIN;

CREATE OR REPLACE FUNCTION finalize_paid_order(
  p_stripe_session_id     TEXT,
  p_reservation_id_hint   UUID,
  p_stripe_payment_intent TEXT,
  p_stripe_event_id       TEXT,
  p_event_type            TEXT,
  p_expected_currency     TEXT,
  p_amount_total          INTEGER,
  p_customer_email        TEXT,
  p_customer_name         TEXT,
  p_customer_phone        TEXT,
  p_shipping_address      JSONB
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_res          RECORD;
  v_item         RECORD;
  v_order_id     UUID;
  v_order_num    TEXT;
  v_merch_total  INTEGER := 0;
  v_shipping     INTEGER := 0;
  v_expected     INTEGER := 0;
  v_cust_email   TEXT;
  v_cust_name    TEXT;
  v_cust_phone   TEXT;
  v_ship_addr    JSONB;
  v_ship_method  TEXT;
BEGIN
  -- Claim event row-lock
  INSERT INTO webhook_events (stripe_event_id, event_type, payload, processed)
  VALUES (p_stripe_event_id, p_event_type, '{"auto":true}'::jsonb, false)
  ON CONFLICT (stripe_event_id) DO NOTHING;
  PERFORM id FROM webhook_events WHERE stripe_event_id=p_stripe_event_id FOR UPDATE;
  IF (SELECT processed FROM webhook_events WHERE stripe_event_id=p_stripe_event_id) THEN
    SELECT id, order_number INTO v_order_id, v_order_num
    FROM orders WHERE stripe_checkout_session_id=p_stripe_session_id;
    RETURN jsonb_build_object('outcome','already_processed','order_id',v_order_id,
           'order_number',v_order_num,'already_processed',true);
  END IF;

  -- Lock reservation FIRST
  SELECT id, status, stripe_checkout_session_id,
         customer_email, customer_name, customer_phone,
         shipping_address, shipping_method, shipping_cents
  INTO v_res
  FROM reservations WHERE stripe_checkout_session_id=p_stripe_session_id FOR UPDATE;

  IF NOT FOUND AND p_reservation_id_hint IS NOT NULL THEN
    SELECT id, status, stripe_checkout_session_id,
           customer_email, customer_name, customer_phone,
           shipping_address, shipping_method, shipping_cents
    INTO v_res
    FROM reservations WHERE id=p_reservation_id_hint FOR UPDATE;
    IF FOUND THEN
      IF v_res.stripe_checkout_session_id IS NOT NULL
         AND v_res.stripe_checkout_session_id <> p_stripe_session_id THEN
        v_res.id := NULL;
      ELSIF v_res.stripe_checkout_session_id IS NULL THEN
        UPDATE reservations SET stripe_checkout_session_id=p_stripe_session_id, updated_at=NOW()
        WHERE id=v_res.id;
      END IF;
    END IF;
  END IF;

  -- Check for existing order after lock
  SELECT id, order_number INTO v_order_id, v_order_num
  FROM orders WHERE stripe_checkout_session_id=p_stripe_session_id;
  IF FOUND THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='already_had_order'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','already_had_order','order_id',v_order_id,
           'order_number',v_order_num,'already_processed',true);
  END IF;

  IF v_res.id IS NULL THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='no_reservation'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','no_reservation','already_processed',false);
  END IF;
  IF v_res.status NOT IN ('open','awaiting_payment','creating') THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='reservation_not_eligible'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','reservation_not_eligible','already_processed',false);
  END IF;

  IF lower(p_expected_currency) <> 'usd' THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|CURRENCY_MISMATCH|got:%', p_expected_currency;
  END IF;

  SELECT COALESCE(SUM(unit_price_cents * quantity), 0) INTO v_merch_total
  FROM reservation_items WHERE reservation_id=v_res.id;
  v_shipping := COALESCE(v_res.shipping_cents, 0);
  v_expected := v_merch_total + v_shipping;
  IF p_amount_total <> v_expected THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|AMOUNT_MISMATCH|stripe:% expected:%', p_amount_total, v_expected;
  END IF;

  -- V50 snapshot (shipping_method IS NOT NULL) wins over webhook fallback
  IF v_res.shipping_method IS NOT NULL THEN
    v_cust_email  := v_res.customer_email;
    v_cust_name   := v_res.customer_name;
    v_cust_phone  := v_res.customer_phone;
    v_ship_addr   := v_res.shipping_address;
    v_ship_method := v_res.shipping_method;
  ELSE
    v_cust_email  := p_customer_email;
    v_cust_name   := p_customer_name;
    v_cust_phone  := p_customer_phone;
    v_ship_addr   := p_shipping_address;
    v_ship_method := NULL;
  END IF;

  v_order_num := 'KVRN-' || LPAD(nextval('order_number_seq')::TEXT, 6, '0');

  INSERT INTO orders (
    order_number, stripe_checkout_session_id, stripe_payment_intent_id,
    reservation_id, payment_status, currency,
    subtotal_cents, shipping_cents, total_cents, shipping_method,
    customer_email, customer_name, customer_phone, shipping_address, paid_at
  ) VALUES (
    v_order_num, p_stripe_session_id, NULLIF(p_stripe_payment_intent,''),
    v_res.id, 'paid', 'usd',
    v_merch_total, v_shipping, p_amount_total, v_ship_method,
    v_cust_email, v_cust_name, v_cust_phone, v_ship_addr, NOW()
  ) RETURNING id INTO v_order_id;

  -- Deduct inventory
  FOR v_item IN
    SELECT ri.variant_id, ri.sku, ri.product_name, ri.size, ri.color,
           ri.quantity, ri.unit_price_cents
    FROM reservation_items ri WHERE ri.reservation_id=v_res.id
    ORDER BY ri.sku
  LOOP
    INSERT INTO order_items (
      order_id, variant_id, sku, product_name, size, color,
      quantity, unit_price_cents, line_total_cents
    ) VALUES (
      v_order_id, v_item.variant_id, v_item.sku, v_item.product_name,
      v_item.size, v_item.color, v_item.quantity, v_item.unit_price_cents,
      v_item.unit_price_cents * v_item.quantity
    );

    UPDATE product_variants
    SET stock_on_hand=stock_on_hand-v_item.quantity,
        reserved_quantity=reserved_quantity-v_item.quantity, updated_at=NOW()
    WHERE id=v_item.variant_id
      AND stock_on_hand>=v_item.quantity AND reserved_quantity>=v_item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|DEDUCT_INVARIANT|%', v_item.sku;
    END IF;

    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, order_id, reservation_id)
    VALUES (v_item.variant_id, -v_item.quantity, 'DEDUCT', 'paid_order',
            'order:' || v_order_id || ' reservation:' || v_res.id,
            'system@kvrn.internal', v_order_id, v_res.id);
  END LOOP;

  UPDATE reservations SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=v_res.id;

  -- Insert email outbox row in the SAME transaction — rolls back if order rolls back.
  -- Only create row when we have a recipient email address.
  -- UNIQUE(order_id, email_type) prevents duplicate rows on replay.
  IF v_cust_email IS NOT NULL AND v_cust_email <> '' THEN
    INSERT INTO transactional_emails
      (order_id, email_type, recipient_email, status, idempotency_key)
    VALUES
      (v_order_id, 'order_confirmation', v_cust_email,
       'pending', 'order-confirmation/' || v_order_id)
    ON CONFLICT (order_id, email_type) DO NOTHING;
  END IF;

  UPDATE webhook_events SET processed=true, processed_at=NOW(), result='order_created'
  WHERE stripe_event_id=p_stripe_event_id;

  RETURN jsonb_build_object('outcome','order_created','order_id',v_order_id,
         'order_number',v_order_num,'already_processed',false);
END;
$$;

COMMIT;
