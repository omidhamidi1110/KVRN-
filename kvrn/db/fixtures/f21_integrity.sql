-- db/fixtures/f21_integrity.sql   (FAIL-HARD)
--
-- STANDALONE CHAIN for migration 021 (financial integrity). Runs on its own fresh
-- database via scripts/test-021-fixtures.sh. Every check is an assertion that RAISES
-- on mismatch; the psql PROCESS EXIT CODE under ON_ERROR_STOP is the only authority.
--
-- PHILOSOPHY: each scenario builds a deliberately broken (or correctly clean) money
-- path with the REAL tables/functions and asserts the exact stable issue code, its
-- class (exception / incomplete / advisory) and the entity roll-up. Several also
-- prove the finding DISAPPEARS when the data is corrected: the scan is derived, not
-- a stored flag.
\set ON_ERROR_STOP on

-- ── assertion helpers ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION f21_assert_eq(p_label TEXT, p_actual TEXT, p_expected TEXT) RETURNS VOID
LANGUAGE plpgsql AS $f$ BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'F21 ASSERT FAILED: % expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE 'PASS % = %', p_label, p_actual;
END $f$;

-- Expect the statement to raise an error containing p_token (SQLERRM), or SQLSTATE.
CREATE OR REPLACE FUNCTION f21_expect_error(p_sql TEXT, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql AS $f$
DECLARE v_msg TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF POSITION(p_token IN v_msg) = 0 THEN
      RAISE EXCEPTION 'F21 ASSERT FAILED: expected error containing [%], got [%] for: %', p_token, v_msg, p_sql;
    END IF;
    RAISE NOTICE 'PASS rejected [%]', p_token;
    RETURN;
  END;
  RAISE EXCEPTION 'F21 ASSERT FAILED: unexpected SUCCESS, expected [%] for: %', p_token, p_sql;
END $f$;

-- The finding exists with exactly this state for this entity.
CREATE OR REPLACE FUNCTION f21_expect_finding(p_code TEXT, p_entity_id TEXT, p_state TEXT) RETURNS VOID
LANGUAGE plpgsql AS $f$
DECLARE v_state TEXT;
BEGIN
  SELECT state INTO v_state FROM financial_integrity_scan()
  WHERE issue_code = p_code AND entity_id = p_entity_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'F21 ASSERT FAILED: expected finding % on % (state %), none found', p_code, p_entity_id, p_state;
  END IF;
  IF v_state <> p_state THEN
    RAISE EXCEPTION 'F21 ASSERT FAILED: finding % on % has state % expected %', p_code, p_entity_id, v_state, p_state;
  END IF;
  RAISE NOTICE 'PASS finding % on % is %', p_code, p_entity_id, p_state;
END $f$;

CREATE OR REPLACE FUNCTION f21_expect_no_finding(p_code TEXT, p_entity_id TEXT) RETURNS VOID
LANGUAGE plpgsql AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM financial_integrity_scan() WHERE issue_code = p_code AND entity_id = p_entity_id) THEN
    RAISE EXCEPTION 'F21 ASSERT FAILED: unexpected finding % on %', p_code, p_entity_id;
  END IF;
  RAISE NOTICE 'PASS no finding % on %', p_code, p_entity_id;
END $f$;

