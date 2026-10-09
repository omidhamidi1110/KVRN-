-- KVRN 056: serialized abandoned-checkout store-credit RELEASE.
-- STAGING ONLY / NOT APPLIED. Depends on 041 and 051.
-- Requires server-verified FINAL Stripe Checkout session expiration; not an
-- arbitrary timeout, unknown payment, webhook retry or customer assertion.
-- No customer endpoint, cron worker, or autonomous release is installed.
BEGIN;
CREATE TABLE IF NOT EXISTS store_credit_checkout_release_proofs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 hold_event_id bigint NOT NULL UNIQUE REFERENCES store_credit_ledger(id) ON DELETE RESTRICT,
 release_event_id bigint NOT NULL UNIQUE REFERENCES store_credit_ledger(id) ON DELETE RESTRICT,
 stripe_checkout_session_id text NOT NULL,
 stripe_status text NOT NULL CHECK(stripe_status='expired'),
 stripe_payment_status text NOT NULL CHECK(stripe_payment_status='unpaid'),
 payment_intent_final text NOT NULL CHECK(payment_intent_final IN ('none','canceled')),
 request_key text NOT NULL UNIQUE CHECK(request_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
 recorded_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION kvrn_credit_release_expired_checkout(
 p_reservation uuid,p_request_key text,p_session_id text,p_pi_final text
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_hold store_credit_checkout_holds%ROWTYPE;
  v_res reservations%ROWTYPE;
  v_held store_credit_ledger%ROWTYPE;
  v_existing store_credit_ledger%ROWTYPE;
  v_release bigint;
BEGIN
 IF p_reservation IS NULL OR p_request_key IS NULL
   OR p_request_key !~ '^[A-Za-z0-9:_-]{12,120}$'
   OR p_session_id IS NULL OR p_session_id !~ '^cs_(test|live)_[A-Za-z0-9_]+$'
   OR p_pi_final NOT IN ('none','canceled')
 THEN RAISE EXCEPTION 'CREDIT_RELEASE_INVALID_INPUT'; END IF;
 PERFORM pg_advisory_xact_lock(48112026051::bigint);
 SELECT * INTO v_hold FROM store_credit_checkout_holds WHERE reservation_id=p_reservation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_RELEASE_HOLD_MISSING'; END IF;
 SELECT * INTO v_held FROM store_credit_ledger WHERE id=v_hold.hold_event_id FOR SHARE;
 IF NOT FOUND OR v_held.event_type<>'hold' OR v_held.account_id<>v_hold.account_id
   OR v_held.hold_key<>v_hold.hold_key OR v_held.amount_cents<>v_hold.amount_cents
 THEN RAISE EXCEPTION 'CREDIT_RELEASE_LEDGER_INTEGRITY'; END IF;
 SELECT * INTO v_existing FROM store_credit_ledger
 WHERE account_id=v_hold.account_id AND hold_key=v_hold.hold_key
   AND event_type IN ('capture','release');
 IF FOUND THEN
   IF v_existing.event_type='release' AND v_existing.idempotency_key=p_request_key
     AND v_existing.amount_cents=v_hold.amount_cents
     AND EXISTS(SELECT 1 FROM store_credit_checkout_release_proofs p
       WHERE p.release_event_id=v_existing.id AND p.hold_event_id=v_hold.hold_event_id
         AND p.stripe_checkout_session_id=p_session_id AND p.payment_intent_final=p_pi_final)
   THEN RETURN v_existing.id; END IF;
   RAISE EXCEPTION 'CREDIT_RELEASE_HOLD_ALREADY_TERMINAL';
 END IF;
 IF EXISTS(SELECT 1 FROM store_credit_ledger WHERE idempotency_key=p_request_key)
   OR EXISTS(SELECT 1 FROM store_credit_checkout_release_proofs WHERE request_key=p_request_key)
 THEN RAISE EXCEPTION 'CREDIT_RELEASE_IDEMPOTENCY_CONFLICT'; END IF;
 SELECT * INTO v_res FROM reservations WHERE id=p_reservation FOR UPDATE;
 IF NOT FOUND OR v_res.status NOT IN ('released','failed')
   OR v_res.stripe_checkout_session_id IS DISTINCT FROM p_session_id
   OR v_res.expires_at>NOW()
 THEN RAISE EXCEPTION 'CREDIT_RELEASE_RESERVATION_NOT_TERMINAL'; END IF;
 -- No order of ANY payment state may exist: unknown/pending is not safe.
 IF EXISTS(SELECT 1 FROM orders o WHERE o.reservation_id=p_reservation
   OR o.stripe_checkout_session_id=p_session_id)
 THEN RAISE EXCEPTION 'CREDIT_RELEASE_ORDER_PRESENT'; END IF;
 INSERT INTO store_credit_ledger(account_id,event_type,amount_cents,idempotency_key,hold_key)
 VALUES(v_hold.account_id,'release',v_hold.amount_cents,p_request_key,v_hold.hold_key)
 RETURNING id INTO v_release;
 INSERT INTO store_credit_checkout_release_proofs(hold_event_id,release_event_id,
   stripe_checkout_session_id,stripe_status,stripe_payment_status,payment_intent_final,request_key)
 VALUES(v_hold.hold_event_id,v_release,p_session_id,'expired','unpaid',p_pi_final,p_request_key);
 RETURN v_release;
END; $$;
-- Immutable proof history. No updates or deletions to rewrite payment finality.
CREATE OR REPLACE FUNCTION kvrn_credit_release_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CREDIT_RELEASE_PROOF_APPEND_ONLY'; END; $$;
CREATE TRIGGER credit_release_proof_immutable BEFORE UPDATE OR DELETE
 ON store_credit_checkout_release_proofs FOR EACH ROW EXECUTE FUNCTION kvrn_credit_release_proof_immutable();
COMMIT;
