-- CHAIN DEPENDENCY: part of a sequential lifecycle; REQUIRES s3t to have
-- run first on the same database. Use scripts/test-020-fixtures.sh, which
-- provides a fresh database per chain and enforces the documented order.
\set ON_ERROR_STOP on
\echo '########## #12a backfill after a 40% refund ##########'
SELECT mkaff('f3000000-0000-0000-0000-000000000020','BF1',1000);
SELECT mko3('f4000000-0000-0000-0000-000000000020','B1','pi_b1','BF1',NULL,NOW()-INTERVAL '10 days');
\echo '   (attribution deliberately NOT run at payment time)'
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('f6000000-0000-0000-0000-000000000020','f4000000-0000-0000-0000-000000000020','rb1','chb1','pi_b1',4000,4000,0,0,'resolved','succeeded',NOW()-INTERVAL '5 days');
SELECT backfill_order_affiliate_attribution('f4000000-0000-0000-0000-000000000020',NULL,'admin') AS r;
\echo '>>> EXPECT net 600 (1000 accrued - 400 for the 40% refund), status approved'

\echo '########## #12b backfill with an UNRESOLVED partial dispute ##########'
SELECT mkaff('f3000000-0000-0000-0000-000000000021','BF2',1000);
SELECT mko3('f4000000-0000-0000-0000-000000000021','B2','pi_b2','BF2',NULL,NOW()-INTERVAL '10 days');
SELECT upsert_order_dispute('bf2','chb2','pi_b2',3000,'usd','lost','lost','evbf2','charge.dispute.closed',NOW()-INTERVAL '4 days',NULL,'{}'::jsonb);
SELECT backfill_order_affiliate_attribution('f4000000-0000-0000-0000-000000000021',NULL,'admin')->>'incomplete' AS should_be_true;
SELECT status, incomplete FROM affiliate_commissions WHERE order_id='f4000000-0000-0000-0000-000000000021';
SELECT COUNT(*) AS payable_rows FROM affiliate_payable_commissions('f3000000-0000-0000-0000-000000000021');
\echo '>>> EXPECT incomplete=t, not payable'

\echo '########## #12c HISTORICAL TERMS: order at 10%, config later 20% ##########'
SELECT mkaff('f3000000-0000-0000-0000-000000000022','BF3',1000);
SELECT mko3('f4000000-0000-0000-0000-000000000022','B3','pi_b3','BF3',NULL,NOW()-INTERVAL '10 days');
\echo '   --- terms change to 20% five days ago ---'
INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,fixed_reversal_policy,
  attribution_window_days,commission_hold_days,effective_at,actor_email)
VALUES ('f3000000-0000-0000-0000-000000000022','percentage',2000,'proportional',30,0,NOW()-INTERVAL '5 days','admin');
UPDATE affiliates SET default_commission_rate_bps=2000 WHERE id='f3000000-0000-0000-0000-000000000022';
SELECT backfill_order_affiliate_attribution('f4000000-0000-0000-0000-000000000022',NULL,'admin')->>'net_commission_cents' AS should_be_1000_not_2000;
SELECT commission_rate_bps_snapshot FROM order_affiliate_attributions WHERE order_id='f4000000-0000-0000-0000-000000000022';
\echo '>>> EXPECT 1000 and snapshot 1000 bps (order-time terms), NOT 2000'

\echo '########## #12d backfill is idempotent ##########'
SELECT backfill_order_affiliate_attribution('f4000000-0000-0000-0000-000000000020',NULL,'admin')->>'outcome' AS second_run;
SELECT COALESCE(SUM(adjustment_cents),0) AS net_unchanged FROM affiliate_commission_adjustments
WHERE order_id='f4000000-0000-0000-0000-000000000020';

\echo '########## #14 atomic audit rows exist for financial mutations ##########'
SELECT action, COUNT(*) FROM admin_audit_logs
WHERE resource IN ('affiliate_payouts','affiliate_commissions','order_disputes','orders')
GROUP BY action ORDER BY action;
