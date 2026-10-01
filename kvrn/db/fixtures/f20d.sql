-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES f20a to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '=== Z1 ZERO-BASE INVARIANT: fully discounted order -> commission 0 ==='
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_fixed_cents)
VALUES ('d1000000-0000-0000-0000-000000000f01','AFFFIX','Fixed 50','fixed',5000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at)
VALUES ('d1000000-0000-0000-0000-000000000f01','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='d1000000-0000-0000-0000-000000000f01';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='d1000000-0000-0000-0000-000000000f01';
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('d2000000-0000-0000-0000-00000000a001','OZ1','cs_z1','pi_z1','paid','usd',5000,0,5000,0,0,'2026-06-01','AFFFIX');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-00000000a001',NULL,'sys')->>'commission_cents' AS zero_base_commission;
SELECT compute_affiliate_commission(0,'fixed',NULL,5000) AS fixed_at_zero,
       compute_affiliate_commission(0,'percentage',1000,NULL) AS pct_at_zero,
       compute_affiliate_commission(3000,'fixed',NULL,5000) AS fixed_capped_at_base;

\echo '=== Z2 PAUSED affiliate: pre-pause click qualifies, post-pause does not ==='
INSERT INTO affiliate_links (id,affiliate_id,slug) VALUES ('d4000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','go');
INSERT INTO affiliate_clicks (id,link_id,affiliate_id,session_id,occurred_at)
VALUES ('d5000000-0000-0000-0000-000000000001','d4000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','sessA','2026-06-01T00:00:00Z');
INSERT INTO affiliate_status_events (affiliate_id,to_status,from_status,effective_at)
VALUES ('d1000000-0000-0000-0000-000000000001','paused','active','2026-06-15T00:00:00Z');
SELECT affiliate_active_at('d1000000-0000-0000-0000-000000000001','2026-06-01'::timestamptz) AS active_before_pause,
       affiliate_active_at('d1000000-0000-0000-0000-000000000001','2026-06-20'::timestamptz) AS active_after_pause;
\echo '--- existing accruals survive the pause ---'
SELECT COUNT(*) AS surviving_commissions FROM affiliate_commissions WHERE affiliate_id='d1000000-0000-0000-0000-000000000001';
INSERT INTO affiliate_status_events (affiliate_id,to_status,from_status,effective_at)
VALUES ('d1000000-0000-0000-0000-000000000001','active','paused','2026-06-16T00:00:00Z');

\echo '=== Z3 HOLD SNAPSHOT: later config change cannot move eligibility ==='
SELECT hold_days_snapshot, eligible_at FROM order_affiliate_attributions
WHERE order_id='d2000000-0000-0000-0000-000000000001';
UPDATE affiliates SET commission_hold_days=90 WHERE id='d1000000-0000-0000-0000-000000000001';
SELECT hold_days_snapshot, eligible_at AS unchanged_after_config_change FROM order_affiliate_attributions
WHERE order_id='d2000000-0000-0000-0000-000000000001';

\echo '=== Z4 auto-approval after hold; incomplete never auto-approves ==='
SELECT approve_eligible_commissions('2026-08-01'::timestamptz)->>'count' AS approved;
SELECT COUNT(*) AS still_pending_incomplete FROM affiliate_commissions WHERE incomplete AND status='pending';

\echo '=== Z5 PAYOUT lifecycle: pay -> refund -> recovery -> restore -> pay again ==='
SELECT mk_order('d2000000-0000-0000-0000-00000000b001','OP1','pi_p1');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-00000000b001',NULL,'sys');
UPDATE affiliate_commissions SET status='approved' WHERE order_id='d2000000-0000-0000-0000-00000000b001';
SELECT affiliate_commission_payable((SELECT id FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-00000000b001')) AS payable_1;
SELECT create_affiliate_payout('d1000000-0000-0000-0000-000000000001',
  ARRAY[(SELECT id FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-00000000b001')],'admin')->>'amount_cents' AS payout_1;
SELECT mark_affiliate_payout_paid((SELECT id FROM affiliate_payouts ORDER BY created_at DESC LIMIT 1),'2026-07-01'::timestamptz,'ach','r1','admin')->>'outcome';
SELECT affiliate_commission_payable((SELECT id FROM affiliate_commissions WHERE order_id='d2000000-0000-0000-0000-00000000b001')) AS payable_after_pay;
\echo '   payable must now be 0'