-- All non-advisory findings on an entity, as a sorted comma list ('' when clean).
CREATE OR REPLACE FUNCTION f21_codes(p_entity_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(string_agg(issue_code, ',' ORDER BY issue_code), '')
  FROM financial_integrity_scan() WHERE entity_id = p_entity_id AND state <> 'advisory';
$f$;

CREATE OR REPLACE FUNCTION f21_entity_state(p_type TEXT, p_entity_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $f$
  SELECT state FROM financial_integrity_entity_states() WHERE entity_type = p_type AND entity_id = p_entity_id;
$f$;

-- ── builders ────────────────────────────────────────────────────────────────
INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
VALUES ('f2100000-0000-0000-0000-00000000aaaa','F','F','F21','f21',1000,true);
INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
VALUES ('f2100000-0000-0000-0000-00000000bbbb','f2100000-0000-0000-0000-00000000aaaa','F21-M','Black','#000','M',1,0);
-- 100 units of landed cost $3.00. add_inventory_layer does not touch stock_on_hand.
SELECT add_inventory_layer('f2100000-0000-0000-0000-00000000bbbb',100,300,'purchase',NULL,NULL,'cost_batch','f21');
UPDATE product_variants SET stock_on_hand = 100 WHERE id = 'f2100000-0000-0000-0000-00000000bbbb';

CREATE OR REPLACE FUNCTION f21_oid(n INT) RETURNS UUID LANGUAGE sql IMMUTABLE AS
$f$ SELECT ('f2110000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid $f$;

-- A fully clean paid order: 1 line ($10.00, cost $3.00 from FIFO), $5.00 shipping,
-- verified Stripe fee, carrier label recorded. Optional knobs break exactly one thing.
CREATE OR REPLACE FUNCTION f21_mk(
  n INT,
  p_total INT DEFAULT 1500,            -- break ORDER_TOTAL_MISMATCH
  p_fee INT DEFAULT 100,               -- NULL => fee missing
  p_fee_source TEXT DEFAULT 'stripe_api',
  p_consume BOOLEAN DEFAULT TRUE,      -- FALSE => no FIFO consumption
  p_cogs INT DEFAULT 300,              -- NULL => unknown; other => disagree with FIFO
  p_label INT DEFAULT 450,             -- NULL => no shipment
  p_label_source TEXT DEFAULT 'shippo_label',
  p_future BOOLEAN DEFAULT FALSE       -- paid after FIFO costing began
) RETURNS VOID LANGUAGE plpgsql AS $f$
DECLARE v_id UUID := f21_oid(n); v_item UUID := gen_random_uuid(); v_fifo JSONB;
        v_num TEXT := 'F21-' || lpad(n::text,3,'0');
BEGIN
  INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
    payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,
    shipping_quoted_cents,shipping_before_discount_cents,
    stripe_fee_cents,stripe_fee_source,stripe_balance_transaction_id)
  VALUES (v_id,v_num,'cs_'||v_num,'pi_'||v_num,'ch_'||v_num,'paid','usd',1000,500,0,0,p_total,
    CASE WHEN p_future THEN NOW()+INTERVAL '1 hour' ELSE NOW()-INTERVAL '1 day' END,
    500,500,p_fee,CASE WHEN p_fee IS NULL THEN NULL ELSE p_fee_source END,
    CASE WHEN p_fee IS NULL OR p_fee_source <> 'stripe_api' THEN NULL ELSE 'txn_'||v_num END);

  INSERT INTO order_items (id,order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents,
                           unit_cogs_cents,line_cogs_cents)
  VALUES (v_item,v_id,'f2100000-0000-0000-0000-00000000bbbb','F21-M','F21','M','Black',1,1000,1000,p_cogs,p_cogs);

  IF p_consume THEN
    v_fifo := consume_inventory_fifo('f2100000-0000-0000-0000-00000000bbbb',1,'sale',NULL,v_id,v_item);
    UPDATE product_variants SET stock_on_hand = stock_on_hand - 1
      WHERE id = 'f2100000-0000-0000-0000-00000000bbbb';
  ELSE
    -- No consumption means the unit never left the layers; keep stock honest too.
    NULL;
  END IF;

  IF p_label IS NOT NULL THEN
    INSERT INTO shipments (order_id,tracking_number,carrier,label_cost_cents,cost_source)
    VALUES (v_id,'trk'||n,'usps',p_label,p_label_source);
  END IF;
END $f$;

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S0: empty database is reconciled, not "unknown" ##########'
-- No orders yet: nothing may be reported, and the roll-up is RECONCILED.
SELECT f21_assert_eq('S0 findings on a clean empty ledger',
  (SELECT COUNT(*) FROM financial_integrity_scan())::text, '0');
SELECT f21_assert_eq('S0 variant reconciled',
  f21_entity_state('variant','f2100000-0000-0000-0000-00000000bbbb'), 'RECONCILED');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S1: a fully clean order is RECONCILED with zero findings ##########'
SELECT f21_mk(1);
SELECT f21_assert_eq('S1 order has no findings', f21_codes(f21_oid(1)::text), '');
SELECT f21_assert_eq('S1 order state', f21_entity_state('order', f21_oid(1)::text), 'RECONCILED');
SELECT f21_assert_eq('S1 whole ledger has no findings',
  (SELECT COUNT(*) FROM financial_integrity_scan())::text, '0');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S2: order / payment invariants ##########'
SELECT f21_mk(2, p_total => 1600);
SELECT f21_expect_finding('ORDER_TOTAL_MISMATCH', f21_oid(2)::text, 'exception');
SELECT f21_assert_eq('S2 state EXCEPTION', f21_entity_state('order', f21_oid(2)::text), 'EXCEPTION');

-- tax is not revenue: a tax_cents value must be carried by the total identity
UPDATE orders SET total_cents = 1500 WHERE id = f21_oid(2);
SELECT f21_expect_no_finding('ORDER_TOTAL_MISMATCH', f21_oid(2)::text);   -- derived: fixing the data clears it

-- payment identity
SELECT f21_mk(3);
UPDATE orders SET stripe_payment_intent_id = NULL WHERE id = f21_oid(3);
SELECT f21_expect_finding('ORDER_PAYMENT_ID_MISSING', f21_oid(3)::text, 'incomplete');
UPDATE orders SET stripe_payment_intent_id = 'pi_F21-003' WHERE id = f21_oid(3);
SELECT f21_expect_no_finding('ORDER_PAYMENT_ID_MISSING', f21_oid(3)::text);

-- paid_at with a never-captured status contradicts itself
UPDATE orders SET payment_status = 'failed' WHERE id = f21_oid(3);
SELECT f21_expect_finding('ORDER_PAYMENT_STATUS_CONTRADICTS_PAID', f21_oid(3)::text, 'exception');
UPDATE orders SET payment_status = 'paid' WHERE id = f21_oid(3);

-- items must add up to the subtotal
SELECT f21_mk(4);
UPDATE orders SET subtotal_cents = 1100, total_cents = 1600 WHERE id = f21_oid(4);
SELECT f21_expect_finding('ORDER_ITEMS_SUBTOTAL_MISMATCH', f21_oid(4)::text, 'exception');

-- shipping revenue must follow quote - auto-free waiver - promo (shipping stays separate)
SELECT f21_mk(5);
UPDATE orders SET shipping_cents = 700, total_cents = 1700 WHERE id = f21_oid(5);
SELECT f21_expect_finding('ORDER_SHIPPING_SNAPSHOT_MISMATCH', f21_oid(5)::text, 'exception');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S3: Stripe fee is recognised once; unknown is never zero ##########'
SELECT f21_mk(6, p_fee => NULL);
SELECT f21_expect_finding('ORDER_STRIPE_FEE_MISSING', f21_oid(6)::text, 'incomplete');
SELECT f21_assert_eq('S3 order state INCOMPLETE (not zero fee)', f21_entity_state('order', f21_oid(6)::text), 'INCOMPLETE');
SELECT f21_assert_eq('S3 the scan never invented a fee',
  (SELECT stripe_fee_cents IS NULL FROM orders WHERE id = f21_oid(6))::text, 'true');

SELECT f21_mk(7, p_fee_source => 'manual');
SELECT f21_expect_finding('ORDER_STRIPE_FEE_MANUAL', f21_oid(7)::text, 'advisory');
SELECT f21_assert_eq('S3 manual fee is advisory only: order stays RECONCILED',
  f21_entity_state('order', f21_oid(7)::text), 'RECONCILED');

SELECT f21_mk(8);
SELECT f21_mk(9);
UPDATE orders SET stripe_balance_transaction_id = 'txn_F21-008' WHERE id = f21_oid(9);   -- same txn on two orders
SELECT f21_expect_finding('ORDER_STRIPE_FEE_DUPLICATED', f21_oid(8)::text, 'exception');
SELECT f21_expect_finding('ORDER_STRIPE_FEE_DUPLICATED', f21_oid(9)::text, 'exception');
UPDATE orders SET stripe_balance_transaction_id = 'txn_F21-009' WHERE id = f21_oid(9);

UPDATE orders SET stripe_fee_cents = 99999 WHERE id = f21_oid(8);
SELECT f21_expect_finding('ORDER_STRIPE_FEE_OUT_OF_BOUNDS', f21_oid(8)::text, 'exception');
UPDATE orders SET stripe_fee_cents = 100 WHERE id = f21_oid(8);

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S4: COGS snapshot, FIFO backing, immutability ##########'
SELECT f21_mk(10, p_cogs => NULL, p_consume => FALSE);
SELECT f21_expect_finding('ORDER_COGS_UNKNOWN', f21_oid(10)::text, 'incomplete');
SELECT f21_assert_eq('S4 unknown COGS is INCOMPLETE, not zero', f21_entity_state('order', f21_oid(10)::text), 'INCOMPLETE');

-- A line cost that disagrees with what FIFO actually consumed
SELECT f21_mk(11, p_cogs => 999);
SELECT f21_expect_finding('ORDER_FIFO_COST_MISMATCH', f21_oid(11)::text, 'exception');

-- An order paid after FIFO costing began, with no consumption rows
SELECT f21_mk(12, p_consume => FALSE, p_future => TRUE);
SELECT f21_expect_finding('ORDER_FIFO_CONSUMPTION_MISSING', f21_oid(12)::text, 'exception');

-- unit and line cogs that contradict each other
SELECT f21_mk(13);
-- (a known snapshot cannot be rewritten, so build the inconsistency at insert time)
INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,payment_status,
  currency,subtotal_cents,shipping_cents,total_cents,paid_at,stripe_fee_cents,stripe_fee_source,stripe_balance_transaction_id)
VALUES (f21_oid(14),'F21-014','cs_14','pi_14','ch_14','paid','usd',1000,0,1000,NOW()-INTERVAL '2 days',100,'stripe_api','txn_14');
INSERT INTO order_items (order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents,unit_cogs_cents,line_cogs_cents)
VALUES (f21_oid(14),'f2100000-0000-0000-0000-00000000bbbb','F21-M','F21','M','Black',2,500,1000,300,100);
SELECT f21_expect_finding('ORDER_COGS_FIELDS_INCONSISTENT', f21_oid(14)::text, 'exception');

-- IMMUTABILITY: a known COGS snapshot can never be rewritten...
SELECT f21_expect_error(format($q$UPDATE order_items SET line_cogs_cents = 1, unit_cogs_cents = 1 WHERE order_id = %L$q$, f21_oid(1)),
  'KVRN_COGS|SNAPSHOT_IMMUTABLE');
SELECT f21_expect_error(format($q$UPDATE order_items SET unit_cogs_cents = 1 WHERE order_id = %L$q$, f21_oid(1)),
  'KVRN_COGS|SNAPSHOT_IMMUTABLE');
SELECT f21_expect_error(format($q$UPDATE order_items SET line_cogs_cents = 1 WHERE order_id = %L$q$, f21_oid(1)),
  'KVRN_COGS|SNAPSHOT_IMMUTABLE');
SELECT f21_assert_eq('S4 snapshot unchanged after the rejected rewrite',
  (SELECT line_cogs_cents FROM order_items WHERE order_id = f21_oid(1))::text, '300');
-- ...but an UNKNOWN one may be supplied once (correcting an unknown, not rewriting a fact)
UPDATE order_items SET unit_cogs_cents = 300, line_cogs_cents = 300 WHERE order_id = f21_oid(10);
SELECT f21_expect_no_finding('ORDER_COGS_UNKNOWN', f21_oid(10)::text);
SELECT f21_expect_error(format($q$UPDATE order_items SET line_cogs_cents = 301 WHERE order_id = %L$q$, f21_oid(10)),
  'KVRN_COGS|SNAPSHOT_IMMUTABLE');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S5: shipping revenue vs shipping expense are separate and never guessed ##########'
SELECT f21_mk(15, p_label => NULL);
SELECT f21_expect_finding('ORDER_SHIPPING_COST_MISSING', f21_oid(15)::text, 'incomplete');
SELECT f21_mk(16, p_label_source => 'shippo_quote');
SELECT f21_expect_finding('ORDER_SHIPPING_COST_ESTIMATE_ONLY', f21_oid(16)::text, 'incomplete');
SELECT f21_mk(17, p_label_source => NULL);
SELECT f21_expect_finding('ORDER_SHIPPING_COST_UNSOURCED', f21_oid(17)::text, 'advisory');
SELECT f21_assert_eq('S5 customer shipping revenue untouched by cost findings',
  (SELECT shipping_cents FROM orders WHERE id = f21_oid(15))::text, '500');
-- a cancelled order that never shipped does not owe a label
UPDATE orders SET fulfillment_status = 'cancelled' WHERE id = f21_oid(15);
SELECT f21_expect_no_finding('ORDER_SHIPPING_COST_MISSING', f21_oid(15)::text);

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S6: refunds ##########'
-- refunds beyond what was paid
SELECT f21_mk(18);
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,component_breakdown_status,status,refunded_at)
VALUES (f21_oid(18),'re_18a','ch_F21-018','pi_F21-018',1000,1000,0,0,0,'resolved','succeeded',NOW()),
       (f21_oid(18),'re_18b','ch_F21-018','pi_F21-018',1000,500,500,0,0,'resolved','succeeded',NOW());
