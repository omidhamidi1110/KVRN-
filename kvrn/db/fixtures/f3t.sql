\set ON_ERROR_STOP on
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('e9000000-0000-0000-0000-000000000001','F3','F3','F','f3',10000,true);
SELECT create_affiliate('PROV','Prov',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id' AS aid \gset
UPDATE affiliates SET created_at='2020-01-01' WHERE id=:'aid'::uuid;
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id=:'aid'::uuid;
UPDATE affiliate_status_events SET effective_at='2020-01-01' WHERE affiliate_id=:'aid'::uuid;

\echo '########## B6 PROVENANCE: resolution v1 -> correction v2 ##########'
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('e9100000-0000-0000-0000-000000000001','P1','cs_p1','pi_p1','paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '2 days','PROV');
SELECT resolve_order_affiliate_attribution('e9100000-0000-0000-0000-000000000001',NULL,'s')->>'commission_cents' AS accrued;
SELECT upsert_order_dispute('dp1','chp1','pi_p1',6000,'usd','lost','lost','evp1','charge.dispute.closed',NOW(),NULL,'{}'::jsonb);
SELECT id AS did FROM order_disputes WHERE stripe_dispute_id='dp1' \gset
SELECT resolve_dispute_merchandise_by_dispute(:'did'::uuid,4000,2000,0,'admin','v1')->>'resolution_id' AS r1 \gset
SELECT resolve_dispute_merchandise_by_dispute(:'did'::uuid,4500,1500,0,'admin','v2 correction')->>'resolution_id' AS r2 \gset
\echo '--- each adjustment must cite the resolution that caused it ---'
SELECT adjustment_cents,
       CASE WHEN source_dispute_resolution_id = :'r1'::uuid THEN 'v1'
            WHEN source_dispute_resolution_id = :'r2'::uuid THEN 'v2'
            WHEN source_dispute_resolution_id IS NULL THEN 'NULL' ELSE 'other' END AS cites
FROM affiliate_commission_adjustments
WHERE order_id='e9100000-0000-0000-0000-000000000001' AND reason='dispute_reversal'
ORDER BY created_at;
\echo '>>> EXPECT -400 cites v1, -50 cites v2'
\echo '--- duplicate identical retry adds NO row ---'
SELECT resolve_dispute_merchandise_by_dispute(:'did'::uuid,4500,1500,0,'admin','v2 correction')->>'outcome' AS dup;
SELECT COUNT(*) AS reversal_rows FROM affiliate_commission_adjustments
WHERE order_id='e9100000-0000-0000-0000-000000000001' AND reason='dispute_reversal';
\echo '--- a status-driven win invents no resolution link ---'
SELECT upsert_order_dispute('dp1','chp1','pi_p1',6000,'usd','won','won','evp2','charge.dispute.closed',NOW()+INTERVAL '1 hour',NULL,'{}'::jsonb);
SELECT sync_affiliate_dispute_state(:'did'::uuid,NULL,'s')->>'adjustment_cents' AS win;
SELECT source_dispute_resolution_id IS NULL AS win_link_is_null FROM affiliate_commission_adjustments
WHERE order_id='e9100000-0000-0000-0000-000000000001' AND reason='dispute_won_restore';

\echo '########## B7 PERIOD-SCOPED INCOMPLETE COUNT ##########'
-- OLD incomplete commission, 2 years ago
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('e9100000-0000-0000-0000-000000000002','P2','cs_p2','pi_p2','paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '730 days','PROV');
SELECT resolve_order_affiliate_attribution('e9100000-0000-0000-0000-000000000002',NULL,'s');
SELECT upsert_order_dispute('dp2','chp2','pi_p2',3000,'usd','lost','lost','evp3','charge.dispute.closed',NOW()-INTERVAL '725 days',NULL,'{}'::jsonb);
SELECT sync_affiliate_dispute_state((SELECT id FROM order_disputes WHERE stripe_dispute_id='dp2'),NULL,'s')->>'outcome' AS old_incomplete;
-- NEW complete commission, today
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('e9100000-0000-0000-0000-000000000003','P3','cs_p3','pi_p3','paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '1 day','PROV');
SELECT resolve_order_affiliate_attribution('e9100000-0000-0000-0000-000000000003',NULL,'s')->>'outcome' AS new_complete;
SELECT incomplete_commission_count AS period_30d_count
FROM affiliate_commission_effect(NOW()-INTERVAL '30 days', NOW()+INTERVAL '1 day');
\echo '>>> EXPECT 0 : the 2-year-old unresolved case is NOT in the 30-day period'
SELECT incomplete_count AS global_backlog, oldest_attributed_at::date FROM affiliate_reconciliation_backlog();
\echo '>>> EXPECT backlog >=1 and the old date, surfaced separately as GLOBAL'
SELECT incomplete_commission_count AS period_all_time
FROM affiliate_commission_effect(NOW()-INTERVAL '1000 days', NOW()+INTERVAL '1 day');
\echo '>>> EXPECT >=1 : an all-time period does include it'
