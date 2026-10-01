\set ON_ERROR_STOP on
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('c0000000-0000-0000-0000-000000000001','DX','PX','X','x',10000,true);
CREATE OR REPLACE FUNCTION mko(p_id UUID,p_num TEXT,p_pi TEXT,p_sub INT,p_code TEXT)
RETURNS VOID LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
    currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
  VALUES (p_id,p_num,'cs_'||p_num,p_pi,'paid','usd',p_sub,0,0,0,p_sub,'2026-06-01',p_code);
END $f$;

\echo '################ CASE A: dispute lost -> refund 5000 -> won ################'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('c1000000-0000-0000-0000-00000000000a','CA','CA','percentage',1000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('c1000000-0000-0000-0000-00000000000a','active','2020-01-01');
SELECT mko('c2000000-0000-0000-0000-00000000000a','A1','pi_a',10000,'CA');
SELECT resolve_order_affiliate_attribution('c2000000-0000-0000-0000-00000000000a',NULL,'s')->>'commission_cents' AS accrued;
SELECT upsert_order_dispute('da','cha','pi_a',10000,'usd','lost','lost','eva1','charge.dispute.closed','2026-06-10T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000a' ORDER BY effective_at LIMIT 1),'s')->>'adjustment_cents' AS dispute_lost;
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('c3000000-0000-0000-0000-00000000000a','c2000000-0000-0000-0000-00000000000a','ra','cha','pi_a',5000,5000,0,0,'resolved','succeeded','2026-06-20');
SELECT apply_affiliate_refund_reversal('c3000000-0000-0000-0000-00000000000a','s')->>'adjustment_cents' AS refund_while_saturated;
SELECT upsert_order_dispute('da','cha','pi_a',10000,'usd','won','won','eva2','charge.dispute.closed','2026-07-01T00:00:00Z'::timestamptz,NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000a' ORDER BY effective_at DESC LIMIT 1),'s')->>'adjustment_cents' AS dispute_won;
SELECT SUM(adjustment_cents) AS final_net FROM affiliate_commission_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000a';
\echo '>>> CORRECT = 500 (refund survives the win).  BUG shows 1000.'

\echo '################ CASE #2: lost -> won -> lost -> won ################'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('c1000000-0000-0000-0000-00000000000b','CB','CB','percentage',1000);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('c1000000-0000-0000-0000-00000000000b','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='c1000000-0000-0000-0000-00000000000a';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='c1000000-0000-0000-0000-00000000000a';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='c1000000-0000-0000-0000-00000000000b';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='c1000000-0000-0000-0000-00000000000b';
SELECT mko('c2000000-0000-0000-0000-00000000000b','B1','pi_b',10000,'CB');
SELECT resolve_order_affiliate_attribution('c2000000-0000-0000-0000-00000000000b',NULL,'s')->>'commission_cents' AS accrued;
DO $$ DECLARE i INT; st TEXT; BEGIN
  FOR i IN 1..4 LOOP
    st := CASE WHEN i % 2 = 1 THEN 'lost' ELSE 'won' END;
    PERFORM upsert_order_dispute('db','chb','pi_b',10000,'usd',st,st,'evb'||i,'charge.dispute.closed',
      ('2026-06-'||LPAD((9+i)::text,2,'0')||'T00:00:00Z')::timestamptz,NULL,'{}'::jsonb);
  END LOOP;
END $$;
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT id FROM order_dispute_financial_adjustments
           WHERE order_id='c2000000-0000-0000-0000-00000000000b' ORDER BY effective_at LOOP
    PERFORM apply_affiliate_dispute_adjustment(r.id,'s');
  END LOOP;
END $$;
SELECT reason, adjustment_cents FROM affiliate_commission_adjustments
WHERE order_id='c2000000-0000-0000-0000-00000000000b' ORDER BY created_at;
SELECT SUM(adjustment_cents) AS final_net, 1000 AS original_accrual
FROM affiliate_commission_adjustments WHERE order_id='c2000000-0000-0000-0000-00000000000b';
\echo '>>> CORRECT = 1000 exactly.  BUG shows over-restoration above 1000.'