SELECT f21_expect_finding('ORDER_REFUNDS_EXCEED_PAID', f21_oid(18)::text, 'exception');

-- components not decomposed yet: unknown, never zero
SELECT f21_mk(19);
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,status,refunded_at)
VALUES (f21_oid(19),'re_19','ch_F21-019','pi_F21-019',500,'succeeded',NOW());
SELECT f21_expect_finding('REFUND_COMPONENTS_UNRESOLVED', (SELECT id::text FROM order_refunds WHERE stripe_refund_id='re_19'), 'incomplete');
SELECT f21_expect_finding('REFUND_FEE_RETURN_UNKNOWN', (SELECT id::text FROM order_refunds WHERE stripe_refund_id='re_19'), 'incomplete');
SELECT f21_assert_eq('S6 refund entity INCOMPLETE',
  f21_entity_state('refund', (SELECT id::text FROM order_refunds WHERE stripe_refund_id='re_19')), 'INCOMPLETE');
SELECT f21_assert_eq('S6 the scan did not invent components',
  (SELECT merchandise_refund_cents IS NULL FROM order_refunds WHERE stripe_refund_id='re_19')::text, 'true');
-- resolving the components clears it (derived)
SELECT resolve_refund_components((SELECT id FROM order_refunds WHERE stripe_refund_id='re_19'), 500, 0, 0, 'f21');
SELECT f21_expect_no_finding('REFUND_COMPONENTS_UNRESOLVED', (SELECT id::text FROM order_refunds WHERE stripe_refund_id='re_19'));

-- components that do not add up
SELECT f21_mk(20);
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,component_breakdown_status,component_breakdown_source,status,refunded_at)
VALUES (f21_oid(20),'re_20','ch_F21-020','pi_F21-020',500,300,0,0,0,'resolved','admin','succeeded',NOW());
SELECT f21_expect_finding('REFUND_COMPONENTS_SUM_MISMATCH', (SELECT id::text FROM order_refunds WHERE stripe_refund_id='re_20'), 'exception');

-- a refund against the wrong payment
SELECT f21_mk(21);
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,component_breakdown_status,component_breakdown_source,status,refunded_at)
VALUES (f21_oid(21),'re_21','ch_OTHER','pi_OTHER',500,500,0,0,0,'resolved','admin','succeeded',NOW());
SELECT f21_expect_finding('REFUND_PAYMENT_MISMATCH', (SELECT id::text FROM order_refunds WHERE stripe_refund_id='re_21'), 'exception');
SELECT f21_expect_finding('ORDER_CHARGE_ID_CONFLICT', f21_oid(21)::text, 'exception');

-- full refund must be reflected in payment_status
SELECT f21_mk(22);
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,component_breakdown_status,component_breakdown_source,status,refunded_at)
VALUES (f21_oid(22),'re_22','ch_F21-022','pi_F21-022',1500,1000,500,0,0,'resolved','admin','succeeded',NOW());
SELECT f21_expect_finding('ORDER_REFUND_STATUS_MISMATCH', f21_oid(22)::text, 'exception');
UPDATE orders SET payment_status = 'refunded' WHERE id = f21_oid(22);
SELECT f21_expect_no_finding('ORDER_REFUND_STATUS_MISMATCH', f21_oid(22)::text);

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S7: disputes and refund overlap ##########'
-- (a) A real lost dispute through the real function, then its balance transaction: clean.
SELECT f21_mk(23);
SELECT upsert_order_dispute('du_23','ch_F21-023','pi_F21-023',1500,'usd','lost','lost','evt_23a','charge.dispute.closed',
  NOW(), NOW()-INTERVAL '10 days','{}'::jsonb);
SELECT f21_expect_finding('DISPUTE_BALANCE_TRANSACTION_MISSING',
  (SELECT id::text FROM order_disputes WHERE stripe_dispute_id='du_23'), 'incomplete');
INSERT INTO dispute_balance_transactions (dispute_id,stripe_balance_transaction_id,amount_cents,fee_cents,net_cents)
SELECT id,'txn_du23',-1500,1500,-3000 FROM order_disputes WHERE stripe_dispute_id='du_23';
SELECT f21_assert_eq('S7a real-path lost dispute is clean once the balance txn is recorded',
  f21_codes((SELECT id::text FROM order_disputes WHERE stripe_dispute_id='du_23')), '');

-- (b) The overlap: the dispute was recognised in full, THEN a refund arrived. The same
--     $5.00 would be reversed twice. This is exactly the frozen-offset gap.
SELECT f21_mk(24);
SELECT upsert_order_dispute('du_24','ch_F21-024','pi_F21-024',1500,'usd','lost','lost','evt_24a','charge.dispute.closed',
  NOW(), NOW()-INTERVAL '10 days','{}'::jsonb);
INSERT INTO dispute_balance_transactions (dispute_id,stripe_balance_transaction_id,amount_cents,fee_cents,net_cents)
SELECT id,'txn_du24',-1500,1500,-3000 FROM order_disputes WHERE stripe_dispute_id='du_24';
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,component_breakdown_status,component_breakdown_source,status,refunded_at)
VALUES (f21_oid(24),'re_24','ch_F21-024','pi_F21-024',500,500,0,0,0,'resolved','admin','succeeded',NOW());
SELECT f21_expect_finding('DISPUTE_REFUND_OVERLAP_DOUBLE_COUNTED',
  (SELECT id::text FROM order_disputes WHERE stripe_dispute_id='du_24'), 'exception');

-- (c) A dispute impact that the append-only ledger does not explain
SELECT f21_mk(25);
INSERT INTO order_disputes (order_id,stripe_dispute_id,amount_cents,stripe_status,status,net_revenue_impact_cents,opened_at)
VALUES (f21_oid(25),'du_25',1500,'lost','lost',1500,NOW()-INTERVAL '5 days');
SELECT f21_expect_finding('DISPUTE_LEDGER_MISMATCH', (SELECT id::text FROM order_disputes WHERE stripe_dispute_id='du_25'), 'exception');

-- (d) A refund offset larger than any refund that exists
SELECT f21_mk(26);
INSERT INTO order_disputes (order_id,stripe_dispute_id,amount_cents,stripe_status,status,refund_offset_cents,net_revenue_impact_cents,opened_at)
VALUES (f21_oid(26),'du_26',1500,'won','won',500,0,NOW()-INTERVAL '5 days');
SELECT f21_expect_finding('DISPUTE_OFFSET_EXCEEDS_REFUNDS', (SELECT id::text FROM order_disputes WHERE stripe_dispute_id='du_26'), 'exception');

-- (e) Disputed more than the order total
SELECT f21_mk(27);
INSERT INTO order_disputes (order_id,stripe_dispute_id,amount_cents,stripe_status,status,net_revenue_impact_cents,opened_at)
VALUES (f21_oid(27),'du_27',9999,'under_review','under_review',0,NOW()-INTERVAL '5 days');
SELECT f21_expect_finding('DISPUTE_AMOUNT_EXCEEDS_ORDER', (SELECT id::text FROM order_disputes WHERE stripe_dispute_id='du_27'), 'exception');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S8: inventory: derived, and clears when corrected ##########'
SELECT f21_assert_eq('S8 variant starts reconciled', f21_entity_state('variant','f2100000-0000-0000-0000-00000000bbbb'), 'RECONCILED');
UPDATE product_variants SET stock_on_hand = stock_on_hand + 5 WHERE id = 'f2100000-0000-0000-0000-00000000bbbb';
SELECT f21_expect_finding('INVENTORY_STOCK_LAYER_MISMATCH','f2100000-0000-0000-0000-00000000bbbb','exception');
SELECT f21_assert_eq('S8 variant EXCEPTION', f21_entity_state('variant','f2100000-0000-0000-0000-00000000bbbb'), 'EXCEPTION');
UPDATE product_variants SET stock_on_hand = stock_on_hand - 5 WHERE id = 'f2100000-0000-0000-0000-00000000bbbb';
SELECT f21_expect_no_finding('INVENTORY_STOCK_LAYER_MISMATCH','f2100000-0000-0000-0000-00000000bbbb');

-- stock on hand matches layers only if every sale decremented both. Real write-off path:
SELECT f21_assert_eq('S8 write-off through the real function',
  record_inventory_write_off('f2100000-0000-0000-0000-00000000bbbb',2,'damaged','f21','f21')->>'outcome', 'written_off');
