-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES s2test to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '########## T4 FULL RECOVERY LIFECYCLE ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,commission_hold_days)
VALUES ('e1000000-0000-0000-0000-000000000004','T4','T4','percentage',1000,0);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('e1000000-0000-0000-0000-000000000004','active','2020-01-01');
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000004';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000004';
SELECT mko('e2000000-0000-0000-0000-000000000004','T4','pi_t4',10000,'T4');
SELECT resolve_order_affiliate_attribution('e2000000-0000-0000-0000-000000000004',NULL,'s')->>'commission_cents' AS accrual;
SELECT id AS cid FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000004' \gset
SELECT refresh_affiliate_commission_state(:'cid'::uuid)->>'status' AS auto_approved;
SELECT create_affiliate_payout('e1000000-0000-0000-0000-000000000004',ARRAY[:'cid'::uuid],'admin')->>'amount_cents' AS payout_1;
SELECT mark_affiliate_payout_paid((SELECT id FROM affiliate_payouts WHERE affiliate_id='e1000000-0000-0000-0000-000000000004' ORDER BY created_at DESC LIMIT 1),NOW(),'ach','p1','admin')->>'outcome';
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('e3000000-0000-0000-0000-000000000004','e2000000-0000-0000-0000-000000000004','rt4','cht4','pi_t4',4000,4000,0,0,'resolved','succeeded',NOW());
SELECT apply_affiliate_refund_reversal('e3000000-0000-0000-0000-000000000004','s')->>'adjustment_cents' AS refund_reversal;
SELECT (SELECT COALESCE(SUM(adjustment_cents),0) FROM affiliate_commission_adjustments WHERE commission_id=:'cid'::uuid) AS ledger,
       affiliate_commission_overpaid(:'cid'::uuid) AS owed,
       affiliate_commission_payable(:'cid'::uuid) AS payable;
\echo '>>> EXPECT ledger 600, owed 400, payable 0'
\echo '--- pending recovery is NOT cash ---'
SELECT record_affiliate_payout_recovery(:'cid'::uuid,400,NOW(),'admin','pending','fx-s2b-m1')->>'outcome' AS pending_rec;
SELECT affiliate_commission_overpaid(:'cid'::uuid) AS owed_still_400;
\echo '--- collect the recovery (real cash in) ---'
SELECT collect_affiliate_recovery(:'cid'::uuid,400,NOW(),'ach','rec1','admin','fx-s2b-c1')->>'recovered_cents' AS collected;
SELECT affiliate_commission_overpaid(:'cid'::uuid) AS owed_now_0,
       affiliate_commission_payable(:'cid'::uuid) AS payable_now;
\echo '--- over-collection refused ---'
DO $$ BEGIN PERFORM collect_affiliate_recovery((SELECT id FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000004'),1,NOW(),'ach','x','admin','fx-s2b-c2');
  RAISE NOTICE 'T4 FAIL over-collect accepted';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'T4 PASS %', SPLIT_PART(SQLERRM,'|',2); END $$;
\echo '--- restoration +400 via dispute win, then SECOND payout ---'
SELECT upsert_order_dispute('t4','cht4','pi_t4',10000,'usd','lost','lost','evt4a','charge.dispute.closed',NOW(),NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000004' ORDER BY effective_at LIMIT 1),'s')->>'adjustment_cents' AS d_lost;
SELECT upsert_order_dispute('t4','cht4','pi_t4',10000,'usd','won','won','evt4b','charge.dispute.closed',NOW()+INTERVAL '1 hour',NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000004' ORDER BY effective_at DESC LIMIT 1),'s')->>'adjustment_cents' AS d_won;
SELECT (SELECT COALESCE(SUM(adjustment_cents),0) FROM affiliate_commission_adjustments WHERE commission_id=:'cid'::uuid) AS ledger_after,
       affiliate_commission_payable(:'cid'::uuid) AS payable_after;
SELECT create_affiliate_payout('e1000000-0000-0000-0000-000000000004',ARRAY[:'cid'::uuid],'admin')->>'amount_cents' AS second_payout;
\echo '>>> EXPECT second_payout 400'

\echo '########## T5 RUNTIME auto-approval through the payable read path ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,commission_hold_days)
VALUES ('e1000000-0000-0000-0000-000000000005','T5','T5','percentage',1000,30);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('e1000000-0000-0000-0000-000000000005','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000004';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000004';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000005';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000005';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000005';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000005';
SELECT mko('e2000000-0000-0000-0000-000000000005','T5','pi_t5',10000,'T5');
SELECT resolve_order_affiliate_attribution('e2000000-0000-0000-0000-000000000005',NULL,'s');
SELECT status AS before_read FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000005';
\echo '   (paid 90 days ago, 30-day hold -> eligible, but still pending until read)'
SELECT COUNT(*) AS payable_rows FROM affiliate_payable_commissions('e1000000-0000-0000-0000-000000000005');
SELECT status AS after_read FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000005';
\echo '>>> EXPECT after_read = approved, with NO admin action'

\echo '########## T6 canonical VOID releases payable ##########'
SELECT id AS c5 FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000005' \gset
SELECT create_affiliate_payout('e1000000-0000-0000-0000-000000000005',ARRAY[:'c5'::uuid],'admin')->>'payout_id' AS pid \gset
SELECT affiliate_commission_payable(:'c5'::uuid) AS payable_while_draft;
SELECT void_affiliate_payout(:'pid'::uuid,'created in error','admin')->>'outcome' AS voided;
SELECT affiliate_commission_payable(:'c5'::uuid) AS payable_after_void;
SELECT void_affiliate_payout(:'pid'::uuid,'again','admin')->>'outcome' AS idempotent;
\echo '--- paid payout cannot be voided ---'
DO $$ BEGIN PERFORM void_affiliate_payout((SELECT id FROM affiliate_payouts WHERE status='paid' LIMIT 1),'x','admin');
  RAISE NOTICE 'T6 FAIL paid voided';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'T6 PASS %', SPLIT_PART(SQLERRM,'|',2); END $$;
SELECT COUNT(*) AS void_audit_rows FROM admin_audit_logs WHERE resource='affiliate_payouts' AND action='void';
