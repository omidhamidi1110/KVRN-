-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES f20a, f20d to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '=== Z6 paid -> refund -> recovery -> dispute win restore -> payable again ==='
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
  amount_cents,merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('d3000000-0000-0000-0000-00000000b001','d2000000-0000-0000-0000-00000000b001','reP1','ch_p1','pi_p1',4000,4000,0,0,'resolved','succeeded','2026-07-10T00:00:00Z');
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-00000000b001','sys')->>'adjustment_cents' AS reversal_after_payout;
SELECT status AS commission_status_preserved FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-00000000b001';
SELECT COUNT(*) AS payout_history_intact FROM affiliate_payout_lines
WHERE commission_id=(SELECT id FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-00000000b001');
SELECT record_affiliate_payout_recovery(
  (SELECT id FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-00000000b001'),
  400,'2026-07-10'::timestamptz,'admin','clawback','fx-f20e-m1')->>'recovery_amount_cents' AS recovery;
SELECT affiliate_commission_payable((SELECT id FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-00000000b001')) AS payable_after_recovery;
\echo '   paid status + payout line preserved; history never rewritten'
