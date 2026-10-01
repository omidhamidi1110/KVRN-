\set ON_ERROR_STOP on
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('d0000000-0000-0000-0000-000000000001','B2','B2','B','b2',10000,true);
CREATE OR REPLACE FUNCTION mko(p_id UUID,p_num TEXT,p_pi TEXT,p_code TEXT,p_did UUID,p_paid TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
    currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code,discount_id)
  VALUES (p_id,p_num,'cs_'||p_num,p_pi,'paid','usd',10000,0,0,0,10000,p_paid,p_code,p_did);
END $f$;

\echo '########## #4A OWNERSHIP TRANSFER A -> B ##########'
INSERT INTO discounts (id,code,name,type,percentage_bps,active) VALUES
 ('d1000000-0000-0000-0000-00000000000d','SHARED','Shared','percentage',1000,true);
-- A created and owns D from June 1
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,
  attribution_window_days,commission_hold_days,discount_id,created_at,created_by)
VALUES ('d2000000-0000-0000-0000-00000000000a','AFFA','A','percentage',1000,30,0,NULL,'2026-06-01','admin');
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('d2000000-0000-0000-0000-00000000000a','active','2026-06-01');
INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,fixed_reversal_policy,
  attribution_window_days,commission_hold_days,discount_id,effective_at)
VALUES ('d2000000-0000-0000-0000-00000000000a','percentage',1000,'proportional',30,0,'d1000000-0000-0000-0000-00000000000d','2026-06-01');
-- B created July 1, takes ownership July 1; A releases July 1
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,
  attribution_window_days,commission_hold_days,discount_id,created_at,created_by)
VALUES ('d2000000-0000-0000-0000-00000000000b','AFFB','B','percentage',2000,30,0,'d1000000-0000-0000-0000-00000000000d','2026-07-01','admin');
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('d2000000-0000-0000-0000-00000000000b','active','2026-07-01');
INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,fixed_reversal_policy,
  attribution_window_days,commission_hold_days,discount_id,effective_at) VALUES
 ('d2000000-0000-0000-0000-00000000000a','percentage',1000,'proportional',30,0,NULL,'2026-07-01'),
 ('d2000000-0000-0000-0000-00000000000b','percentage',2000,'proportional',30,0,'d1000000-0000-0000-0000-00000000000d','2026-07-01');

SELECT 'owner_on_jun15='||COALESCE((SELECT code FROM affiliates WHERE id=(SELECT affiliate_id FROM affiliate_owner_of_discount_at('d1000000-0000-0000-0000-00000000000d','2026-06-15'))),'none') AS r1;
SELECT 'owner_on_jul15='||COALESCE((SELECT code FROM affiliates WHERE id=(SELECT affiliate_id FROM affiliate_owner_of_discount_at('d1000000-0000-0000-0000-00000000000d','2026-07-15'))),'none') AS r2;

SELECT mko('d3000000-0000-0000-0000-000000000001','O1','pi_o1','SHARED','d1000000-0000-0000-0000-00000000000d','2026-06-15');
SELECT mko('d3000000-0000-0000-0000-000000000002','O2','pi_o2','SHARED','d1000000-0000-0000-0000-00000000000d','2026-07-15');
\echo '--- LATE backfill of O1 in August ---'
SELECT backfill_order_affiliate_attribution('d3000000-0000-0000-0000-000000000001',NULL,'admin')->>'outcome' AS o1;
SELECT a.code AS o1_attributed_to, att.commission_rate_bps_snapshot FROM order_affiliate_attributions att
JOIN affiliates a ON a.id=att.affiliate_id WHERE att.order_id='d3000000-0000-0000-0000-000000000001';
SELECT backfill_order_affiliate_attribution('d3000000-0000-0000-0000-000000000002',NULL,'admin')->>'outcome' AS o2;
SELECT a.code AS o2_attributed_to FROM order_affiliate_attributions att
JOIN affiliates a ON a.id=att.affiliate_id WHERE att.order_id='d3000000-0000-0000-0000-000000000002';
\echo '>>> EXPECT O1->AFFA (1000 bps), O2->AFFB'

\echo '########## #4B HISTORICAL AMBIGUITY -> FAIL CLOSED ##########'
-- corrupt history: A also owns D again from Jul 1 (overlapping B)
INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,fixed_reversal_policy,
  attribution_window_days,commission_hold_days,discount_id,effective_at)
VALUES ('d2000000-0000-0000-0000-00000000000a','percentage',1000,'proportional',30,0,'d1000000-0000-0000-0000-00000000000d','2026-07-02');
SELECT COUNT(*) AS owners_on_jul15 FROM affiliate_owner_of_discount_at('d1000000-0000-0000-0000-00000000000d','2026-07-15');
SELECT mko('d3000000-0000-0000-0000-000000000003','O3','pi_o3','SHARED','d1000000-0000-0000-0000-00000000000d','2026-07-15');
SELECT resolve_order_affiliate_attribution('d3000000-0000-0000-0000-000000000003',NULL,'s')->>'outcome' AS ambiguous;
SELECT COUNT(*) AS commissions_created FROM affiliate_commissions WHERE order_id='d3000000-0000-0000-0000-000000000003';
SELECT COUNT(*) AS conflicts_detected FROM affiliate_discount_ownership_conflicts();
\echo '>>> EXPECT ambiguous_historical_ownership, 0 commissions, conflicts>0'

\echo '########## #5A affiliate created AFTER the order ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps,
  attribution_window_days,commission_hold_days,created_at,created_by)
VALUES ('d2000000-0000-0000-0000-00000000000c','LATE','Late','percentage',1000,30,0,'2026-07-01','admin');
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at) VALUES ('d2000000-0000-0000-0000-00000000000c','active','2026-07-01');
INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,fixed_reversal_policy,
  attribution_window_days,commission_hold_days,effective_at)
VALUES ('d2000000-0000-0000-0000-00000000000c','percentage',1000,'proportional',30,0,'2026-07-01');
SELECT affiliate_active_at('d2000000-0000-0000-0000-00000000000c','2026-06-01'::timestamptz) AS active_before_creation,
       (affiliate_terms_at('d2000000-0000-0000-0000-00000000000c','2026-06-01'::timestamptz)) IS NULL AS terms_null_before_creation;
SELECT mko('d3000000-0000-0000-0000-000000000004','O4','pi_o4','LATE',NULL,'2026-06-01');
SELECT backfill_order_affiliate_attribution('d3000000-0000-0000-0000-000000000004',NULL,'admin')->>'outcome' AS text_path_should_be_none;
\echo '>>> EXPECT FALSE / TRUE / no_attribution'