SELECT f21_assert_eq('S8 a normal write-off is fully reconciled',
  (SELECT COUNT(*) FROM financial_integrity_scan() WHERE domain = 'inventory'
     AND entity_type IN ('inventory_write_off','variant'))::text, '0');

-- an unknown-cost layer is INCOMPLETE, never costed at zero
SELECT add_inventory_layer('f2100000-0000-0000-0000-00000000bbbb',3,NULL,'opening_balance',NULL,NULL,'unknown','f21');
UPDATE product_variants SET stock_on_hand = stock_on_hand + 3 WHERE id = 'f2100000-0000-0000-0000-00000000bbbb';
SELECT f21_expect_finding('INVENTORY_UNKNOWN_COST_UNITS','f2100000-0000-0000-0000-00000000bbbb','incomplete');
SELECT f21_assert_eq('S8 variant INCOMPLETE', f21_entity_state('variant','f2100000-0000-0000-0000-00000000bbbb'), 'INCOMPLETE');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S9: returns and exchanges ##########'
SELECT f21_mk(28);
INSERT INTO order_returns (id,order_id,return_number,status,return_shipping_paid_by)
VALUES ('f2120000-0000-0000-0000-000000000001',f21_oid(28),'RET-F21-1','received','kvrn');
SELECT f21_expect_finding('RETURN_LABEL_COST_MISSING','f2120000-0000-0000-0000-000000000001','incomplete');
UPDATE order_returns SET return_label_cost_cents = 700 WHERE id = 'f2120000-0000-0000-0000-000000000001';
SELECT f21_expect_no_finding('RETURN_LABEL_COST_MISSING','f2120000-0000-0000-0000-000000000001');

-- more units returned than were ever sold
INSERT INTO order_return_items (return_id,order_item_id,quantity,disposition)
SELECT 'f2120000-0000-0000-0000-000000000001', id, 3, 'damaged' FROM order_items WHERE order_id = f21_oid(28);
SELECT f21_expect_finding('RETURN_QUANTITY_EXCEEDS_ORDERED', f21_oid(28)::text, 'exception');

-- exchange shipped without a recorded carrier cost: unknown, not zero
SELECT f21_mk(29);
INSERT INTO order_exchanges (id,order_id,exchange_number,status,shipped_at)
VALUES ('f2130000-0000-0000-0000-000000000001',f21_oid(29),'EX-F21-1','shipped',NOW());
SELECT f21_expect_finding('EXCHANGE_SHIPPING_COST_MISSING','f2130000-0000-0000-0000-000000000001','incomplete');

-- the only writer for it: write-once, attributable, validated
SELECT f21_expect_error($q$SELECT record_exchange_replacement_shipping_cost('f2130000-0000-0000-0000-000000000001',-1,'f21')$q$, 'KVRN_EXCHANGE|INVALID_COST');
SELECT f21_expect_error($q$SELECT record_exchange_replacement_shipping_cost('f2130000-0000-0000-0000-000000000001',650,'  ')$q$, 'KVRN_EXCHANGE|ACTOR_REQUIRED');
SELECT f21_assert_eq('S9 cost recorded',
  record_exchange_replacement_shipping_cost('f2130000-0000-0000-0000-000000000001',650,'f21')->>'outcome','recorded');
SELECT f21_expect_no_finding('EXCHANGE_SHIPPING_COST_MISSING','f2130000-0000-0000-0000-000000000001');
SELECT f21_assert_eq('S9 idempotent re-send',
  record_exchange_replacement_shipping_cost('f2130000-0000-0000-0000-000000000001',650,'f21')->>'outcome','already_recorded');
SELECT f21_expect_error($q$SELECT record_exchange_replacement_shipping_cost('f2130000-0000-0000-0000-000000000001',651,'f21')$q$, 'KVRN_EXCHANGE|COST_ALREADY_RECORDED');
SELECT f21_assert_eq('S9 value was not overwritten',
  (SELECT replacement_shipping_cost_cents FROM order_exchanges WHERE id='f2130000-0000-0000-0000-000000000001')::text,'650');
SELECT f21_assert_eq('S9 the write is audited',
  (SELECT COUNT(*) FROM admin_audit_logs WHERE action='record_replacement_shipping_cost')::text,'1');
INSERT INTO order_exchanges (id,order_id,exchange_number,status) VALUES ('f2130000-0000-0000-0000-000000000002',f21_oid(29),'EX-F21-2','pending');
SELECT f21_expect_error($q$SELECT record_exchange_replacement_shipping_cost('f2130000-0000-0000-0000-000000000002',100,'f21')$q$, 'KVRN_EXCHANGE|NOT_SHIPPED');

