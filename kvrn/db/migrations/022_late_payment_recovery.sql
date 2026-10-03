-- KVRN Migration 022 — Paid-but-unfinalizable payments: late-payment recovery
--                      and a durable payment-exception ledger
--
-- Forward-only. Idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE /
-- DROP TRIGGER IF EXISTS, so re-running it any number of times is safe.
-- Migrations 001–021 are not edited. 018, 019, 020 and 021 stay byte-identical.
--
-- ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
--
-- finalize_paid_order() (last defined in 019) only finalizes a reservation whose
-- status is open / awaiting_payment / creating. If a successful-payment webhook
-- is delayed until after expiry cleanup has run (release_expired_reservations(),
-- run lazily by the next checkout), the reservation is 'released'. Finalize then
-- returned 'reservation_not_eligible' and marked the Stripe event PROCESSED, so
-- Stripe never retried: the customer was charged, no order existed, stock stayed
-- unreserved, and nothing recorded that it had happened.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
--   1. 'released' and 'failed' reservations are RECOVERABLE. Under the same row
--      locks and availability rule as reserve_inventory(), in the same SKU order:
--        * every line available  -> stock is re-reserved, the reservation is
--          reopened, and the normal finalization path continues unchanged.
--          Exactly one order, one deduction, one outbox email, one FIFO draw.
--        * ANY line short        -> NO stock is touched (never oversell); the
--          payment is recorded in payment_exceptions for manual refund.
--   2. payment_exceptions: a durable, admin-visible record, UNIQUE per Stripe
--      session. It is also written for a paid session KVRN cannot match to any
--      reservation, and for a reservation in an unexpected state.
--   3. A session that already has an exception is never re-evaluated, so a
--      replayed or later event cannot create an order for refunded money.
--   4. resolve_payment_exception(): the only way to close one. It requires a
--      resolution and a note and writes admin_audit_logs in the same transaction.
--
-- ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────
--
--   * Currency / amount mismatch still RAISE (transaction rolls back, Stripe
--     retries, the webhook shows as failing). Unchanged on purpose.
--   * Normal finalization of an open reservation is byte-for-byte the same SQL
--     path as 019: same order insert, deduction guard, FIFO consumption,
--     discount redemption, outbox row and idempotency locks.
--   * No economic fact is rewritten. A payment exception has NO order, so it
--     creates no revenue, COGS, fee or affiliate recognition; refunding it in
--     Stripe is not an order refund (recordOrderRefund reports 'no_order').

BEGIN;

