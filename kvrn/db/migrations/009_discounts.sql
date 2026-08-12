-- KVRN Migration 009 — Discount Engine (V58.4 complete)
-- Applies after 001-008. Modify directly since undeployed.
--
-- Discount priority:
--   1. AUTOMATIC US $150+ free shipping (eligibility: country=US AND subtotal>=15000)
--      Blocks all order discounts regardless of selected shipping method.
--   2. Manual shipping discount codes → reduce shippingCents directly
--   3. One merchandise/order discount (KVRN10, unique SMS code, other)
--
-- Key invariants:
--   discount_cents     = merchandise/order discount only (never shipping)
--   shipping_final_cents = actual shipping charged by Stripe
--   expected_total = subtotal - discount_cents + shipping_final_cents

BEGIN;

-- ── 1. stripe_coupon_definitions — shared Stripe coupons keyed by discount terms ─
-- All KVRN codes with identical terms share the same underlying Stripe coupon.
-- Concurrency: DB-leader pattern — see lib/discounts.ts getOrCreateStripeCouponForTerms().
--   - NULL-safe unique expression index (COALESCE) prevents duplicate rows for identical terms.
--   - First INSERT with stripe_coupon_id='pending' wins leadership.
--   - Leader creates Stripe coupon using deterministic idempotency key, then UPDATEs row.
--   - Followers poll the row until a real coupon_id appears.
--   - Stale pending rows (> 60 s) can be taken over by a new leader via DELETE + re-INSERT.
--   - pg_advisory_xact_lock is NOT used (not reliable across separate Neon connections).

CREATE TABLE IF NOT EXISTS stripe_coupon_definitions (
  id               UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT   NOT NULL CHECK (kind IN ('fixed_amount','percentage')),
  currency         TEXT   NOT NULL DEFAULT 'usd',
  amount_cents     INTEGER,               -- for fixed_amount
  percentage_bps   INTEGER,               -- for percentage (1000 = 10%)
  -- 'pending' during leader creation; real coupon_id once confirmed
  stripe_coupon_id TEXT   NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- NULL-safe unique index using COALESCE (works PG 14+, no NULLS NOT DISTINCT needed)
-- -1 is out-of-range for valid amounts/bps, serving as a sentinel for NULL
CREATE UNIQUE INDEX IF NOT EXISTS scd_terms_uq
  ON stripe_coupon_definitions
  (kind, currency, COALESCE(amount_cents, -1), COALESCE(percentage_bps, -1));

-- ── 2. discounts table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discounts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  TEXT        NOT NULL,
  name                  TEXT        NOT NULL,
  description           TEXT,
  type                  TEXT        NOT NULL
    CONSTRAINT dc_type_chk CHECK (type IN ('fixed_amount','percentage','shipping')),
  amount_cents          INTEGER     CHECK (amount_cents IS NULL OR amount_cents >= 0),
  percentage_bps        INTEGER     CHECK (percentage_bps IS NULL OR (percentage_bps > 0 AND percentage_bps <= 10000)),
  active                BOOLEAN     NOT NULL DEFAULT TRUE,
  single_use            BOOLEAN     NOT NULL DEFAULT FALSE,
  max_redemptions       INTEGER     CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redemption_count      INTEGER     NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  minimum_subtotal_cents INTEGER    CHECK (minimum_subtotal_cents IS NULL OR minimum_subtotal_cents >= 0),
  allowed_country_codes TEXT[],
  excluded_country_codes TEXT[],
  subscriber_id         UUID,
  system_managed        BOOLEAN     NOT NULL DEFAULT FALSE,
  starts_at             TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  priority              INTEGER     NOT NULL DEFAULT 10,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discounts_code_uq UNIQUE (code)
);

