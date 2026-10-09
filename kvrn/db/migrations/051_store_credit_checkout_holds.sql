-- KVRN 051: isolated, non-sending / non-payment store-credit CHECKOUT HOLD writer.
-- NOT APPLIED. Migration 041 required; staging tests and owner approval required.
-- There is intentionally no issue, capture, release or customer-facing API here.
-- Checkout must separately verify customer ownership, actual net tender, Stripe
-- split-tender correctness and canonical reservation economics BEFORE calling.
-- Merely storing a hold does not reduce the amount Stripe charges.
BEGIN;

CREATE TABLE IF NOT EXISTS store_credit_checkout_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES store_credit_accounts(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  hold_event_id bigint NOT NULL UNIQUE REFERENCES store_credit_ledger(id) ON DELETE RESTRICT,
  hold_key text NOT NULL UNIQUE CHECK(length(hold_key) BETWEEN 12 AND 120),
  amount_cents bigint NOT NULL CHECK(amount_cents > 0 AND amount_cents <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sc_checkout_holds_account ON store_credit_checkout_holds(account_id,created_at);

CREATE OR REPLACE FUNCTION kvrn_credit_create_checkout_hold(
  p_account uuid, p_reservation uuid, p_hold_key text, p_request_key text, p_cents bigint
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_existing store_credit_checkout_holds%ROWTYPE;
  v_replay store_credit_ledger%ROWTYPE;
  v_res reservations%ROWTYPE;
  v_issued numeric;
  v_captured numeric;
  v_pending numeric;
  v_available numeric;
  v_event bigint;
BEGIN
  IF p_account IS NULL OR p_reservation IS NULL
     OR p_hold_key IS NULL OR p_hold_key !~ '^[A-Za-z0-9:_-]{12,120}$'
     OR p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9:_-]{12,120}$'
     OR p_cents IS NULL OR p_cents <= 0 OR p_cents > 9007199254740991
  THEN RAISE EXCEPTION 'CREDIT_HOLD_INVALID_INPUT'; END IF;
  -- Shared constant lock prevents two concurrent holds spending the same credit.
  -- Future terminal writers MUST take this SAME advisory lock.
  PERFORM pg_advisory_xact_lock(48112026051::bigint);

  SELECT * INTO v_existing FROM store_credit_checkout_holds WHERE reservation_id=p_reservation;
  IF FOUND THEN
    IF v_existing.account_id=p_account AND v_existing.hold_key=p_hold_key
       AND v_existing.amount_cents=p_cents AND EXISTS (
         SELECT 1 FROM store_credit_ledger e WHERE e.id=v_existing.hold_event_id
           AND e.event_type='hold' AND e.idempotency_key=p_request_key
           AND e.hold_key=p_hold_key AND e.amount_cents=p_cents
       ) THEN RETURN v_existing.hold_event_id; END IF;
    RAISE EXCEPTION 'CREDIT_RESERVATION_ALREADY_HELD';
  END IF;
  -- Do not allow a different reservation to reuse an old idempotency key.
  SELECT * INTO v_replay FROM store_credit_ledger WHERE idempotency_key=p_request_key;
  IF FOUND THEN RAISE EXCEPTION 'CREDIT_HOLD_IDEMPOTENCY_CONFLICT'; END IF;
  IF EXISTS (SELECT 1 FROM store_credit_checkout_holds WHERE hold_key=p_hold_key) THEN
    RAISE EXCEPTION 'CREDIT_HOLD_KEY_CONFLICT';
  END IF;
  PERFORM 1 FROM store_credit_accounts WHERE id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_ACCOUNT_NOT_FOUND'; END IF;
  SELECT * INTO v_res FROM reservations WHERE id=p_reservation FOR UPDATE;
  IF NOT FOUND OR v_res.status NOT IN ('open','awaiting_payment')
     OR v_res.expires_at IS NULL OR v_res.expires_at <= NOW()
     OR v_res.stripe_checkout_session_id IS NULL
  THEN RAISE EXCEPTION 'CREDIT_CHECKOUT_RESERVATION_NOT_ACTIVE'; END IF;
  -- Numeric aggregates: never silently overflow bigint/JS precision.
  SELECT
    COALESCE(SUM(e.amount_cents) FILTER (WHERE e.event_type='issue'),0),
    COALESCE(SUM(e.amount_cents) FILTER (WHERE e.event_type='capture'),0),
    COALESCE(SUM(e.amount_cents) FILTER (WHERE e.event_type='hold'
      AND NOT EXISTS (
        SELECT 1 FROM store_credit_ledger t
        WHERE t.account_id=e.account_id AND t.hold_key=e.hold_key
          AND t.event_type IN ('capture','release')
      )),0)
  INTO v_issued,v_captured,v_pending
  FROM store_credit_ledger e WHERE e.account_id=p_account;
  v_available := v_issued-v_captured-v_pending;
  IF v_available < p_cents OR v_available < 0
     OR v_available > 9007199254740991 OR v_pending < 0
     OR v_issued > 9007199254740991 OR v_captured > v_issued
  THEN RAISE EXCEPTION 'CREDIT_INSUFFICIENT_OR_LEDGER_INTEGRITY'; END IF;

  INSERT INTO store_credit_ledger(account_id,event_type,amount_cents,idempotency_key,hold_key)
  VALUES(p_account,'hold',p_cents,p_request_key,p_hold_key) RETURNING id INTO v_event;
  INSERT INTO store_credit_checkout_holds(account_id,reservation_id,hold_event_id,hold_key,amount_cents)
  VALUES(p_account,p_reservation,v_event,p_hold_key,p_cents);
  RETURN v_event;
END; $$;

-- Do not grant EXECUTE to browser-facing roles. As with all KVRN DB functions,
-- app calls must be authenticated server-side and gated by explicit env approval.
-- No endpoint calls this procedure in this phase.
COMMIT;
