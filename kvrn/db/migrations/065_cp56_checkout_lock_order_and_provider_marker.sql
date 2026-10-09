-- KVRN CP56 065: TEST/STAGING-ONLY, NEVER APPLIED TO PRODUCTION HERE.
-- After 064, correct two store-credit concurrency regressions in 062:
-- 1. Finalizer acquired a reservation row lock before the shared 051 advisory
--    lock, while release/provider-start took 051 first -> possible deadlock.
--    Replacing the function in place preserves OID/permissions/dependencies.
-- 2. Provider-start marker checked for a hold, but NOT whether it was already
--    RELEASED; both release and starting provider could otherwise succeed.
-- The full finalizer below is copied verbatim from locked 062, except one
-- advisory lock moved to function entry. No economics/FIFO/cash logic changed.
BEGIN;

CREATE OR REPLACE FUNCTION kvrn_credit_mark_checkout_provider_started(
 p_reservation uuid,p_coupon_id text
) RETURNS boolean LANGUAGE plpgsql AS $body$
DECLARE v_res reservations%ROWTYPE;
BEGIN
 IF p_reservation IS NULL OR p_coupon_id IS NULL
    OR length(p_coupon_id) NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'CREDIT_PROVIDER_MARK_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(48112026051::bigint);
 SELECT * INTO v_res FROM reservations WHERE id=p_reservation FOR UPDATE;
 IF NOT FOUND OR v_res.status NOT IN ('open','awaiting_payment')
    OR v_res.stripe_checkout_session_id IS NOT NULL OR v_res.expires_at<=NOW()
    OR NOT EXISTS(
      SELECT 1 FROM store_credit_checkout_holds h
      JOIN store_credit_ledger held ON held.id=h.hold_event_id
      WHERE h.reservation_id=p_reservation AND held.event_type='hold'
        AND held.account_id=h.account_id AND held.hold_key=h.hold_key
        AND held.amount_cents=h.amount_cents
        AND NOT EXISTS (
          SELECT 1 FROM store_credit_ledger terminal
          WHERE terminal.account_id=h.account_id AND terminal.hold_key=h.hold_key
            AND terminal.event_type IN ('capture','release')))
 THEN RAISE EXCEPTION 'CREDIT_PROVIDER_MARK_STALE_OR_TERMINAL_HOLD'; END IF;
 IF EXISTS(SELECT 1 FROM store_credit_checkout_provider_requests WHERE reservation_id=p_reservation)
 THEN RAISE EXCEPTION 'CREDIT_PROVIDER_REQUEST_ALREADY_STARTED_NO_RETRY'; END IF;
 INSERT INTO store_credit_checkout_provider_requests(reservation_id,coupon_id)
 VALUES(p_reservation,p_coupon_id);
 RETURN true;
END;
$body$;

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
  -- 062: held store credit is TENDER, NEVER merchandise discount.
  v_credit_cents     BIGINT := 0;
  v_gross_cents      BIGINT := 0;
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
  -- CP56: obtain the SAME credit advisory lock BEFORE webhook and reservation
  -- row locks. Release and provider-start already take this lock first.
  -- Reversing this order caused a deadlock with concurrent expiry/finalization.
  PERFORM pg_advisory_xact_lock(48112026051::bigint);
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
  -- 062: Ordinary checkouts still use exactly the 022 invariant. Credit
  -- checkouts must have a previously committed hold linked to this reservation.
  -- The signed Stripe webhook supplies the cash paid; credit is a separate
  -- liability capture, not a product discount or cash revenue.
  -- CP56: already holding credit advisory lock since function entry.
  SELECT h.amount_cents INTO v_credit_cents FROM store_credit_checkout_holds h
  JOIN store_credit_ledger held ON held.id=h.hold_event_id
  WHERE h.reservation_id=v_res.id AND held.event_type='hold'
    AND held.account_id=h.account_id AND held.hold_key=h.hold_key
    AND held.amount_cents=h.amount_cents;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM store_credit_checkout_holds WHERE reservation_id=v_res.id)
    THEN RAISE EXCEPTION 'KVRN_CREDIT|CORRUPT_CHECKOUT_HOLD'; END IF;
    v_credit_cents:=0;
  END IF;
  v_gross_cents:=GREATEST(0,v_merch_total-v_discount_cents)::bigint+v_ship_final::bigint;
  IF v_gross_cents>2147483647 OR
    (v_credit_cents>0 AND (v_credit_cents>=v_gross_cents OR v_credit_cents>2147483647)) THEN
    RAISE EXCEPTION 'KVRN_CREDIT|INVALID_TENDER_ACCOUNTING';
  END IF;
  IF v_credit_cents>0 AND (
    p_stripe_session_id !~ '^cs_test_[A-Za-z0-9_]+$' OR
    p_stripe_payment_intent !~ '^pi_[A-Za-z0-9_]+$') THEN
    RAISE EXCEPTION 'KVRN_CREDIT|ONLY_VERIFIED_TEST_PAYMENTS';
  END IF;
  v_expected := (v_gross_cents-v_credit_cents)::integer;

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

  -- 062: Enforce exactly-one credit capture IN THIS SAME transaction as the
  -- completed reservation, paid cash order, FIFO costs and customer outbox.
  -- On any mismatch the whole transaction rolls back (webhook retries, never
  -- a paid order with uncaptured credit). The proof writer validates the
  -- original hold, order/cash/credit totals and previous refund/dispute state.
  IF v_credit_cents>0 THEN
    PERFORM kvrn_credit_capture_verified_checkout(
      v_res.id,v_order_id,'capture:'||v_res.id::text,
      p_stripe_session_id,p_stripe_payment_intent,
      p_amount_total,v_gross_cents);
  END IF;

  UPDATE webhook_events SET processed=true, processed_at=NOW(),
         result = CASE WHEN v_recovered THEN 'order_created_recovered' ELSE 'order_created' END
  WHERE stripe_event_id=p_stripe_event_id;

  RETURN jsonb_build_object('outcome','order_created','order_id',v_order_id,
         'order_number',v_order_num,'already_processed',false,'recovered',v_recovered);
END;
$$;
COMMIT;
