-- KVRN Migration 017 — COGS snapshot + attribution copy + shipping quote at finalization
--
-- HIGHEST-RISK MIGRATION IN PHASE B. It replaces finalize_paid_order, the function that
-- creates every paid order. Everything below preserves the migration-009 behaviour
-- byte-for-byte except for four strictly additive changes:
--
--   1. reservations gains shipping_quoted_cents / shipping_auto_free_discount_cents
--   2. save_reservation_checkout_details accepts those two new values
--   3. finalize_paid_order snapshots per-line COGS onto order_items
--   4. finalize_paid_order copies reservations.attribution -> orders.attribution
--      and the shipping quote fields -> orders
--
-- UNCHANGED and verified against 009: the 11-argument signature, webhook idempotency
-- lock, reservation locking + hint fallback, currency guard, AMOUNT_MISMATCH invariant,
-- inventory deduction invariant, inventory_movements rows, discount claim/redemption
-- finalization, limited-code guard, and the transactional email outbox insert.
--
-- COGS FAILURE MUST NEVER BLOCK AN ORDER. Cost resolution is a LEFT-JOIN style lookup:
-- when no cost batch exists the snapshot columns are simply left NULL and the order
-- completes normally. NULL means "unknown", and the financial layer refuses to treat
-- it as zero.
--
-- Run after 001-016.

BEGIN;

-- ── 1. reservations: shipping quote snapshot ─────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reservations' AND column_name = 'shipping_quoted_cents'
  ) THEN
    ALTER TABLE reservations ADD COLUMN shipping_quoted_cents INTEGER
      CHECK (shipping_quoted_cents IS NULL OR shipping_quoted_cents >= 0);
    ALTER TABLE reservations ADD COLUMN shipping_auto_free_discount_cents INTEGER NOT NULL DEFAULT 0
      CHECK (shipping_auto_free_discount_cents >= 0);
  END IF;
END $$;

-- ── 2. save_reservation_checkout_details — replace with 2 extra params ───────
--
-- Adding DEFAULT parameters via CREATE OR REPLACE would create an OVERLOAD, not a
-- replacement, making the existing 13-argument call ambiguous. The old signature is
-- therefore dropped explicitly inside this transaction before the new one is created.
DROP FUNCTION IF EXISTS save_reservation_checkout_details(
  UUID, TEXT, TEXT, TEXT, JSONB, TEXT, INTEGER, INTEGER, INTEGER, UUID, TEXT, TEXT, INTEGER
);

