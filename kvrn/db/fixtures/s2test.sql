\set ON_ERROR_STOP on
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('e0000000-0000-0000-0000-000000000001','S2','S2','S','s',10000,true);
CREATE OR REPLACE FUNCTION mko(p_id UUID,p_num TEXT,p_pi TEXT,p_sub INT,p_code TEXT,p_hold INT DEFAULT 0)
RETURNS VOID LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
    currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
  VALUES (p_id,p_num,'cs_'||p_num,p_pi,'paid','usd',p_sub,0,0,0,p_sub,NOW()-INTERVAL '90 days',p_code);
END $f$;

\echo '########## T1 partial lost -> Incomplete -> WON clears the blocker ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,commission_hold_days)
VALUES ('e1000000-0000-0000-0000-000000000001','T1','T1','percentage',1000,0);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('e1000000-0000-0000-0000-000000000001','active','2020-01-01');
SELECT mko('e2000000-0000-0000-0000-000000000001','T1','pi_t1',10000,'T1');
SELECT resolve_order_affiliate_attribution('e2000000-0000-0000-0000-000000000001',NULL,'s')->>'commission_cents' AS accrued;
SELECT upsert_order_dispute('t1','cht1','pi_t1',3000,'usd','lost','lost','evt1a','charge.dispute.closed',NOW()-INTERVAL '10 days',NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000001' ORDER BY effective_at LIMIT 1),'s')->>'outcome' AS partial_lost;
SELECT incomplete, status FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000001';
SELECT upsert_order_dispute('t1','cht1','pi_t1',3000,'usd','won','won','evt1b','charge.dispute.closed',NOW()-INTERVAL '5 days',NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000001' ORDER BY effective_at DESC LIMIT 1),'s')->>'outcome' AS won;
SELECT refresh_affiliate_commission_state((SELECT id FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000001')) AS state;
SELECT incomplete, status, (SELECT COALESCE(SUM(adjustment_cents),0) FROM affiliate_commission_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000001') AS net
FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000001';
\echo '>>> EXPECT incomplete=f, status=approved, net=1000 (no guess, no fabrication)'

\echo '########## T2 two partial disputes: resolve one -> STILL blocked ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,commission_hold_days)
VALUES ('e1000000-0000-0000-0000-000000000002','T2','T2','percentage',1000,0);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('e1000000-0000-0000-0000-000000000002','active','2020-01-01');
SELECT mko('e2000000-0000-0000-0000-000000000002','T2','pi_t2',10000,'T2');
SELECT resolve_order_affiliate_attribution('e2000000-0000-0000-0000-000000000002',NULL,'s');
SELECT upsert_order_dispute('t2a','cht2','pi_t2',3000,'usd','lost','lost','evt2a','charge.dispute.closed',NOW()-INTERVAL '10 days',NULL,'{}'::jsonb);
SELECT upsert_order_dispute('t2b','cht2b','pi_t2',2000,'usd','lost','lost','evt2b','charge.dispute.closed',NOW()-INTERVAL '9 days',NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment(id,'s')->>'outcome' FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000002';
SELECT COUNT(*) AS blockers FROM affiliate_unresolved_sources((SELECT id FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000002'));
SELECT resolve_dispute_merchandise((SELECT a.id FROM order_dispute_financial_adjustments a JOIN order_disputes d ON d.id=a.dispute_id WHERE d.stripe_dispute_id='t2a'),2000,1000,0,'admin',NULL)->>'outcome' AS resolved_one;
SELECT incomplete, status FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000002';
\echo '>>> EXPECT still incomplete=t (second dispute unresolved)'
SELECT resolve_dispute_merchandise((SELECT a.id FROM order_dispute_financial_adjustments a JOIN order_disputes d ON d.id=a.dispute_id WHERE d.stripe_dispute_id='t2b'),1500,500,0,'admin',NULL)->>'outcome' AS resolved_two;
SELECT incomplete, status FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000002';
\echo '>>> EXPECT incomplete=f only now'

\echo '########## T3 HOLD: reversed day2 -> won day5 -> must be PENDING ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,commission_hold_days)
VALUES ('e1000000-0000-0000-0000-000000000003','T3','T3','percentage',1000,30);
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('e1000000-0000-0000-0000-000000000003','active','2020-01-01');
-- TEMPORAL CAUSALITY (blocker #5): these scenarios place orders in the past,
-- so the affiliate must have EXISTED then. Creation is backdated to match the
-- scenario's intent; it does not weaken the rule.
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000001';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000001';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000002';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000002';
UPDATE affiliates SET created_at='2020-01-01' WHERE id='e1000000-0000-0000-0000-000000000003';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='e1000000-0000-0000-0000-000000000003';
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('e2000000-0000-0000-0000-000000000003','T3','cs_t3','pi_t3','paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '5 days','T3');
SELECT resolve_order_affiliate_attribution('e2000000-0000-0000-0000-000000000003',NULL,'s')->>'eligible_at' AS eligible_in_25_days;
SELECT upsert_order_dispute('t3','cht3','pi_t3',10000,'usd','lost','lost','evt3a','charge.dispute.closed',NOW()-INTERVAL '3 days',NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000003' ORDER BY effective_at LIMIT 1),'s')->>'adjustment_cents' AS day2_lost;
SELECT status AS after_loss FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000003';
SELECT upsert_order_dispute('t3','cht3','pi_t3',10000,'usd','won','won','evt3b','charge.dispute.closed',NOW()-INTERVAL '1 day',NULL,'{}'::jsonb);
SELECT apply_affiliate_dispute_adjustment((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='e2000000-0000-0000-0000-000000000003' ORDER BY effective_at DESC LIMIT 1),'s')->>'adjustment_cents' AS day5_won;
SELECT status AS after_win FROM affiliate_commissions WHERE order_id='e2000000-0000-0000-0000-000000000003';
\echo '>>> EXPECT after_win = pending, NOT approved (25 days of hold remain)'
