\set ON_ERROR_STOP on
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('e0000000-0000-0000-0000-000000000001','DR','PR','R','r',10000,true);
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('e1000000-0000-0000-0000-000000000001','RACE','Race','percentage',1000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at)
VALUES ('e1000000-0000-0000-0000-000000000001','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000001';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000001';
DO $$ DECLARE i INT; oid UUID; BEGIN
  FOR i IN 1..3 LOOP
    oid := ('e2000000-0000-0000-0000-00000000000'||i)::uuid;
    INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
      currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
    VALUES (oid,'R'||i,'cs_r'||i,'pi_r'||i,'paid','usd',10000,0,0,0,10000,'2026-06-01','RACE');
    PERFORM resolve_order_affiliate_attribution(oid,NULL,'sys');
  END LOOP;
END $$;
UPDATE affiliate_commissions SET status='approved' WHERE affiliate_id='e1000000-0000-0000-0000-000000000001';
SELECT COUNT(*) AS approved, SUM(affiliate_commission_payable(id)) AS total_payable
FROM affiliate_commissions WHERE affiliate_id='e1000000-0000-0000-0000-000000000001';
