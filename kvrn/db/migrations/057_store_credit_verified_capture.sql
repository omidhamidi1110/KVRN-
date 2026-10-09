-- KVRN 057: paid-checkout store-credit CAPTURE proof (staging-only).
-- UNAPPLIED. Requires 041, 051, 056. Does not change checkout, orders,
-- revenue, Stripe webhooks, inventory or the existing finalize_order function.
-- Real split-tender checkout is NOT enabled: canonical checkout finalization must
-- first be updated, independently tested, and explicitly approved.
BEGIN;
CREATE TABLE IF NOT EXISTS store_credit_checkout_capture_proofs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 hold_event_id bigint NOT NULL UNIQUE REFERENCES store_credit_ledger(id) ON DELETE RESTRICT,
 capture_event_id bigint NOT NULL UNIQUE REFERENCES store_credit_ledger(id) ON DELETE RESTRICT,
 order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
 reservation_id uuid NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
 stripe_checkout_session_id text NOT NULL UNIQUE,
 stripe_payment_intent_id text NOT NULL UNIQUE,
 cash_received_cents bigint NOT NULL CHECK(cash_received_cents>0 AND cash_received_cents<=9007199254740991),
 gross_order_cents bigint NOT NULL CHECK(gross_order_cents>0 AND gross_order_cents<=9007199254740991),
 credit_captured_cents bigint NOT NULL CHECK(credit_captured_cents>0 AND credit_captured_cents<=9007199254740991),
 request_key text NOT NULL UNIQUE CHECK(request_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
 captured_at timestamptz NOT NULL DEFAULT NOW(),
 CONSTRAINT store_credit_capture_cash_plus_credit CHECK (
   cash_received_cents+credit_captured_cents=gross_order_cents
 )
);
CREATE OR REPLACE FUNCTION kvrn_credit_capture_verified_checkout(
 p_reservation uuid,p_order uuid,p_request_key text,p_checkout_session_id text,
 p_payment_intent_id text,p_cash_received_cents bigint,p_gross_order_cents bigint
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
 v_hold store_credit_checkout_holds%ROWTYPE;
 v_hold_event store_credit_ledger%ROWTYPE;
 v_terminal store_credit_ledger%ROWTYPE;
 v_proof store_credit_checkout_capture_proofs%ROWTYPE;
 v_order orders%ROWTYPE;
 v_res reservations%ROWTYPE;
 v_gross numeric;
 v_capture bigint;
BEGIN
 IF p_reservation IS NULL OR p_order IS NULL OR p_request_key IS NULL
  OR p_request_key !~ '^[A-Za-z0-9:_-]{12,120}$'
  OR p_checkout_session_id !~ '^cs_test_[A-Za-z0-9_]+$'
  OR p_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
  OR p_cash_received_cents IS NULL OR p_cash_received_cents NOT BETWEEN 1 AND 9007199254740991
  OR p_gross_order_cents IS NULL OR p_gross_order_cents NOT BETWEEN 1 AND 9007199254740991
 THEN RAISE EXCEPTION 'CREDIT_CAPTURE_INVALID_INPUT'; END IF;
 -- Same lock as hold creation, terminal release and issuance. Finalize only once.
 PERFORM pg_advisory_xact_lock(48112026051::bigint);
 SELECT * INTO v_hold FROM store_credit_checkout_holds
 WHERE reservation_id=p_reservation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_CAPTURE_HOLD_MISSING'; END IF;
 SELECT * INTO v_hold_event FROM store_credit_ledger WHERE id=v_hold.hold_event_id FOR SHARE;
 IF NOT FOUND OR v_hold_event.event_type<>'hold' OR v_hold_event.account_id<>v_hold.account_id
  OR v_hold_event.hold_key<>v_hold.hold_key OR v_hold_event.amount_cents<>v_hold.amount_cents
 THEN RAISE EXCEPTION 'CREDIT_CAPTURE_HOLD_INTEGRITY'; END IF;
 SELECT * INTO v_terminal FROM store_credit_ledger WHERE account_id=v_hold.account_id
  AND hold_key=v_hold.hold_key AND event_type IN ('capture','release');
 IF FOUND THEN
  IF v_terminal.event_type='capture' AND v_terminal.idempotency_key=p_request_key
   AND v_terminal.amount_cents=v_hold.amount_cents AND v_terminal.order_id=p_order
  THEN
   SELECT * INTO v_proof FROM store_credit_checkout_capture_proofs
    WHERE capture_event_id=v_terminal.id AND hold_event_id=v_hold.hold_event_id;
   IF FOUND AND v_proof.reservation_id=p_reservation AND v_proof.order_id=p_order
    AND v_proof.stripe_checkout_session_id=p_checkout_session_id
    AND v_proof.stripe_payment_intent_id=p_payment_intent_id
    AND v_proof.cash_received_cents=p_cash_received_cents
    AND v_proof.gross_order_cents=p_gross_order_cents
   THEN RETURN v_terminal.id; END IF;
  END IF;
  RAISE EXCEPTION 'CREDIT_CAPTURE_ALREADY_TERMINAL';
 END IF;
 IF EXISTS(SELECT 1 FROM store_credit_ledger WHERE idempotency_key=p_request_key)
  OR EXISTS(SELECT 1 FROM store_credit_checkout_capture_proofs WHERE request_key=p_request_key)
 THEN RAISE EXCEPTION 'CREDIT_CAPTURE_IDEMPOTENCY_CONFLICT'; END IF;
 SELECT * INTO v_res FROM reservations WHERE id=p_reservation FOR UPDATE;
 IF NOT FOUND OR v_res.status<>'completed'
  OR v_res.stripe_checkout_session_id IS DISTINCT FROM p_checkout_session_id
 THEN RAISE EXCEPTION 'CREDIT_CAPTURE_RESERVATION_NOT_FINAL'; END IF;
 SELECT * INTO v_order FROM orders WHERE id=p_order FOR UPDATE;
 IF NOT FOUND OR v_order.reservation_id IS DISTINCT FROM p_reservation
  OR v_order.stripe_checkout_session_id IS DISTINCT FROM p_checkout_session_id
  OR v_order.stripe_payment_intent_id IS DISTINCT FROM p_payment_intent_id
  OR v_order.payment_status<>'paid' OR v_order.paid_at IS NULL
  OR v_order.fulfillment_status='cancelled' OR lower(v_order.currency)<>'usd'
  OR v_order.total_cents IS NULL OR v_order.total_cents<=0
  OR v_order.total_cents::bigint<>p_cash_received_cents
 THEN RAISE EXCEPTION 'CREDIT_CAPTURE_PAID_ORDER_MISMATCH'; END IF;
 -- Never treat unknown refunds/disputes as absent. If ANY recorded refund or
 -- dispute exists, manual accounting reconciliation is required before capture.
 IF EXISTS(SELECT 1 FROM order_refunds WHERE order_id=p_order)
  OR EXISTS(SELECT 1 FROM order_disputes WHERE order_id=p_order)
 THEN RAISE EXCEPTION 'CREDIT_CAPTURE_REFUND_OR_DISPUTE'; END IF;
 IF v_order.subtotal_cents IS NULL OR v_order.subtotal_cents<0
  OR v_order.discount_cents IS NULL OR v_order.discount_cents<0
  OR v_order.discount_cents>v_order.subtotal_cents
  OR v_order.shipping_cents IS NULL OR v_order.shipping_cents<0
  OR v_order.tax_cents IS NULL OR v_order.tax_cents<0
 THEN RAISE EXCEPTION 'CREDIT_CAPTURE_CANONICAL_TOTALS_INVALID'; END IF;
 v_gross:=v_order.subtotal_cents::numeric-v_order.discount_cents::numeric
    +v_order.shipping_cents::numeric+v_order.tax_cents::numeric;
 IF v_gross<>p_gross_order_cents::numeric
  OR p_cash_received_cents::numeric+v_hold.amount_cents::numeric<>v_gross
 THEN RAISE EXCEPTION 'CREDIT_CAPTURE_SPLIT_TENDER_MISMATCH'; END IF;
 INSERT INTO store_credit_ledger(account_id,event_type,amount_cents,idempotency_key,hold_key,order_id)
 VALUES(v_hold.account_id,'capture',v_hold.amount_cents,p_request_key,v_hold.hold_key,p_order)
 RETURNING id INTO v_capture;
 INSERT INTO store_credit_checkout_capture_proofs(
  hold_event_id,capture_event_id,order_id,reservation_id,stripe_checkout_session_id,
  stripe_payment_intent_id,cash_received_cents,gross_order_cents,credit_captured_cents,request_key)
 VALUES(v_hold.hold_event_id,v_capture,p_order,p_reservation,p_checkout_session_id,
  p_payment_intent_id,p_cash_received_cents,p_gross_order_cents,v_hold.amount_cents,p_request_key);
 RETURN v_capture;
END; $$;
CREATE OR REPLACE FUNCTION kvrn_credit_capture_proofs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CREDIT_CAPTURE_PROOF_APPEND_ONLY'; END; $$;
CREATE TRIGGER credit_capture_proofs_immutable BEFORE UPDATE OR DELETE
 ON store_credit_checkout_capture_proofs FOR EACH ROW EXECUTE FUNCTION kvrn_credit_capture_proofs_immutable();
COMMIT;
