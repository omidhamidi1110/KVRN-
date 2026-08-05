-- KVRN V50 Migration 003 — Checkout Shipping Snapshot
-- Run AFTER migration 002 (use PRODUCTION_MIGRATION_URL, never DATABASE_URL):
--   psql "$PRODUCTION_MIGRATION_URL" \
--     -v ON_ERROR_STOP=1 \
--     -f db/migrations/003_checkout_shipping_v50.sql

BEGIN;

-- ── 1. Add checkout snapshot columns to reservations ─────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reservations' AND column_name='customer_email') THEN
    ALTER TABLE reservations ADD COLUMN customer_email TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reservations' AND column_name='customer_name') THEN
    ALTER TABLE reservations ADD COLUMN customer_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reservations' AND column_name='customer_phone') THEN
    ALTER TABLE reservations ADD COLUMN customer_phone TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reservations' AND column_name='shipping_address') THEN
    ALTER TABLE reservations ADD COLUMN shipping_address JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reservations' AND column_name='shipping_method') THEN
    ALTER TABLE reservations ADD COLUMN shipping_method TEXT
      CONSTRAINT reservations_v50_shipping_method_chk
      CHECK (shipping_method IS NULL OR shipping_method IN ('standard', 'express'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reservations' AND column_name='shipping_cents') THEN
    ALTER TABLE reservations ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0
      CONSTRAINT reservations_v50_shipping_cents_chk CHECK (shipping_cents >= 0);
  END IF;
END $$;

-- ── 2. Add shipping_method to orders ─────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='orders' AND column_name='shipping_method') THEN
    ALTER TABLE orders ADD COLUMN shipping_method TEXT
      CONSTRAINT orders_v50_shipping_method_chk
      CHECK (shipping_method IS NULL OR shipping_method IN ('standard', 'express'));
  END IF;
END $$;

-- ── 3. save_reservation_checkout_details function ────────────────────────────

CREATE OR REPLACE FUNCTION save_reservation_checkout_details(
  p_reservation_id    UUID,
  p_customer_email    TEXT,
  p_customer_name     TEXT,
  p_customer_phone    TEXT,
  p_shipping_address  JSONB,
  p_shipping_method   TEXT,
  p_shipping_cents    INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF p_shipping_method NOT IN ('standard', 'express') THEN
    RAISE EXCEPTION 'Invalid shipping_method: %', p_shipping_method;
  END IF;
  IF p_shipping_cents < 0 THEN
    RAISE EXCEPTION 'shipping_cents must be >= 0';
  END IF;

  UPDATE reservations
  SET customer_email   = p_customer_email,
      customer_name    = p_customer_name,
      customer_phone   = p_customer_phone,
      shipping_address = p_shipping_address,
      shipping_method  = p_shipping_method,
      shipping_cents   = p_shipping_cents,
      updated_at       = NOW()
  WHERE id = p_reservation_id
    AND status IN ('creating', 'open');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- ── 4. Update finalize_paid_order to use reservation snapshot ─────────────────
-- Keeps the same 11-argument signature for TypeScript compatibility.
-- Merchandise subtotal + reservation.shipping_cents = trusted expected total.

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

  -- Lock reservation first
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

  -- Check for existing order after holding reservation lock
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

  -- Currency check
  IF lower(p_expected_currency) <> 'usd' THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|CURRENCY_MISMATCH|got:%', p_expected_currency;
  END IF;

  -- Trusted total: merchandise from reservation_items + shipping from reservation snapshot
  SELECT COALESCE(SUM(unit_price_cents * quantity), 0) INTO v_merch_total
  FROM reservation_items WHERE reservation_id=v_res.id;
  v_shipping := COALESCE(v_res.shipping_cents, 0);
  v_expected := v_merch_total + v_shipping;

  IF p_amount_total <> v_expected THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|AMOUNT_MISMATCH|stripe:% expected:%', p_amount_total, v_expected;
  END IF;

  -- Prefer reservation snapshot for customer info; fallback to webhook values
  -- Fix 1: treat V50 reservation snapshot as one authoritative unit.
  -- shipping_method IS NOT NULL signals a V50 snapshot was saved before Stripe opened.
  -- For V50 snapshots, use the complete reservation — including NULL customer_phone
  -- (intentional: customer did not opt into SMS updates) — never field-by-field COALESCE.
  -- Legacy V49 reservations have shipping_method IS NULL and fall back to webhook values.
  IF v_res.shipping_method IS NOT NULL THEN
    -- V50 snapshot: authoritative — preserve every field including intentional NULLs
    v_cust_email  := v_res.customer_email;
    v_cust_name   := v_res.customer_name;
    v_cust_phone  := v_res.customer_phone;   -- NULL when customer declined SMS opt-in
    v_ship_addr   := v_res.shipping_address;
    v_ship_method := v_res.shipping_method;
  ELSE
    -- Legacy V49 reservation: no snapshot saved — use webhook values as fallback
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

  -- Create order items + deduct inventory (snapshot data, deterministic SKU order)
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
  UPDATE webhook_events SET processed=true, processed_at=NOW(), result='order_created'
  WHERE stripe_event_id=p_stripe_event_id;

  RETURN jsonb_build_object('outcome','order_created','order_id',v_order_id,
         'order_number',v_order_num,'already_processed',false);
END;
$$;

COMMIT;

-- Verify
SELECT 'reservations.shipping_cents' AS col,
       data_type FROM information_schema.columns
WHERE table_name='reservations' AND column_name='shipping_cents';

SELECT 'orders.shipping_method' AS col,
       data_type FROM information_schema.columns
WHERE table_name='orders' AND column_name='shipping_method';