CREATE OR REPLACE FUNCTION save_reservation_checkout_details(
  p_reservation_id             UUID,
  p_customer_email             TEXT,
  p_customer_name              TEXT,
  p_customer_phone             TEXT,
  p_shipping_address           JSONB,
  p_shipping_method            TEXT,
  p_shipping_before_discount   INTEGER DEFAULT 0,
  p_shipping_discount_cents    INTEGER DEFAULT 0,
  p_shipping_final_cents       INTEGER DEFAULT 0,
  p_discount_id                UUID    DEFAULT NULL,
  p_discount_code              TEXT    DEFAULT NULL,
  p_discount_type              TEXT    DEFAULT NULL,
  p_discount_cents             INTEGER DEFAULT 0,
  -- NEW: live carrier quote before ANY reduction, and the automatic free-shipping waiver
  p_shipping_quoted_cents      INTEGER DEFAULT NULL,
  p_shipping_auto_free_cents   INTEGER DEFAULT 0
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  IF p_shipping_method NOT IN ('standard','express') THEN
    RAISE EXCEPTION 'Invalid shipping_method: %', p_shipping_method;
  END IF;
  UPDATE reservations
  SET
    customer_email                 = p_customer_email,
    customer_name                  = p_customer_name,
    customer_phone                 = p_customer_phone,
    shipping_address               = p_shipping_address,
    shipping_method                = p_shipping_method,
    shipping_cents                 = p_shipping_final_cents,
    shipping_before_discount_cents = p_shipping_before_discount,
    shipping_discount_cents        = p_shipping_discount_cents,
    shipping_final_cents           = p_shipping_final_cents,
    shipping_quoted_cents             = p_shipping_quoted_cents,
    shipping_auto_free_discount_cents = COALESCE(p_shipping_auto_free_cents, 0),
    discount_id                    = p_discount_id,
    discount_code                  = p_discount_code,
    discount_type                  = p_discount_type,
    discount_cents                 = COALESCE(p_discount_cents, 0),
    updated_at                     = NOW()
  WHERE id = p_reservation_id
    AND status IN ('open','creating','awaiting_payment');
  RETURN FOUND;
END;
$$;

-- ── 3. resolve_cost_batch() — cost lookup with deterministic precedence ──────
--
-- Precedence (most specific first). Within a tier the newest effective_from wins.
--   1. variant-specific batch
--   2. colour-group batch for the product
--   3. product default batch
-- Returns NULL when nothing matches, which the caller treats as "cost unknown".
CREATE OR REPLACE FUNCTION resolve_cost_batch(
  p_variant_id UUID,
  p_sale_date  DATE
) RETURNS product_cost_batches
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_product_id UUID;
  v_color      TEXT;
  v_batch      product_cost_batches;
BEGIN
  IF p_variant_id IS NULL THEN RETURN NULL; END IF;

  SELECT product_id, color_name INTO v_product_id, v_color
  FROM product_variants WHERE id = p_variant_id;

  IF v_product_id IS NULL THEN RETURN NULL; END IF;

  -- Tier 1: variant-specific
  SELECT * INTO v_batch FROM product_cost_batches
  WHERE variant_id = p_variant_id
    AND effective_from <= p_sale_date
  ORDER BY effective_from DESC, created_at DESC
  LIMIT 1;
  IF FOUND THEN RETURN v_batch; END IF;

  -- Tier 2: colour group
  SELECT * INTO v_batch FROM product_cost_batches
  WHERE product_id = v_product_id
    AND color_name = v_color
    AND variant_id IS NULL
    AND effective_from <= p_sale_date
  ORDER BY effective_from DESC, created_at DESC
  LIMIT 1;
  IF FOUND THEN RETURN v_batch; END IF;

  -- Tier 3: product default
  SELECT * INTO v_batch FROM product_cost_batches
  WHERE product_id = v_product_id
    AND color_name IS NULL
    AND variant_id IS NULL
    AND effective_from <= p_sale_date
  ORDER BY effective_from DESC, created_at DESC
  LIMIT 1;
  IF FOUND THEN RETURN v_batch; END IF;

  RETURN NULL;
END;
$$;

-- ── 4. finalize_paid_order() — identical signature, additive snapshots ───────
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
  v_res              RECORD;
  v_item             RECORD;
  v_order_id         UUID;
  v_order_num        TEXT;
  v_merch_total      INTEGER := 0;
  v_discount_cents   INTEGER := 0;   -- merchandise/order discount only
  v_ship_before      INTEGER := 0;   -- shipping before any discount
  v_ship_discount    INTEGER := 0;   -- shipping reduction
  v_ship_final       INTEGER := 0;   -- actual net shipping charged
  v_expected         INTEGER := 0;
  v_cust_email       TEXT;
  v_cust_name        TEXT;
  v_cust_phone       TEXT;
  v_ship_addr        JSONB;
  v_ship_method      TEXT;
  v_claim_id         UUID;
  v_redemption_id    UUID;
  v_is_limited_code  BOOLEAN;
  -- NEW
  v_batch            product_cost_batches;
  v_sale_date        DATE := (NOW() AT TIME ZONE 'UTC')::DATE;
BEGIN
  -- Idempotency lock
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

  -- Lock reservation  (NEW: also selects attribution + shipping quote columns)
  SELECT id, status, stripe_checkout_session_id,
         customer_email, customer_name, customer_phone,
         shipping_address, shipping_method, shipping_cents,
         discount_id, discount_code, discount_type, discount_cents,
         shipping_before_discount_cents, shipping_discount_cents, shipping_final_cents,
         shipping_quoted_cents, shipping_auto_free_discount_cents, attribution
  INTO v_res
  FROM reservations WHERE stripe_checkout_session_id=p_stripe_session_id FOR UPDATE;

  IF NOT FOUND AND p_reservation_id_hint IS NOT NULL THEN
    SELECT id, status, stripe_checkout_session_id,
           customer_email, customer_name, customer_phone,
           shipping_address, shipping_method, shipping_cents,
           discount_id, discount_code, discount_type, discount_cents,
           shipping_before_discount_cents, shipping_discount_cents, shipping_final_cents,
           shipping_quoted_cents, shipping_auto_free_discount_cents, attribution
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

  -- Resolve discount and shipping values from reservation snapshot
  v_discount_cents := COALESCE(v_res.discount_cents, 0);          -- merchandise only
  v_ship_before    := COALESCE(v_res.shipping_before_discount_cents,
                                v_res.shipping_cents, 0);
  v_ship_discount  := COALESCE(v_res.shipping_discount_cents, 0);
  v_ship_final     := COALESCE(v_res.shipping_final_cents,
                                v_res.shipping_cents, 0);

  -- Expected = merch - merch_discount + final_shipping
  -- shipping_final already contains the shipping reduction
  -- Never subtract shipping_discount twice
  v_expected := GREATEST(0, v_merch_total - v_discount_cents) + v_ship_final;

  IF p_amount_total <> v_expected THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|AMOUNT_MISMATCH|stripe:% expected:%', p_amount_total, v_expected;
  END IF;

  -- Use snapshot values
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
    subtotal_cents, shipping_cents, discount_cents, total_cents, shipping_method,
    discount_code, discount_id, discount_type,
    shipping_before_discount_cents, shipping_discount_cents,
    shipping_quoted_cents, shipping_auto_free_discount_cents, attribution,
    customer_email, customer_name, customer_phone, shipping_address, paid_at
  ) VALUES (
    v_order_num, p_stripe_session_id, NULLIF(p_stripe_payment_intent,''),
    v_res.id, 'paid', 'usd',
    v_merch_total,
    v_ship_final,     -- shipping_cents = final charged (backwards compatible)
    v_discount_cents, -- merchandise discount only
    p_amount_total,   -- total_cents = actual paid amount
    v_ship_method,
    v_res.discount_code, v_res.discount_id, v_res.discount_type,
    v_ship_before, v_ship_discount,
    -- NEW: carrier quote before any reduction + automatic free-shipping waiver + attribution
    v_res.shipping_quoted_cents,
    COALESCE(v_res.shipping_auto_free_discount_cents, 0),
    v_res.attribution,
    v_cust_email, v_cust_name, v_cust_phone, v_ship_addr, NOW()
  ) RETURNING id INTO v_order_id;

  -- Deduct inventory
  FOR v_item IN
    SELECT ri.variant_id, ri.sku, ri.product_name, ri.size, ri.color,
           ri.quantity, ri.unit_price_cents
    FROM reservation_items ri WHERE ri.reservation_id=v_res.id ORDER BY ri.sku
  LOOP
    -- NEW: resolve the cost batch in force on the sale date.
    -- NULL result => snapshot columns stay NULL => "cost unknown", never 0.
    v_batch := resolve_cost_batch(v_item.variant_id, v_sale_date);

    INSERT INTO order_items (
      order_id, variant_id, sku, product_name, size, color,
      quantity, unit_price_cents, line_total_cents,
      cost_batch_id,
      unit_manufacturing_cents, unit_freight_cents, unit_duties_cents,
      unit_tariffs_cents, unit_import_tax_cents, unit_packaging_cents,
      unit_other_landed_cents,
      unit_cogs_cents, line_cogs_cents
    ) VALUES (
      v_order_id, v_item.variant_id, v_item.sku, v_item.product_name,
      v_item.size, v_item.color, v_item.quantity, v_item.unit_price_cents,
      v_item.unit_price_cents * v_item.quantity,
      v_batch.id,
      v_batch.manufacturing_cents, v_batch.freight_cents, v_batch.duties_cents,
      v_batch.tariffs_cents, v_batch.import_tax_cents, v_batch.packaging_cents,
      v_batch.other_landed_cents,
      v_batch.unit_cogs_cents,
      CASE WHEN v_batch.unit_cogs_cents IS NULL THEN NULL
           ELSE v_batch.unit_cogs_cents * v_item.quantity END
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

  -- ── Discount finalization (strictly idempotent via INSERT RETURNING) ──────────
  IF v_res.discount_id IS NOT NULL THEN
    -- Determine if this is a limited-use code (requires a valid claim)
    SELECT (single_use OR max_redemptions IS NOT NULL)
    INTO v_is_limited_code
    FROM discounts WHERE id = v_res.discount_id;

    -- Find active finalizable claim for this reservation
    SELECT id INTO v_claim_id
    FROM discount_claims
    WHERE reservation_id = v_res.id
      AND discount_id = v_res.discount_id
      AND finalized_at IS NULL
      AND released_at IS NULL
    FOR UPDATE;

    -- For limited codes: require a valid claim (invariant guard)
    IF v_is_limited_code AND v_claim_id IS NULL THEN
      RAISE EXCEPTION 'KVRN_DISCOUNT|NO_CLAIM_FOR_LIMITED_CODE|discount:%|reservation:%',
        v_res.discount_id, v_res.id;
    END IF;

    -- Insert redemption (idempotent: ON CONFLICT DO NOTHING)
    INSERT INTO discount_redemptions (
      discount_id, order_id, claim_id, subscriber_id, customer_email
    )
    SELECT v_res.discount_id, v_order_id::TEXT, v_claim_id,
           d.subscriber_id, v_cust_email
    FROM discounts d WHERE d.id = v_res.discount_id
    ON CONFLICT (discount_id, order_id) DO NOTHING
    RETURNING id INTO v_redemption_id;

    -- Only increment counter if this is a NEW redemption
    IF v_redemption_id IS NOT NULL THEN
      UPDATE discounts
      SET redemption_count = redemption_count + 1, updated_at = NOW()
      WHERE id = v_res.discount_id;

      IF v_claim_id IS NOT NULL THEN
        UPDATE discount_claims SET finalized_at = NOW() WHERE id = v_claim_id;
      END IF;
    END IF;
  END IF;

  -- Email outbox
  IF v_cust_email IS NOT NULL AND v_cust_email <> '' THEN
    INSERT INTO transactional_emails
      (order_id, email_type, recipient_email, status, idempotency_key)
    VALUES (v_order_id, 'order_confirmation', v_cust_email,
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

SELECT
  proname,
  pg_get_function_identity_arguments(oid) AS args
FROM pg_proc
WHERE proname IN ('finalize_paid_order','save_reservation_checkout_details','resolve_cost_batch')
ORDER BY proname;
