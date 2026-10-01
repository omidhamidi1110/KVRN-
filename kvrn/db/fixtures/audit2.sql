\set ON_ERROR_STOP on
-- SELF-CONTAINED. Creates its own affiliate and predecessor order so the forced
-- audit-failure rollback can be proven from a completely fresh database.
SELECT create_affiliate('ATOM','Atom',NULL::text,'percentage',1000,NULL::integer,
  'proportional',30,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id' AS seed_aid \gset
-- TEMPORAL CAUSALITY (blocker #5): orders below predate NOW(), so the affiliate must too.
UPDATE affiliates SET created_at = NOW() - INTERVAL '365 days' WHERE code='ATOM';
UPDATE affiliate_terms_events SET effective_at = NOW() - INTERVAL '365 days'
  WHERE affiliate_id = :'seed_aid'::uuid;
UPDATE affiliate_status_events SET effective_at = NOW() - INTERVAL '365 days'
  WHERE affiliate_id = :'seed_aid'::uuid;
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('aa000000-0000-0000-0000-000000000001','AT','AT','A','a',10000,true)
ON CONFLICT (id) DO NOTHING;
\echo '########## D (corrected): force audit failure while voiding a DRAFT ##########'
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
  currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
VALUES ('ab000000-0000-0000-0000-000000000002','AT2','cs_at2','pi_at2','paid','usd',10000,0,0,0,10000,NOW()-INTERVAL '1 day','ATOM');
SELECT resolve_order_affiliate_attribution('ab000000-0000-0000-0000-000000000002',NULL,'s');
SELECT id AS c2 FROM affiliate_commissions WHERE order_id='ab000000-0000-0000-0000-000000000002' \gset
SELECT refresh_affiliate_commission_state(:'c2'::uuid);
SELECT id AS aid2 FROM affiliates WHERE code='ATOM' \gset
SELECT create_affiliate_payout(:'aid2'::uuid, ARRAY[:'c2'::uuid],'admin')->>'payout_id' AS dpid \gset
SELECT status AS draft_status, amount_cents FROM affiliate_payouts WHERE id=:'dpid'::uuid;
SELECT affiliate_commission_payable(:'c2'::uuid) AS payable_reserved_by_draft;

ALTER TABLE admin_audit_logs ADD CONSTRAINT tmp_block_void CHECK (action <> 'void');
DO $$ BEGIN
  PERFORM void_affiliate_payout((SELECT id FROM affiliate_payouts WHERE status='draft' ORDER BY created_at DESC LIMIT 1),'forced','admin');
  RAISE NOTICE 'D FAIL: void committed despite audit failure';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'D PASS: audit CHECK blocked it (%)', SQLSTATE;
          WHEN OTHERS THEN RAISE NOTICE 'D other: %', SQLSTATE; END $$;
ALTER TABLE admin_audit_logs DROP CONSTRAINT tmp_block_void;

\echo '--- the draft must be UNTOUCHED: financial mutation rolled back with the audit ---'
SELECT status AS status_after_failed_void FROM affiliate_payouts WHERE id=:'dpid'::uuid;
SELECT COUNT(*) AS void_audit_rows FROM admin_audit_logs WHERE action='void';
\echo '--- and the same void SUCCEEDS once the audit can be written ---'
SELECT void_affiliate_payout(:'dpid'::uuid,'now ok','admin')->>'outcome' AS void_now;
SELECT status AS final_status FROM affiliate_payouts WHERE id=:'dpid'::uuid;
SELECT affiliate_commission_payable(:'c2'::uuid) AS payable_released;
SELECT COUNT(*) AS void_audit_after FROM admin_audit_logs WHERE action='void';

\echo '########## C. dispute resolution: exactly ONE canonical audit row ##########'
SELECT upsert_order_dispute('atd','chatd','pi_at2',3000,'usd','lost','lost','evatd','charge.dispute.closed',NOW(),NULL,'{}'::jsonb);
SELECT resolve_dispute_merchandise((SELECT id FROM order_dispute_financial_adjustments WHERE order_id='ab000000-0000-0000-0000-000000000002' LIMIT 1),
  2000,1000,0,'admin','verified')->>'outcome' AS resolved;
SELECT COUNT(*) AS resolve_audit_rows FROM admin_audit_logs WHERE action='resolve_merchandise';

\echo '########## 3. HISTORICAL TERMS via the PRODUCTION path ##########'
SELECT update_affiliate_terms(:'aid2'::uuid,'percentage',2000,NULL,'proportional',30,0,NULL,NOW(),'raise','admin')->>'outcome' AS appended;
SELECT (affiliate_terms_at(:'aid2'::uuid, NOW()-INTERVAL '2 days')).commission_rate_bps AS before_change_10pct,
       (affiliate_terms_at(:'aid2'::uuid, NOW()+INTERVAL '1 hour')).commission_rate_bps AS after_change_20pct;