CREATE INDEX IF NOT EXISTS idx_dc_active     ON discounts(active);
CREATE INDEX IF NOT EXISTS idx_dc_type       ON discounts(type);
CREATE INDEX IF NOT EXISTS idx_dc_sub        ON discounts(subscriber_id) WHERE subscriber_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dc_sysmanaged ON discounts(system_managed) WHERE system_managed = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='set_dc_updated_at') THEN
    CREATE TRIGGER set_dc_updated_at BEFORE UPDATE ON discounts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── 3. discount_claims — race-condition prevention for limited codes ───────────
-- Claimed atomically at Stripe session creation.
-- Released on session expired/failed. Finalized on paid order.

CREATE TABLE IF NOT EXISTS discount_claims (
  id               UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id      UUID   NOT NULL REFERENCES discounts(id),
  reservation_id   UUID   NOT NULL,
  stripe_session_id TEXT,
  claimed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  finalized_at     TIMESTAMPTZ,
  released_at      TIMESTAMPTZ,
  CONSTRAINT dcl_reservation_uq UNIQUE (reservation_id)
);

CREATE INDEX IF NOT EXISTS idx_dcl_discount   ON discount_claims(discount_id);
CREATE INDEX IF NOT EXISTS idx_dcl_reservation ON discount_claims(reservation_id);

-- ── 4. discount_redemptions — final record on confirmed payment ───────────────
CREATE TABLE IF NOT EXISTS discount_redemptions (
  id            UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id   UUID   NOT NULL REFERENCES discounts(id),
  order_id      TEXT   NOT NULL,
  claim_id      UUID   REFERENCES discount_claims(id),
  subscriber_id UUID,
  customer_email TEXT,
  phone_e164    TEXT,
  redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dr_discount_order_uq UNIQUE (discount_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_dr_discount_id ON discount_redemptions(discount_id);
CREATE INDEX IF NOT EXISTS idx_dr_order_id    ON discount_redemptions(order_id);

-- ── 5. Reservation discount + shipping snapshot columns ───────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reservations' AND column_name='discount_code') THEN
    ALTER TABLE reservations ADD COLUMN discount_code  TEXT;
    ALTER TABLE reservations ADD COLUMN discount_id    UUID;
    ALTER TABLE reservations ADD COLUMN discount_type  TEXT;
    -- discount_cents: merchandise/order discount only (not shipping)
    ALTER TABLE reservations ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);
    -- shipping columns: before = original, discount = reduction, final = net charged
    ALTER TABLE reservations ADD COLUMN shipping_before_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_before_discount_cents >= 0);
    ALTER TABLE reservations ADD COLUMN shipping_discount_cents        INTEGER NOT NULL DEFAULT 0 CHECK (shipping_discount_cents >= 0);
    ALTER TABLE reservations ADD COLUMN shipping_final_cents           INTEGER NOT NULL DEFAULT 0 CHECK (shipping_final_cents >= 0);
  END IF;
END $$;

-- ── 6. Order discount + shipping snapshot columns ────────────────────────────
-- Field semantics (canonical for V58+):
--   orders.subtotal_cents                  = pre-discount merchandise subtotal
--   orders.shipping_cents                  = FINAL charged shipping (backwards compatible)
--   orders.shipping_before_discount_cents  = original shipping before any discount code
--   orders.shipping_discount_cents         = shipping reduction from code
--   orders.discount_cents                  = merchandise/order discount only (never shipping)
--   orders.total_cents                     = amount actually paid
-- Note: shipping_final_cents is NOT a separate column on orders;
--       orders.shipping_cents IS the canonical final charged shipping.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='orders' AND column_name='discount_code') THEN
    ALTER TABLE orders ADD COLUMN discount_code TEXT;
    ALTER TABLE orders ADD COLUMN discount_id   UUID;
    ALTER TABLE orders ADD COLUMN discount_type TEXT;
    ALTER TABLE orders ADD COLUMN shipping_before_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_before_discount_cents >= 0);
    ALTER TABLE orders ADD COLUMN shipping_discount_cents        INTEGER NOT NULL DEFAULT 0 CHECK (shipping_discount_cents >= 0);
  END IF;
END $$;

