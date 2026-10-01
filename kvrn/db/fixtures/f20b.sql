-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES f20a to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '=== S4 partial refund 2000 + PARTIAL dispute -> Incomplete, no guess ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000004','O4','pi_4');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000004',NULL,'sys');
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
  amount_cents,merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('d3000000-0000-0000-0000-000000000004','d2000000-0000-0000-0000-000000000004','re4','ch4','pi_4',
  2000,2000,0,0,'resolved','succeeded','2026-06-05T00:00:00Z');
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-000000000004','sys')->>'adjustment_cents' AS s4_refund;
SELECT upsert_order_dispute('du4','ch4','pi_4',6000,'usd','lost','lost','ev4','charge.dispute.closed',
  '2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment(
  (SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000004'),'sys')
  ->>'outcome' AS s4_dispute_outcome;
SELECT incomplete, incomplete_reason FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-000000000004';
SELECT SUM(adjustment_cents) AS s4_net FROM affiliate_commission_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000004';

\echo '--- S4b ADMIN RESOLVES the partial dispute: merch 3000 of 6000 ---'
SELECT resolve_dispute_merchandise(
  (SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000004'),
  3000,3000,0,'admin@kvrn','verified') -> 'affiliate_effect' ->> 'adjustment_cents' AS s4b_effect;
SELECT incomplete FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-000000000004';
SELECT SUM(adjustment_cents) AS s4b_net FROM affiliate_commission_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000004';
\echo '   expect -300 (3000/10000 x 1000); net 1000-200-300 = 500'

\echo '--- S4c DUPLICATE resolution refused ---'
SELECT resolve_dispute_merchandise(
  (SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000004'),
  3000,3000,0,'admin@kvrn',NULL)->>'outcome' AS s4c;

\echo '--- S4d components must total the disputed amount ---'
DO $$ BEGIN
  PERFORM resolve_dispute_merchandise(
    (SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000001'),
    1,1,1,'admin@kvrn',NULL);
  RAISE NOTICE 'S4d FAIL accepted';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'S4d PASS %', SPLIT_PART(SQLERRM,'|',2); END $$;

\echo '=== S5 multiple partial refunds 2000+3000 then dispute lost full ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000005','O5','pi_5');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000005',NULL,'sys');
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
  amount_cents,merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('d3000000-0000-0000-0000-000000000051','d2000000-0000-0000-0000-000000000005','re51','ch5','pi_5',2000,2000,0,0,'resolved','succeeded','2026-06-03T00:00:00Z'),
       ('d3000000-0000-0000-0000-000000000052','d2000000-0000-0000-0000-000000000005','re52','ch5','pi_5',3000,3000,0,0,'resolved','succeeded','2026-06-04T00:00:00Z');
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-000000000051','sys')->>'adjustment_cents' AS r1;
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-000000000052','sys')->>'adjustment_cents' AS r2;
SELECT upsert_order_dispute('du5','ch5','pi_5',11000,'usd','lost','lost','ev5','charge.dispute.closed',
  '2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment(
  (SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000005'),'sys')
  ->>'adjustment_cents' AS s5_dispute;
SELECT SUM(adjustment_cents) AS s5_net FROM affiliate_commission_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000005';
\echo '   -200 -300 -500 = -1000 total reversal; net 0'