-- an unsettled price difference is not revenue and not silently dropped
INSERT INTO order_exchanges (id,order_id,exchange_number,status,price_difference_cents,price_difference_status)
VALUES ('f2130000-0000-0000-0000-000000000003',f21_oid(29),'EX-F21-3','pending',800,'pending');
SELECT f21_expect_finding('EXCHANGE_PRICE_DIFFERENCE_UNSETTLED','f2130000-0000-0000-0000-000000000003','incomplete');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S10: affiliates: commission expense vs payout cash ##########'
SELECT create_affiliate('F21A','F21 Affiliate',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id' AS aid \gset
UPDATE affiliates SET created_at = NOW()-INTERVAL '365 days' WHERE id = :'aid'::uuid;
UPDATE affiliate_terms_events SET effective_at = NOW()-INTERVAL '365 days' WHERE affiliate_id = :'aid'::uuid;
UPDATE affiliate_status_events SET effective_at = NOW()-INTERVAL '365 days' WHERE affiliate_id = :'aid'::uuid;

SELECT f21_mk(30);
UPDATE orders SET discount_code = 'F21A', paid_at = NOW()-INTERVAL '90 days' WHERE id = f21_oid(30);
SELECT resolve_order_affiliate_attribution(f21_oid(30),NULL,'s')->>'commission_cents' AS cc \gset
SELECT id AS cid FROM affiliate_commissions WHERE order_id = f21_oid(30) \gset
SELECT f21_assert_eq('S10 commission accrued', :'cc', '100');
SELECT f21_assert_eq('S10 commission is clean',
  f21_entity_state('affiliate_commission', :'cid'), 'RECONCILED');
SELECT refresh_affiliate_commission_state(:'cid'::uuid);
SELECT create_affiliate_payout(:'aid'::uuid, ARRAY[:'cid'::uuid],'admin')->>'payout_id' AS pid \gset
SELECT f21_assert_eq('S10 draft payout is clean', f21_entity_state('affiliate_payout', :'pid'), 'RECONCILED');

-- payout amount must equal its lines
UPDATE affiliate_payouts SET amount_cents = 150 WHERE id = :'pid'::uuid;
SELECT f21_expect_finding('AFFILIATE_PAYOUT_LINES_MISMATCH', :'pid', 'exception');
UPDATE affiliate_payouts SET amount_cents = 100 WHERE id = :'pid'::uuid;
SELECT f21_expect_no_finding('AFFILIATE_PAYOUT_LINES_MISMATCH', :'pid');

-- the same commission cannot be allocated to two live payouts (paid twice)
INSERT INTO affiliate_payouts (id,affiliate_id,payout_number,amount_cents,status)
VALUES ('f2140000-0000-0000-0000-000000000001', :'aid'::uuid, 'PAY-F21-DUP', 100, 'draft');
INSERT INTO affiliate_payout_lines (payout_id,commission_id,amount_cents)
VALUES ('f2140000-0000-0000-0000-000000000001', :'cid'::uuid, 100);
SELECT f21_expect_finding('AFFILIATE_COMMISSION_OVER_ALLOCATED', :'cid', 'exception');
DELETE FROM affiliate_payouts WHERE id = 'f2140000-0000-0000-0000-000000000001';   -- a draft may be removed
SELECT f21_expect_no_finding('AFFILIATE_COMMISSION_OVER_ALLOCATED', :'cid');

SELECT f21_assert_eq('S10 mark paid',
  mark_affiliate_payout_paid(:'pid'::uuid, NOW(), 'ach', 'ref-1', 'admin')->>'outcome', 'paid');
SELECT f21_assert_eq('S10 paid payout reconciled', f21_entity_state('affiliate_payout', :'pid'), 'RECONCILED');

-- PAID PAYOUT HISTORY IS IMMUTABLE
SELECT f21_expect_error(format($q$UPDATE affiliate_payouts SET amount_cents = 1 WHERE id = %L$q$, :'pid'), 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_expect_error(format($q$UPDATE affiliate_payouts SET paid_at = NOW() - INTERVAL '30 days' WHERE id = %L$q$, :'pid'), 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_expect_error(format($q$UPDATE affiliate_payouts SET reference = 'edited' WHERE id = %L$q$, :'pid'), 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_expect_error(format($q$UPDATE affiliate_payouts SET status = 'draft' WHERE id = %L$q$, :'pid'), 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_expect_error(format($q$DELETE FROM affiliate_payouts WHERE id = %L$q$, :'pid'), 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_expect_error(format($q$DELETE FROM affiliate_payout_lines WHERE payout_id = %L$q$, :'pid'), 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_expect_error(format($q$UPDATE affiliate_payout_lines SET amount_cents = 5 WHERE payout_id = %L$q$, :'pid'), 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_expect_error(format($q$INSERT INTO affiliate_payout_lines (payout_id,commission_id,amount_cents) VALUES (%L,%L,1)$q$, :'pid', :'cid'), 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_assert_eq('S10 the paid payout is exactly as paid',
  (SELECT amount_cents||'/'||status||'/'||reference FROM affiliate_payouts WHERE id = :'pid'::uuid), '100/paid/ref-1');
-- the canonical void path still refuses a paid payout
SELECT f21_expect_error(format($q$SELECT void_affiliate_payout(%L,'oops','admin')$q$, :'pid'), 'KVRN_PAYOUT|PAID_CANNOT_BE_VOIDED');

-- the legacy direct paid -> void flip stays possible (frozen 020 fixture rev2c depends on it) but is
-- PERMANENTLY DETECTABLE, because the paid date survives it.
INSERT INTO affiliate_payouts (id,affiliate_id,payout_number,amount_cents,status,paid_at)
VALUES ('f2140000-0000-0000-0000-000000000002', :'aid'::uuid, 'PAY-F21-VOID', 0, 'paid', NOW());
UPDATE affiliate_payouts SET status = 'void' WHERE id = 'f2140000-0000-0000-0000-000000000002';
SELECT f21_expect_finding('AFFILIATE_PAYOUT_VOIDED_AFTER_PAID','f2140000-0000-0000-0000-000000000002','exception');

-- a reversal after payout leaves an overpayment that must be handled, never hidden
SELECT f21_mk(31);
UPDATE orders SET discount_code = 'F21A', paid_at = NOW()-INTERVAL '90 days' WHERE id = f21_oid(31);
SELECT resolve_order_affiliate_attribution(f21_oid(31),NULL,'s');
SELECT id AS cid2 FROM affiliate_commissions WHERE order_id = f21_oid(31) \gset
SELECT refresh_affiliate_commission_state(:'cid2'::uuid);
SELECT create_affiliate_payout(:'aid'::uuid, ARRAY[:'cid2'::uuid],'admin')->>'payout_id' AS pid2 \gset
SELECT mark_affiliate_payout_paid(:'pid2'::uuid, NOW(), 'ach', 'ref-2', 'admin');
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,component_breakdown_status,component_breakdown_source,status,refunded_at)
VALUES (f21_oid(31),'re_31','ch_F21-031','pi_F21-031',1000,1000,0,0,0,'resolved','admin','succeeded',NOW())
RETURNING id AS rid \gset
SELECT apply_affiliate_refund_reversal(:'rid'::uuid,'s');
SELECT f21_expect_finding('AFFILIATE_OVERPAID_UNRECOVERED', :'cid2', 'exception');
SELECT f21_assert_eq('S10 overpaid commission is EXCEPTION', f21_entity_state('affiliate_commission', :'cid2'), 'EXCEPTION');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S11: expenses and ad spend: no double counting, no undated rows ##########'
INSERT INTO expense_transactions (id,provider,category,name,amount_cents,invoice_id,paid_at)
VALUES ('f2150000-0000-0000-0000-000000000001','Neon','infrastructure','Neon May',1900,'INV-100','2026-05-01');
INSERT INTO expense_transactions (id,provider,category,name,amount_cents,invoice_id,paid_at,created_at)
VALUES ('f2150000-0000-0000-0000-000000000002','neon ','infrastructure','Neon May (again)',1900,' inv-100','2026-05-01', NOW()+INTERVAL '1 second');
SELECT f21_expect_finding('EXPENSE_DUPLICATE_INVOICE','f2150000-0000-0000-0000-000000000002','exception');
SELECT f21_expect_no_finding('EXPENSE_DUPLICATE_INVOICE','f2150000-0000-0000-0000-000000000001');   -- the first is the original
INSERT INTO expense_transactions (id,provider,category,name,amount_cents) VALUES
  ('f2150000-0000-0000-0000-000000000003','X','software','Undated',500);
SELECT f21_expect_finding('EXPENSE_UNDATED','f2150000-0000-0000-0000-000000000003','incomplete');
SELECT f21_assert_eq('S11 an undated expense is INCOMPLETE, not zero',
  f21_entity_state('expense','f2150000-0000-0000-0000-000000000003'), 'INCOMPLETE');

INSERT INTO ad_spend (id,platform,campaign_name,spend_cents,period_start,period_end)
VALUES ('f2160000-0000-0000-0000-000000000001','meta','Spring',10000,'2026-05-01','2026-05-31'),
       ('f2160000-0000-0000-0000-000000000002','meta','Spring',10000,'2026-05-01','2026-05-31');
SELECT f21_assert_eq('S11 exactly one of the identical ad-spend rows is flagged',
  (SELECT COUNT(*) FROM financial_integrity_scan() WHERE issue_code='AD_SPEND_DUPLICATE')::text, '1');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S12: derived, deterministic, side-effect free ##########'
-- (a) every entity a finding points at is part of the checked universe
SELECT f21_assert_eq('S12a no finding refers to an unknown entity',
  (SELECT COUNT(*) FROM financial_integrity_scan() f
    WHERE NOT EXISTS (SELECT 1 FROM financial_integrity_entities() e
                      WHERE e.entity_type = f.entity_type AND e.entity_id = f.entity_id))::text, '0');
-- (b) one finding per (code, entity): the fingerprint is a true identity
SELECT f21_assert_eq('S12b fingerprints are unique',
  (SELECT COUNT(*) - COUNT(DISTINCT fi_fingerprint(issue_code, entity_type, entity_id)) FROM financial_integrity_scan())::text, '0');
-- (c) only the three documented classes, resolutions and known pages
SELECT f21_assert_eq('S12c classes are exactly exception/incomplete/advisory',
  (SELECT COUNT(*) FROM financial_integrity_scan() WHERE state NOT IN ('exception','incomplete','advisory'))::text, '0');
SELECT f21_assert_eq('S12c resolution is automatic/manual_data/manual_review',
  (SELECT COUNT(*) FROM financial_integrity_scan() WHERE resolution NOT IN ('automatic','manual_data','manual_review'))::text, '0');
-- (d) deterministic: two scans of unchanged data are identical
SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h1 FROM financial_integrity_scan() t \gset
SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h2 FROM financial_integrity_scan() t \gset
SELECT f21_assert_eq('S12d scan is deterministic', :'h2', :'h1');
-- (e) the scan changes no economic table
SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS e1 FROM (
  SELECT o::text AS x FROM orders o UNION ALL SELECT i::text FROM order_items i
  UNION ALL SELECT r::text FROM order_refunds r UNION ALL SELECT d::text FROM order_disputes d
  UNION ALL SELECT p::text FROM affiliate_payouts p UNION ALL SELECT c::text FROM inventory_layer_consumptions c) q \gset
SELECT COUNT(*) FROM financial_integrity_scan();
SELECT COUNT(*) FROM financial_integrity_entity_states();
SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS e2 FROM (
  SELECT o::text AS x FROM orders o UNION ALL SELECT i::text FROM order_items i
  UNION ALL SELECT r::text FROM order_refunds r UNION ALL SELECT d::text FROM order_disputes d
  UNION ALL SELECT p::text FROM affiliate_payouts p UNION ALL SELECT c::text FROM inventory_layer_consumptions c) q \gset
SELECT f21_assert_eq('S12e scanning rewrote nothing', :'e2', :'e1');
-- (f) the roll-up rule: any exception -> EXCEPTION, else any incomplete -> INCOMPLETE
SELECT f21_assert_eq('S12f an entity with an exception AND an incomplete is EXCEPTION',
  f21_entity_state('order', f21_oid(11)::text), 'EXCEPTION');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S13: append-only detection history ##########'
SELECT f21_expect_error($q$SELECT record_financial_integrity_run(NULL)$q$, 'KVRN_INTEGRITY|ACTOR_REQUIRED');
SELECT f21_expect_error($q$SELECT record_financial_integrity_run('   ')$q$, 'KVRN_INTEGRITY|ACTOR_REQUIRED');

SELECT (record_financial_integrity_run('f21','test')->>'new_count')::int AS n1 \gset
SELECT f21_assert_eq('S13 first run detects every finding as new',
  :'n1'::text, (SELECT COUNT(*) FROM financial_integrity_scan())::text);
SELECT f21_assert_eq('S13 first run: events == findings',
  (SELECT COUNT(*) FROM financial_integrity_events WHERE event_type='detected')::text,
  (SELECT COUNT(*) FROM financial_integrity_scan())::text);

-- unchanged data: nothing new, nothing changed, nothing resolved
SELECT record_financial_integrity_run('f21','test') AS r2 \gset
SELECT f21_assert_eq('S13 second run has no new', (:'r2'::jsonb)->>'new_count', '0');
SELECT f21_assert_eq('S13 second run has no changes', (:'r2'::jsonb)->>'changed_count', '0');
SELECT f21_assert_eq('S13 second run resolves nothing', (:'r2'::jsonb)->>'resolved_count', '0');
SELECT f21_assert_eq('S13 events did not grow on an unchanged run',
  (SELECT COUNT(*) FROM financial_integrity_events)::text,
  (SELECT COUNT(*) FROM financial_integrity_events WHERE event_type='detected')::text);

-- first-detected time is carried into the live findings
SELECT f21_assert_eq('S13 every current finding has a detected_at',
  (SELECT COUNT(*) FROM financial_integrity_findings() WHERE detected_at IS NULL)::text, '0');
SELECT detected_at AS d1 FROM financial_integrity_findings()
  WHERE issue_code='ORDER_ITEMS_SUBTOTAL_MISMATCH' AND entity_id = f21_oid(4)::text \gset

-- fix the data -> the next run records a resolution
UPDATE orders SET subtotal_cents = 1000, total_cents = 1500 WHERE id = f21_oid(4);
SELECT record_financial_integrity_run('f21','test') AS r3 \gset
SELECT f21_assert_eq('S13 a corrected issue is recorded as resolved',
  (((:'r3'::jsonb)->>'resolved_count')::int >= 1)::text, 'true');
SELECT f21_assert_eq('S13 the resolved fingerprint is not open any more',
  (SELECT COUNT(*) FROM financial_integrity_open_history()
    WHERE fingerprint = fi_fingerprint('ORDER_ITEMS_SUBTOTAL_MISMATCH','order',f21_oid(4)::text))::text, '0');

-- regress it -> detected again as a NEW episode with a NEW detected_at
SELECT pg_sleep(0.05);
UPDATE orders SET subtotal_cents = 1100, total_cents = 1600 WHERE id = f21_oid(4);
SELECT record_financial_integrity_run('f21','test') AS r4 \gset
SELECT f21_assert_eq('S13 a recurrence is detected again', (((:'r4'::jsonb)->>'new_count')::int >= 1)::text, 'true');
SELECT f21_assert_eq('S13 a recurrence is a later episode',
  (SELECT detected_at > :'d1'::timestamptz FROM financial_integrity_findings()
    WHERE issue_code='ORDER_ITEMS_SUBTOTAL_MISMATCH' AND entity_id = f21_oid(4)::text)::text, 'true');
UPDATE orders SET subtotal_cents = 1000, total_cents = 1500 WHERE id = f21_oid(4);

-- a class change is recorded as 'changed', not as a new issue
UPDATE orders SET stripe_fee_cents = NULL, stripe_fee_source = NULL, stripe_balance_transaction_id = NULL WHERE id = f21_oid(8);
SELECT record_financial_integrity_run('f21','test');
SELECT f21_assert_eq('S13 missing fee detected', (SELECT COUNT(*) FROM financial_integrity_events
  WHERE fingerprint = fi_fingerprint('ORDER_STRIPE_FEE_MISSING','order',f21_oid(8)::text) AND event_type='detected')::text, '1');

-- history can never be edited or erased
SELECT f21_expect_error($q$UPDATE financial_integrity_events SET state = 'advisory'$q$, 'KVRN_INTEGRITY|APPEND_ONLY');
SELECT f21_expect_error($q$DELETE FROM financial_integrity_events$q$, 'KVRN_INTEGRITY|APPEND_ONLY');
SELECT f21_expect_error($q$TRUNCATE financial_integrity_events$q$, 'KVRN_INTEGRITY|APPEND_ONLY');
SELECT f21_expect_error($q$UPDATE financial_integrity_runs SET actor = 'x'$q$, 'KVRN_INTEGRITY|APPEND_ONLY');
SELECT f21_expect_error($q$DELETE FROM financial_integrity_runs$q$, 'KVRN_INTEGRITY|APPEND_ONLY');
SELECT f21_expect_error($q$TRUNCATE financial_integrity_runs CASCADE$q$, 'KVRN_INTEGRITY|APPEND_ONLY');

-- running the recorder changes no economic row either
SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS e3 FROM (
  SELECT o::text AS x FROM orders o UNION ALL SELECT i::text FROM order_items i
  UNION ALL SELECT r::text FROM order_refunds r UNION ALL SELECT d::text FROM order_disputes d
  UNION ALL SELECT p::text FROM affiliate_payouts p UNION ALL SELECT c::text FROM inventory_layer_consumptions c) q \gset
SELECT record_financial_integrity_run('f21','test');
SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS e4 FROM (
  SELECT o::text AS x FROM orders o UNION ALL SELECT i::text FROM order_items i
  UNION ALL SELECT r::text FROM order_refunds r UNION ALL SELECT d::text FROM order_disputes d
  UNION ALL SELECT p::text FROM affiliate_payouts p UNION ALL SELECT c::text FROM inventory_layer_consumptions c) q \gset
SELECT f21_assert_eq('S13 recording history rewrote no economic row', :'e4', :'e3');

-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## S14: obsolete 7-arg save_reservation_checkout_details is gone ##########'
SELECT f21_assert_eq('S14 only one signature remains',
  (SELECT COUNT(*) FROM pg_proc WHERE proname='save_reservation_checkout_details')::text, '1');
SELECT f21_assert_eq('S14 the survivor is the 15-argument form the app calls',
  (SELECT pronargs FROM pg_proc WHERE proname='save_reservation_checkout_details')::text, '15');

-- ═══════════════════════════════════════════════════════════════════════════
-- REV1 SCENARIOS (independent-audit blockers)
-- ═══════════════════════════════════════════════════════════════════════════

\echo '########## S15 (B1): an unknown refund fee is INCOMPLETE and bounded ##########'
SELECT f21_mk(40);
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,component_breakdown_source,status,refunded_at)
VALUES (f21_oid(40),'re_40','ch_F21-040','pi_F21-040',500,500,0,0,'resolved','admin','succeeded',NOW());
SELECT id AS rid40 FROM order_refunds WHERE stripe_refund_id = 're_40' \gset
SELECT f21_expect_finding('REFUND_FEE_RETURN_UNKNOWN', :'rid40', 'incomplete');
SELECT f21_assert_eq('S15 the fee return was NOT invented as zero',
  (SELECT fee_refunded_cents IS NULL FROM order_refunds WHERE id = :'rid40'::uuid)::text, 'true');
SELECT f21_assert_eq('S15 the refund is INCOMPLETE', f21_entity_state('refund', :'rid40'), 'INCOMPLETE');
SELECT f21_assert_eq('S15 the period that paid the order cannot claim exactness',
  financial_integrity_period_state(NOW()-INTERVAL '3 days', NOW())->'orders'->>(f21_oid(40)::text), 'INCOMPLETE');
-- the only writer: write-once, bounded by the order's Stripe fee, attributable
SELECT f21_expect_error(format($q$SELECT record_refund_fee_returned(%L,-1,'f21')$q$, :'rid40'), 'KVRN_REFUND|INVALID_FEE');
SELECT f21_expect_error(format($q$SELECT record_refund_fee_returned(%L,10,' ')$q$, :'rid40'), 'KVRN_REFUND|ACTOR_REQUIRED');
SELECT f21_expect_error(format($q$SELECT record_refund_fee_returned(%L,101,'f21')$q$, :'rid40'), 'KVRN_REFUND|FEE_EXCEEDS_ORDER_FEE');
SELECT f21_assert_eq('S15 recorded', record_refund_fee_returned(:'rid40'::uuid,30,'f21')->>'outcome', 'recorded');
SELECT f21_expect_no_finding('REFUND_FEE_RETURN_UNKNOWN', :'rid40');
SELECT f21_assert_eq('S15 idempotent re-send', record_refund_fee_returned(:'rid40'::uuid,30,'f21')->>'outcome', 'already_recorded');
SELECT f21_expect_error(format($q$SELECT record_refund_fee_returned(%L,31,'f21')$q$, :'rid40'), 'KVRN_REFUND|FEE_ALREADY_RECORDED');
SELECT f21_assert_eq('S15 the write is audited',
  (SELECT COUNT(*) FROM admin_audit_logs WHERE action='record_refund_fee_returned' AND resource_id = :'rid40')::text, '1');
-- a cumulative return above the order's fee is a contradiction, not an absorbed number
INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,component_breakdown_status,component_breakdown_source,status,refunded_at)
VALUES (f21_oid(40),'re_40b','ch_F21-040','pi_F21-040',100,100,0,0,80,'resolved','admin','succeeded',NOW());
SELECT f21_expect_finding('REFUND_FEE_EXCEEDS_ORDER_FEE', f21_oid(40)::text, 'exception');

-- REV2: a recorded fee return is immutable at the DATABASE level, not only inside the writer
SELECT f21_expect_error(format($q$UPDATE order_refunds SET fee_refunded_cents = 31 WHERE id = %L$q$, :'rid40'), 'KVRN_REFUND|FEE_IMMUTABLE');
SELECT f21_expect_error(format($q$UPDATE order_refunds SET fee_refunded_cents = NULL WHERE id = %L$q$, :'rid40'), 'KVRN_REFUND|FEE_IMMUTABLE');
UPDATE order_refunds SET fee_refunded_cents = 30 WHERE id = :'rid40'::uuid;       -- same value: harmless no-op
UPDATE order_refunds SET reason = 'f21 metadata update', updated_at = now() WHERE id = :'rid40'::uuid;   -- unrelated update still works
SELECT f21_assert_eq('S15 the fee return is untouched',
  (SELECT fee_refunded_cents::text FROM order_refunds WHERE id = :'rid40'::uuid), '30');
SELECT f21_assert_eq('S15 unrelated refund update applied',
  (SELECT reason FROM order_refunds WHERE id = :'rid40'::uuid), 'f21 metadata update');

\echo '########## S16 (B2): shipping cost is exact only when it is an actual ##########'
SELECT f21_mk(41, p_label => 450, p_label_source => 'shippo_quote');
SELECT f21_expect_finding('ORDER_SHIPPING_COST_ESTIMATE_ONLY', f21_oid(41)::text, 'incomplete');
SELECT f21_assert_eq('S16 a quote is not a cost', (SELECT cost_cents IS NULL FROM fi_order_shipping(f21_oid(41)))::text, 'true');
UPDATE shipments SET cost_source = 'shippo_label' WHERE order_id = f21_oid(41);
SELECT f21_expect_no_finding('ORDER_SHIPPING_COST_ESTIMATE_ONLY', f21_oid(41)::text);
SELECT f21_assert_eq('S16 an actual label cost is exact', (SELECT cost_cents::text FROM fi_order_shipping(f21_oid(41))), '450');
SELECT f21_mk(42, p_label => NULL);
SELECT f21_assert_eq('S16 paid and unshipped is unknown, not zero', (SELECT cost_cents IS NULL FROM fi_order_shipping(f21_oid(42)))::text, 'true');
UPDATE orders SET fulfillment_status = 'cancelled' WHERE id = f21_oid(42);
SELECT f21_assert_eq('S16 cancelled with no label is a known zero', (SELECT cost_cents::text FROM fi_order_shipping(f21_oid(42))), '0');
-- a hand-entered cost without provenance stays known but disclosed
SELECT f21_mk(43, p_label => 450, p_label_source => NULL);
SELECT f21_expect_finding('ORDER_SHIPPING_COST_UNSOURCED', f21_oid(43)::text, 'advisory');
SELECT f21_assert_eq('S16 an unsourced cost remains known', (SELECT cost_cents::text FROM fi_order_shipping(f21_oid(43))), '450');

\echo '########## S17 (B5): payout lines cannot be re-parented into / out of a paid payout ##########'
SELECT f21_mk(44);
UPDATE orders SET discount_code = 'F21A', paid_at = NOW()-INTERVAL '90 days' WHERE id = f21_oid(44);
SELECT resolve_order_affiliate_attribution(f21_oid(44),NULL,'s');
SELECT id AS cid44 FROM affiliate_commissions WHERE order_id = f21_oid(44) \gset
SELECT refresh_affiliate_commission_state(:'cid44'::uuid);
SELECT create_affiliate_payout(:'aid'::uuid, ARRAY[:'cid44'::uuid],'admin')->>'payout_id' AS pid44 \gset
-- :pid is the PAID payout from S10, :pid44 is a DRAFT carrying a different commission
SELECT f21_expect_error(format($q$UPDATE affiliate_payout_lines SET payout_id = %L WHERE payout_id = %L$q$, :'pid', :'pid44'),
  'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_expect_error(format($q$UPDATE affiliate_payout_lines SET payout_id = %L WHERE payout_id = %L$q$, :'pid44', :'pid'),
  'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE');
SELECT f21_assert_eq('S17 the draft still owns its line',
  (SELECT COUNT(*) FROM affiliate_payout_lines WHERE payout_id = :'pid44'::uuid)::text, '1');
SELECT f21_assert_eq('S17 the paid payout is exactly as paid',
  (SELECT COUNT(*) FROM affiliate_payout_lines WHERE payout_id = :'pid'::uuid)::text, '1');

\echo '########## S18 (B6): expense / ad-spend money is voided, never hard-deleted ##########'
INSERT INTO expense_transactions (id,provider,category,name,amount_cents,paid_at,invoice_id)
VALUES ('f2170000-0000-0000-0000-000000000001','Vercel','infrastructure','Vercel',4000,'2026-03-12','INV-F21-V');
INSERT INTO ad_spend (id,platform,campaign_name,spend_cents,period_start,period_end)
VALUES ('f2170000-0000-0000-0000-000000000002','tiktok','F21 void',900,'2026-03-01','2026-03-31');
SELECT f21_expect_error($q$DELETE FROM expense_transactions WHERE id='f2170000-0000-0000-0000-000000000001'$q$, 'KVRN_MONEY|HARD_DELETE_BLOCKED');
SELECT f21_expect_error($q$DELETE FROM ad_spend WHERE id='f2170000-0000-0000-0000-000000000002'$q$, 'KVRN_MONEY|HARD_DELETE_BLOCKED');
SELECT f21_expect_error($q$TRUNCATE expense_transactions$q$, 'KVRN_MONEY|HARD_DELETE_BLOCKED');
SELECT f21_expect_error($q$TRUNCATE ad_spend$q$, 'KVRN_MONEY|HARD_DELETE_BLOCKED');
-- a live money fact cannot be rewritten in place either (void and re-enter)
SELECT f21_expect_error($q$UPDATE expense_transactions SET amount_cents = 1 WHERE id='f2170000-0000-0000-0000-000000000001'$q$, 'KVRN_MONEY|FACT_IMMUTABLE');
SELECT f21_expect_error($q$UPDATE ad_spend SET spend_cents = 1 WHERE id='f2170000-0000-0000-0000-000000000002'$q$, 'KVRN_MONEY|FACT_IMMUTABLE');
SELECT f21_expect_error($q$SELECT void_expense_transaction('f2170000-0000-0000-0000-000000000001','','x')$q$, 'KVRN_MONEY|ACTOR_REQUIRED');
SELECT f21_expect_error($q$SELECT void_expense_transaction('f2170000-0000-0000-0000-000000000001','admin','  ')$q$, 'KVRN_MONEY|REASON_REQUIRED');
SELECT f21_assert_eq('S18 void', void_expense_transaction('f2170000-0000-0000-0000-000000000001','alice','entered twice')->>'outcome', 'voided');
SELECT f21_assert_eq('S18 void ad', void_ad_spend('f2170000-0000-0000-0000-000000000002','alice','wrong campaign')->>'outcome', 'voided');
SELECT f21_assert_eq('S18 the row and its amount are retained',
  (SELECT amount_cents::text FROM expense_transactions WHERE id='f2170000-0000-0000-0000-000000000001'), '4000');
SELECT f21_assert_eq('S18 who/why recorded',
  (SELECT voided_by||'/'||void_reason FROM expense_transactions WHERE id='f2170000-0000-0000-0000-000000000001'), 'alice/entered twice');
-- idempotent and it never rewrites who/why/when
SELECT voided_at AS vt FROM expense_transactions WHERE id='f2170000-0000-0000-0000-000000000001' \gset
SELECT f21_assert_eq('S18 repeat void is a no-op',
  void_expense_transaction('f2170000-0000-0000-0000-000000000001','bob','other reason')->>'outcome', 'already_voided');
SELECT f21_assert_eq('S18 repeat void kept the original actor/reason/time',
  (SELECT (voided_by='alice' AND void_reason='entered twice' AND voided_at = :'vt'::timestamptz)::text FROM expense_transactions WHERE id='f2170000-0000-0000-0000-000000000001'), 'true');
-- a voided row is frozen: cannot be edited or un-voided
SELECT f21_expect_error($q$UPDATE expense_transactions SET amount_cents = 1 WHERE id='f2170000-0000-0000-0000-000000000001'$q$, 'KVRN_MONEY|VOIDED_ROW_IMMUTABLE');
SELECT f21_expect_error($q$UPDATE expense_transactions SET voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE id='f2170000-0000-0000-0000-000000000001'$q$, 'KVRN_MONEY|VOIDED_ROW_IMMUTABLE');
SELECT f21_expect_error($q$UPDATE ad_spend SET spend_cents = 1 WHERE id='f2170000-0000-0000-0000-000000000002'$q$, 'KVRN_MONEY|VOIDED_ROW_IMMUTABLE');
SELECT f21_assert_eq('S18 the void is audited with the amount snapshot',
  (SELECT payload->>'amount_cents' FROM admin_audit_logs WHERE action='void' AND resource_id='f2170000-0000-0000-0000-000000000001'), '4000');
-- a voided duplicate is not a live duplicate finding
INSERT INTO expense_transactions (id,provider,category,name,amount_cents,paid_at,invoice_id)
VALUES ('f2170000-0000-0000-0000-000000000003','Vercel','infrastructure','Vercel',4000,'2026-03-12','INV-F21-V');
SELECT f21_expect_no_finding('EXPENSE_DUPLICATE_INVOICE','f2170000-0000-0000-0000-000000000003');
SELECT f21_expect_no_finding('EXPENSE_DUPLICATE_INVOICE','f2170000-0000-0000-0000-000000000001');

\echo '########## S19: exchange replacement shipping cost is DB-level write-once ##########'
SELECT f21_mk(45);
INSERT INTO order_exchanges (id,order_id,exchange_number,status,shipped_at)
VALUES ('f2130000-0000-0000-0000-000000000045',f21_oid(45),'EX-F21-45','shipped',NOW());
SELECT record_exchange_replacement_shipping_cost('f2130000-0000-0000-0000-000000000045',650,'f21');
SELECT f21_expect_error($q$UPDATE order_exchanges SET replacement_shipping_cost_cents = 1 WHERE id='f2130000-0000-0000-0000-000000000045'$q$, 'KVRN_EXCHANGE|SHIPPING_COST_IMMUTABLE');
SELECT f21_expect_error($q$UPDATE order_exchanges SET replacement_shipping_cost_cents = NULL WHERE id='f2130000-0000-0000-0000-000000000045'$q$, 'KVRN_EXCHANGE|SHIPPING_COST_IMMUTABLE');
SELECT f21_assert_eq('S19 amount intact',
  (SELECT replacement_shipping_cost_cents::text FROM order_exchanges WHERE id='f2130000-0000-0000-0000-000000000045'), '650');
UPDATE order_exchanges SET status = 'completed' WHERE id='f2130000-0000-0000-0000-000000000045';
SELECT f21_assert_eq('S19 unrelated updates still work',
  (SELECT status FROM order_exchanges WHERE id='f2130000-0000-0000-0000-000000000045'), 'completed');
-- re-asserting the SAME value is not a change and is allowed
UPDATE order_exchanges SET replacement_shipping_cost_cents = 650 WHERE id='f2130000-0000-0000-0000-000000000045';

\echo '########## S20 (B4): findings RELEVANT to a period decide whether it can be "exact" ##########'
-- Four orders in an isolated historic window; only the window's own findings may count.
CREATE OR REPLACE FUNCTION f21_pstate(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql STABLE AS $f$ SELECT financial_integrity_period_state(p_from, p_to)->>'state' $f$;
-- S11 left a deliberately UNDATED expense: by design it is relevant to EVERY period (its period is
-- unknown). Date it so this scenario isolates the windows.
SELECT f21_assert_eq('S20 an undated expense makes EVERY window INCOMPLETE (period unknown)',
  f21_pstate('2025-01-01+00','2025-02-01+00'), 'INCOMPLETE');
UPDATE expense_transactions SET paid_at = '2024-06-01' WHERE paid_at IS NULL AND period_start IS NULL;
SELECT f21_mk(46); SELECT f21_mk(47);
UPDATE orders SET paid_at = '2025-01-10 12:00+00' WHERE id = f21_oid(46);
UPDATE orders SET paid_at = '2025-03-10 12:00+00' WHERE id = f21_oid(47);
SELECT f21_assert_eq('S20 clean window -> RECONCILED', f21_pstate('2025-01-01+00','2025-02-01+00'), 'RECONCILED');
-- a contradiction in ANOTHER window does not touch this one
UPDATE orders SET total_cents = 1599 WHERE id = f21_oid(47);
SELECT f21_assert_eq('S20 an unrelated exception does not poison a clean window', f21_pstate('2025-01-01+00','2025-02-01+00'), 'RECONCILED');
SELECT f21_assert_eq('S20 ...but the window that owns it is EXCEPTION', f21_pstate('2025-03-01+00','2025-04-01+00'), 'EXCEPTION');
SELECT f21_assert_eq('S20 a window spanning both is EXCEPTION', f21_pstate('2025-01-01+00','2025-04-01+00'), 'EXCEPTION');
UPDATE orders SET total_cents = 1500 WHERE id = f21_oid(47);
SELECT f21_assert_eq('S20 correcting the data restores RECONCILED', f21_pstate('2025-03-01+00','2025-04-01+00'), 'RECONCILED');
-- a missing required fact is INCOMPLETE (Unknown), not EXCEPTION
UPDATE orders SET stripe_fee_cents = NULL, stripe_fee_source = NULL, stripe_balance_transaction_id = NULL WHERE id = f21_oid(46);
SELECT f21_assert_eq('S20 a missing fee -> INCOMPLETE', f21_pstate('2025-01-01+00','2025-02-01+00'), 'INCOMPLETE');
SELECT f21_assert_eq('S20 per-order state is reported',
  financial_integrity_period_state('2025-01-01+00','2025-02-01+00')->'orders'->>(f21_oid(46)::text), 'INCOMPLETE');
SELECT f21_assert_eq('S20 INCOMPLETE reports a count and the codes behind it',
  ((financial_integrity_period_state('2025-01-01+00','2025-02-01+00')->>'incomplete_count')::int > 0)::text, 'true');
UPDATE orders SET stripe_fee_cents = 100, stripe_fee_source = 'stripe_api', stripe_balance_transaction_id = 'txn_F21-046' WHERE id = f21_oid(46);
SELECT f21_assert_eq('S20 supplying the fee restores RECONCILED', f21_pstate('2025-01-01+00','2025-02-01+00'), 'RECONCILED');
-- duplicate expense in the window poisons only windows that recognise it; a void clears it
INSERT INTO expense_transactions (id,provider,category,name,amount_cents,paid_at,invoice_id) VALUES
  ('f2170000-0000-0000-0000-000000000011','Neon','infrastructure','Neon',700,'2025-01-15','INV-F21-N'),
  ('f2170000-0000-0000-0000-000000000012','Neon','infrastructure','Neon',700,'2025-01-15','INV-F21-N');
SELECT f21_assert_eq('S20 duplicate expense in the window -> EXCEPTION', f21_pstate('2025-01-01+00','2025-02-01+00'), 'EXCEPTION');
SELECT f21_assert_eq('S20 the same duplicate does not poison another window', f21_pstate('2025-03-01+00','2025-04-01+00'), 'RECONCILED');
SELECT void_expense_transaction('f2170000-0000-0000-0000-000000000012','admin','duplicate');
SELECT f21_assert_eq('S20 voiding the duplicate restores the window', f21_pstate('2025-01-01+00','2025-02-01+00'), 'RECONCILED');

\echo '########## S21: the scan is still deterministic and side-effect free after REV1 ##########'
SELECT f21_assert_eq('S21 fingerprints remain unique',
  (SELECT COUNT(*) - COUNT(DISTINCT fi_fingerprint(issue_code, entity_type, entity_id)) FROM financial_integrity_scan())::text, '0');
SELECT f21_assert_eq('S21 classes remain exactly exception/incomplete/advisory',
  (SELECT COUNT(*) FROM financial_integrity_scan() WHERE state NOT IN ('exception','incomplete','advisory'))::text, '0');

\echo '########## F21: ALL SCENARIOS PASSED ##########'
