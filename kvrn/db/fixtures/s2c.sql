-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES s2test, s2b to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '########## T4b RECOVERY LIFECYCLE (dispute-caused reversal, later won) ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,commission_hold_days)
VALUES ('e1000000-0000-0000-0000-000000000009','T4B','T4B','percentage',1000,0);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('e1000000-0000-0000-0000-000000000009','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000009';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000009';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000009';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000009';
SELECT mko('e2000000-0000-0000-0000-000000000009','T4B','pi_t4b',10000,'T4B');
SELECT resolve_order_affiliate_attribution('e2000000-0000-0000-0000-000000000009',NULL,'s')->>'commission_cents' AS accrual;
SELECT id AS cid FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000009' \gset
SELECT refresh_affiliate_commission_state(:'cid'::uuid)->>'status' AS approved;
SELECT create_affiliate_payout('e1000000-0000-0000-0000-000000000009',ARRAY[:'cid'::uuid],'admin')->>'payout_id' AS p1 \gset
SELECT mark_affiliate_payout_paid(:'p1'::uuid,NOW(),'ach','p1','admin')->>'outcome' AS paid_1000;

\echo '--- partial dispute lost claiming 4000 merchandise -> -400 ---'
SELECT upsert_order_dispute('t4b','cht4b','pi_t4b',4000,'usd','lost','lost','evt4b1','charge.dispute.closed',NOW(),NULL,'{}'::jsonb);
SELECT resolve_dispute_merchandise((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000009' ORDER BY effective_at LIMIT 1),
  4000,0,0,'admin','verified') -> 'affiliate_effect' ->> 'adjustment_cents' AS dispute_reversal;
SELECT (SELECT COALESCE(SUM(adjustment_cents),0) FROM affiliate_commission_adjustments WHERE commission_id=:'cid'::uuid) AS ledger,
       affiliate_commission_overpaid(:'cid'::uuid) AS owed,
       affiliate_commission_payable(:'cid'::uuid) AS payable;
\echo '>>> EXPECT ledger 600, owed 400, payable 0'

\echo '--- pending recovery is NOT collected cash ---'
SELECT record_affiliate_payout_recovery(:'cid'::uuid,400,NOW(),'admin','owed','fx-s2c-m1')->>'outcome' AS pending;
SELECT affiliate_commission_overpaid(:'cid'::uuid) AS owed_still_400;
\echo '--- collect 400 ---'
SELECT collect_affiliate_recovery(:'cid'::uuid,400,NOW(),'ach','rec','admin','fx-s2c-c1')->>'recovered_cents' AS collected;
SELECT affiliate_commission_overpaid(:'cid'::uuid) AS owed_0;
\echo '--- dispute WON -> +400 restored ---'
SELECT upsert_order_dispute('t4b','cht4b','pi_t4b',4000,'usd','won','won','evt4b2','charge.dispute.closed',NOW()+INTERVAL '1 hour',NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000009' ORDER BY effective_at DESC LIMIT 1),'s')->>'adjustment_cents' AS restored;
SELECT (SELECT COALESCE(SUM(adjustment_cents),0) FROM affiliate_commission_adjustments WHERE commission_id=:'cid'::uuid) AS ledger_1000,
       affiliate_commission_payable(:'cid'::uuid) AS payable_400;
SELECT create_affiliate_payout('e1000000-0000-0000-0000-000000000009',ARRAY[:'cid'::uuid],'admin')->>'amount_cents' AS second_payout_400;
\echo '>>> EXPECT ledger 1000, payable 400, second payout 400'

\echo '########## T6b VOID releases payable (canonical path) ##########'
SELECT id AS c5 FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000005' \gset
SELECT affiliate_commission_payable(:'c5'::uuid) AS payable_after_void;
SELECT void_affiliate_payout((SELECT id FROM affiliate_payouts WHERE affiliate_id='e1000000-0000-0000-0000-000000000005' ORDER BY created_at DESC LIMIT 1),'again','admin')->>'outcome' AS idempotent;
DO $$ BEGIN PERFORM void_affiliate_payout((SELECT id FROM affiliate_payouts WHERE status='paid' LIMIT 1),'x','admin');
  RAISE NOTICE 'T6b FAIL paid voided';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'T6b PASS %', SPLIT_PART(SQLERRM,'|',2); END $$;
SELECT COUNT(*) AS void_audit_rows FROM admin_audit_logs WHERE resource='affiliate_payouts' AND action='void';
