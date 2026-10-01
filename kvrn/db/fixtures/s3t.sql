\set ON_ERROR_STOP on
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('f1000000-0000-0000-0000-000000000001','S3','S3','S','s3',10000,true);
CREATE OR REPLACE FUNCTION mko3(p_id UUID,p_num TEXT,p_pi TEXT,p_code TEXT,p_did UUID,p_paid TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
    currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code,discount_id)
  VALUES (p_id,p_num,'cs_'||p_num,p_pi,'paid','usd',10000,0,0,0,10000,p_paid,p_code,p_did);
END $f$;
CREATE OR REPLACE FUNCTION mkaff(p_id UUID,p_code TEXT,p_bps INT,p_win INT DEFAULT 30,p_disc UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,attribution_window_days,commission_hold_days,discount_id)
  VALUES (p_id,p_code,p_code,'percentage',p_bps,p_win,0,p_disc);
  INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES (p_id,'active','2020-01-01');
  INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,fixed_reversal_policy,
    attribution_window_days,commission_hold_days,discount_id,effective_at)
  VALUES (p_id,'percentage',p_bps,'proportional',p_win,0,p_disc,'2020-01-01');
END $f$;

\echo '########## #9A ordinary promo whose code equals an affiliate code ##########'
INSERT INTO discounts (id,code,name,type,percentage_bps,active)
VALUES ('f2000000-0000-0000-0000-00000000000d','SUMMER10','Summer','percentage',1000,true);
SELECT mkaff('f3000000-0000-0000-0000-00000000000a','SUMMER10',1000);
SELECT mko3('f4000000-0000-0000-0000-00000000000a','A9','pi_9a','SUMMER10','f2000000-0000-0000-0000-00000000000d',NOW()-INTERVAL '1 day');
SELECT resolve_order_affiliate_attribution('f4000000-0000-0000-0000-00000000000a',NULL,'s')->>'outcome' AS should_be_no_attribution;

\echo '########## #9B two affiliates cannot own one discount ##########'
INSERT INTO discounts (id,code,name,type,percentage_bps,active)
VALUES ('f2000000-0000-0000-0000-00000000000e','OWNED','Owned','percentage',1000,true);
SELECT mkaff('f3000000-0000-0000-0000-00000000000b','OWN1',1000,30,'f2000000-0000-0000-0000-00000000000e');
DO $$ BEGIN
  PERFORM mkaff('f3000000-0000-0000-0000-00000000000c','OWN2',1000,30,'f2000000-0000-0000-0000-00000000000e');
  RAISE NOTICE '9B FAIL: second owner accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE '9B PASS: duplicate discount ownership rejected'; END $$;

\echo '########## D most recent qualifying click wins ##########'
SELECT mkaff('f3000000-0000-0000-0000-00000000000f','LNKA',1000);
SELECT mkaff('f3000000-0000-0000-0000-000000000010','LNKB',2000);
INSERT INTO affiliate_links (id,affiliate_id,slug) VALUES
 ('f5000000-0000-0000-0000-00000000000f','f3000000-0000-0000-0000-00000000000f','creator-a'),
 ('f5000000-0000-0000-0000-000000000010','f3000000-0000-0000-0000-000000000010','creator-b');
INSERT INTO analytics_sessions (session_id) VALUES ('sessD');
INSERT INTO affiliate_clicks (link_id,affiliate_id,session_id,occurred_at) VALUES
 ('f5000000-0000-0000-0000-00000000000f','f3000000-0000-0000-0000-00000000000f','sessD',NOW()-INTERVAL '3 days'),
 ('f5000000-0000-0000-0000-000000000010','f3000000-0000-0000-0000-000000000010','sessD',NOW()-INTERVAL '1 day');
SELECT mko3('f4000000-0000-0000-0000-00000000000d','AD','pi_d',NULL,NULL,NOW());
SELECT resolve_order_affiliate_attribution('f4000000-0000-0000-0000-00000000000d','sessD','s')->>'affiliate_id' AS winner_should_be_LNKB;
SELECT code FROM affiliates WHERE id='f3000000-0000-0000-0000-000000000010';

\echo '########## E affiliate CODE beats a valid link ##########'
INSERT INTO discounts (id,code,name,type,percentage_bps,active)
VALUES ('f2000000-0000-0000-0000-00000000000f','CODEB','CodeB','percentage',1000,true);
SELECT mkaff('f3000000-0000-0000-0000-000000000011','CODEAFF',1500,30,'f2000000-0000-0000-0000-00000000000f');
INSERT INTO analytics_sessions (session_id) VALUES ('sessE');
INSERT INTO affiliate_clicks (link_id,affiliate_id,session_id,occurred_at)
VALUES ('f5000000-0000-0000-0000-00000000000f','f3000000-0000-0000-0000-00000000000f','sessE',NOW()-INTERVAL '1 day');
SELECT mko3('f4000000-0000-0000-0000-00000000000e','AE','pi_e','CODEB','f2000000-0000-0000-0000-00000000000f',NOW());
SELECT (SELECT code FROM affiliates a WHERE a.id=(resolve_order_affiliate_attribution('f4000000-0000-0000-0000-00000000000e','sessE','s')->>'affiliate_id')::uuid) AS should_be_CODEAFF;
SELECT attribution_method FROM order_affiliate_attributions WHERE order_id='f4000000-0000-0000-0000-00000000000e';

\echo '########## F pre-pause click still converts inside its window ##########'
SELECT mkaff('f3000000-0000-0000-0000-000000000012','PAUSED',1000);
INSERT INTO affiliate_links (id,affiliate_id,slug) VALUES ('f5000000-0000-0000-0000-000000000012','f3000000-0000-0000-0000-000000000012','creator-p');
INSERT INTO analytics_sessions (session_id) VALUES ('sessF');
INSERT INTO affiliate_clicks (link_id,affiliate_id,session_id,occurred_at)
VALUES ('f5000000-0000-0000-0000-000000000012','f3000000-0000-0000-0000-000000000012','sessF',NOW()-INTERVAL '5 days');
INSERT INTO affiliate_status_events (affiliate_id,from_status,to_status,effective_at)
VALUES ('f3000000-0000-0000-0000-000000000012','active','paused',NOW()-INTERVAL '2 days');
UPDATE affiliates SET status='paused' WHERE id='f3000000-0000-0000-0000-000000000012';
SELECT mko3('f4000000-0000-0000-0000-00000000000f','AF','pi_f',NULL,NULL,NOW());
SELECT resolve_order_affiliate_attribution('f4000000-0000-0000-0000-00000000000f','sessF','s')->>'outcome' AS prepause_click_should_attribute;

\echo '########## F2 a click made AFTER the pause must NOT qualify ##########'
INSERT INTO analytics_sessions (session_id) VALUES ('sessF2');
INSERT INTO affiliate_clicks (link_id,affiliate_id,session_id,occurred_at)
VALUES ('f5000000-0000-0000-0000-000000000012','f3000000-0000-0000-0000-000000000012','sessF2',NOW()-INTERVAL '1 day');
SELECT mko3('f4000000-0000-0000-0000-000000000010','AF2','pi_f2',NULL,NULL,NOW());
SELECT resolve_order_affiliate_attribution('f4000000-0000-0000-0000-000000000010','sessF2','s')->>'outcome' AS postpause_should_be_none;
