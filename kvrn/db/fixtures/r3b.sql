-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES repro to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '########## CASE B: fixed all_or_nothing, refund survives the win ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_fixed_cents,default_fixed_reversal_policy)
VALUES ('c1000000-0000-0000-0000-00000000000c','CC','CC','fixed',1000,'all_or_nothing');
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('c1000000-0000-0000-0000-00000000000c','active','2020-01-01');
SELECT mko('c2000000-0000-0000-0000-00000000000c','C1','pi_c',10000,'CC');
SELECT resolve_order_affiliate_attribution('c2000000-0000-0000-0000-00000000000c',NULL,'s')->>'commission_cents' AS accrued;
SELECT upsert_order_dispute('dc','chc','pi_c',10000,'usd','lost','lost','evc1','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000c' ORDER BY effective_at LIMIT 1),'s')->>'adjustment_cents' AS lost;
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('c3000000-0000-0000-0000-00000000000c','c2000000-0000-0000-0000-00000000000c','rc','chc','pi_c',5000,5000,0,0,'resolved','succeeded','2026-06-20');
SELECT apply_affiliate_refund_reversal('c3000000-0000-0000-0000-00000000000c','s')->>'adjustment_cents' AS refund;
SELECT upsert_order_dispute('dc','chc','pi_c',10000,'usd','won','won','evc2','charge.dispute.closed','2026-07-01T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000c' ORDER BY effective_at DESC LIMIT 1),'s')->>'adjustment_cents' AS won;
SELECT SUM(adjustment_cents) AS final_net FROM affiliate_commission_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000c';
\echo '>>> EXPECT 0 : refund still exists, all_or_nothing keeps it fully reversed'

\echo '########## CASE C: base 3 / commission 1 rounding overlap ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('c1000000-0000-0000-0000-00000000000d','CD','CD','percentage',3333);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('c1000000-0000-0000-0000-00000000000d','active','2020-01-01');
SELECT mko('c2000000-0000-0000-0000-00000000000d','D1','pi_d',3,'CD');
SELECT resolve_order_affiliate_attribution('c2000000-0000-0000-0000-00000000000d',NULL,'s')->>'commission_cents' AS accrued;
SELECT upsert_order_dispute('dd','chd','pi_d',2,'usd','lost','lost','evd1','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT resolve_dispute_merchandise((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000d' ORDER BY effective_at LIMIT 1),1,1,0,'admin',NULL)
  -> 'affiliate_effect' ->> 'adjustment_cents' AS dispute_claims_1c;
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('c3000000-0000-0000-0000-00000000000d','c2000000-0000-0000-0000-00000000000d','rd','chd','pi_d',1,1,0,0,'resolved','succeeded','2026-06-20');
SELECT apply_affiliate_refund_reversal('c3000000-0000-0000-0000-00000000000d','s')->>'adjustment_cents' AS refund_claims_1c;
SELECT upsert_order_dispute('dd','chd','pi_d',2,'usd','won','won','evd2','charge.dispute.closed','2026-07-01T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000d' ORDER BY effective_at DESC LIMIT 1),'s')->>'adjustment_cents' AS won_restores;
SELECT affiliate_outstanding_merchandise((SELECT id FROM affiliate_commissions WHERE order_id='c2000000-0000-0000-0000-00000000000d')) AS outstanding,
       SUM(adjustment_cents) AS final_net FROM affiliate_commission_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000d';
\echo '>>> EXPECT won_restores +1 (though the dispute originally moved 0c), outstanding 1, net 1'

\echo '########## CASE #4: POSITIVE dispute_revised while STILL LOST ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('c1000000-0000-0000-0000-00000000000e','CE','CE','percentage',1000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('c1000000-0000-0000-0000-00000000000e','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='c1000000-0000-0000-0000-00000000000c';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='c1000000-0000-0000-0000-00000000000c';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='c1000000-0000-0000-0000-00000000000d';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='c1000000-0000-0000-0000-00000000000d';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='c1000000-0000-0000-0000-00000000000e';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='c1000000-0000-0000-0000-00000000000e';
SELECT mko('c2000000-0000-0000-0000-00000000000e','E1','pi_e',10000,'CE');
SELECT resolve_order_affiliate_attribution('c2000000-0000-0000-0000-00000000000e',NULL,'s');
SELECT upsert_order_dispute('de','che','pi_e',10000,'usd','lost','lost','eve1','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000e' ORDER BY effective_at LIMIT 1),'s')->>'adjustment_cents' AS lost;
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('c3000000-0000-0000-0000-00000000000e','c2000000-0000-0000-0000-00000000000e','re','che','pi_e',5000,5000,0,0,'resolved','succeeded','2026-06-20');
SELECT apply_affiliate_refund_reversal('c3000000-0000-0000-0000-00000000000e','s')->>'adjustment_cents' AS refund;
-- another LOST event: 018 emits a POSITIVE revised row because refund_offset grew
SELECT upsert_order_dispute('de','che','pi_e',10000,'usd','lost','lost','eve2','charge.dispute.closed','2026-06-25T00:00:00Z'::timestamptz,NULL,'{}'::jsonb)->>'revenue_adjustment_cents' AS r018_positive_revised;
SELECT adjustment_type, adjustment_cents, to_status FROM order_dispute_financial_adjustments
WHERE order_id='c2000000-0000-0000-0000-00000000000e' ORDER BY effective_at;
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000e' ORDER BY effective_at DESC LIMIT 1),'s')->>'adjustment_cents' AS affiliate_effect;
SELECT SUM(adjustment_cents) AS final_net FROM affiliate_commission_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000e';
\echo '>>> EXPECT affiliate_effect 0 (still lost, no restoration) and net 0'
