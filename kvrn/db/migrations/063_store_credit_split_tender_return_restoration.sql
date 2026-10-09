-- KVRN 063: owner-approved restoration of ORIGINAL store-credit tender on returns.
-- DEVELOPMENT/STAGING ONLY, UNAPPLIED. Requires 018,041,053,057,062.
-- Completes the credit half of a cash-plus-credit return without claiming a
-- Stripe cash refund, modifying the original paid order, or overwriting ledger.
-- Cash refunds remain provider-confirmed and recorded by record_order_refund.
BEGIN;

CREATE TABLE IF NOT EXISTS store_credit_split_return_restorations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 return_id uuid NOT NULL UNIQUE REFERENCES order_returns(id) ON DELETE RESTRICT,
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 original_capture_proof_id uuid NOT NULL REFERENCES store_credit_checkout_capture_proofs(id) ON DELETE RESTRICT,
 credit_issue_event_id bigint NOT NULL UNIQUE REFERENCES store_credit_ledger(id) ON DELETE RESTRICT,
 amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<=9007199254740991),
 allocated_cash_merchandise_cents bigint NOT NULL CHECK(allocated_cash_merchandise_cents>=0),
 delivery_verified_at timestamptz NOT NULL,
 delivery_proof_sha256 text NOT NULL CHECK(delivery_proof_sha256 ~ '^[0-9a-f]{64}$'),
 owner_sha256 text NOT NULL CHECK(owner_sha256 ~ '^[0-9a-f]{64}$'),
 request_key text NOT NULL UNIQUE CHECK(request_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
 created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_split_restorations_order ON store_credit_split_return_restorations(order_id,created_at);

CREATE OR REPLACE FUNCTION kvrn_credit_restore_original_tender_on_return(
 p_return uuid,p_amount bigint,p_delivered timestamptz,
 p_delivery_proof text,p_owner_hash text,p_request_key text
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
 v_ret order_returns%ROWTYPE;
 v_order orders%ROWTYPE;
 v_proof store_credit_checkout_capture_proofs%ROWTYPE;
 v_hold store_credit_checkout_holds%ROWTYPE;
 v_existing store_credit_split_return_restorations%ROWTYPE;
 v_issued bigint;
 v_credit_issued numeric;
 v_cash_refunded numeric;
 v_cash_merch numeric;
 v_net_basis numeric;
 v_line_count integer;
 v_bad_lines integer;
BEGIN
 IF p_return IS NULL OR p_amount IS NULL OR p_amount<=0 OR p_amount>2147483647
   OR p_delivered IS NULL OR p_delivered>NOW()
   OR p_delivery_proof IS NULL OR p_delivery_proof !~ '^[0-9a-f]{64}$'
   OR p_owner_hash IS NULL OR p_owner_hash !~ '^[0-9a-f]{64}$'
   OR p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9:_-]{12,120}$'
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_INVALID_REQUEST'; END IF;
 PERFORM pg_advisory_xact_lock(48112026051::bigint);
 SELECT * INTO v_ret FROM order_returns WHERE id=p_return FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_RESTORE_RETURN_MISSING'; END IF;
 SELECT * INTO v_order FROM orders WHERE id=v_ret.order_id FOR SHARE;
 IF NOT FOUND OR v_order.payment_status<>'paid' OR lower(v_order.currency)<>'usd'
   OR v_order.paid_at IS NULL OR v_order.fulfillment_status='cancelled'
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_PAYMENT_UNVERIFIED'; END IF;
 SELECT * INTO v_proof FROM store_credit_checkout_capture_proofs
  WHERE order_id=v_order.id FOR SHARE;
 IF NOT FOUND OR v_proof.credit_captured_cents<=0
    OR v_proof.cash_received_cents<>v_order.total_cents
    OR v_proof.cash_received_cents+v_proof.credit_captured_cents<>v_proof.gross_order_cents
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_ORIGINAL_TENDER_UNPROVEN'; END IF;
 SELECT * INTO v_hold FROM store_credit_checkout_holds
 WHERE reservation_id=v_proof.reservation_id FOR SHARE;
 IF NOT FOUND OR v_hold.amount_cents<>v_proof.credit_captured_cents
    OR v_hold.hold_event_id<>v_proof.hold_event_id
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_ORIGINAL_ACCOUNT_UNPROVEN'; END IF;
 -- Exact idempotent replay of the same owner evidence is allowed, but a
 -- different request or return must NEVER increase the credited amount.
 SELECT * INTO v_existing FROM store_credit_split_return_restorations WHERE return_id=p_return;
 IF FOUND THEN
   IF v_existing.order_id=v_order.id AND v_existing.original_capture_proof_id=v_proof.id
     AND v_existing.amount_cents=p_amount AND v_existing.delivery_verified_at=p_delivered
     AND v_existing.delivery_proof_sha256=p_delivery_proof
     AND v_existing.owner_sha256=p_owner_hash AND v_existing.request_key=p_request_key
     AND EXISTS(SELECT 1 FROM store_credit_ledger l WHERE l.id=v_existing.credit_issue_event_id
      AND l.return_id=p_return AND l.event_type='issue' AND l.account_id=v_hold.account_id
      AND l.amount_cents=p_amount AND l.idempotency_key=p_request_key)
   THEN RETURN v_existing.credit_issue_event_id; END IF;
   RAISE EXCEPTION 'CREDIT_RESTORE_REPLAY_CONFLICT';
 END IF;
 IF EXISTS(SELECT 1 FROM store_credit_ledger WHERE idempotency_key=p_request_key OR return_id=p_return)
   OR EXISTS(SELECT 1 FROM store_credit_return_approvals WHERE return_id=p_return)
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_ALREADY_SETTLED'; END IF;
 IF v_ret.status<>'completed' OR v_ret.received_at IS NULL OR v_ret.completed_at IS NULL
    OR v_ret.requested_at IS NULL OR v_ret.requested_at<p_delivered
    OR v_ret.requested_at>p_delivered+INTERVAL '14 days'
    OR v_ret.received_at<v_ret.requested_at OR v_ret.completed_at<v_ret.received_at
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_RETURN_NOT_INSPECTED_OR_LATE'; END IF;
 -- Disputes, pending/uncertain Stripe refunds and unallocated Stripe refunds
 -- forbid restoration until the financial history can be reconciled.
 IF EXISTS(SELECT 1 FROM order_disputes WHERE order_id=v_order.id)
   OR EXISTS(SELECT 1 FROM order_refunds WHERE order_id=v_order.id AND status<>'succeeded')
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_DISPUTE_OR_UNRESOLVED_REFUND'; END IF;
 SELECT COALESCE(SUM(amount_cents::numeric),0) INTO v_cash_refunded
 FROM order_refunds WHERE order_id=v_order.id AND status='succeeded';
 IF v_cash_refunded>v_proof.cash_received_cents
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_CASH_REFUND_OVERFLOW'; END IF;
 -- Sum DISTINCT allocation rows once. Refunds allocated to multiple returns
 -- may never collectively exceed the corresponding Stripe cash refund.
 IF EXISTS(
   SELECT 1 FROM order_refunds rf
   LEFT JOIN return_refund_allocations a ON a.refund_id=rf.id
   WHERE rf.order_id=v_order.id AND rf.status='succeeded'
   GROUP BY rf.id,rf.amount_cents
   HAVING COALESCE(SUM(a.merchandise_cents::numeric+a.shipping_cents::numeric+a.tax_cents::numeric),0)
      <>rf.amount_cents::numeric
 ) THEN RAISE EXCEPTION 'CREDIT_RESTORE_UNALLOCATED_CASH_REFUND'; END IF;
 SELECT COALESCE(SUM(a.merchandise_cents::numeric),0)
 INTO v_cash_merch FROM return_refund_allocations a
 JOIN order_refunds rf ON rf.id=a.refund_id
 WHERE a.return_id=p_return AND rf.order_id=v_order.id AND rf.status='succeeded';
 SELECT COUNT(*)::int,
    COUNT(*) FILTER(WHERE ri.net_merchandise_basis_cents IS NULL
     OR ri.net_merchandise_basis_cents<0 OR ri.quantity<=0 OR oi.order_id<>v_order.id)::int,
    COALESCE(SUM(ri.net_merchandise_basis_cents::numeric),0)
 INTO v_line_count,v_bad_lines,v_net_basis FROM order_return_items ri
 JOIN order_items oi ON oi.id=ri.order_item_id WHERE ri.return_id=p_return;
 IF v_line_count<1 OR v_bad_lines>0 OR v_net_basis<p_amount+v_cash_merch
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_EXCEEDS_RETURNED_MERCHANDISE'; END IF;
 -- A returned unit is not a renewable source of money. Prevent overlapping
 -- completed returns from claiming more units than the original order sold.
 IF EXISTS (
   SELECT 1 FROM order_return_items ri
   JOIN order_returns other_return ON other_return.id=ri.return_id
   JOIN order_items oi ON oi.id=ri.order_item_id
   WHERE other_return.order_id=v_order.id
     AND other_return.status='completed'
   GROUP BY ri.order_item_id,oi.quantity
   HAVING SUM(ri.quantity::numeric)>oi.quantity::numeric
 ) THEN RAISE EXCEPTION 'CREDIT_RESTORE_DUPLICATE_RETURN_UNITS'; END IF;
 -- Includes all previous issued credits on returns of this SAME order, even
 -- through the standard 053 workflow. Restorations can never exceed original
 -- credit tender, irrespective of how many physical returns were opened.
 SELECT COALESCE(SUM(l.amount_cents::numeric),0) INTO v_credit_issued
 FROM store_credit_ledger l JOIN order_returns r ON r.id=l.return_id
 WHERE r.order_id=v_order.id AND l.event_type='issue';
 IF v_credit_issued+p_amount>v_proof.credit_captured_cents
   OR v_cash_refunded+v_credit_issued+p_amount>v_proof.gross_order_cents
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_EXCEEDS_ORIGINAL_TENDER'; END IF;
 IF EXISTS(SELECT 1 FROM store_credit_ledger WHERE account_id=v_hold.account_id
  AND event_type='issue' GROUP BY account_id
  HAVING COALESCE(SUM(amount_cents::numeric),0)+p_amount>9007199254740991)
 THEN RAISE EXCEPTION 'CREDIT_RESTORE_ACCOUNT_OVERFLOW'; END IF;
 INSERT INTO store_credit_ledger(account_id,event_type,amount_cents,idempotency_key,return_id)
 VALUES(v_hold.account_id,'issue',p_amount,p_request_key,p_return)
 RETURNING id INTO v_issued;
 INSERT INTO store_credit_split_return_restorations(return_id,order_id,original_capture_proof_id,
  credit_issue_event_id,amount_cents,allocated_cash_merchandise_cents,delivery_verified_at,
  delivery_proof_sha256,owner_sha256,request_key)
 VALUES(p_return,v_order.id,v_proof.id,v_issued,p_amount,v_cash_merch::bigint,p_delivered,
  p_delivery_proof,p_owner_hash,p_request_key);
 RETURN v_issued;
END; $$;

CREATE OR REPLACE FUNCTION kvrn_credit_restore_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CREDIT_RESTORE_PROOF_APPEND_ONLY'; END; $$;
CREATE TRIGGER credit_split_return_restore_immutable BEFORE UPDATE OR DELETE
ON store_credit_split_return_restorations FOR EACH ROW EXECUTE FUNCTION kvrn_credit_restore_proof_immutable();
COMMIT;
