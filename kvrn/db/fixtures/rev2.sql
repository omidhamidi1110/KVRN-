\set ON_ERROR_STOP on
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('a9000000-0000-0000-0000-000000000001','DR2','PR2','R2','r2',100,true);
CREATE OR REPLACE FUNCTION mko(p_id UUID,p_num TEXT,p_pi TEXT,p_sub INT,p_disc INT,p_dcode TEXT,p_did UUID)
RETURNS VOID LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
    currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code,discount_id)
  VALUES (p_id,p_num,'cs_'||p_num,p_pi,'paid','usd',p_sub,0,p_disc,0,p_sub-p_disc,'2026-06-01',p_dcode,p_did);
END $f$;

\echo '=== R1 base 3, commission 1, TWO 1-cent refunds ==='
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('a9100000-0000-0000-0000-000000000001','R1','R1','percentage',3333);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('a9100000-0000-0000-0000-000000000001','active','2020-01-01');
SELECT mko('a9200000-0000-0000-0000-000000000001','R1','pi_r1',3,0,'R1',NULL);
SELECT resolve_order_affiliate_attribution('a9200000-0000-0000-0000-000000000001',NULL,'s')->>'commission_cents' AS c;
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('a9300000-0000-0000-0000-000000000001','a9200000-0000-0000-0000-000000000001','x1','c1','pi_r1',1,1,0,0,'resolved','succeeded','2026-06-02'),
       ('a9300000-0000-0000-0000-000000000002','a9200000-0000-0000-0000-000000000001','x2','c1','pi_r1',1,1,0,0,'resolved','succeeded','2026-06-03');
SELECT apply_affiliate_refund_reversal('a9300000-0000-0000-0000-000000000001','s')->>'adjustment_cents' AS r1_adj;
SELECT apply_affiliate_refund_reversal('a9300000-0000-0000-0000-000000000002','s')->>'adjustment_cents' AS r2_adj;
SELECT SUM(adjustment_cents) AS net, MAX(cumulative_merchandise_reversed_after) AS cum
FROM affiliate_commission_adjustments WHERE order_id='a9200000-0000-0000-0000-000000000001';
\echo '   EXPECT: r1_adj 0, r2_adj -1, net 0, cum 2'

\echo '=== R2 base 7, commission 1, SEVEN 1-cent refunds ==='
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('a9100000-0000-0000-0000-000000000002','R2','R2','percentage',1429);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('a9100000-0000-0000-0000-000000000002','active','2020-01-01');
SELECT mko('a9200000-0000-0000-0000-000000000002','R2','pi_r2',7,0,'R2',NULL);
SELECT resolve_order_affiliate_attribution('a9200000-0000-0000-0000-000000000002',NULL,'s')->>'commission_cents' AS c;
DO $$ DECLARE i INT; rid UUID; BEGIN
  FOR i IN 1..7 LOOP
    rid := ('a9400000-0000-0000-0000-00000000000'||i)::uuid;
    INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
      merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
    VALUES (rid,'a9200000-0000-0000-0000-000000000002','y'||i,'c2','pi_r2',1,1,0,0,'resolved','succeeded',('2026-06-0'||i)::timestamptz);
    PERFORM apply_affiliate_refund_reversal(rid,'s');
  END LOOP; END $$;
SELECT SUM(adjustment_cents) AS net, MAX(cumulative_merchandise_reversed_after) AS cum,
       COUNT(*) AS rows FROM affiliate_commission_adjustments WHERE order_id='a9200000-0000-0000-0000-000000000002';
\echo '   EXPECT: net 0 (1 accrued -1 reversed), cum 7, rows 8'

\echo '=== R3 affiliate.code != discount.code, linked by discount_id ==='
INSERT INTO discounts (id,code,name,type,percentage_bps,active,system_managed)
VALUES ('a9500000-0000-0000-0000-000000000001','JOHN20','John 20','percentage',2000,true,true);
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,discount_id)
VALUES ('a9100000-0000-0000-0000-000000000003','CREATOR_JOHN','John','percentage',1000,'a9500000-0000-0000-0000-000000000001');
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('a9100000-0000-0000-0000-000000000003','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='a9100000-0000-0000-0000-000000000001';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='a9100000-0000-0000-0000-000000000001';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='a9100000-0000-0000-0000-000000000002';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='a9100000-0000-0000-0000-000000000002';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='a9100000-0000-0000-0000-000000000003';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='a9100000-0000-0000-0000-000000000003';
SELECT mko('a9200000-0000-0000-0000-000000000003','R3','pi_r3',10000,2000,'JOHN20','a9500000-0000-0000-0000-000000000001');
SELECT resolve_order_affiliate_attribution('a9200000-0000-0000-0000-000000000003',NULL,'s')->>'outcome' AS r3_outcome;
SELECT a.code AS attributed_affiliate FROM order_affiliate_attributions att
JOIN affiliates a ON a.id=att.affiliate_id WHERE att.order_id='a9200000-0000-0000-0000-000000000003';
\echo '   EXPECT: attributed, CREATOR_JOHN'

\echo '=== R4 ordinary promo must NOT attribute an affiliate ==='
INSERT INTO discounts (id,code,name,type,percentage_bps,active)
VALUES ('a9500000-0000-0000-0000-000000000002','SUMMER10','Summer','percentage',1000,true);
SELECT mko('a9200000-0000-0000-0000-000000000004','R4','pi_r4',10000,1000,'SUMMER10','a9500000-0000-0000-0000-000000000002');
SELECT resolve_order_affiliate_attribution('a9200000-0000-0000-0000-000000000004',NULL,'s')->>'outcome' AS r4_outcome;
\echo '   EXPECT: no_attribution'
