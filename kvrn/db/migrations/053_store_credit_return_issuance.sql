-- KVRN 053 — inspected-return store-credit issuance, STAGING ONLY / NOT APPLIED.
-- Depends on 041, 051 and existing 018 return/refund financial snapshots.
-- Disabled by application gate. No customer-access or checkout-redemption route.
-- Paid, completed returns can be credited only after separately verified delivery
-- evidence and an explicit owner review. Carrier evidence is NOT verified by SQL.
BEGIN;
CREATE TABLE IF NOT EXISTS store_credit_return_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL UNIQUE REFERENCES order_returns(id) ON DELETE RESTRICT,
  credit_event_id bigint NOT NULL UNIQUE REFERENCES store_credit_ledger(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  delivery_verified_at timestamptz NOT NULL,
  delivery_evidence_sha256 text NOT NULL CHECK(delivery_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by_owner_sha256 text NOT NULL CHECK(approved_by_owner_sha256 ~ '^[0-9a-f]{64}$'),
  request_key text NOT NULL UNIQUE CHECK(request_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
  approved_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sc_return_approvals_recent ON store_credit_return_approvals(approved_at DESC);

CREATE OR REPLACE FUNCTION kvrn_credit_issue_inspected_return(
 p_return uuid,p_account_key text,p_amount bigint,p_delivered timestamptz,
 p_delivery_proof_hash text,p_owner_hash text,p_request_key text
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
 v_return order_returns%ROWTYPE;
 v_order orders%ROWTYPE;
 v_existing store_credit_return_approvals%ROWTYPE;
 v_account uuid;
 v_event bigint;
 v_line_count integer;
 v_unsafe_lines integer;
 v_net_basis numeric;
 v_total_issued numeric;
BEGIN
 IF p_return IS NULL OR p_account_key IS NULL OR p_account_key !~ '^[0-9a-f]{64}$'
   OR p_amount IS NULL OR p_amount<=0 OR p_amount>9007199254740991
   OR p_delivered IS NULL OR p_delivered>NOW()
   OR p_delivery_proof_hash IS NULL OR p_delivery_proof_hash !~ '^[0-9a-f]{64}$'
   OR p_owner_hash IS NULL OR p_owner_hash !~ '^[0-9a-f]{64}$'
   OR p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9:_-]{12,120}$'
 THEN RAISE EXCEPTION 'CREDIT_ISSUE_INVALID_INPUT'; END IF;
 -- Shared with checkout hold writer: no concurrent issue can overdraw an account.
 PERFORM pg_advisory_xact_lock(48112026051::bigint);
 SELECT * INTO v_return FROM order_returns WHERE id=p_return FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_RETURN_MISSING'; END IF;
 SELECT * INTO v_order FROM orders WHERE id=v_return.order_id FOR SHARE;
 IF NOT FOUND OR v_order.currency<>'usd' OR v_order.payment_status<>'paid'
    OR v_order.customer_email IS NULL OR btrim(v_order.customer_email)=''
 THEN RAISE EXCEPTION 'CREDIT_ORDER_PAYMENT_OR_IDENTITY_UNVERIFIED'; END IF;
 -- Strictly after checkout payment and physical return inspection; never treat
 -- completed return alone as approval for cash or a stored-value balance.
 IF v_return.status<>'completed' OR v_return.received_at IS NULL OR v_return.completed_at IS NULL
   OR v_return.requested_at IS NULL OR v_return.requested_at < p_delivered
   OR v_return.requested_at > p_delivered+INTERVAL '14 days'
   OR v_return.received_at<v_return.requested_at
   OR v_return.completed_at<v_return.received_at
 THEN RAISE EXCEPTION 'CREDIT_RETURN_WINDOW_OR_INSPECTION_INVALID'; END IF;
 -- A retry must match every liability/evidence attribute exactly. No duplicate
 -- credit can be issued for the same physical return or re-used request key.
 SELECT * INTO v_existing FROM store_credit_return_approvals WHERE return_id=p_return;
 IF FOUND THEN
   IF v_existing.amount_cents=p_amount AND v_existing.delivery_verified_at=p_delivered
      AND v_existing.delivery_evidence_sha256=p_delivery_proof_hash
      AND v_existing.approved_by_owner_sha256=p_owner_hash
      AND v_existing.request_key=p_request_key
      AND EXISTS (SELECT 1 FROM store_credit_ledger l JOIN store_credit_accounts a ON a.id=l.account_id
        WHERE l.id=v_existing.credit_event_id AND l.event_type='issue'
          AND l.return_id=p_return AND l.amount_cents=p_amount
          AND l.idempotency_key=p_request_key AND a.account_key=p_account_key)
   THEN RETURN v_existing.credit_event_id; END IF;
   RAISE EXCEPTION 'CREDIT_RETURN_ALREADY_ISSUED';
 END IF;
 IF EXISTS(SELECT 1 FROM store_credit_ledger WHERE idempotency_key=p_request_key)
   OR EXISTS(SELECT 1 FROM store_credit_return_approvals WHERE request_key=p_request_key)
 THEN RAISE EXCEPTION 'CREDIT_ISSUE_KEY_ALREADY_USED'; END IF;
 -- ANY refund/chargeback is potentially overlapping, including pending/failed
 -- records. Mixed cash/credit settlements need a separately reconciled design.
 IF EXISTS(SELECT 1 FROM order_refunds WHERE order_id=v_order.id)
   OR EXISTS(SELECT 1 FROM return_refund_allocations WHERE return_id=p_return)
   OR EXISTS(SELECT 1 FROM order_disputes WHERE order_id=v_order.id)
 THEN RAISE EXCEPTION 'CREDIT_REFUND_OR_DISPUTE_PRESENT'; END IF;
 SELECT COUNT(*),
   COUNT(*) FILTER (WHERE ri.net_merchandise_basis_cents IS NULL
                      OR ri.net_merchandise_basis_cents<0 OR ri.quantity<=0
                      OR oi.order_id<>v_order.id),
   COALESCE(SUM(ri.net_merchandise_basis_cents::numeric),0)
 INTO v_line_count,v_unsafe_lines,v_net_basis
 FROM order_return_items ri JOIN order_items oi ON oi.id=ri.order_item_id
 WHERE ri.return_id=p_return;
 IF v_line_count<1 OR v_unsafe_lines>0 OR v_net_basis<p_amount
    OR v_net_basis>9007199254740991
 THEN RAISE EXCEPTION 'CREDIT_MERCHANDISE_ECONOMICS_INVALID'; END IF;
 -- Caller must derive p_account_key from THIS order's normalized customer email
 -- using the server-only pepper; SQL does not have or accept the pepper.
 INSERT INTO store_credit_accounts(account_key) VALUES(p_account_key) ON CONFLICT(account_key) DO NOTHING;
 SELECT id INTO v_account FROM store_credit_accounts WHERE account_key=p_account_key FOR UPDATE;
 IF v_account IS NULL THEN RAISE EXCEPTION 'CREDIT_ACCOUNT_INTEGRITY'; END IF;
 SELECT COALESCE(SUM(amount_cents::numeric),0) INTO v_total_issued
 FROM store_credit_ledger WHERE account_id=v_account AND event_type='issue';
 IF v_total_issued+p_amount>9007199254740991 THEN RAISE EXCEPTION 'CREDIT_ISSUE_TOTAL_OVERFLOW'; END IF;
 INSERT INTO store_credit_ledger(account_id,event_type,amount_cents,idempotency_key,return_id)
 VALUES(v_account,'issue',p_amount,p_request_key,p_return) RETURNING id INTO v_event;
 INSERT INTO store_credit_return_approvals(return_id,credit_event_id,amount_cents,
   delivery_verified_at,delivery_evidence_sha256,approved_by_owner_sha256,request_key)
 VALUES(p_return,v_event,p_amount,p_delivered,p_delivery_proof_hash,p_owner_hash,p_request_key);
 RETURN v_event;
END; $$;

-- Append-only review history. Trigger prevents silent changes to the evidence
-- once financial liability has been issued. Retain evidence hashes, not raw IDs.
CREATE OR REPLACE FUNCTION kvrn_credit_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CREDIT_APPROVALS_APPEND_ONLY'; END; $$;
CREATE TRIGGER store_credit_approvals_immutable BEFORE UPDATE OR DELETE
 ON store_credit_return_approvals FOR EACH ROW EXECUTE FUNCTION kvrn_credit_approval_immutable();
-- No trigger, cron or API automatically creates credit. No source of funds
-- is conjured or booked as historical cash revenue.
COMMIT;