CREATE TABLE IF NOT EXISTS payment_exceptions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_checkout_session_id  TEXT        NOT NULL,
  stripe_payment_intent_id    TEXT,
  reservation_id              UUID,
  first_stripe_event_id       TEXT        NOT NULL,
  reason                      TEXT        NOT NULL,
  status                      TEXT        NOT NULL DEFAULT 'open',
  resolution                  TEXT,
  resolution_note             TEXT,
  resolved_by                 TEXT,
  resolved_at                 TIMESTAMPTZ,
  amount_cents                INTEGER     NOT NULL,
  currency                    TEXT        NOT NULL,
  customer_email              TEXT,
  customer_name               TEXT,
  customer_phone              TEXT,
  shipping_address            JSONB,
  detail                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_exceptions_session_uq UNIQUE (stripe_checkout_session_id),
  CONSTRAINT payment_exceptions_reason_chk
    CHECK (reason IN ('no_reservation','insufficient_stock','reservation_not_eligible')),
  CONSTRAINT payment_exceptions_status_chk CHECK (status IN ('open','resolved')),
  CONSTRAINT payment_exceptions_resolution_chk
    CHECK (resolution IS NULL OR resolution IN ('refunded','fulfilled_manually','dismissed')),
  CONSTRAINT payment_exceptions_state_chk CHECK (
    (status = 'open' AND resolution IS NULL AND resolved_at IS NULL)
    OR
    (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL
       AND resolved_by IS NOT NULL AND COALESCE(btrim(resolution_note), '') <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_exceptions_open
  ON payment_exceptions (created_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_payment_exceptions_pi
  ON payment_exceptions (stripe_payment_intent_id);

-- A payment record is never deleted: it is the only trace of money received.
CREATE OR REPLACE FUNCTION payment_exceptions_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KVRN_PAYMENT_EXCEPTION|DELETE_FORBIDDEN';
END;
$$;
DROP TRIGGER IF EXISTS trg_payment_exceptions_no_delete ON payment_exceptions;
CREATE TRIGGER trg_payment_exceptions_no_delete
  BEFORE DELETE ON payment_exceptions
  FOR EACH ROW EXECUTE FUNCTION payment_exceptions_no_delete();

-- Idempotent writer: one row per Stripe session, ever.
CREATE OR REPLACE FUNCTION record_payment_exception(
  p_stripe_session_id  TEXT,
  p_reservation_id     UUID,
  p_payment_intent     TEXT,
  p_event_id           TEXT,
  p_reason             TEXT,
  p_amount_cents       INTEGER,
  p_currency           TEXT,
  p_customer_email     TEXT,
  p_customer_name      TEXT,
  p_customer_phone     TEXT,
  p_shipping_address   JSONB,
  p_detail             JSONB
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO payment_exceptions (
    stripe_checkout_session_id, stripe_payment_intent_id, reservation_id,
    first_stripe_event_id, reason, amount_cents, currency,
    customer_email, customer_name, customer_phone, shipping_address, detail
  ) VALUES (
    p_stripe_session_id, NULLIF(p_payment_intent, ''), p_reservation_id,
    p_event_id, p_reason, COALESCE(p_amount_cents, 0), COALESCE(NULLIF(lower(p_currency), ''), 'usd'),
    p_customer_email, p_customer_name, p_customer_phone, p_shipping_address,
    COALESCE(p_detail, '{}'::jsonb)
  )
  ON CONFLICT (stripe_checkout_session_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM payment_exceptions
    WHERE stripe_checkout_session_id = p_stripe_session_id;
  END IF;
  RETURN v_id;
END;
$$;

-- The only way to close a payment exception. Atomic with its audit row.
CREATE OR REPLACE FUNCTION resolve_payment_exception(
  p_id          UUID,
  p_resolution  TEXT,
  p_note        TEXT,
  p_actor_email TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_row payment_exceptions;
BEGIN
  IF p_resolution IS NULL OR p_resolution NOT IN ('refunded','fulfilled_manually','dismissed') THEN
    RAISE EXCEPTION 'KVRN_PAYMENT_EXCEPTION|INVALID_RESOLUTION';
  END IF;
  IF COALESCE(btrim(p_note), '') = '' THEN
    RAISE EXCEPTION 'KVRN_PAYMENT_EXCEPTION|NOTE_REQUIRED';
  END IF;
  IF COALESCE(btrim(p_actor_email), '') = '' THEN
    RAISE EXCEPTION 'KVRN_PAYMENT_EXCEPTION|ACTOR_REQUIRED';
  END IF;

  SELECT * INTO v_row FROM payment_exceptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;

  IF v_row.status = 'resolved' THEN
    IF v_row.resolution = p_resolution THEN
      RETURN jsonb_build_object('outcome', 'already_resolved', 'resolution', v_row.resolution);
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict', 'resolution', v_row.resolution);
  END IF;

  UPDATE payment_exceptions
  SET status = 'resolved', resolution = p_resolution, resolution_note = btrim(p_note),
      resolved_by = p_actor_email, resolved_at = NOW(), updated_at = NOW()
  WHERE id = p_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor_email, 'PAYMENT_EXCEPTION_RESOLVED', 'payment_exceptions', p_id::TEXT,
          jsonb_build_object('resolution', p_resolution, 'note', btrim(p_note),
                             'session', v_row.stripe_checkout_session_id,
                             'payment_intent', v_row.stripe_payment_intent_id,
                             'amount_cents', v_row.amount_cents));

  RETURN jsonb_build_object('outcome', 'resolved', 'resolution', p_resolution);
END;
$$;

-- ── finalize_paid_order: 019 body + late-payment recovery ────────────────────
-- Same signature as 019 (CREATE OR REPLACE). Every difference from 019 is marked
-- with a "022" comment.
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
  -- 019: FIFO consumption replaces the date-effective cost lookup.
  v_order_item_id    UUID;
  v_movement_id      UUID;
  v_fifo             JSONB;
  -- 022: late-payment recovery / durable payment exception
  v_recovered        BOOLEAN := FALSE;
  v_exc_id           UUID;
  v_short            JSONB   := '[]'::jsonb;
  v_var              RECORD;
  v_items_json       JSONB;
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
         shipping_quoted_cents, shipping_auto_free_discount_cents, attribution, release_reason
  INTO v_res
  FROM reservations WHERE stripe_checkout_session_id=p_stripe_session_id FOR UPDATE;

  IF NOT FOUND AND p_reservation_id_hint IS NOT NULL THEN
    SELECT id, status, stripe_checkout_session_id,
           customer_email, customer_name, customer_phone,
           shipping_address, shipping_method, shipping_cents,
           discount_id, discount_code, discount_type, discount_cents,
           shipping_before_discount_cents, shipping_discount_cents, shipping_final_cents,
           shipping_quoted_cents, shipping_auto_free_discount_cents, attribution, release_reason
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

  -- 022: a session that already has a payment exception is never re-evaluated.
  -- Without this, a replayed event arriving after stock was restocked (or after an
  -- admin already refunded the customer) could silently create an order for money
  -- that was handed back. The exception row is the single source of truth.
  SELECT id INTO v_exc_id FROM payment_exceptions
  WHERE stripe_checkout_session_id = p_stripe_session_id;
  IF FOUND THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='payment_exception_existing'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','payment_exception','payment_exception_id',v_exc_id,
           'already_processed',true,'duplicate',true);
  END IF;

  IF v_res.id IS NULL THEN
    -- 022: money was taken for a session KVRN cannot match to a reservation.
    -- Previously acknowledged and forgotten; now durably recorded.
    v_exc_id := record_payment_exception(
      p_stripe_session_id, p_reservation_id_hint, p_stripe_payment_intent, p_stripe_event_id,
      'no_reservation', p_amount_total, p_expected_currency,
      p_customer_email, p_customer_name, p_customer_phone, p_shipping_address,
      '{}'::jsonb);
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='no_reservation'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','no_reservation','already_processed',false,
           'payment_exception_id',v_exc_id);
  END IF;

  -- Items snapshot, used to describe a payment exception to the admin.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sku', ri.sku, 'product_name', ri.product_name, 'size', ri.size,
           'quantity', ri.quantity, 'unit_price_cents', ri.unit_price_cents)
         ORDER BY ri.sku), '[]'::jsonb)
  INTO v_items_json FROM reservation_items ri WHERE ri.reservation_id = v_res.id;

  -- 022: 'released' and 'failed' are RECOVERABLE. A successful payment must never
  -- disappear because expiry cleanup ran first. 'completed' with no order for this
  -- session (or any other state) cannot be reasoned about automatically.
  IF v_res.status NOT IN ('open','awaiting_payment','creating','released','failed') THEN
    v_exc_id := record_payment_exception(
      p_stripe_session_id, v_res.id, p_stripe_payment_intent, p_stripe_event_id,
      'reservation_not_eligible', p_amount_total, p_expected_currency,
      COALESCE(v_res.customer_email, p_customer_email),
      COALESCE(v_res.customer_name,  p_customer_name),
      COALESCE(v_res.customer_phone, p_customer_phone),
      COALESCE(v_res.shipping_address, p_shipping_address),
      jsonb_build_object('reservation_status', v_res.status, 'items', v_items_json));
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='reservation_not_eligible'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','payment_exception','reason','reservation_not_eligible',
           'payment_exception_id',v_exc_id,'already_processed',false);
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

  -- ── 022: LATE-PAYMENT RECOVERY ───────────────────────────────────────────────
  -- The reservation was released (expiry cleanup, or a failure path) but the
  -- customer's payment succeeded. Re-take the stock under the SAME row locks and
  -- the SAME availability rule reserve_inventory uses, in the same SKU order, so
  -- this cannot oversell and cannot deadlock with a concurrent reservation.
  --
  -- All-or-nothing: if ANY line is short, no stock is touched and the payment is
  -- recorded as a payment exception for manual refund/resolution instead.
  IF v_res.status IN ('released','failed') THEN
    FOR v_item IN
      SELECT ri.variant_id, ri.sku, ri.quantity
      FROM reservation_items ri JOIN product_variants pv ON pv.id = ri.variant_id
      WHERE ri.reservation_id = v_res.id ORDER BY pv.sku
    LOOP
      SELECT stock_on_hand, reserved_quantity INTO v_var
      FROM product_variants WHERE id = v_item.variant_id FOR UPDATE;
      IF v_var.stock_on_hand - v_var.reserved_quantity < v_item.quantity THEN
        v_short := v_short || jsonb_build_array(jsonb_build_object(
          'sku', v_item.sku, 'wanted', v_item.quantity,
          'available', GREATEST(0, v_var.stock_on_hand - v_var.reserved_quantity)));
      END IF;
    END LOOP;

    IF jsonb_array_length(v_short) > 0 THEN
      v_exc_id := record_payment_exception(
        p_stripe_session_id, v_res.id, p_stripe_payment_intent, p_stripe_event_id,
        'insufficient_stock', p_amount_total, p_expected_currency,
        COALESCE(v_res.customer_email, p_customer_email),
        COALESCE(v_res.customer_name,  p_customer_name),
        COALESCE(v_res.customer_phone, p_customer_phone),
        COALESCE(v_res.shipping_address, p_shipping_address),
        jsonb_build_object('reservation_status', v_res.status,
                           'release_reason', v_res.release_reason,
                           'shortages', v_short, 'items', v_items_json));
      UPDATE webhook_events SET processed=true, processed_at=NOW(), result='payment_exception'
      WHERE stripe_event_id=p_stripe_event_id;
      RETURN jsonb_build_object('outcome','payment_exception','reason','insufficient_stock',
             'payment_exception_id',v_exc_id,'already_processed',false);
    END IF;

    FOR v_item IN
      SELECT ri.variant_id, ri.sku, ri.quantity
      FROM reservation_items ri JOIN product_variants pv ON pv.id = ri.variant_id
      WHERE ri.reservation_id = v_res.id ORDER BY pv.sku
    LOOP
      UPDATE product_variants
      SET reserved_quantity = reserved_quantity + v_item.quantity, updated_at = NOW()
      WHERE id = v_item.variant_id;
      INSERT INTO inventory_movements
        (variant_id, quantity_delta, movement_type, reason, note, actor_email, reservation_id)
      VALUES (v_item.variant_id, v_item.quantity, 'RESERVE', 'late_payment_recovery',
              'reservation:' || v_res.id || ' event:' || p_stripe_event_id,
              'system@kvrn.internal', v_res.id);
    END LOOP;

    -- The customer already paid the discounted price: honour the claim that
    -- cleanup released, so the redemption below counts exactly once.
    UPDATE discount_claims SET released_at = NULL
    WHERE reservation_id = v_res.id AND finalized_at IS NULL AND released_at IS NOT NULL;

    UPDATE reservations
    SET status='open', released_at=NULL, release_reason=NULL, updated_at=NOW()
    WHERE id = v_res.id;
    v_recovered := TRUE;
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
    -- ── 019: COGS now comes from FIFO layer consumption ────────────────────
    -- The order line is inserted first so its id can be attached to the
    -- consumption records, then costed once the layers are actually drawn.
    INSERT INTO order_items (
      order_id, variant_id, sku, product_name, size, color,
      quantity, unit_price_cents, line_total_cents
    ) VALUES (
      v_order_id, v_item.variant_id, v_item.sku, v_item.product_name,
      v_item.size, v_item.color, v_item.quantity, v_item.unit_price_cents,
      v_item.unit_price_cents * v_item.quantity
    ) RETURNING id INTO v_order_item_id;

    -- UNCHANGED from 017: same decrement, same guard, same exception.
    UPDATE product_variants
    SET stock_on_hand=stock_on_hand-v_item.quantity,
        reserved_quantity=reserved_quantity-v_item.quantity, updated_at=NOW()
    WHERE id=v_item.variant_id
      AND stock_on_hand>=v_item.quantity AND reserved_quantity>=v_item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|DEDUCT_INVARIANT|%', v_item.sku;
    END IF;

    -- UNCHANGED from 017 except RETURNING, needed to link the consumptions.
    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, order_id, reservation_id)
    VALUES (v_item.variant_id, -v_item.quantity, 'DEDUCT', 'paid_order',
            'order:' || v_order_id || ' reservation:' || v_res.id,
            'system@kvrn.internal', v_order_id, v_res.id)
    RETURNING id INTO v_movement_id;

    -- Atomic with the decrement above: same transaction, so quantity and cost
    -- can never diverge. A layer shortage records an accounting exception and
    -- returns NULL cost rather than failing this already-paid order.
    v_fifo := consume_inventory_fifo(
      v_item.variant_id, v_item.quantity, 'sale',
      v_movement_id, v_order_id, v_order_item_id);

    -- Component columns stay NULL: FIFO gives a blended landed cost per layer,
    -- not a component breakdown. cost_batch_id is recorded when the whole line
    -- came from a single batch-backed layer, otherwise left NULL.
    UPDATE order_items
    SET unit_cogs_cents = CASE
          WHEN (v_fifo->>'total_cost_cents') IS NULL THEN NULL
          ELSE ROUND((v_fifo->>'total_cost_cents')::NUMERIC / v_item.quantity)::INTEGER END,
        line_cogs_cents = (v_fifo->>'total_cost_cents')::INTEGER,
        -- Recorded only when the whole line came from a single batch-backed
        -- layer. PostgreSQL has no MIN(uuid), so the comparison is done on text
        -- and cast back.
        cost_batch_id = (
          SELECT CASE WHEN COUNT(DISTINCT l.cost_batch_id) = 1
                      THEN MAX(l.cost_batch_id::TEXT)::UUID END
          FROM inventory_layer_consumptions c
          JOIN inventory_cost_layers l ON l.id = c.layer_id
          WHERE c.order_item_id = v_order_item_id
        )
    WHERE id = v_order_item_id;
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
    IF v_is_limited_code AND v_claim_id IS NULL AND NOT v_recovered THEN
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

  UPDATE webhook_events SET processed=true, processed_at=NOW(),
         result = CASE WHEN v_recovered THEN 'order_created_recovered' ELSE 'order_created' END
  WHERE stripe_event_id=p_stripe_event_id;

  RETURN jsonb_build_object('outcome','order_created','order_id',v_order_id,
         'order_number',v_order_num,'already_processed',false,'recovered',v_recovered);
END;
$$;

COMMIT;

-- Post-migration verification (informational).
SELECT 'payment_exceptions' AS tbl, COUNT(*) AS rows FROM payment_exceptions
UNION ALL SELECT 'open_payment_exceptions', COUNT(*) FROM payment_exceptions WHERE status = 'open';
