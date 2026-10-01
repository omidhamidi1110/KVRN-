\set ON_ERROR_STOP on
\echo '########## BLOCKER 3: backfill must ignore effective_at ordering ##########'
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('c3000000-0000-0000-0000-000000000001','B3','B3','B','b3',10000,true);
SELECT create_affiliate('BK3','Bk3',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id' AS aid \gset
-- Backdate creation: temporal causality (#5) correctly refuses to attribute an
-- order to an affiliate that did not exist when the order was placed.
UPDATE affiliates SET created_at=NOW()-INTERVAL '365 days' WHERE code='BK3';
UPDATE affiliate_terms_events SET effective_at=NOW()-INTERVAL '365 days'
  WHERE affiliate_id=(SELECT id FROM affiliates WHERE code='BK3');
UPDATE affiliate_status_events SET effective_at=NOW()-INTERVAL '365 days'
  WHERE affiliate_id=(SELECT id FROM affiliates WHERE code='BK3');
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('c4000000-0000-0000-0000-000000000001','BK3','cs_bk3','pi_bk3','paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '30 days','BK3');
\echo '--- events arrive out of economic order: LOST backdated, then WON later ---'
SELECT upsert_order_dispute('bk3','chbk3','pi_bk3',10000,'usd','lost','lost','ev1','charge.dispute.closed',NOW()-INTERVAL '20 days',NULL,'{}'::jsonb);
SELECT upsert_order_dispute('bk3','chbk3','pi_bk3',10000,'usd','won','won','ev2','charge.dispute.closed',NOW()-INTERVAL '2 days',NULL,'{}'::jsonb);
SELECT to_status, effective_at::date, adjustment_cents FROM order_dispute_financial_adjustments
WHERE order_id='c4000000-0000-0000-0000-000000000001' ORDER BY effective_at;
SELECT status AS current_dispute_status FROM order_disputes WHERE stripe_dispute_id='bk3';
\echo '--- backfill from CURRENT state ---'
SELECT backfill_order_affiliate_attribution('c4000000-0000-0000-0000-000000000001',NULL,'admin')->>'net_commission_cents' AS net;
SELECT affiliate_source_claim((SELECT id FROM affiliate_commissions WHERE order_id='c4000000-0000-0000-0000-000000000001'),
  'dispute:'||(SELECT id FROM order_disputes WHERE stripe_dispute_id='bk3')) AS claim_should_be_0;
\echo '>>> EXPECT net 1000 and claim 0: dispute is currently WON'
\echo '--- BLOCKER 10: every backfill outcome audited ---'
SELECT backfill_order_affiliate_attribution('c4000000-0000-0000-0000-000000000001',NULL,'admin')->>'outcome' AS retry;
SELECT payload->>'outcome' AS audited_outcome, COUNT(*) FROM admin_audit_logs
WHERE action='backfill_attempt' GROUP BY 1 ORDER BY 1;
