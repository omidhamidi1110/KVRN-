\set ON_ERROR_STOP on
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('b0000000-0000-0000-0000-000000000001','B','B','B','b',10000,true);
SELECT create_affiliate('BLK','Blk',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id' AS aid \gset
-- Backdate creation: temporal causality (#5) correctly refuses to attribute an
-- order to an affiliate that did not exist when the order was placed.
UPDATE affiliates SET created_at=NOW()-INTERVAL '365 days' WHERE code='BLK';
UPDATE affiliate_terms_events SET effective_at=NOW()-INTERVAL '365 days'
  WHERE affiliate_id=(SELECT id FROM affiliates WHERE code='BLK');
UPDATE affiliate_status_events SET effective_at=NOW()-INTERVAL '365 days'
  WHERE affiliate_id=(SELECT id FROM affiliates WHERE code='BLK');

\echo '########## BLOCKER 1: zero-revenue-delta lost partial dispute ##########'
-- merchandise 10000, shipping 5000 -> total 15000
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('b1000000-0000-0000-0000-000000000001','B1','cs_b1','pi_b1','paid','usd',10000,5000,0,0,15000,NOW()-INTERVAL '2 days','BLK');
SELECT resolve_order_affiliate_attribution('b1000000-0000-0000-0000-000000000001',NULL,'s')->>'commission_cents' AS accrued;
-- gross refund of 6000 that is ALL shipping+tax: merchandise component 0
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','rb','chb','pi_b1',
  5000,0,5000,0,'resolved','succeeded',NOW()-INTERVAL '1 day');
SELECT apply_affiliate_refund_reversal('b2000000-0000-0000-0000-000000000001','s')->>'adjustment_cents' AS refund_effect_0;
\echo '--- now a PARTIAL dispute of 5000 becomes lost; 018 offset already covers it ---'
SELECT upsert_order_dispute('db1','chb','pi_b1',5000,'usd','lost','lost','evb1','charge.dispute.closed',NOW(),NULL,'{}'::jsonb)
  ->>'revenue_adjustment_cents' AS r018_delta;
SELECT COUNT(*) AS dfa_rows_created FROM order_dispute_financial_adjustments
WHERE order_id='b1000000-0000-0000-0000-000000000001';
\echo '>>> 018 delta 0 => NO adjustment row => webhook path finds nothing to apply'
SELECT status AS dispute_is_lost, amount_cents FROM order_disputes WHERE stripe_dispute_id='db1';
SELECT incomplete, incomplete_reason FROM affiliate_commissions WHERE order_id='b1000000-0000-0000-0000-000000000001';
SELECT COUNT(*) AS unresolved_sources FROM affiliate_unresolved_sources((SELECT id FROM affiliate_commissions WHERE order_id='b1000000-0000-0000-0000-000000000001'));
\echo '--- FIX: dispute-centric sync, driven by the DISPUTE not an 018 row ---'
SELECT sync_affiliate_dispute_state((SELECT id FROM order_disputes WHERE stripe_dispute_id='db1'),NULL,'sys')->>'outcome' AS sync_outcome;
SELECT incomplete, incomplete_reason FROM affiliate_commissions WHERE order_id='b1000000-0000-0000-0000-000000000001';
\echo '--- admin decomposes WITHOUT any 018 adjustment row ---'
SELECT resolve_dispute_merchandise_by_dispute((SELECT id FROM order_disputes WHERE stripe_dispute_id='db1'),
  4000,1000,0,'admin','partial split')->'affiliate_effect'->>'adjustment_cents' AS decomposed_effect;
SELECT affiliate_source_claim((SELECT id FROM affiliate_commissions WHERE order_id='b1000000-0000-0000-0000-000000000001'),
  'dispute:'||(SELECT id FROM order_disputes WHERE stripe_dispute_id='db1')) AS claim_now_4000;
SELECT incomplete AS incomplete_now_false FROM affiliate_commissions WHERE order_id='b1000000-0000-0000-0000-000000000001';

\echo '########## BLOCKER 2: same-amount correction blocked by idempotency ##########'
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('b1000000-0000-0000-0000-000000000002','B2','cs_b2','pi_b2','paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '2 days','BLK');
SELECT resolve_order_affiliate_attribution('b1000000-0000-0000-0000-000000000002',NULL,'s')->>'commission_cents' AS accrued2;
SELECT upsert_order_dispute('db2','chb2','pi_b2',6000,'usd','lost','lost','evb2','charge.dispute.closed',NOW(),NULL,'{}'::jsonb);
SELECT id AS dfa FROM order_dispute_financial_adjustments WHERE order_id='b1000000-0000-0000-0000-000000000002' LIMIT 1 \gset
SELECT resolve_dispute_merchandise_by_dispute((SELECT id FROM order_disputes WHERE stripe_dispute_id='db2'),4000,2000,0,'admin','v1')->'affiliate_effect'->>'adjustment_cents' AS v1_effect;
SELECT id AS cid2 FROM affiliate_commissions WHERE order_id='b1000000-0000-0000-0000-000000000002' \gset
SELECT affiliate_source_claim(:'cid2'::uuid,'dispute:'||(SELECT id FROM order_disputes WHERE stripe_dispute_id='db2')) AS claim_after_v1;
\echo '--- correction to 4500 for the SAME amount ---'
SELECT resolve_dispute_merchandise_by_dispute((SELECT id FROM order_disputes WHERE stripe_dispute_id='db2'),4500,1500,0,'admin','v2 correction')->'affiliate_effect'->>'adjustment_cents' AS v2_effect;
SELECT affiliate_source_claim(:'cid2'::uuid,'dispute:'||(SELECT id FROM order_disputes WHERE stripe_dispute_id='db2')) AS claim_after_v2;
SELECT merchandise_cents, version, superseded_at IS NOT NULL AS superseded FROM dispute_merchandise_resolutions
WHERE dispute_id=(SELECT id FROM order_disputes WHERE stripe_dispute_id='db2') ORDER BY version;
\echo '--- duplicate identical v2 retry must book nothing ---'
SELECT resolve_dispute_merchandise_by_dispute((SELECT id FROM order_disputes WHERE stripe_dispute_id='db2'),4500,1500,0,'admin','v2 correction')->>'outcome' AS dup_retry;
SELECT affiliate_source_claim(:'cid2'::uuid,'dispute:'||(SELECT id FROM order_disputes WHERE stripe_dispute_id='db2')) AS claim_still_4500,
       (SELECT SUM(adjustment_cents) FROM affiliate_commission_adjustments WHERE commission_id=:'cid2'::uuid) AS net;
\echo '>>> EXPECT claim 4500, net 1000-450 = 550'
