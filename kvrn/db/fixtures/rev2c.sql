-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES rev2, rev2b to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '=== R7 unresolved refund + unresolved dispute: resolve one, still blocked ==='
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('a9100000-0000-0000-0000-000000000007','R7','R7','percentage',1000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('a9100000-0000-0000-0000-000000000007','active','2020-01-01');
SELECT mko('a9200000-0000-0000-0000-000000000007','R7','pi_r7',10000,0,'R7',NULL);
SELECT resolve_order_affiliate_attribution('a9200000-0000-0000-0000-000000000007',NULL,'s');
-- unresolved refund
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,status,refunded_at)
VALUES ('a9300000-0000-0000-0000-000000000007','a9200000-0000-0000-0000-000000000007','u7','ch7','pi_r7',2000,'succeeded','2026-06-05');
SELECT apply_affiliate_refund_reversal('a9300000-0000-0000-0000-000000000007','s')->>'outcome' AS refund_blocked;
-- plus an unresolved partial dispute
SELECT upsert_order_dispute('d7','ch7','pi_r7',3000,'usd','lost','lost','ev7','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='a9200000-0000-0000-0000-000000000007'),'s')->>'outcome' AS dispute_blocked;
SELECT COUNT(*) AS unresolved FROM affiliate_unresolved_sources((SELECT id FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000007'));
\echo '--- resolve ONLY the refund (fix #4 path) ---'
SELECT resolve_refund_components('a9300000-0000-0000-0000-000000000007'::uuid,2000,0,0,'admin')->>'outcome' AS refund_resolved;
SELECT resume_affiliate_after_refund_resolution('a9300000-0000-0000-0000-000000000007'::uuid,'admin') -> 'reversal' ->> 'adjustment_cents' AS auto_reversal;
SELECT incomplete FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000007';
\echo '   EXPECT reversal -200 applied AND incomplete still TRUE (dispute unresolved)'
\echo '--- idempotency of the resume path ---'
SELECT resume_affiliate_after_refund_resolution('a9300000-0000-0000-0000-000000000007'::uuid,'admin') -> 'reversal' ->> 'outcome' AS resume_again;

\echo '=== R8/R9/R10 draft vs paid vs void ==='
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('a9100000-0000-0000-0000-000000000008','R8','R8','percentage',1000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('a9100000-0000-0000-0000-000000000008','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='a9100000-0000-0000-0000-000000000007';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='a9100000-0000-0000-0000-000000000007';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='a9100000-0000-0000-0000-000000000008';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='a9100000-0000-0000-0000-000000000008';
SELECT mko('a9200000-0000-0000-0000-000000000008','R8','pi_r8',10000,0,'R8',NULL);
SELECT resolve_order_affiliate_attribution('a9200000-0000-0000-0000-000000000008',NULL,'s');
UPDATE affiliate_commissions SET status='approved' WHERE order_id='a9200000-0000-0000-0000-000000000008';
SELECT create_affiliate_payout('a9100000-0000-0000-0000-000000000008',
  ARRAY[(SELECT id FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000008')],'admin')->>'amount_cents' AS draft;
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('a9300000-0000-0000-0000-000000000008','a9200000-0000-0000-0000-000000000008','r8','ch8','pi_r8',5000,5000,0,0,'resolved','succeeded','2026-06-20');
SELECT apply_affiliate_refund_reversal('a9300000-0000-0000-0000-000000000008','s')->>'adjustment_cents' AS reversal;
SELECT affiliate_commission_overpaid((SELECT id FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000008')) AS overpaid_while_draft;
\echo '   R8 EXPECT overpaid 0 -- a draft has moved no cash'
SELECT mark_affiliate_payout_paid((SELECT id FROM affiliate_payouts WHERE affiliate_id='a9100000-0000-0000-0000-000000000008'),'2026-06-25'::timestamptz,'ach','r','admin')->>'outcome';
SELECT affiliate_commission_overpaid((SELECT id FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000008')) AS overpaid_after_paid;
\echo '   R9 EXPECT overpaid 500 -- 1000 paid vs 500 earned'
UPDATE affiliate_payouts SET status='void' WHERE affiliate_id='a9100000-0000-0000-0000-000000000008';
SELECT affiliate_commission_payable((SELECT id FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000008')) AS payable_after_void,
       affiliate_commission_overpaid((SELECT id FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000008')) AS overpaid_after_void;
\echo '   R10 EXPECT payable 500 restored, overpaid 0'
