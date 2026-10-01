-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES b2t to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '########## #6A BACKDATED TERMS CORRECTION ##########'
SELECT create_affiliate('PROJ','Proj',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id' AS pid \gset
-- normalise creation to June 1 so history is meaningful
UPDATE affiliates SET created_at='2026-06-01' WHERE id=:'pid'::uuid;
UPDATE affiliate_terms_events SET effective_at='2026-06-01' WHERE affiliate_id=:'pid'::uuid;
UPDATE affiliate_status_events SET effective_at='2026-06-01' WHERE affiliate_id=:'pid'::uuid;
SELECT update_affiliate_terms(:'pid'::uuid,'percentage',2000,NULL,'proportional',30,0,NULL,'2026-07-01','raise','admin')->>'current_projection_rate_bps' AS after_jul1;
\echo '--- August: insert a BACKDATED correction effective June 15 = 15% ---'
SELECT update_affiliate_terms(:'pid'::uuid,'percentage',1500,NULL,'proportional',30,0,NULL,'2026-06-15','correction','admin')->>'current_projection_rate_bps' AS projection_after_backdate;
SELECT default_commission_rate_bps AS current_projection FROM affiliates WHERE id=:'pid'::uuid;
SELECT (affiliate_terms_at(:'pid'::uuid,'2026-06-10'::timestamptz)).commission_rate_bps AS jun10,
       (affiliate_terms_at(:'pid'::uuid,'2026-06-20'::timestamptz)).commission_rate_bps AS jun20,
       (affiliate_terms_at(:'pid'::uuid,'2026-07-10'::timestamptz)).commission_rate_bps AS jul10;
\echo '>>> EXPECT projection 2000; jun10=1000 jun20=1500 jul10=2000'

\echo '########## #6B BACKDATED STATUS CORRECTION ##########'
SELECT set_affiliate_status(:'pid'::uuid,'paused','2026-07-01','pause','admin')->>'current_projection' AS after_pause;
SELECT set_affiliate_status(:'pid'::uuid,'active','2026-06-15','backdated correction','admin')->>'current_projection' AS after_backdated;
SELECT status AS current_status FROM affiliates WHERE id=:'pid'::uuid;
\echo '>>> EXPECT current status stays paused (July 1 supersedes June 15)'

\echo '########## #6C/D FUTURE EVENTS REJECTED ##########'
DO $$ BEGIN PERFORM update_affiliate_terms((SELECT id FROM affiliates WHERE code='PROJ'),'percentage',5000,NULL,'proportional',30,0,NULL,NOW()+INTERVAL '1 day','future','admin');
  RAISE NOTICE '6C FAIL accepted'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '6C PASS %', SPLIT_PART(SQLERRM,'|',2); END $$;
DO $$ BEGIN PERFORM set_affiliate_status((SELECT id FROM affiliates WHERE code='PROJ'),'terminated',NOW()+INTERVAL '1 day','future','admin');
  RAISE NOTICE '6D FAIL accepted'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '6D PASS %', SPLIT_PART(SQLERRM,'|',2); END $$;
SELECT COUNT(*) AS future_terms_rows FROM affiliate_terms_events WHERE affiliate_id=:'pid'::uuid AND effective_at>NOW();
SELECT COUNT(*) AS future_status_rows FROM affiliate_status_events WHERE affiliate_id=:'pid'::uuid AND effective_at>NOW();
SELECT default_commission_rate_bps AS unchanged, status AS unchanged_status FROM affiliates WHERE id=:'pid'::uuid;
SELECT COUNT(*) AS misleading_audit FROM admin_audit_logs WHERE resource_id=:'pid' AND payload->>'rate_bps'='5000';
\echo '>>> EXPECT 0 future rows, projection unchanged, 0 misleading audit'

\echo '########## #6E EQUAL effective_at -> deterministic ##########'
SELECT update_affiliate_terms(:'pid'::uuid,'percentage',3000,NULL,'proportional',30,0,NULL,'2026-08-01','v1','admin');
SELECT update_affiliate_terms(:'pid'::uuid,'percentage',4000,NULL,'proportional',30,0,NULL,'2026-08-01','v2 same instant','admin');
SELECT a.default_commission_rate_bps AS projection,
       (affiliate_terms_at(:'pid'::uuid,'2026-08-02'::timestamptz)).commission_rate_bps AS helper
FROM affiliates a WHERE a.id=:'pid'::uuid;
\echo '>>> EXPECT projection = helper (both 4000, latest correction wins)'

\echo '########## #7 WINDOW SNAPSHOT ##########'
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('d0000000-0000-0000-0000-000000000009','W','W','W','w',10000,true) ON CONFLICT DO NOTHING;
SELECT create_affiliate('WIN','Win',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id' AS wid \gset
UPDATE affiliates SET created_at=NOW()-INTERVAL '60 days' WHERE id=:'wid'::uuid;
UPDATE affiliate_terms_events SET effective_at=NOW()-INTERVAL '60 days' WHERE affiliate_id=:'wid'::uuid;
UPDATE affiliate_status_events SET effective_at=NOW()-INTERVAL '60 days' WHERE affiliate_id=:'wid'::uuid;
INSERT INTO affiliate_links (id,affiliate_id,slug,created_at) VALUES ('d4000000-0000-0000-0000-000000000001',:'wid'::uuid,'win',NOW()-INTERVAL '60 days');
INSERT INTO analytics_sessions (session_id) VALUES ('sW');
INSERT INTO affiliate_clicks (link_id,affiliate_id,session_id,occurred_at)
VALUES ('d4000000-0000-0000-0000-000000000001',:'wid'::uuid,'sW',NOW()-INTERVAL '20 days');
\echo '--- window shrinks to 7 days AFTER the click ---'
SELECT update_affiliate_terms(:'wid'::uuid,'percentage',1000,NULL,'proportional',7,0,NULL,NOW()-INTERVAL '5 days','shrink','admin');
SELECT mko('d3000000-0000-0000-0000-00000000000a','W1','pi_w1',NULL,NULL,NOW());
SELECT resolve_order_affiliate_attribution('d3000000-0000-0000-0000-00000000000a','sW','s')->>'outcome' AS a_should_attribute;
SELECT attribution_window_days_snapshot AS window_snapshot_should_be_30,
       commission_rate_bps_snapshot AS rate_from_finalization
FROM order_affiliate_attributions WHERE order_id='d3000000-0000-0000-0000-00000000000a';
\echo '>>> EXPECT attributed, window snapshot 30 (click-time), rate from finalization'

\echo '--- 7B: click under a 7-day window, later widened to 30 ---'
SELECT create_affiliate('WIN2','Win2',NULL::text,'percentage',1000,NULL::integer,'proportional',7,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id' AS w2 \gset
UPDATE affiliates SET created_at=NOW()-INTERVAL '60 days' WHERE id=:'w2'::uuid;
UPDATE affiliate_terms_events SET effective_at=NOW()-INTERVAL '60 days' WHERE affiliate_id=:'w2'::uuid;
UPDATE affiliate_status_events SET effective_at=NOW()-INTERVAL '60 days' WHERE affiliate_id=:'w2'::uuid;
INSERT INTO affiliate_links (id,affiliate_id,slug,created_at) VALUES ('d4000000-0000-0000-0000-000000000002',:'w2'::uuid,'win2',NOW()-INTERVAL '60 days');
INSERT INTO analytics_sessions (session_id) VALUES ('sW2');
INSERT INTO affiliate_clicks (link_id,affiliate_id,session_id,occurred_at)
VALUES ('d4000000-0000-0000-0000-000000000002',:'w2'::uuid,'sW2',NOW()-INTERVAL '20 days');
SELECT update_affiliate_terms(:'w2'::uuid,'percentage',1000,NULL,'proportional',30,0,NULL,NOW()-INTERVAL '5 days','widen','admin');
SELECT mko('d3000000-0000-0000-0000-00000000000b','W2','pi_w2',NULL,NULL,NOW());
SELECT resolve_order_affiliate_attribution('d3000000-0000-0000-0000-00000000000b','sW2','s')->>'outcome' AS b_should_be_none;
\echo '>>> EXPECT no_attribution: a later wider window cannot revive a stale click'