-- ── 7. claim_discount() — atomic, expiry-aware, idempotent ────────────────────
-- Returns:
--   'claimed'     — new claim created
--   'idempotent'  — reservation already holds this exact claim
--   'conflict'    — reservation holds a claim for a different discount
--   'exhausted'   — no available capacity
--   'unlimited'   — discount is unlimited; no exclusive claim needed

CREATE OR REPLACE FUNCTION claim_discount(
  p_discount_id    UUID,
  p_reservation_id UUID,
  p_expires_at     TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_discount        RECORD;
  v_effective_max   INTEGER;
  v_active_claims   INTEGER;
  v_existing_claim  RECORD;
BEGIN
  -- Lock discount row for the duration of this transaction
  SELECT id, active, single_use, max_redemptions, redemption_count
  INTO v_discount
  FROM discounts WHERE id = p_discount_id FOR UPDATE;

  IF NOT FOUND OR NOT v_discount.active THEN
    RETURN 'exhausted';
  END IF;

  -- Unlimited discounts: no exclusive claim needed
  v_effective_max := COALESCE(
    v_discount.max_redemptions,
    CASE WHEN v_discount.single_use THEN 1 ELSE NULL END
  );
  IF v_effective_max IS NULL THEN RETURN 'unlimited'; END IF;

  -- Check existing claim for this reservation
  SELECT id, discount_id INTO v_existing_claim
  FROM discount_claims WHERE reservation_id = p_reservation_id;

  IF v_existing_claim.id IS NOT NULL THEN
    -- Idempotent: same discount already claimed
    IF v_existing_claim.discount_id = p_discount_id THEN RETURN 'idempotent'; END IF;
    -- Conflict: reservation has a claim for a different discount
    RETURN 'conflict';
  END IF;

  -- Count active claims (not finalized, not released, not expired)
  SELECT COUNT(*) INTO v_active_claims
  FROM discount_claims
  WHERE discount_id = p_discount_id
    AND finalized_at IS NULL
    AND released_at IS NULL
    AND expires_at > NOW();

  IF (v_active_claims + v_discount.redemption_count) >= v_effective_max THEN
    RETURN 'exhausted';
  END IF;

  INSERT INTO discount_claims (discount_id, reservation_id, expires_at)
  VALUES (p_discount_id, p_reservation_id, p_expires_at)
  ON CONFLICT (reservation_id) DO NOTHING;

  RETURN 'claimed';
END;
$$;

-- ── 8. release_discount_claim() ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION release_discount_claim(p_reservation_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE discount_claims
  SET released_at = NOW()
  WHERE reservation_id = p_reservation_id
    AND finalized_at IS NULL AND released_at IS NULL;
  RETURN FOUND;
END;
$$;

-- ── 9. release_expired_reservations() — updated to release discount claims ─────
-- Overrides the function from migration 002 to also release associated discount claims.
CREATE OR REPLACE FUNCTION release_expired_reservations() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_res RECORD; v_item RECORD; v_count INTEGER := 0;
BEGIN
  FOR v_res IN
    SELECT id FROM reservations
    WHERE status IN ('creating','open','awaiting_payment') AND expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    FOR v_item IN
      SELECT ri.variant_id, ri.quantity FROM reservation_items ri
      JOIN product_variants pv ON pv.id=ri.variant_id
      WHERE ri.reservation_id=v_res.id ORDER BY pv.sku
    LOOP
      UPDATE product_variants
      SET reserved_quantity=reserved_quantity-v_item.quantity, updated_at=NOW()
      WHERE id=v_item.variant_id AND reserved_quantity>=v_item.quantity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'KVRN_RESERVATION|INVARIANT_VIOLATION|cleanup reservation %', v_res.id;
      END IF;
      INSERT INTO inventory_movements
        (variant_id, quantity_delta, movement_type, reason, note, actor_email, reservation_id)
      VALUES (v_item.variant_id, -v_item.quantity, 'RELEASE', 'expired_cleanup',
              'reservation:' || v_res.id, 'system@kvrn.internal', v_res.id);
    END LOOP;
    -- Release any discount claim for this reservation
    PERFORM release_discount_claim(v_res.id);
    UPDATE reservations SET status='released', release_reason='expired_cleanup',
      released_at=NOW(), updated_at=NOW() WHERE id=v_res.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── 10. save_reservation_checkout_details() — with full shipping snapshot ──────
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
  p_discount_cents             INTEGER DEFAULT 0
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  IF p_shipping_method NOT IN ('standard','express') THEN
    RAISE EXCEPTION 'Invalid shipping_method: %', p_shipping_method;
  END IF;
  UPDATE reservations
  SET
    customer_email                = p_customer_email,
    customer_name                 = p_customer_name,
    customer_phone                = p_customer_phone,
    shipping_address              = p_shipping_address,
    shipping_method               = p_shipping_method,
    -- shipping_cents = final charged shipping (backwards compatible)
    shipping_cents                = p_shipping_final_cents,
    shipping_before_discount_cents = p_shipping_before_discount,
    shipping_discount_cents       = p_shipping_discount_cents,
    shipping_final_cents          = p_shipping_final_cents,
    discount_id                   = p_discount_id,
    discount_code                 = p_discount_code,
    discount_type                 = p_discount_type,
    discount_cents                = COALESCE(p_discount_cents, 0),
    updated_at                    = NOW()
  WHERE id = p_reservation_id
    AND status IN ('open','creating','awaiting_payment');
  RETURN FOUND;
END;
$$;

-- ── 11. finalize_paid_order() — full shipping snapshot + strict idempotency ────
-- discount_cents = merchandise/order discount only (not shipping)
-- shipping_final_cents = actual shipping charged by Stripe
-- expected = merch_subtotal - discount_cents + shipping_final_cents
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

  -- Lock reservation
  SELECT id, status, stripe_checkout_session_id,
         customer_email, customer_name, customer_phone,
         shipping_address, shipping_method, shipping_cents,
         discount_id, discount_code, discount_type, discount_cents,
         shipping_before_discount_cents, shipping_discount_cents, shipping_final_cents
  INTO v_res
  FROM reservations WHERE stripe_checkout_session_id=p_stripe_session_id FOR UPDATE;

  IF NOT FOUND AND p_reservation_id_hint IS NOT NULL THEN
    SELECT id, status, stripe_checkout_session_id,
           customer_email, customer_name, customer_phone,
           shipping_address, shipping_method, shipping_cents,
           discount_id, discount_code, discount_type, discount_cents,
           shipping_before_discount_cents, shipping_discount_cents, shipping_final_cents
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
    v_cust_email, v_cust_name, v_cust_phone, v_ship_addr, NOW()
  ) RETURNING id INTO v_order_id;

  -- Deduct inventory
  FOR v_item IN
    SELECT ri.variant_id, ri.sku, ri.product_name, ri.size, ri.color,
           ri.quantity, ri.unit_price_cents
    FROM reservation_items ri WHERE ri.reservation_id=v_res.id ORDER BY ri.sku
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

-- ── 12. Seed KVRN10 ───────────────────────────────────────────────────────────
INSERT INTO discounts (code, name, description, type, amount_cents, active, single_use,
                       system_managed, priority, created_by)
VALUES ('KVRN10', 'KVRN $10 Order Discount',
        '$10 off. Cannot combine with other discounts or free shipping.',
        'fixed_amount', 1000, TRUE, FALSE, FALSE, 10, 'seed')
ON CONFLICT (code) DO NOTHING;

COMMIT;

SELECT 'discounts' AS tbl, COUNT(*) FROM discounts
UNION ALL SELECT 'discount_claims',       COUNT(*) FROM discount_claims
UNION ALL SELECT 'discount_redemptions',  COUNT(*) FROM discount_redemptions
UNION ALL SELECT 'stripe_coupon_defs',    COUNT(*) FROM stripe_coupon_definitions;
