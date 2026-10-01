-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES f20a, f20b to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '=== S6 lost -> won: restore exactly what THIS dispute reversed ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000006','O6','pi_6');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000006',NULL,'sys');
SELECT upsert_order_dispute('du6','ch6','pi_6',11000,'usd','lost','lost','ev6a','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000006' ORDER BY effective_at LIMIT 1),'sys')->>'adjustment_cents' AS s6_lost;
SELECT upsert_order_dispute('du6','ch6','pi_6',11000,'usd','won','won','ev6b','charge.dispute.closed','2026-07-03T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000006' ORDER BY effective_at DESC LIMIT 1),'sys')->>'adjustment_cents' AS s6_won;
SELECT SUM(adjustment_cents) AS s6_net FROM affiliate_commission_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000006';
\echo '   -1000 then +1000; net back to 1000 accrued'

\echo '=== S7 lost -> partial refund -> won: restore ONLY dispute part ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000007','O7','pi_7');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000007',NULL,'sys');
SELECT upsert_order_dispute('du7','ch7','pi_7',11000,'usd','lost','lost','ev7a','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000007' ORDER BY effective_at LIMIT 1),'sys')->>'adjustment_cents' AS s7_lost;
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
  amount_cents,merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('d3000000-0000-0000-0000-000000000007','d2000000-0000-0000-0000-000000000007','re7','ch7','pi_7',5000,5000,0,0,'resolved','succeeded','2026-06-20T00:00:00Z');
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-000000000007','sys')->>'adjustment_cents' AS s7_refund;
SELECT upsert_order_dispute('du7','ch7','pi_7',11000,'usd','won','won','ev7b','charge.dispute.closed','2026-07-03T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000007' ORDER BY effective_at DESC LIMIT 1),'sys')->>'adjustment_cents' AS s7_won;
SELECT SUM(adjustment_cents) AS s7_net FROM affiliate_commission_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000007';
\echo '   refund added 0 (already fully reversed); win restores +1000; net 1000'

\echo '=== S8 prevented -> 018 emits nothing, so NO affiliate effect ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000008','O8','pi_8');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000008',NULL,'sys');
SELECT upsert_order_dispute('du8','ch8','pi_8',11000,'usd','prevented','prevented','ev8','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb)->>'revenue_adjustment_cents' AS s8_018_effect;
SELECT COUNT(*) AS s8_dispute_adjustments FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000008';
SELECT SUM(adjustment_cents) AS s8_net FROM affiliate_commission_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000008';
\echo '   018 emits 0 adjustments; affiliate net stays 1000'

\echo '=== S9 refund decomposition UNRESOLVED -> incomplete, no guess ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000009','O9','pi_9');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000009',NULL,'sys');
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,status,refunded_at)
VALUES ('d3000000-0000-0000-0000-000000000009','d2000000-0000-0000-0000-000000000009','re9','ch9','pi_9',5000,'succeeded','2026-06-05T00:00:00Z');
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-000000000009','sys')->>'outcome' AS s9;
SELECT incomplete, incomplete_reason FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-000000000009';
SELECT SUM(adjustment_cents) AS s9_net FROM affiliate_commission_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000009';
\echo '   no adjustment written; commission flagged; net stays 1000'

\echo '=== S10 duplicate / repeated application is idempotent ==='
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-000000000051','sys')->>'outcome' AS dup_refund;
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000005' LIMIT 1),'sys')->>'outcome' AS dup_dispute;
SELECT SUM(adjustment_cents) AS s5_still_zero FROM affiliate_commission_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000005';
