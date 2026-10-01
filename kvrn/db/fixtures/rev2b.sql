-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES rev2 to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '=== R5 zero-cent DISPUTE reversal -> win -> merchandise released ==='
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('a9100000-0000-0000-0000-000000000005','R5','R5','percentage',3333);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('a9100000-0000-0000-0000-000000000005','active','2020-01-01');
-- base 3, commission 1. A partial dispute claiming 1c of merchandise rounds to 0c commission.
SELECT mko('a9200000-0000-0000-0000-000000000005','R5','pi_r5',3,0,'R5',NULL);
SELECT resolve_order_affiliate_attribution('a9200000-0000-0000-0000-000000000005',NULL,'s')->>'commission_cents' AS c;
SELECT upsert_order_dispute('dz','chz','pi_r5',2,'usd','lost','lost','evz1','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT resolve_dispute_merchandise((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='a9200000-0000-0000-0000-000000000005' ORDER BY effective_at LIMIT 1),
  1,1,0,'admin','partial') -> 'affiliate_effect' ->> 'adjustment_cents' AS dispute_adj;
SELECT MAX(cumulative_merchandise_reversed_after) AS cum_after_dispute
FROM affiliate_commission_adjustments WHERE order_id='a9200000-0000-0000-0000-000000000005';
\echo '   dispute claimed 1c merchandise but 0c commission'
SELECT upsert_order_dispute('dz','chz','pi_r5',2,'usd','won','won','evz2','charge.dispute.closed','2026-07-01T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='a9200000-0000-0000-0000-000000000005' ORDER BY effective_at DESC LIMIT 1),'s')->>'outcome' AS win;
SELECT (SELECT cumulative_merchandise_reversed_after FROM affiliate_commission_adjustments
        WHERE order_id='a9200000-0000-0000-0000-000000000005' ORDER BY effective_at DESC, created_at DESC LIMIT 1) AS cum_after_win;
\echo '   EXPECT cum back to 0 -- merchandise released for future refunds'
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('a9300000-0000-0000-0000-000000000005','a9200000-0000-0000-0000-000000000005','z5','chz','pi_r5',3,3,0,0,'resolved','succeeded','2026-07-05');
SELECT apply_affiliate_refund_reversal('a9300000-0000-0000-0000-000000000005','s')->>'adjustment_cents' AS later_refund;
\echo '   EXPECT -1 : full merchandise now consumable'

\echo '=== R6 TWO unresolved partial disputes: resolving one keeps it blocked ==='
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('a9100000-0000-0000-0000-000000000006','R6','R6','percentage',1000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('a9100000-0000-0000-0000-000000000006','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='a9100000-0000-0000-0000-000000000005';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='a9100000-0000-0000-0000-000000000005';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='a9100000-0000-0000-0000-000000000006';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='a9100000-0000-0000-0000-000000000006';
SELECT mko('a9200000-0000-0000-0000-000000000006','R6','pi_r6',10000,0,'R6',NULL);
SELECT resolve_order_affiliate_attribution('a9200000-0000-0000-0000-000000000006',NULL,'s');
SELECT upsert_order_dispute('d6a','ch6','pi_r6',3000,'usd','lost','lost','ev6a','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT upsert_order_dispute('d6b','ch6b','pi_r6',2000,'usd','lost','lost','ev6b','charge.dispute.closed','2026-06-11T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment(id,'s')->>'outcome' FROM order_dispute_financial_adjustments WHERE order_id='a9200000-0000-0000-0000-000000000006';
SELECT COUNT(*) AS unresolved_sources FROM affiliate_unresolved_sources((SELECT id FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000006'));
SELECT resolve_dispute_merchandise((SELECT a.id FROM order_dispute_financial_adjustments a JOIN order_disputes d ON d.id=a.dispute_id WHERE d.stripe_dispute_id='d6a'),2000,1000,0,'admin',NULL)->>'outcome' AS resolved_first;
SELECT incomplete, incomplete_reason FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000006';
\echo '   EXPECT still incomplete=t (second dispute unresolved)'
SELECT resolve_dispute_merchandise((SELECT a.id FROM order_dispute_financial_adjustments a JOIN order_disputes d ON d.id=a.dispute_id WHERE d.stripe_dispute_id='d6b'),1500,500,0,'admin',NULL)->>'outcome' AS resolved_second;
SELECT incomplete FROM affiliate_commissions WHERE order_id='a9200000-0000-0000-0000-000000000006';
\echo '   EXPECT incomplete=f only now'
