\set ON_ERROR_STOP on
-- Fixture: base 10000, shipping 1000, total 11000, commission 10% = 1000
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('d0000000-0000-0000-0000-000000000001','DA','PA','Tee','tee',10000,true);
INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active)
VALUES ('d0000000-0000-0000-0000-000000000002','d0000000-0000-0000-0000-000000000001','KVRN-A-M','Black','BLK','M',2,100,0,true);
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('d1000000-0000-0000-0000-000000000001','AFF10','Ten Percent','percentage',1000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at)
VALUES ('d1000000-0000-0000-0000-000000000001','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='d1000000-0000-0000-0000-000000000001';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='d1000000-0000-0000-0000-000000000001';

CREATE OR REPLACE FUNCTION mk_order(p_id UUID, p_num TEXT, p_pi TEXT) RETURNS VOID
LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,
    payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
  VALUES (p_id,p_num,'cs_'||p_num,p_pi,'paid','usd',10000,1000,0,0,11000,'2026-06-01T00:00:00Z','AFF10');
END $f$;

\echo '=== S1 dispute lost, NO refund, full charge -> -1000 ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000001','O1','pi_1');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000001',NULL,'sys')->>'commission_cents' AS accrued;
SELECT upsert_order_dispute('du1','ch1','pi_1',11000,'usd','lost','lost','ev1','charge.dispute.closed',
  '2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb)->>'outcome';
SELECT apply_affiliate_dispute_adjustment(
  (SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000001'),'sys')
  ->>'adjustment_cents' AS s1_effect;
SELECT SUM(adjustment_cents) AS s1_cumulative FROM affiliate_commission_adjustments
WHERE order_id='d2000000-0000-0000-0000-000000000001';

\echo '=== S2 refund merch 5000 THEN dispute lost full -> -500 then -500 ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000002','O2','pi_2');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000002',NULL,'sys');
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
  amount_cents,merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,
  component_breakdown_status,status,refunded_at)
VALUES ('d3000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000002','re2','ch2','pi_2',
  5000,5000,0,0,'resolved','succeeded','2026-06-05T00:00:00Z');
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-000000000002','sys')->>'adjustment_cents' AS s2_refund;
SELECT upsert_order_dispute('du2','ch2','pi_2',11000,'usd','lost','lost','ev2','charge.dispute.closed',
  '2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment(
  (SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000002'),'sys')
  ->>'adjustment_cents' AS s2_dispute;
SELECT SUM(adjustment_cents) AS s2_net, MIN(commission_cents) AS orig
FROM affiliate_commission_adjustments a JOIN affiliate_commissions c ON c.id=a.commission_id
WHERE a.order_id='d2000000-0000-0000-0000-000000000002';
\echo '   net must be 0 (1000 accrued - 500 - 500), NEVER -2000 of reversal'

\echo '=== S3 dispute lost full THEN refund 5000 -> refund adds nothing ==='
SELECT mk_order('d2000000-0000-0000-0000-000000000003','O3','pi_3');
SELECT resolve_order_affiliate_attribution('d2000000-0000-0000-0000-000000000003',NULL,'sys');
SELECT upsert_order_dispute('du3','ch3','pi_3',11000,'usd','lost','lost','ev3','charge.dispute.closed',
  '2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment(
  (SELECT id FROM order_dispute_financial_adjustments WHERE order_id='d2000000-0000-0000-0000-000000000003'),'sys')
  ->>'adjustment_cents' AS s3_dispute;
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
  amount_cents,merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,
  component_breakdown_status,status,refunded_at)
VALUES ('d3000000-0000-0000-0000-000000000003','d2000000-0000-0000-0000-000000000003','re3','ch3','pi_3',
  5000,5000,0,0,'resolved','succeeded','2026-06-12T00:00:00Z');
SELECT apply_affiliate_refund_reversal('d3000000-0000-0000-0000-000000000003','sys')->>'adjustment_cents' AS s3_refund;
SELECT SUM(adjustment_cents) AS s3_net FROM affiliate_commission_adjustments
WHERE order_id='d2000000-0000-0000-0000-000000000003';
\echo '   refund must add 0 (already fully reversed); net 0'
