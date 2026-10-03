-- KVRN Migration 021 — Financial integrity & reconciliation layer
--
-- Forward-only. Idempotent: every statement is CREATE OR REPLACE / IF NOT EXISTS /
-- DROP ... IF EXISTS, so re-running it any number of times is safe.
-- Migrations 001–020 are not edited. 018, 019 and 020 stay byte-identical.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--
--   1. A DERIVED, deterministic reconciliation scan, financial_integrity_scan().
--      It re-checks every money path from the authoritative rows each time it is
--      called. There is NO hand-maintained "is reconciled" flag anywhere: a
--      finding exists exactly while the underlying data violates (or cannot
--      establish) an invariant, and disappears the moment the data is corrected.
--
--   2. Three outcomes per entity, never a boolean:
--        RECONCILED  every required fact is known and consistent
--        INCOMPLETE  a required fact is unknown / not yet resolved
--                    (unknown is NEVER coerced to zero)
--        EXCEPTION   data exists but contradicts an invariant, another
--                    authoritative source, or duplicates an economic event
--      Findings also carry an 'advisory' class: a disclosed assumption or a
--      review signal that deliberately does NOT change an entity's state.
--
--   3. An APPEND-ONLY detection history (financial_integrity_runs / _events) so
--      the Admin can see when an issue was first detected and when it resolved.
--      Rows are never updated or deleted (enforced by trigger). The history never
--      replaces the derived scan; it only records what a scan observed.
--
--   4. A forward-only guard that makes PAID affiliate payout history immutable.
--
--   5. record_exchange_replacement_shipping_cost(): the only path that can fill a
--      replacement-shipment cost, which previously had no writer at all.
--
--   6. Removal of the obsolete 7-argument save_reservation_checkout_details().
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
--
--   * It never UPDATEs, DELETEs or "fixes" an economic fact. Historical COGS
--     snapshots, refunds, dispute ledgers, FIFO consumptions and affiliate
--     ledgers are read, never rewritten.
--   * It does not infer missing values. A missing fee, cost or decomposition
--     becomes an INCOMPLETE finding, not a guess.
--
-- Run after 001-020.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. Obsolete overload cleanup
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 003 created a 7-argument save_reservation_checkout_details(). 009 and
-- 017 each created a longer one with DEFAULT parameters, and 017 explicitly
-- dropped only the 13-argument predecessor. The 7-argument original therefore
-- survives in every database built from migrations 001–020, next to the 15-argument
-- function the application actually calls.
--
-- It is not merely dead code. It writes ONLY reservations.shipping_cents and leaves
-- shipping_before_discount / shipping_discount / shipping_final / shipping_quoted
-- untouched, so a reservation saved through it would produce an order whose shipping
-- snapshot columns cannot reconcile. Production already had it dropped by hand.
--
-- The application calls the 15-argument form with all 15 arguments (lib/
-- reservations.ts), so no caller can be affected. IF EXISTS keeps this a no-op
-- where it is already gone.
DROP FUNCTION IF EXISTS save_reservation_checkout_details(
  UUID, TEXT, TEXT, TEXT, JSONB, TEXT, INTEGER
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Finding shape
-- ═══════════════════════════════════════════════════════════════════════════
--
--   issue_code   stable, machine-readable, never reused for a different meaning
--   state        'exception' | 'incomplete' | 'advisory'
--   domain       order | refund | dispute | return | exchange | inventory |
--                shipping | affiliate | expense
--   entity_type  the thing that carries the state (see financial_integrity_entities)
--   entity_id    its primary key, as text
--   entity_label human-readable handle (order number, SKU, payout number ...)
--   order_id     convenience link when the issue belongs to an order
--   summary      human-readable explanation
--   evidence     the underlying values, so a reviewer can verify independently
--   resolution   'automatic'     the system can resolve it without new data
--                'manual_data'   an operator must supply a missing value
--                'manual_review' data conflicts; someone must investigate
--   action_path  existing Admin page where it is handled
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'financial_integrity_finding') THEN
    CREATE TYPE financial_integrity_finding AS (
      issue_code   TEXT,
      state        TEXT,
      domain       TEXT,
      entity_type  TEXT,
      entity_id    TEXT,
      entity_label TEXT,
      order_id     UUID,
      summary      TEXT,
      evidence     JSONB,
      resolution   TEXT,
      action_path  TEXT
    );
  END IF;
END $$;

-- Constructor so every scan branch is one readable line.
CREATE OR REPLACE FUNCTION fi_f(
  p_code TEXT, p_state TEXT, p_domain TEXT,
  p_entity_type TEXT, p_entity_id TEXT, p_entity_label TEXT, p_order_id UUID,
  p_summary TEXT, p_evidence JSONB, p_resolution TEXT, p_action_path TEXT
) RETURNS financial_integrity_finding
LANGUAGE sql IMMUTABLE AS $$
  SELECT ROW(p_code, p_state, p_domain, p_entity_type, p_entity_id, p_entity_label,
             p_order_id, p_summary, COALESCE(p_evidence, '{}'::jsonb),
             p_resolution, p_action_path)::financial_integrity_finding;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1b. Canonical merchant shipping cost of an order
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ONE definition, used by BOTH the integrity scan and the P&L select
-- (lib/financials.ts financialSelect), so the figure shown and the figure audited
-- can never disagree.
--
-- RELEVANT shipments are the order's OUTBOUND shipments: rows referenced as an
-- exchange replacement shipment or a return label are excluded, because their cost
-- is carried by order_exchanges.replacement_shipping_cost_cents /
-- order_returns.return_label_cost_cents and counting them here would double it.
-- (shipments currently has UNIQUE(order_id) from migration 005, so today there is at
-- most one row; the rules below are written for N so a future relaxation stays right.)
--
--   cost_cents is NULL (unknown) when
--     * there is no shipment yet and the order is not cancelled   (a future expense
--       is not invented as 0), or
--     * ANY relevant shipment has label_cost_cents NULL, or
--     * ANY relevant shipment is cost_source = 'shippo_quote' (a checkout ESTIMATE,
--       never what the carrier was actually paid)
--   cost_cents is 0 when there is no shipment and the order's fulfillment_status is
--     'cancelled' (no label was bought).
--   otherwise cost_cents is the exact SUM of every relevant shipment's actual cost.
--
-- A numeric cost with NO provenance (cost_source NULL) stays KNOWN and is reported by
-- the ORDER_SHIPPING_COST_UNSOURCED advisory: no code path writes one (014 added both
-- columns together) so it can only be hand-entered SQL, and the project already treats
-- hand-entered figures as known-but-disclosed (compare ORDER_STRIPE_FEE_MANUAL).
CREATE OR REPLACE FUNCTION fi_order_shipping(p_order_id UUID)
RETURNS TABLE (shipment_count INTEGER, missing_count INTEGER, estimate_count INTEGER,
               unsourced_count INTEGER, cost_cents INTEGER)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT sh.label_cost_cents AS c, sh.cost_source AS src
    FROM shipments sh
    WHERE sh.order_id = p_order_id
      AND NOT EXISTS (SELECT 1 FROM order_returns r   WHERE r.return_label_shipment_id = sh.id)
      AND NOT EXISTS (SELECT 1 FROM order_exchanges e WHERE e.replacement_shipment_id  = sh.id)
  ), a AS (
    SELECT COUNT(*)::int                                                   AS n,
           COUNT(*) FILTER (WHERE c IS NULL)::int                          AS miss,
           COUNT(*) FILTER (WHERE c IS NOT NULL AND src = 'shippo_quote')::int AS est,
           COUNT(*) FILTER (WHERE c IS NOT NULL AND src IS NULL)::int      AS uns,
           SUM(c)::int                                                     AS tot
    FROM s
  )
  SELECT a.n, a.miss, a.est, a.uns,
         CASE WHEN a.n = 0
                   THEN CASE WHEN (SELECT o.fulfillment_status FROM orders o WHERE o.id = p_order_id) = 'cancelled'
                             THEN 0 ELSE NULL END
              WHEN a.miss > 0 OR a.est > 0 THEN NULL
              ELSE a.tot END
  FROM a;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ORDER / PAYMENT / COGS / SHIPPING-COST / FEE invariants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Scope: orders with paid_at IS NOT NULL. Abandoned reservations and unpaid
-- sessions are not financial facts.
--
-- A note on sales tax. orders.tax_cents exists but the checkout never collects tax
-- (finalize_paid_order does not set it and Stripe automatic tax is not enabled), so
-- it is a constant 0 today. The total identity below still carries it, so the day
-- tax IS collected it is treated as a pass-through liability and never as revenue.
CREATE OR REPLACE FUNCTION fi_scan_orders()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
WITH
-- When did FIFO costing begin? Orders paid on/after this instant must carry sale
-- consumption rows. Earlier orders keep their immutable date-effective snapshot.
cutover AS (
  SELECT COALESCE(
    (SELECT MIN(opening_cutover_at) FROM inventory_cost_layers WHERE is_migration_opening),
    (SELECT MIN(created_at) FROM inventory_layer_consumptions WHERE consumption_type = 'sale')
  ) AS at
),
o AS (
  SELECT ord.*,
    (SELECT COALESCE(SUM(oi.line_total_cents),0) FROM order_items oi WHERE oi.order_id = ord.id)      AS items_total,
    (SELECT COUNT(*)                              FROM order_items oi WHERE oi.order_id = ord.id)      AS item_count,
    (SELECT COUNT(*) FROM order_items oi
       WHERE oi.order_id = ord.id AND oi.line_total_cents <> oi.unit_price_cents * oi.quantity)       AS bad_line_totals,
    (SELECT COUNT(*) FROM order_items oi
       WHERE oi.order_id = ord.id AND oi.line_cogs_cents IS NULL)                                      AS lines_cogs_unknown,
    (SELECT COUNT(*) FROM order_items oi
       WHERE oi.order_id = ord.id
         AND ((oi.unit_cogs_cents IS NULL) <> (oi.line_cogs_cents IS NULL)
              OR (oi.line_cogs_cents IS NOT NULL
                  AND ABS(oi.line_cogs_cents - oi.unit_cogs_cents * oi.quantity) > oi.quantity)))     AS lines_cogs_inconsistent,
    (SELECT COUNT(*) FROM inventory_layer_consumptions c
       WHERE c.order_id = ord.id AND c.consumption_type = 'sale')                                      AS sale_consumptions,
    (SELECT COALESCE(SUM(r.amount_cents),0) FROM order_refunds r
       WHERE r.order_id = ord.id AND r.status = 'succeeded')                                           AS refunds_total,
    (SELECT COALESCE(SUM(e.price_difference_cents),0) FROM order_exchanges e
       WHERE e.order_id = ord.id AND e.price_difference_status = 'succeeded'
         AND e.price_difference_cents > 0)                                                             AS exchange_paid_extra,
    (SELECT COUNT(*) > 0 FROM order_exchanges e
       WHERE e.order_id = ord.id AND e.price_difference_payment_intent_id IS NOT NULL)                 AS has_exchange_payment,
    sh.shipment_count AS ship_n, sh.missing_count AS ship_missing, sh.estimate_count AS ship_est,
    sh.unsourced_count AS ship_uns, sh.cost_cents AS ship_cost
  FROM orders ord
  LEFT JOIN LATERAL fi_order_shipping(ord.id) sh ON TRUE
  WHERE ord.paid_at IS NOT NULL
)
-- ── payment identity ───────────────────────────────────────────────────────
SELECT fi_f('ORDER_PAYMENT_ID_MISSING','incomplete','order','order',o.id::text,o.order_number,o.id,
  'Paid order has no Stripe payment intent, so refunds and disputes cannot be tied to it.',
  jsonb_build_object('stripe_payment_intent_id', o.stripe_payment_intent_id,
                     'stripe_checkout_session_id', o.stripe_checkout_session_id),
  'manual_data','/admin/orders')
FROM o WHERE o.stripe_payment_intent_id IS NULL

UNION ALL
SELECT fi_f('ORDER_PAYMENT_STATUS_CONTRADICTS_PAID','exception','order','order',o.id::text,o.order_number,o.id,
  'Order carries paid_at but its payment_status says it was never captured.',
  jsonb_build_object('paid_at', o.paid_at, 'payment_status', o.payment_status),
  'manual_review','/admin/orders')
FROM o WHERE o.payment_status IN ('pending','failed')

UNION ALL
SELECT fi_f('ORDER_CHARGE_ID_CONFLICT','exception','order','order',o.id::text,o.order_number,o.id,
  'A refund or dispute on this order references a different Stripe charge than the order captured.',
  jsonb_build_object('order_charge_id', o.stripe_charge_id,
    'conflicting_refund_charges', (SELECT COALESCE(jsonb_agg(DISTINCT r.stripe_charge_id),'[]'::jsonb)
        FROM order_refunds r WHERE r.order_id = o.id AND r.stripe_charge_id IS NOT NULL
          AND r.stripe_charge_id <> o.stripe_charge_id),
    'conflicting_dispute_charges', (SELECT COALESCE(jsonb_agg(DISTINCT d.stripe_charge_id),'[]'::jsonb)
        FROM order_disputes d WHERE d.order_id = o.id AND d.stripe_charge_id IS NOT NULL
          AND d.stripe_charge_id <> o.stripe_charge_id)),
  'manual_review','/admin/orders')
FROM o
WHERE o.stripe_charge_id IS NOT NULL AND NOT o.has_exchange_payment
  AND (EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = o.id
                 AND r.stripe_charge_id IS NOT NULL AND r.stripe_charge_id <> o.stripe_charge_id)
    OR EXISTS (SELECT 1 FROM order_disputes d WHERE d.order_id = o.id
                 AND d.stripe_charge_id IS NOT NULL AND d.stripe_charge_id <> o.stripe_charge_id))

-- ── amounts ────────────────────────────────────────────────────────────────
UNION ALL
SELECT fi_f('ORDER_AMOUNT_OUT_OF_BOUNDS','exception','order','order',o.id::text,o.order_number,o.id,
  'An order amount is negative, or the merchandise discount exceeds the merchandise subtotal.',
  jsonb_build_object('subtotal_cents',o.subtotal_cents,'discount_cents',o.discount_cents,
    'shipping_cents',o.shipping_cents,'tax_cents',o.tax_cents,'total_cents',o.total_cents),
  'manual_review','/admin/orders')
FROM o
WHERE o.subtotal_cents < 0 OR o.discount_cents < 0 OR o.shipping_cents < 0
   OR o.tax_cents < 0 OR o.total_cents < 0 OR o.discount_cents > o.subtotal_cents

UNION ALL
SELECT fi_f('ORDER_TOTAL_MISMATCH','exception','order','order',o.id::text,o.order_number,o.id,
  'Order total does not equal (subtotal - discount) + shipping + tax under the canonical formula.',
  jsonb_build_object('total_cents',o.total_cents,
    'expected_cents', GREATEST(0,o.subtotal_cents-o.discount_cents)+o.shipping_cents+o.tax_cents,
    'subtotal_cents',o.subtotal_cents,'discount_cents',o.discount_cents,
    'shipping_cents',o.shipping_cents,'tax_cents',o.tax_cents,
    'difference_cents', o.total_cents-(GREATEST(0,o.subtotal_cents-o.discount_cents)+o.shipping_cents+o.tax_cents)),
  'manual_review','/admin/orders')
FROM o
WHERE o.total_cents <> GREATEST(0,o.subtotal_cents-o.discount_cents)+o.shipping_cents+o.tax_cents

UNION ALL
SELECT fi_f('ORDER_ITEMS_SUBTOTAL_MISMATCH','exception','order','order',o.id::text,o.order_number,o.id,
  'Order merchandise subtotal does not equal the sum of its line totals (or a line total is not unit price x quantity).',
  jsonb_build_object('subtotal_cents',o.subtotal_cents,'items_total_cents',o.items_total,
    'item_count',o.item_count,'lines_with_bad_total',o.bad_line_totals),
  'manual_review','/admin/orders')
FROM o
WHERE o.item_count = 0 OR o.items_total <> o.subtotal_cents OR o.bad_line_totals > 0

UNION ALL
SELECT fi_f('ORDER_SHIPPING_SNAPSHOT_MISMATCH','exception','shipping','order',o.id::text,o.order_number,o.id,
  'Customer shipping revenue does not follow from the quoted rate, the automatic free-shipping waiver and the promo reduction.',
  jsonb_build_object('shipping_quoted_cents',o.shipping_quoted_cents,
    'shipping_auto_free_discount_cents',o.shipping_auto_free_discount_cents,
    'shipping_before_discount_cents',o.shipping_before_discount_cents,
    'shipping_discount_cents',o.shipping_discount_cents,
    'shipping_cents',o.shipping_cents),
  'manual_review','/admin/orders')
FROM o
WHERE (o.shipping_before_discount_cents > 0 OR o.shipping_discount_cents > 0
       OR o.shipping_quoted_cents IS NOT NULL)
  AND ( (o.shipping_quoted_cents IS NOT NULL
         AND o.shipping_before_discount_cents <> o.shipping_quoted_cents - o.shipping_auto_free_discount_cents)
     OR o.shipping_cents <> GREATEST(0, o.shipping_before_discount_cents - o.shipping_discount_cents))

-- ── Stripe fee: recognised once, from an authoritative source ─────────────
UNION ALL
SELECT fi_f('ORDER_STRIPE_FEE_MISSING','incomplete','order','order',o.id::text,o.order_number,o.id,
  'Stripe processing fee has not been reconciled, so order profit cannot be stated. It is not treated as zero.',
  jsonb_build_object('stripe_fee_attempts',o.stripe_fee_attempts,'stripe_fee_last_error',o.stripe_fee_last_error,
                     'has_payment_intent', o.stripe_payment_intent_id IS NOT NULL),
  CASE WHEN o.stripe_payment_intent_id IS NULL THEN 'manual_data' ELSE 'automatic' END,
  '/admin/financials')
FROM o WHERE o.stripe_fee_cents IS NULL

UNION ALL
SELECT fi_f('ORDER_STRIPE_FEE_UNVERIFIED','incomplete','order','order',o.id::text,o.order_number,o.id,
  'A Stripe fee is recorded without any provenance (source unknown), so it cannot be re-derived.',
  jsonb_build_object('stripe_fee_cents',o.stripe_fee_cents,'stripe_fee_source',o.stripe_fee_source),
  'manual_review','/admin/financials')
FROM o WHERE o.stripe_fee_cents IS NOT NULL AND o.stripe_fee_source IS NULL

UNION ALL
SELECT fi_f('ORDER_STRIPE_FEE_NOT_REDERIVABLE','incomplete','order','order',o.id::text,o.order_number,o.id,
  'Fee is marked as coming from the Stripe API but no balance transaction id was kept to re-derive it.',
  jsonb_build_object('stripe_fee_cents',o.stripe_fee_cents,'stripe_balance_transaction_id',o.stripe_balance_transaction_id),
  'manual_review','/admin/financials')
FROM o WHERE o.stripe_fee_source = 'stripe_api' AND o.stripe_balance_transaction_id IS NULL

UNION ALL
SELECT fi_f('ORDER_STRIPE_FEE_MANUAL','advisory','order','order',o.id::text,o.order_number,o.id,
  'Stripe fee was entered manually rather than read from Stripe. It is counted, but it is not machine-verified.',
  jsonb_build_object('stripe_fee_cents',o.stripe_fee_cents,'stripe_fee_source',o.stripe_fee_source),
  'manual_review','/admin/financials')
FROM o WHERE o.stripe_fee_source = 'manual'

UNION ALL
SELECT fi_f('ORDER_STRIPE_FEE_DUPLICATED','exception','order','order',o.id::text,o.order_number,o.id,
  'The same Stripe balance transaction supplied the fee for more than one order, so that fee is counted more than once.',
  jsonb_build_object('stripe_balance_transaction_id',o.stripe_balance_transaction_id,
    'orders_sharing_it',(SELECT jsonb_agg(x.order_number ORDER BY x.order_number) FROM orders x
                         WHERE x.stripe_balance_transaction_id = o.stripe_balance_transaction_id)),
  'manual_review','/admin/financials')
FROM o
WHERE o.stripe_balance_transaction_id IS NOT NULL
  AND (SELECT COUNT(*) FROM orders x WHERE x.stripe_balance_transaction_id = o.stripe_balance_transaction_id) > 1

UNION ALL
SELECT fi_f('ORDER_STRIPE_FEE_OUT_OF_BOUNDS','exception','order','order',o.id::text,o.order_number,o.id,
  'Recorded Stripe fee is larger than the amount charged.',
  jsonb_build_object('stripe_fee_cents',o.stripe_fee_cents,'total_cents',o.total_cents),
  'manual_review','/admin/financials')
FROM o WHERE o.stripe_fee_cents IS NOT NULL AND o.stripe_fee_cents > o.total_cents

-- ── COGS: snapshot present, immutable, and consistent with FIFO ───────────
UNION ALL
SELECT fi_f('ORDER_COGS_UNKNOWN','incomplete','order','order',o.id::text,o.order_number,o.id,
  'At least one order line has no COGS snapshot, so product cost and profit are unknown. It is not treated as zero.',
  jsonb_build_object('lines_without_cogs',o.lines_cogs_unknown,'line_count',o.item_count),
  'manual_data','/admin/financials/costs')
FROM o WHERE o.lines_cogs_unknown > 0

UNION ALL
SELECT fi_f('ORDER_COGS_FIELDS_INCONSISTENT','exception','order','order',o.id::text,o.order_number,o.id,
  'An order line''s unit and line COGS disagree (one is unknown, or line COGS is not unit COGS x quantity).',
  jsonb_build_object('lines_inconsistent',o.lines_cogs_inconsistent),
  'manual_review','/admin/financials/costs')
FROM o WHERE o.lines_cogs_inconsistent > 0

UNION ALL
SELECT fi_f('ORDER_FIFO_CONSUMPTION_MISSING','exception','inventory','order',o.id::text,o.order_number,o.id,
  'Order was paid after FIFO costing began but has no sale consumption rows, so its cost is not backed by inventory layers.',
  jsonb_build_object('paid_at',o.paid_at,'fifo_cutover_at',(SELECT at FROM cutover)),
  'manual_review','/admin/financials/inventory')
FROM o
WHERE o.sale_consumptions = 0 AND (SELECT at FROM cutover) IS NOT NULL
  AND o.paid_at >= (SELECT at FROM cutover)

UNION ALL
SELECT fi_f('ORDER_FIFO_QUANTITY_MISMATCH','exception','inventory','order',o.id::text,o.order_number,o.id,
  'FIFO consumption quantity does not equal the finalized sale quantity for an order line.',
  jsonb_build_object('lines', (SELECT jsonb_agg(jsonb_build_object('sku',oi.sku,'ordered',oi.quantity,
        'consumed',COALESCE((SELECT SUM(c.quantity) FROM inventory_layer_consumptions c
                             WHERE c.order_item_id = oi.id AND c.consumption_type='sale'),0)))
      FROM order_items oi WHERE oi.order_id = o.id
        AND oi.quantity <> COALESCE((SELECT SUM(c.quantity) FROM inventory_layer_consumptions c
                             WHERE c.order_item_id = oi.id AND c.consumption_type='sale'),0))),
  'manual_review','/admin/financials/inventory')
FROM o
WHERE o.sale_consumptions > 0
  AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id
              AND oi.quantity <> COALESCE((SELECT SUM(c.quantity) FROM inventory_layer_consumptions c
                             WHERE c.order_item_id = oi.id AND c.consumption_type='sale'),0))

UNION ALL
SELECT fi_f('ORDER_FIFO_COST_MISMATCH','exception','inventory','order',o.id::text,o.order_number,o.id,
  'An order line''s COGS does not equal what its FIFO consumptions cost (or a cost was invented where a layer had none).',
  jsonb_build_object('lines', (SELECT jsonb_agg(jsonb_build_object('sku',oi.sku,'line_cogs_cents',oi.line_cogs_cents,
        'fifo_cost_cents',(SELECT SUM(c.total_cost_cents) FROM inventory_layer_consumptions c
                           WHERE c.order_item_id = oi.id AND c.consumption_type='sale'),
        'any_unknown_or_uncovered',EXISTS (SELECT 1 FROM inventory_layer_consumptions c
                           WHERE c.order_item_id = oi.id AND c.consumption_type='sale'
                             AND (c.coverage='uncovered' OR c.total_cost_cents IS NULL))))
      FROM order_items oi
      WHERE oi.order_id = o.id AND EXISTS (SELECT 1 FROM inventory_layer_consumptions c
                                           WHERE c.order_item_id = oi.id AND c.consumption_type='sale')
        AND (CASE WHEN EXISTS (SELECT 1 FROM inventory_layer_consumptions c
                               WHERE c.order_item_id = oi.id AND c.consumption_type='sale'
                                 AND (c.coverage='uncovered' OR c.total_cost_cents IS NULL))
                  THEN oi.line_cogs_cents IS NOT NULL
                  ELSE oi.line_cogs_cents IS DISTINCT FROM
                       (SELECT SUM(c.total_cost_cents) FROM inventory_layer_consumptions c
                        WHERE c.order_item_id = oi.id AND c.consumption_type='sale') END))),
  'manual_review','/admin/financials/inventory')
FROM o
WHERE o.sale_consumptions > 0
  AND EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.order_id = o.id AND EXISTS (SELECT 1 FROM inventory_layer_consumptions c
                                         WHERE c.order_item_id = oi.id AND c.consumption_type='sale')
      AND (CASE WHEN EXISTS (SELECT 1 FROM inventory_layer_consumptions c
                             WHERE c.order_item_id = oi.id AND c.consumption_type='sale'
                               AND (c.coverage='uncovered' OR c.total_cost_cents IS NULL))
                THEN oi.line_cogs_cents IS NOT NULL
                ELSE oi.line_cogs_cents IS DISTINCT FROM
                     (SELECT SUM(c.total_cost_cents) FROM inventory_layer_consumptions c
                      WHERE c.order_item_id = oi.id AND c.consumption_type='sale') END))

-- ── merchant shipping cost: never silently assumed zero, estimates never "actual" ──
-- Evaluated over EVERY relevant shipment of the order (fi_order_shipping), not the
-- first row: a later missing or quote-only shipment must not hide behind a clean one.
UNION ALL
SELECT fi_f('ORDER_SHIPPING_COST_MISSING','incomplete','shipping','order',o.id::text,o.order_number,o.id,
  'Merchant carrier cost is not recorded for this order (no shipment yet, or a shipment without a cost), so order profit cannot be stated. It is not treated as zero.',
  jsonb_build_object('shipments',o.ship_n,'shipments_without_cost',o.ship_missing,
                     'fulfillment_status',o.fulfillment_status,
                     'customer_shipping_revenue_cents',o.shipping_cents),
  'manual_data','/admin/financials/shipping')
FROM o
WHERE o.ship_cost IS NULL AND (o.ship_missing > 0 OR o.ship_n = 0)

UNION ALL
SELECT fi_f('ORDER_SHIPPING_COST_ESTIMATE_ONLY','incomplete','shipping','order',o.id::text,o.order_number,o.id,
  'A recorded shipping cost is only a checkout rate quote, not the amount actually paid to the carrier, so it is excluded from exact profit.',
  jsonb_build_object('shipments',o.ship_n,'quote_only_shipments',o.ship_est),
  'manual_data','/admin/financials/shipping')
FROM o WHERE o.ship_est > 0

UNION ALL
SELECT fi_f('ORDER_SHIPPING_COST_UNSOURCED','advisory','shipping','order',o.id::text,o.order_number,o.id,
  'A shipping cost is recorded without a provenance (shippo_label / manual); it is treated as known.',
  jsonb_build_object('shipments',o.ship_n,'unsourced_shipments',o.ship_uns,'label_cost_cents',o.ship_cost),
  'manual_review','/admin/financials/shipping')
FROM o WHERE o.ship_uns > 0

-- ── refund totals against the captured payment ────────────────────────────
UNION ALL
SELECT fi_f('ORDER_REFUNDS_EXCEED_PAID','exception','refund','order',o.id::text,o.order_number,o.id,
  'Succeeded refunds on this order add up to more than the customer paid.',
  jsonb_build_object('refunds_total_cents',o.refunds_total,'order_total_cents',o.total_cents,
                     'exchange_paid_extra_cents',o.exchange_paid_extra,
                     'excess_cents',o.refunds_total-(o.total_cents+o.exchange_paid_extra)),
  'manual_review','/admin/financials/returns')
FROM o WHERE o.refunds_total > o.total_cents + o.exchange_paid_extra

UNION ALL
SELECT fi_f('ORDER_REFUND_STATUS_MISMATCH','exception','refund','order',o.id::text,o.order_number,o.id,
  'Order payment_status disagrees with the refunds on record (refunded without full refunds, or fully refunded but not marked).',
  jsonb_build_object('payment_status',o.payment_status,'refunds_total_cents',o.refunds_total,
                     'order_total_cents',o.total_cents),
  'manual_review','/admin/orders')
FROM o
WHERE (o.payment_status = 'refunded' AND o.refunds_total < o.total_cents)
   OR (o.payment_status <> 'refunded' AND o.total_cents > 0 AND o.refunds_total >= o.total_cents)

UNION ALL
SELECT fi_f('ORDER_REFUND_COMPONENTS_EXCEED_ORDER','exception','refund','order',o.id::text,o.order_number,o.id,
  'Resolved refund components add up to more merchandise, shipping or tax than the order ever contained.',
  jsonb_build_object(
    'merchandise_refunded_cents', x.m, 'merchandise_available_cents', GREATEST(0,o.subtotal_cents-o.discount_cents),
    'shipping_refunded_cents', x.s,    'shipping_available_cents', o.shipping_cents,
    'tax_refunded_cents', x.t,         'tax_available_cents', o.tax_cents),
  'manual_review','/admin/financials/returns')
FROM o
JOIN LATERAL (
  SELECT COALESCE(SUM(r.merchandise_refund_cents),0) AS m,
         COALESCE(SUM(r.shipping_refund_cents),0)    AS s,
         COALESCE(SUM(r.tax_refund_cents),0)         AS t
  FROM order_refunds r
  WHERE r.order_id = o.id AND r.status = 'succeeded' AND r.component_breakdown_status = 'resolved'
) x ON TRUE
WHERE x.m > GREATEST(0,o.subtotal_cents-o.discount_cents) OR x.s > o.shipping_cents OR x.t > o.tax_cents
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. REFUND / RETURN / EXCHANGE invariants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Entities: refund, return, exchange (and 'order' for per-order return quantity).
CREATE OR REPLACE FUNCTION fi_scan_refunds()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
WITH
cutover AS (
  SELECT COALESCE(
    (SELECT MIN(opening_cutover_at) FROM inventory_cost_layers WHERE is_migration_opening),
    (SELECT MIN(created_at) FROM inventory_layer_consumptions WHERE consumption_type = 'sale')
  ) AS at
),
r AS (
  SELECT rf.*, o.order_number, o.paid_at AS order_paid_at,
         o.stripe_payment_intent_id AS order_pi
  FROM order_refunds rf JOIN orders o ON o.id = rf.order_id
)
-- ── refunds ────────────────────────────────────────────────────────────────
SELECT fi_f('REFUND_ON_UNPAID_ORDER','exception','refund','refund',r.id::text,
  COALESCE(r.stripe_refund_id, r.id::text), r.order_id,
  'A succeeded refund exists on an order that was never recorded as paid.',
  jsonb_build_object('refund_cents',r.amount_cents,'order_paid_at',r.order_paid_at,
                     'order_number',r.order_number),
  'manual_review','/admin/orders')
FROM r WHERE r.status = 'succeeded' AND r.order_paid_at IS NULL

UNION ALL
SELECT fi_f('REFUND_COMPONENTS_UNRESOLVED','incomplete','refund','refund',r.id::text,
  COALESCE(r.stripe_refund_id, r.id::text), r.order_id,
  'Refund amount is known but its merchandise / shipping / tax split is not. Revenue, tax and affiliate effects of this refund cannot be stated yet.',
  jsonb_build_object('refund_cents',r.amount_cents,
    'component_breakdown_status',r.component_breakdown_status,
    'merchandise_refund_cents',r.merchandise_refund_cents,
    'shipping_refund_cents',r.shipping_refund_cents,
    'tax_refund_cents',r.tax_refund_cents),
  'manual_data','/admin/financials/returns')
FROM r
WHERE r.status = 'succeeded'
  AND (r.component_breakdown_status <> 'resolved'
       OR r.merchandise_refund_cents IS NULL
       OR r.shipping_refund_cents IS NULL
       OR r.tax_refund_cents IS NULL)

UNION ALL
SELECT fi_f('REFUND_COMPONENTS_SUM_MISMATCH','exception','refund','refund',r.id::text,
  COALESCE(r.stripe_refund_id, r.id::text), r.order_id,
  'Resolved refund components do not add up to the refunded amount.',
  jsonb_build_object('refund_cents',r.amount_cents,
    'components_sum_cents',r.merchandise_refund_cents+r.shipping_refund_cents+r.tax_refund_cents,
    'merchandise_refund_cents',r.merchandise_refund_cents,
    'shipping_refund_cents',r.shipping_refund_cents,
    'tax_refund_cents',r.tax_refund_cents),
  'manual_review','/admin/financials/returns')
FROM r
WHERE r.status = 'succeeded' AND r.component_breakdown_status = 'resolved'
  AND r.merchandise_refund_cents IS NOT NULL AND r.shipping_refund_cents IS NOT NULL
  AND r.tax_refund_cents IS NOT NULL
  AND r.merchandise_refund_cents + r.shipping_refund_cents + r.tax_refund_cents <> r.amount_cents

UNION ALL
SELECT fi_f('REFUND_PAYMENT_MISMATCH','exception','refund','refund',r.id::text,
  COALESCE(r.stripe_refund_id, r.id::text), r.order_id,
  'Refund references a different Stripe payment than the order (and than any exchange payment on it).',
  jsonb_build_object('refund_payment_intent',r.stripe_payment_intent_id,'order_payment_intent',r.order_pi),
  'manual_review','/admin/orders')
FROM r
WHERE r.stripe_payment_intent_id IS NOT NULL AND r.order_pi IS NOT NULL
  AND r.stripe_payment_intent_id <> r.order_pi
  AND NOT EXISTS (SELECT 1 FROM order_exchanges e
                  WHERE e.order_id = r.order_id
                    AND e.price_difference_payment_intent_id = r.stripe_payment_intent_id)

UNION ALL
SELECT fi_f('REFUND_FEE_RETURN_UNKNOWN','incomplete','refund','refund',r.id::text,
  COALESCE(r.stripe_refund_id, r.id::text), r.order_id,
  'Whether Stripe returned any processing fee on this refund is not recorded (migration 015: NULL = unknown, not zero). The order''s net Stripe fee, and so its profit, cannot be stated until it is recorded; record 0 if Stripe returned nothing.',
  jsonb_build_object('refund_cents',r.amount_cents,'fee_refunded_cents',r.fee_refunded_cents),
  'manual_data','/admin/financials/returns')
FROM r WHERE r.status = 'succeeded' AND r.fee_refunded_cents IS NULL

UNION ALL
SELECT fi_f('REFUND_FEE_EXCEEDS_ORDER_FEE','exception','refund','order',o.id::text,o.order_number,o.id,
  'Processing fee returned on this order''s refunds adds up to more than the Stripe fee recorded for the order itself.',
  jsonb_build_object('stripe_fee_cents',o.stripe_fee_cents,'fee_refunded_cents',x.fee_refunded),
  'manual_review','/admin/financials/returns')
FROM orders o
JOIN LATERAL (SELECT SUM(q.fee_refunded_cents)::bigint AS fee_refunded
              FROM order_refunds q WHERE q.order_id = o.id AND q.status = 'succeeded') x ON TRUE
WHERE o.paid_at IS NOT NULL AND o.stripe_fee_cents IS NOT NULL AND x.fee_refunded > o.stripe_fee_cents

UNION ALL
SELECT fi_f('REFUND_PENDING_STALE','advisory','refund','refund',r.id::text,
  COALESCE(r.stripe_refund_id, r.id::text), r.order_id,
  'Refund has been pending for more than 7 days; it is not counted until it succeeds.',
  jsonb_build_object('refund_cents',r.amount_cents,'created_at',r.created_at),
  'manual_review','/admin/financials/returns')
FROM r WHERE r.status = 'pending' AND r.created_at < now() - interval '7 days'

UNION ALL
SELECT fi_f('REFUND_ALLOCATION_EXCEEDS_REFUND','exception','refund','refund',r.id::text,
  COALESCE(r.stripe_refund_id, r.id::text), r.order_id,
  'Return allocations of this refund claim more merchandise, shipping or tax than the refund contained.',
  jsonb_build_object('allocated_merchandise_cents',a.m,'refund_merchandise_cents',r.merchandise_refund_cents,
    'allocated_shipping_cents',a.s,'refund_shipping_cents',r.shipping_refund_cents,
    'allocated_tax_cents',a.t,'refund_tax_cents',r.tax_refund_cents),
  'manual_review','/admin/financials/returns')
FROM r
JOIN LATERAL (
  SELECT COALESCE(SUM(merchandise_cents),0) AS m, COALESCE(SUM(shipping_cents),0) AS s,
         COALESCE(SUM(tax_cents),0) AS t
  FROM return_refund_allocations x WHERE x.refund_id = r.id
) a ON TRUE
WHERE r.component_breakdown_status = 'resolved'
  AND (a.m > COALESCE(r.merchandise_refund_cents,0)
    OR a.s > COALESCE(r.shipping_refund_cents,0)
    OR a.t > COALESCE(r.tax_refund_cents,0))

-- ── returns ────────────────────────────────────────────────────────────────
UNION ALL
SELECT fi_f('RETURN_QUANTITY_EXCEEDS_ORDERED','exception','return','order',x.order_id::text,x.order_number,x.order_id,
  'Returned quantity on this order exceeds the quantity that was sold.',
  jsonb_build_object('lines', x.lines),
  'manual_review','/admin/financials/returns')
FROM (
  SELECT oi.order_id, o.order_number,
         jsonb_agg(jsonb_build_object('order_item_id',oi.id,'sku',oi.sku,
                   'sold',oi.quantity,'returned',q.returned) ORDER BY oi.id) AS lines
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN LATERAL (
    SELECT COALESCE(SUM(ri.quantity),0) AS returned
    FROM order_return_items ri JOIN order_returns rt ON rt.id = ri.return_id
    WHERE ri.order_item_id = oi.id AND rt.status <> 'cancelled'
  ) q ON TRUE
  WHERE q.returned > oi.quantity
  GROUP BY oi.order_id, o.order_number
) x

UNION ALL
SELECT fi_f('RETURN_RESTOCK_LAYER_MISSING','exception','return','return',rt.id::text,rt.return_number,rt.order_id,
  'Return items are marked restocked but no inventory layer was created for them, so the returned units are not in costed inventory.',
  jsonb_build_object('item_ids', jsonb_agg(ri.id ORDER BY ri.id)),
  'manual_review','/admin/financials/returns')
FROM order_returns rt
JOIN order_return_items ri ON ri.return_id = rt.id
WHERE ri.restocked
  AND NOT EXISTS (SELECT 1 FROM inventory_cost_layers l WHERE l.return_item_id = ri.id)
GROUP BY rt.id, rt.return_number, rt.order_id

UNION ALL
SELECT fi_f('RETURN_RESTOCK_COGS_UNKNOWN','incomplete','return','return',rt.id::text,rt.return_number,rt.order_id,
  'Restocked return items have no known cost, so the COGS credit is unknown (not zero).',
  jsonb_build_object('item_ids', jsonb_agg(ri.id ORDER BY ri.id)),
  'manual_data','/admin/financials/returns')
FROM order_returns rt
JOIN order_return_items ri ON ri.return_id = rt.id
WHERE ri.restocked AND ri.cogs_credit_cents IS NULL
GROUP BY rt.id, rt.return_number, rt.order_id

UNION ALL
SELECT fi_f('RETURN_COGS_CREDIT_MISMATCH','exception','return','return',rt.id::text,rt.return_number,rt.order_id,
  'The COGS credit recorded for a restocked item differs from the value of the layer it created.',
  jsonb_build_object('items', jsonb_agg(jsonb_build_object('item_id',ri.id,'cogs_credit_cents',ri.cogs_credit_cents,
                     'layer_value_cents',l.units_received * l.unit_landed_cost_cents) ORDER BY ri.id)),
  'manual_review','/admin/financials/returns')
FROM order_returns rt
JOIN order_return_items ri ON ri.return_id = rt.id
JOIN inventory_cost_layers l ON l.return_item_id = ri.id
WHERE ri.restocked AND ri.cogs_credit_cents IS NOT NULL AND l.unit_landed_cost_cents IS NOT NULL
  AND ri.cogs_credit_cents <> l.units_received * l.unit_landed_cost_cents
GROUP BY rt.id, rt.return_number, rt.order_id

UNION ALL
SELECT fi_f('RETURN_LABEL_COST_MISSING','incomplete','return','return',rt.id::text,rt.return_number,rt.order_id,
  'KVRN pays for this return shipping but the label cost is not recorded.',
  jsonb_build_object('status',rt.status,'paid_by',rt.return_shipping_paid_by),
  'manual_data','/admin/financials/returns')
FROM order_returns rt
WHERE rt.return_shipping_paid_by = 'kvrn' AND rt.return_label_cost_cents IS NULL
  AND rt.status IN ('received','completed')

-- ── exchanges ──────────────────────────────────────────────────────────────
UNION ALL
SELECT fi_f('EXCHANGE_SHIPPING_COST_MISSING','incomplete','exchange','exchange',e.id::text,e.exchange_number,e.order_id,
  'A replacement shipment went out but its carrier cost is not recorded, so its shipping expense is unknown.',
  jsonb_build_object('status',e.status,'shipped_at',e.shipped_at),
  'manual_data','/admin/financials/returns')
FROM order_exchanges e
WHERE e.status IN ('shipped','completed') AND e.replacement_shipping_cost_cents IS NULL

UNION ALL
SELECT fi_f('EXCHANGE_PRICE_DIFFERENCE_UNSETTLED','incomplete','exchange','exchange',e.id::text,e.exchange_number,e.order_id,
  'The price difference on this exchange has not been collected or refunded.',
  jsonb_build_object('price_difference_cents',e.price_difference_cents,
                     'price_difference_status',e.price_difference_status),
  'manual_review','/admin/financials/returns')
FROM order_exchanges e
WHERE e.price_difference_cents <> 0 AND e.price_difference_status IN ('pending','failed')
  AND e.status <> 'cancelled'

UNION ALL
SELECT fi_f('EXCHANGE_COGS_UNKNOWN','incomplete','exchange','exchange',e.id::text,e.exchange_number,e.order_id,
  'A shipped replacement item has no known cost.',
  jsonb_build_object('unknown_lines', (SELECT COUNT(*) FROM order_exchange_items i
                      WHERE i.exchange_id = e.id AND i.line_cogs_cents IS NULL)),
  'manual_data','/admin/financials/returns')
FROM order_exchanges e
WHERE e.status IN ('shipped','completed')
  AND EXISTS (SELECT 1 FROM order_exchange_items i WHERE i.exchange_id = e.id AND i.line_cogs_cents IS NULL)

UNION ALL
SELECT fi_f('EXCHANGE_FIFO_QUANTITY_MISMATCH','exception','exchange','exchange',e.id::text,e.exchange_number,e.order_id,
  'Units shipped on this exchange do not match the units consumed from inventory layers.',
  jsonb_build_object('shipped_units',q.items,'consumed_units',q.consumed),
  'manual_review','/admin/financials/returns')
FROM order_exchanges e
CROSS JOIN cutover
JOIN LATERAL (
  SELECT (SELECT COALESCE(SUM(quantity),0) FROM order_exchange_items i WHERE i.exchange_id = e.id) AS items,
         (SELECT COALESCE(SUM(quantity),0) FROM inventory_layer_consumptions c
           WHERE c.exchange_id = e.id AND c.consumption_type = 'exchange_out') AS consumed
) q ON TRUE
WHERE e.status IN ('shipped','completed') AND cutover.at IS NOT NULL
  AND e.shipped_at >= cutover.at AND q.items <> q.consumed

UNION ALL
SELECT fi_f('EXCHANGE_FIFO_COST_MISMATCH','exception','exchange','exchange',e.id::text,e.exchange_number,e.order_id,
  'The cost snapshotted on the exchange items differs from the cost consumed from inventory layers.',
  jsonb_build_object('snapshot_cogs_cents',q.snap,'consumed_cost_cents',q.cons),
  'manual_review','/admin/financials/returns')
FROM order_exchanges e
JOIN LATERAL (
  SELECT (SELECT SUM(line_cogs_cents) FROM order_exchange_items i WHERE i.exchange_id = e.id) AS snap,
         (SELECT SUM(total_cost_cents) FROM inventory_layer_consumptions c
           WHERE c.exchange_id = e.id AND c.consumption_type = 'exchange_out') AS cons,
         (SELECT COUNT(*) FROM order_exchange_items i WHERE i.exchange_id = e.id AND i.line_cogs_cents IS NULL) AS snap_nulls,
         (SELECT COUNT(*) FROM inventory_layer_consumptions c
           WHERE c.exchange_id = e.id AND c.consumption_type = 'exchange_out' AND c.total_cost_cents IS NULL) AS cons_nulls
) q ON TRUE
WHERE e.status IN ('shipped','completed') AND q.snap_nulls = 0 AND q.cons_nulls = 0
  AND q.snap IS NOT NULL AND q.cons IS NOT NULL AND q.snap <> q.cons
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. DISPUTE invariants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A disputed charge and a refunded charge can overlap. net_revenue_impact_cents is
-- already net of refund_offset_cents (018), so refunds + dispute impact can never
-- legitimately exceed what the customer paid. If they do, one economic reversal
-- was counted twice.
CREATE OR REPLACE FUNCTION fi_scan_disputes()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
WITH d AS (
  SELECT dp.*, o.order_number, o.total_cents AS order_total,
    (SELECT COALESCE(SUM(r.amount_cents),0) FROM order_refunds r
       WHERE r.order_id = dp.order_id AND r.status = 'succeeded')                AS refunds_total,
    (SELECT COALESCE(SUM(a.adjustment_cents),0)
       FROM order_dispute_financial_adjustments a WHERE a.dispute_id = dp.id)    AS ledger_sum,
    (SELECT COUNT(*) FROM dispute_balance_transactions b WHERE b.dispute_id = dp.id) AS bt_count
  FROM order_disputes dp JOIN orders o ON o.id = dp.order_id
)
SELECT fi_f('DISPUTE_LEDGER_MISMATCH','exception','dispute','dispute',d.id::text,d.stripe_dispute_id,d.order_id,
  'The append-only dispute adjustment ledger does not equal the dispute''s current recognised revenue impact.',
  jsonb_build_object('net_revenue_impact_cents',d.net_revenue_impact_cents,
                     'ledger_sum_cents',d.ledger_sum,'status',d.status),
  'manual_review','/admin/financials/disputes')
FROM d WHERE d.net_revenue_impact_cents + d.ledger_sum <> 0

UNION ALL
SELECT fi_f('DISPUTE_AMOUNT_EXCEEDS_ORDER','exception','dispute','dispute',d.id::text,d.stripe_dispute_id,d.order_id,
  'Disputed amount is larger than the order total.',
  jsonb_build_object('disputed_cents',d.amount_cents,'order_total_cents',d.order_total),
  'manual_review','/admin/financials/disputes')
FROM d WHERE d.amount_cents > d.order_total

UNION ALL
SELECT fi_f('DISPUTE_REFUND_OVERLAP_DOUBLE_COUNTED','exception','dispute','dispute',d.id::text,d.stripe_dispute_id,d.order_id,
  'Refunds plus the recognised dispute loss exceed what the customer paid: the same money has been reversed twice.',
  jsonb_build_object('refunds_total_cents',d.refunds_total,
                     'net_revenue_impact_cents',d.net_revenue_impact_cents,
                     'order_total_cents',d.order_total,
                     'excess_cents',d.refunds_total + d.net_revenue_impact_cents - d.order_total),
  'manual_review','/admin/financials/disputes')
FROM d WHERE d.refunds_total + d.net_revenue_impact_cents > d.order_total

UNION ALL
SELECT fi_f('DISPUTE_OFFSET_EXCEEDS_REFUNDS','exception','dispute','dispute',d.id::text,d.stripe_dispute_id,d.order_id,
  'The refund offset applied to this dispute is larger than the refunds that exist on the order.',
  jsonb_build_object('refund_offset_cents',d.refund_offset_cents,'refunds_total_cents',d.refunds_total),
  'manual_review','/admin/financials/disputes')
FROM d WHERE d.refund_offset_cents > d.refunds_total

UNION ALL
SELECT fi_f('DISPUTE_ADJUSTMENT_ORDER_MISMATCH','exception','dispute','dispute',d.id::text,d.stripe_dispute_id,d.order_id,
  'A dispute adjustment row belongs to a different order than its dispute.',
  jsonb_build_object('mismatched_rows',
    (SELECT COUNT(*) FROM order_dispute_financial_adjustments a
       WHERE a.dispute_id = d.id AND a.order_id <> d.order_id)),
  'manual_review','/admin/financials/disputes')
FROM d
WHERE EXISTS (SELECT 1 FROM order_dispute_financial_adjustments a
              WHERE a.dispute_id = d.id AND a.order_id <> d.order_id)

UNION ALL
SELECT fi_f('DISPUTE_BALANCE_TRANSACTION_MISSING','incomplete','dispute','dispute',d.id::text,d.stripe_dispute_id,d.order_id,
  'No Stripe balance transaction is recorded for this dispute, so the dispute fee (and the actual funds withdrawn) is unknown.',
  jsonb_build_object('status',d.status,'disputed_cents',d.amount_cents),
  'manual_data','/admin/financials/disputes')
FROM d
WHERE d.bt_count = 0 AND d.status IN ('open','under_review','lost','won')

UNION ALL
SELECT fi_f('DISPUTE_PARTIAL_MERCHANDISE_UNRESOLVED','incomplete','dispute','dispute',d.id::text,d.stripe_dispute_id,d.order_id,
  'A partial dispute was lost but the merchandise / shipping / tax split of the loss has not been resolved.',
  jsonb_build_object('disputed_cents',d.amount_cents,'order_total_cents',d.order_total),
  'manual_data','/admin/financials/disputes')
FROM d
WHERE d.status = 'lost' AND d.amount_cents <> d.order_total
  AND NOT EXISTS (SELECT 1 FROM dispute_merchandise_resolutions m
                  WHERE m.dispute_id = d.id AND m.resolved_disputed_amount_cents = d.amount_cents)

UNION ALL
SELECT fi_f('DISPUTE_STALE','advisory','dispute','dispute',d.id::text,d.stripe_dispute_id,d.order_id,
  'Dispute has been open for more than 90 days.',
  jsonb_build_object('status',d.status,'opened_at',d.opened_at),
  'manual_review','/admin/financials/disputes')
FROM d WHERE d.status IN ('open','under_review') AND d.opened_at < now() - interval '90 days'
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. INVENTORY / COGS / PURCHASE invariants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Inventory purchases are CAPITALISED into layers and only reach profit as COGS
-- when units are consumed. Cash paid for a purchase is therefore never a profit
-- figure; the checks below tie capitalised value to receipts and consumption.
CREATE OR REPLACE FUNCTION fi_scan_inventory()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
WITH
cutover AS (
  SELECT COALESCE(
    (SELECT MIN(opening_cutover_at) FROM inventory_cost_layers WHERE is_migration_opening),
    (SELECT MIN(created_at) FROM inventory_layer_consumptions WHERE consumption_type = 'sale')
  ) AS at
),
val AS (SELECT * FROM inventory_valuation())
SELECT fi_f('INVENTORY_STOCK_LAYER_MISMATCH','exception','inventory','variant',v.variant_id::text,v.sku,NULL,
  'Physical stock on hand does not equal the units held in costed inventory layers.',
  jsonb_build_object('stock_on_hand',v.stock_on_hand,'layer_units_remaining',v.layer_units_remaining,
                     'difference',v.layer_units_remaining - v.stock_on_hand),
  'manual_review','/admin/financials/inventory')
FROM val v WHERE v.layer_units_remaining <> v.stock_on_hand

UNION ALL
SELECT fi_f('INVENTORY_UNKNOWN_COST_UNITS','incomplete','inventory','variant',v.variant_id::text,v.sku,NULL,
  'Some units on hand have no known landed cost, so inventory value and future COGS for them are unknown.',
  jsonb_build_object('unknown_cost_units',v.unknown_cost_units,'known_cost_units',v.known_cost_units,
                     'known_value_cents',v.value_at_cost_cents),
  'manual_data','/admin/financials/inventory')
FROM val v WHERE v.unknown_cost_units > 0

UNION ALL
SELECT fi_f('INVENTORY_NEGATIVE_STOCK','exception','inventory','variant',pv.id::text,pv.sku,NULL,
  'Stock on hand is negative.',
  jsonb_build_object('stock_on_hand',pv.stock_on_hand),
  'manual_review','/admin/financials/inventory')
FROM product_variants pv WHERE pv.stock_on_hand < 0

UNION ALL
SELECT fi_f('INVENTORY_LAYER_UNITS_INVALID','exception','inventory','variant',l.variant_id::text,pv.sku,NULL,
  'An inventory layer has negative remaining units or more remaining than received.',
  jsonb_build_object('layers', jsonb_agg(jsonb_build_object('layer_id',l.id,'units_received',l.units_received,
                     'units_remaining',l.units_remaining) ORDER BY l.id)),
  'manual_review','/admin/financials/inventory')
FROM inventory_cost_layers l JOIN product_variants pv ON pv.id = l.variant_id
WHERE l.units_remaining < 0 OR l.units_remaining > l.units_received
GROUP BY l.variant_id, pv.sku

UNION ALL
SELECT fi_f('INVENTORY_CONSUMPTION_COST_MISMATCH','exception','inventory','variant',c.variant_id::text,pv.sku,NULL,
  'A FIFO consumption row''s total cost is not quantity × unit cost.',
  jsonb_build_object('consumptions', jsonb_agg(jsonb_build_object('consumption_id',c.id,'quantity',c.quantity,
                     'unit_cost_cents',c.unit_cost_cents,'total_cost_cents',c.total_cost_cents) ORDER BY c.id)),
  'manual_review','/admin/financials/inventory')
FROM inventory_layer_consumptions c JOIN product_variants pv ON pv.id = c.variant_id
WHERE c.coverage = 'layer' AND c.unit_cost_cents IS NOT NULL AND c.total_cost_cents IS NOT NULL
  AND c.total_cost_cents <> c.unit_cost_cents * c.quantity
GROUP BY c.variant_id, pv.sku

-- ── write-offs ─────────────────────────────────────────────────────────────
UNION ALL
SELECT fi_f('WRITE_OFF_COST_UNKNOWN','incomplete','inventory','inventory_write_off',w.id::text,
  pv.sku || ' x' || w.quantity,NULL,
  'Inventory was written off but the cost of some or all units is unknown, so the loss is incomplete.',
  jsonb_build_object('quantity',w.quantity,'total_cost_cents',w.total_cost_cents,
                     'known_cost_quantity',w.known_cost_quantity,'unknown_cost_quantity',w.unknown_cost_quantity),
  'manual_data','/admin/financials/inventory')
FROM inventory_write_offs w JOIN product_variants pv ON pv.id = w.variant_id
WHERE w.total_cost_cents IS NULL OR w.unknown_cost_quantity > 0

UNION ALL
SELECT fi_f('WRITE_OFF_CONSUMPTION_MISMATCH','exception','inventory','inventory_write_off',w.id::text,
  pv.sku || ' x' || w.quantity,NULL,
  'Written-off quantity does not match the units consumed from inventory layers for it.',
  jsonb_build_object('write_off_quantity',w.quantity,'consumed_quantity',q.consumed),
  'manual_review','/admin/financials/inventory')
FROM inventory_write_offs w
JOIN product_variants pv ON pv.id = w.variant_id
CROSS JOIN cutover
JOIN LATERAL (
  SELECT COALESCE(SUM(c.quantity),0) AS consumed FROM inventory_layer_consumptions c
  WHERE c.write_off_id = w.id
) q ON TRUE
WHERE cutover.at IS NOT NULL AND w.created_at >= cutover.at AND q.consumed <> w.quantity

UNION ALL
SELECT fi_f('WRITE_OFF_COST_MISMATCH','exception','inventory','inventory_write_off',w.id::text,
  pv.sku || ' x' || w.quantity,NULL,
  'Recorded write-off cost differs from the cost consumed from inventory layers.',
  jsonb_build_object('write_off_total_cost_cents',w.total_cost_cents,'consumed_cost_cents',q.cost),
  'manual_review','/admin/financials/inventory')
FROM inventory_write_offs w
JOIN product_variants pv ON pv.id = w.variant_id
JOIN LATERAL (
  SELECT SUM(c.total_cost_cents) AS cost,
         COUNT(*) FILTER (WHERE c.total_cost_cents IS NULL) AS nulls,
         COUNT(*) AS n
  FROM inventory_layer_consumptions c WHERE c.write_off_id = w.id
) q ON TRUE
WHERE w.total_cost_cents IS NOT NULL AND q.n > 0 AND q.nulls = 0 AND q.cost <> w.total_cost_cents

-- ── capitalisation ─────────────────────────────────────────────────────────
UNION ALL
SELECT fi_f('BATCH_CAPITALIZATION_MISMATCH','exception','inventory','cost_batch',s.cost_batch_id::text,
  COALESCE(s.batch_label, s.cost_batch_id::text),NULL,
  'Value capitalised into inventory layers does not equal the batch''s intended landed total.',
  jsonb_build_object('intended_capitalized_cents',s.intended_capitalized_cents,
                     'received_capitalized_cents',s.received_capitalized_cents,
                     'intended_units',s.intended_units,'received_units',s.received_units),
  'manual_review','/admin/financials/inventory')
FROM batch_receipt_status() s
WHERE (s.fully_received AND NOT s.capitalization_reconciled)
   OR s.received_capitalized_cents > s.intended_capitalized_cents
   OR s.received_units > COALESCE(s.intended_units, s.received_units)

UNION ALL
SELECT fi_f('PURCHASE_OVERPAID','exception','inventory','purchase',p.purchase_id::text,
  COALESCE(p.reference, p.supplier, p.purchase_id::text),NULL,
  'Cash paid on this purchase exceeds its invoice total. (Cash paid is not profit; this is a payment-integrity check only.)',
  jsonb_build_object('expected_total_cents',p.expected_total_cents,'cash_paid_cents',p.cash_paid_cents),
  'manual_review','/admin/financials/inventory')
FROM purchase_reconciliation() p
WHERE p.expected_total_cents IS NOT NULL AND p.cash_paid_cents > p.expected_total_cents

UNION ALL
SELECT fi_f('PURCHASE_CANCELLED_WITH_RECEIPTS','exception','inventory','purchase',p.purchase_id::text,
  COALESCE(p.reference, p.supplier, p.purchase_id::text),NULL,
  'A cancelled purchase still has inventory capitalised against it.',
  jsonb_build_object('status',p.status,'received_capitalized_cents',p.received_capitalized_cents),
  'manual_review','/admin/financials/inventory')
FROM purchase_reconciliation() p
WHERE p.status = 'cancelled' AND p.received_capitalized_cents > 0
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. AFFILIATE invariants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Commission EXPENSE (accrual ledger, effective_at) and payout CASH (paid_at) are
-- different things and are checked separately. Paid payout history is immutable
-- (trigger below), so a paid payout that disagrees with its lines is a defect to
-- investigate, never a row to quietly edit.
CREATE OR REPLACE FUNCTION fi_scan_affiliates()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
WITH c AS (
  SELECT ac.*, o.order_number,
    (SELECT COALESCE(SUM(a.adjustment_cents),0) FROM affiliate_commission_adjustments a
       WHERE a.commission_id = ac.id)                                             AS ledger_cents,
    (SELECT COALESCE(SUM(l.amount_cents),0) FROM affiliate_payout_lines l
       JOIN affiliate_payouts p ON p.id = l.payout_id
       WHERE l.commission_id = ac.id AND p.status <> 'void')                      AS allocated_cents,
    (SELECT COUNT(*) FROM affiliate_unresolved_sources(ac.id))                    AS unresolved,
    affiliate_commission_overpaid(ac.id)                                          AS overpaid,
    affiliate_derive_commission_status(ac.id, now())                              AS derived_status
  FROM affiliate_commissions ac JOIN orders o ON o.id = ac.order_id
)
SELECT fi_f('AFFILIATE_COMMISSION_INCOMPLETE','incomplete','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'Commission cannot be finalised: a refund or dispute affecting its base is not fully resolved.',
  jsonb_build_object('unresolved_sources',
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',u.source_kind,'id',u.source_id,'detail',u.detail)),'[]'::jsonb)
         FROM affiliate_unresolved_sources(c.id) u),
      'commission_cents',c.commission_cents),
  'manual_data','/admin/financials/affiliates')
FROM c WHERE c.unresolved > 0

UNION ALL
SELECT fi_f('AFFILIATE_INCOMPLETE_FLAG_DRIFT','exception','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'The stored incomplete flag disagrees with the unresolved sources derived from refunds and disputes.',
  jsonb_build_object('stored_incomplete',c.incomplete,'unresolved_sources',c.unresolved),
  'automatic','/admin/financials/affiliates')
FROM c WHERE c.incomplete <> (c.unresolved > 0)

UNION ALL
SELECT fi_f('AFFILIATE_COMMISSION_STATUS_DRIFT','exception','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'Stored commission status contradicts the status derived from payouts and the ledger (paid / reversed).',
  jsonb_build_object('stored_status',c.status,'derived_status',c.derived_status),
  'automatic','/admin/financials/affiliates')
FROM c
WHERE (c.status = 'paid') <> (c.derived_status = 'paid')
   OR (c.status = 'reversed') <> (c.derived_status = 'reversed')

UNION ALL
SELECT fi_f('AFFILIATE_COMMISSION_STATUS_STALE','advisory','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'Stored status has not caught up with time-based eligibility (pending vs approved). It refreshes on the next approval run.',
  jsonb_build_object('stored_status',c.status,'derived_status',c.derived_status,'eligible_at',c.eligible_at),
  'automatic','/admin/financials/affiliates')
FROM c
WHERE c.status IN ('pending','approved') AND c.derived_status IN ('pending','approved')
  AND c.status <> c.derived_status

UNION ALL
SELECT fi_f('AFFILIATE_INITIAL_ACCRUAL_MISSING','exception','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'The commission ledger has no initial accrual equal to the commission amount.',
  jsonb_build_object('commission_cents',c.commission_cents,
    'initial_accrual_cents',(SELECT SUM(a.adjustment_cents) FROM affiliate_commission_adjustments a
                              WHERE a.commission_id = c.id AND a.reason = 'initial_accrual')),
  'manual_review','/admin/financials/affiliates')
FROM c
WHERE COALESCE((SELECT SUM(a.adjustment_cents) FROM affiliate_commission_adjustments a
                WHERE a.commission_id = c.id AND a.reason = 'initial_accrual'), 0) <> c.commission_cents

UNION ALL
SELECT fi_f('AFFILIATE_ATTRIBUTION_MISMATCH','exception','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'Commission row disagrees with its attribution on order or affiliate.',
  jsonb_build_object('commission_order_id',c.order_id,'commission_affiliate_id',c.affiliate_id,
                     'attribution_order_id',a.order_id,'attribution_affiliate_id',a.affiliate_id),
  'manual_review','/admin/financials/affiliates')
FROM c JOIN order_affiliate_attributions a ON a.id = c.attribution_id
WHERE a.order_id <> c.order_id OR a.affiliate_id <> c.affiliate_id

UNION ALL
SELECT fi_f('AFFILIATE_COMMISSION_OVER_ALLOCATED','exception','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'Non-void payouts (draft or paid) allocate more to this commission than its ledger owes: it would be paid twice.',
  jsonb_build_object('ledger_cents',c.ledger_cents,'allocated_cents',c.allocated_cents),
  'manual_review','/admin/financials/affiliates')
FROM c
WHERE c.allocated_cents > c.ledger_cents
  + COALESCE((SELECT SUM(a.recovered_cents) FROM affiliate_commission_adjustments a WHERE a.commission_id = c.id),0)
  AND c.overpaid = 0

UNION ALL
SELECT fi_f('AFFILIATE_RECOVERY_PENDING','incomplete','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'A paid commission was later reversed; the overpayment is awaiting recovery from the affiliate.',
  jsonb_build_object('overpaid_cents',c.overpaid),
  'manual_data','/admin/financials/affiliates')
FROM c
WHERE c.overpaid > 0
  AND EXISTS (SELECT 1 FROM affiliate_commission_adjustments a
              WHERE a.commission_id = c.id AND a.recovery_status = 'pending')

UNION ALL
SELECT fi_f('AFFILIATE_RECOVERY_WRITTEN_OFF','advisory','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'An overpaid commission was written off rather than recovered. The loss stays recognised as commission expense.',
  jsonb_build_object('overpaid_cents',c.overpaid),
  'manual_review','/admin/financials/affiliates')
FROM c
WHERE c.overpaid > 0
  AND NOT EXISTS (SELECT 1 FROM affiliate_commission_adjustments a
                  WHERE a.commission_id = c.id AND a.recovery_status = 'pending')
  AND EXISTS (SELECT 1 FROM affiliate_commission_adjustments a
              WHERE a.commission_id = c.id AND a.recovery_status = 'written_off')

UNION ALL
SELECT fi_f('AFFILIATE_OVERPAID_UNRECOVERED','exception','affiliate','affiliate_commission',c.id::text,c.order_number,c.order_id,
  'More cash has been paid out on this commission than the ledger now owes, and no recovery has been recorded.',
  jsonb_build_object('overpaid_cents',c.overpaid,'ledger_cents',c.ledger_cents),
  'manual_review','/admin/financials/affiliates')
FROM c
WHERE c.overpaid > 0
  AND NOT EXISTS (SELECT 1 FROM affiliate_commission_adjustments a
                  WHERE a.commission_id = c.id AND a.recovery_status IN ('pending','written_off'))

-- ── attribution without a commission ───────────────────────────────────────
UNION ALL
SELECT fi_f('AFFILIATE_ATTRIBUTION_WITHOUT_COMMISSION','incomplete','affiliate','order',o.id::text,o.order_number,o.id,
  'A paid order is attributed to an affiliate but no commission row exists for it.',
  jsonb_build_object('affiliate_id',a.affiliate_id,'attribution_id',a.id),
  'manual_review','/admin/financials/affiliates')
FROM order_affiliate_attributions a
JOIN orders o ON o.id = a.order_id
WHERE o.paid_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM affiliate_commissions x WHERE x.attribution_id = a.id)

-- ── payouts ────────────────────────────────────────────────────────────────
UNION ALL
SELECT fi_f('AFFILIATE_PAYOUT_LINES_MISMATCH','exception','affiliate','affiliate_payout',p.id::text,p.payout_number,NULL,
  'Payout amount does not equal the sum of its commission lines.',
  jsonb_build_object('payout_cents',p.amount_cents,'lines_cents',x.lines_cents,'status',p.status),
  'manual_review','/admin/financials/affiliates')
FROM affiliate_payouts p
JOIN LATERAL (SELECT COALESCE(SUM(l.amount_cents),0) AS lines_cents
              FROM affiliate_payout_lines l WHERE l.payout_id = p.id) x ON TRUE
WHERE p.status <> 'void' AND p.amount_cents <> x.lines_cents

UNION ALL
SELECT fi_f('AFFILIATE_PAYOUT_VOIDED_AFTER_PAID','exception','affiliate','affiliate_payout',p.id::text,p.payout_number,NULL,
  'A void payout still carries a paid date: it was marked paid and later flipped to void directly, which rewrites cash history. Cash is treated as paid until reviewed.',
  jsonb_build_object('status',p.status,'paid_at',p.paid_at,'amount_cents',p.amount_cents),
  'manual_review','/admin/financials/affiliates')
FROM affiliate_payouts p WHERE p.status = 'void' AND p.paid_at IS NOT NULL

UNION ALL
SELECT fi_f('AFFILIATE_PAYOUT_UNREFERENCED','advisory','affiliate','affiliate_payout',p.id::text,p.payout_number,NULL,
  'A paid payout has no method or reference, so the cash movement cannot be traced to a bank record.',
  jsonb_build_object('paid_at',p.paid_at,'method',p.method,'reference',p.reference),
  'manual_review','/admin/financials/affiliates')
FROM affiliate_payouts p
WHERE p.status = 'paid' AND (COALESCE(BTRIM(p.method),'') = '' OR COALESCE(BTRIM(p.reference),'') = '')

UNION ALL
SELECT fi_f('AFFILIATE_PAYOUT_DRAFT_STALE','advisory','affiliate','affiliate_payout',p.id::text,p.payout_number,NULL,
  'A draft payout has been open for more than 14 days. It holds commissions out of the payable pool.',
  jsonb_build_object('amount_cents',p.amount_cents,'created_at',p.created_at),
  'manual_review','/admin/financials/affiliates')
FROM affiliate_payouts p WHERE p.status = 'draft' AND p.created_at < now() - interval '14 days'
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6b. Booked expense / ad-spend money is VOIDED, never physically deleted
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The application used to run DELETE FROM expense_transactions / ad_spend and wrote
-- its audit row AFTER the delete with an empty payload, so the amount, provider and
-- invoice of a booked money fact were gone and could not be reconstructed.
--
-- Model (smallest append-only correction):
--   * rows are RETAINED; "delete" in the Admin means VOID
--   * a void records who, why and when (voided_by / void_reason / voided_at), all or none
--   * every report and the integrity scan read ACTIVE rows (voided_at IS NULL) only, so a
--     voided row stops counting exactly once and a voided duplicate no longer double-counts
--   * void_* functions are idempotent: a retry returns the ORIGINAL who/why/when and
--     never rewrites them; the audit entry carries the full monetary snapshot
--   * DELETE and TRUNCATE are refused at the database (KVRN_MONEY|HARD_DELETE_BLOCKED)
--   * a VOIDED row is frozen (KVRN_MONEY|VOIDED_ROW_IMMUTABLE): it can neither be edited
--     into a different fact nor un-voided
--   * a LIVE row's monetary facts are frozen (KVRN_MONEY|FACT_IMMUTABLE); only
--     descriptive annotations may change, and an unknown paid_at may be filled once.
--     A wrong amount is corrected by voiding the row and entering the right one.
--   * expense_definitions (a NON-economic plan, not a booked fact) may still be deleted;
--     the existing ON DELETE SET NULL link from a transaction is permitted, even on a
--     voided row, because it changes no money.
ALTER TABLE expense_transactions ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE expense_transactions ADD COLUMN IF NOT EXISTS voided_by   TEXT;
ALTER TABLE expense_transactions ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE ad_spend             ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE ad_spend             ADD COLUMN IF NOT EXISTS voided_by   TEXT;
ALTER TABLE ad_spend             ADD COLUMN IF NOT EXISTS void_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'et_void_all_or_none') THEN
    ALTER TABLE expense_transactions ADD CONSTRAINT et_void_all_or_none CHECK (
      (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND BTRIM(voided_by) <> '' AND BTRIM(void_reason) <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_void_all_or_none') THEN
    ALTER TABLE ad_spend ADD CONSTRAINT ad_void_all_or_none CHECK (
      (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND BTRIM(voided_by) <> '' AND BTRIM(void_reason) <> ''));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_et_active ON expense_transactions (paid_at) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ad_active ON ad_spend (period_start, period_end) WHERE voided_at IS NULL;

CREATE OR REPLACE FUNCTION fi_money_row_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE o JSONB; n JSONB; allowed TEXT[];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'KVRN_MONEY|HARD_DELETE_BLOCKED|TRUNCATE %', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KVRN_MONEY|HARD_DELETE_BLOCKED|% %', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  o := to_jsonb(OLD) - 'updated_at';
  n := to_jsonb(NEW) - 'updated_at';

  IF OLD.voided_at IS NOT NULL THEN
    -- Frozen. The single permitted change is the FK "ON DELETE SET NULL" of a deleted
    -- expense DEFINITION, which carries no money.
    IF TG_TABLE_NAME = 'expense_transactions' THEN
      IF NEW.expense_definition_id IS NOT NULL
         AND NEW.expense_definition_id IS DISTINCT FROM OLD.expense_definition_id THEN
        RAISE EXCEPTION 'KVRN_MONEY|VOIDED_ROW_IMMUTABLE|% %', TG_TABLE_NAME, OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      o := o - 'expense_definition_id'; n := n - 'expense_definition_id';
    END IF;
    IF o IS DISTINCT FROM n THEN
      RAISE EXCEPTION 'KVRN_MONEY|VOIDED_ROW_IMMUTABLE|% %', TG_TABLE_NAME, OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- LIVE row: the monetary facts are frozen; annotations and the void transition may change.
  allowed := ARRAY['voided_at','voided_by','void_reason'];
  IF TG_TABLE_NAME = 'expense_transactions' THEN
    allowed := allowed || ARRAY['name','notes','expense_definition_id'];
    IF OLD.paid_at IS NULL THEN allowed := allowed || ARRAY['paid_at']; END IF;   -- supplying an UNKNOWN date
  ELSE
    allowed := allowed || ARRAY['notes','provider_reported_revenue_cents','provider_reported_orders','provider_source'];
  END IF;
  IF (SELECT jsonb_object_agg(k, v) FROM jsonb_each(o) AS t(k, v) WHERE k <> ALL (allowed))
     IS DISTINCT FROM
     (SELECT jsonb_object_agg(k, v) FROM jsonb_each(n) AS t(k, v) WHERE k <> ALL (allowed)) THEN
    RAISE EXCEPTION 'KVRN_MONEY|FACT_IMMUTABLE|% %', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fi_expense_money_guard ON expense_transactions;
CREATE TRIGGER fi_expense_money_guard
  BEFORE UPDATE OR DELETE ON expense_transactions
  FOR EACH ROW EXECUTE FUNCTION fi_money_row_guard();
DROP TRIGGER IF EXISTS fi_expense_no_truncate ON expense_transactions;
CREATE TRIGGER fi_expense_no_truncate
  BEFORE TRUNCATE ON expense_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION fi_money_row_guard();
DROP TRIGGER IF EXISTS fi_ad_spend_money_guard ON ad_spend;
CREATE TRIGGER fi_ad_spend_money_guard
  BEFORE UPDATE OR DELETE ON ad_spend
  FOR EACH ROW EXECUTE FUNCTION fi_money_row_guard();
DROP TRIGGER IF EXISTS fi_ad_spend_no_truncate ON ad_spend;
CREATE TRIGGER fi_ad_spend_no_truncate
  BEFORE TRUNCATE ON ad_spend
  FOR EACH STATEMENT EXECUTE FUNCTION fi_money_row_guard();

CREATE OR REPLACE FUNCTION void_expense_transaction(p_id UUID, p_actor TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE t RECORD;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_MONEY|ACTOR_REQUIRED'; END IF;
  IF p_reason IS NULL OR BTRIM(p_reason) = '' THEN RAISE EXCEPTION 'KVRN_MONEY|REASON_REQUIRED'; END IF;
  SELECT * INTO t FROM expense_transactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_MONEY|NOT_FOUND|%', p_id; END IF;
  IF t.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','already_voided','id',t.id,'voided_at',t.voided_at,
                              'voided_by',t.voided_by,'void_reason',t.void_reason);
  END IF;
  UPDATE expense_transactions
     SET voided_at = now(), voided_by = BTRIM(p_actor), void_reason = BTRIM(p_reason)
   WHERE id = p_id;
  -- The audit row carries the FULL monetary snapshot: the fact stays reconstructible even
  -- if the table were ever restored without it.
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (BTRIM(p_actor), 'void', 'expense_transactions', p_id::text,
          jsonb_build_object('reason', BTRIM(p_reason), 'provider', t.provider, 'category', t.category,
            'name', t.name, 'amount_cents', t.amount_cents, 'paid_at', t.paid_at,
            'period_start', t.period_start, 'period_end', t.period_end, 'invoice_id', t.invoice_id));
  RETURN jsonb_build_object('outcome','voided','id',p_id,'voided_by',BTRIM(p_actor),'void_reason',BTRIM(p_reason));
END;
$$;

CREATE OR REPLACE FUNCTION void_ad_spend(p_id UUID, p_actor TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE t RECORD;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_MONEY|ACTOR_REQUIRED'; END IF;
  IF p_reason IS NULL OR BTRIM(p_reason) = '' THEN RAISE EXCEPTION 'KVRN_MONEY|REASON_REQUIRED'; END IF;
  SELECT * INTO t FROM ad_spend WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_MONEY|NOT_FOUND|%', p_id; END IF;
  IF t.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','already_voided','id',t.id,'voided_at',t.voided_at,
                              'voided_by',t.voided_by,'void_reason',t.void_reason);
  END IF;
  UPDATE ad_spend
     SET voided_at = now(), voided_by = BTRIM(p_actor), void_reason = BTRIM(p_reason)
   WHERE id = p_id;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (BTRIM(p_actor), 'void', 'ad_spend', p_id::text,
          jsonb_build_object('reason', BTRIM(p_reason), 'platform', t.platform,
            'campaign_name', t.campaign_name, 'campaign_id', t.campaign_id, 'spend_cents', t.spend_cents,
            'period_start', t.period_start, 'period_end', t.period_end));
  RETURN jsonb_build_object('outcome','voided','id',p_id,'voided_by',BTRIM(p_actor),'void_reason',BTRIM(p_reason));
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. EXPENSE / AD-SPEND invariants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Operating expenses and ad spend are recognised by their own dates, never
-- through an order. The risks are a row that cannot be placed in any period
-- (unknown, not zero) and one recorded twice (double-counted expense).
CREATE OR REPLACE FUNCTION fi_scan_expenses()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
SELECT fi_f('EXPENSE_UNDATED','incomplete','expense','expense',e.id::text,e.name,NULL,
  'Expense has no paid date and no service period, so it cannot be placed in any reporting period.',
  jsonb_build_object('provider',e.provider,'amount_cents',e.amount_cents),
  'manual_data','/admin/financials/expenses')
FROM expense_transactions e
WHERE e.voided_at IS NULL AND e.paid_at IS NULL AND e.period_start IS NULL AND e.period_end IS NULL

UNION ALL
SELECT fi_f('EXPENSE_DUPLICATE_INVOICE','exception','expense','expense',e.id::text,e.name,NULL,
  'The same provider invoice is recorded more than once; counting both would double the expense.',
  jsonb_build_object('provider',e.provider,'invoice_id',e.invoice_id,'amount_cents',e.amount_cents,
                     'first_row_id',f.id,'first_amount_cents',f.amount_cents),
  'manual_review','/admin/financials/expenses')
FROM expense_transactions e
JOIN LATERAL (
  SELECT x.id, x.amount_cents FROM expense_transactions x
  WHERE x.id <> e.id AND x.voided_at IS NULL
    AND LOWER(BTRIM(x.provider)) = LOWER(BTRIM(e.provider))
    AND LOWER(BTRIM(x.invoice_id)) = LOWER(BTRIM(e.invoice_id))
    AND (x.created_at, x.id::text) < (e.created_at, e.id::text)
  ORDER BY x.created_at, x.id LIMIT 1
) f ON TRUE
WHERE e.voided_at IS NULL AND COALESCE(BTRIM(e.invoice_id),'') <> ''

UNION ALL
SELECT fi_f('EXPENSE_FUTURE_DATED','advisory','expense','expense',e.id::text,e.name,NULL,
  'Expense is dated in the future; it is counted only once its date is reached.',
  jsonb_build_object('paid_at',e.paid_at,'period_start',e.period_start),
  'manual_review','/admin/financials/expenses')
FROM expense_transactions e
WHERE e.voided_at IS NULL AND COALESCE(e.paid_at, e.period_start) > (now() AT TIME ZONE 'UTC')::date + 1

UNION ALL
SELECT fi_f('AD_SPEND_DUPLICATE','exception','expense','ad_spend',a.id::text,
  a.platform || COALESCE(' / ' || a.campaign_name,''),NULL,
  'An identical ad-spend row (same platform, campaign, period and amount) already exists; counting both would double the spend.',
  jsonb_build_object('platform',a.platform,'campaign',COALESCE(a.campaign_id,a.campaign_name),
                     'period_start',a.period_start,'period_end',a.period_end,
                     'spend_cents',a.spend_cents,'first_row_id',f.id),
  'manual_review','/admin/financials/advertising')
FROM ad_spend a
JOIN LATERAL (
  SELECT x.id FROM ad_spend x
  WHERE x.id <> a.id AND x.voided_at IS NULL AND x.platform = a.platform
    AND COALESCE(x.campaign_id, x.campaign_name, '') = COALESCE(a.campaign_id, a.campaign_name, '')
    AND x.period_start = a.period_start AND x.period_end = a.period_end
    AND x.spend_cents = a.spend_cents
    AND (x.created_at, x.id::text) < (a.created_at, a.id::text)
  ORDER BY x.created_at, x.id LIMIT 1
) f ON TRUE
WHERE a.voided_at IS NULL
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Aggregator, entity universe, state roll-up
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION financial_integrity_scan()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
  SELECT * FROM fi_scan_orders()
  UNION ALL SELECT * FROM fi_scan_refunds()
  UNION ALL SELECT * FROM fi_scan_disputes()
  UNION ALL SELECT * FROM fi_scan_inventory()
  UNION ALL SELECT * FROM fi_scan_affiliates()
  UNION ALL SELECT * FROM fi_scan_expenses();
$$;

-- Every entity the scan can speak about. An entity with no finding is RECONCILED.
-- Keeping the universe explicit is what makes "RECONCILED" mean "checked and clean"
-- rather than "never looked at".
CREATE OR REPLACE FUNCTION financial_integrity_entities()
RETURNS TABLE (entity_type TEXT, entity_id TEXT, entity_label TEXT)
LANGUAGE sql STABLE AS $$
  SELECT 'order', o.id::text, o.order_number FROM orders o WHERE o.paid_at IS NOT NULL
  UNION ALL SELECT 'refund', r.id::text, COALESCE(r.stripe_refund_id, r.id::text)
            FROM order_refunds r WHERE r.status = 'succeeded'
  UNION ALL SELECT 'return', t.id::text, t.return_number FROM order_returns t
  UNION ALL SELECT 'exchange', e.id::text, e.exchange_number FROM order_exchanges e
  UNION ALL SELECT 'dispute', d.id::text, d.stripe_dispute_id FROM order_disputes d
  UNION ALL SELECT 'variant', v.id::text, v.sku FROM product_variants v
  UNION ALL SELECT 'inventory_write_off', w.id::text, w.id::text FROM inventory_write_offs w
  UNION ALL SELECT 'cost_batch', b.id::text, COALESCE(b.batch_label, b.id::text) FROM product_cost_batches b
  UNION ALL SELECT 'purchase', p.id::text, COALESCE(p.reference, p.supplier, p.id::text) FROM inventory_purchases p
  UNION ALL SELECT 'affiliate_commission', c.id::text, c.id::text FROM affiliate_commissions c
  UNION ALL SELECT 'affiliate_payout', p.id::text, p.payout_number FROM affiliate_payouts p
  UNION ALL SELECT 'expense', x.id::text, x.name FROM expense_transactions x WHERE x.voided_at IS NULL
  UNION ALL SELECT 'ad_spend', a.id::text, a.platform FROM ad_spend a WHERE a.voided_at IS NULL;
$$;

-- Per-entity roll-up: any exception -> EXCEPTION; else any incomplete -> INCOMPLETE;
-- else RECONCILED. Advisories never change the state.
CREATE OR REPLACE FUNCTION financial_integrity_entity_states()
RETURNS TABLE (entity_type TEXT, entity_id TEXT, entity_label TEXT, state TEXT,
               exception_count INTEGER, incomplete_count INTEGER, advisory_count INTEGER)
LANGUAGE sql STABLE AS $$
  WITH f AS (SELECT * FROM financial_integrity_scan()),
  agg AS (
    SELECT f.entity_type, f.entity_id,
           COUNT(*) FILTER (WHERE f.state = 'exception')::int  AS ex,
           COUNT(*) FILTER (WHERE f.state = 'incomplete')::int AS inc,
           COUNT(*) FILTER (WHERE f.state = 'advisory')::int   AS adv
    FROM f GROUP BY f.entity_type, f.entity_id
  )
  SELECT u.entity_type, u.entity_id, u.entity_label,
         CASE WHEN COALESCE(a.ex,0)  > 0 THEN 'EXCEPTION'
              WHEN COALESCE(a.inc,0) > 0 THEN 'INCOMPLETE'
              ELSE 'RECONCILED' END,
         COALESCE(a.ex,0), COALESCE(a.inc,0), COALESCE(a.adv,0)
  FROM financial_integrity_entities() u
  LEFT JOIN agg a ON a.entity_type = u.entity_type AND a.entity_id = u.entity_id;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Append-only detection history
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The scan is the source of truth. This history only remembers WHEN the scan first
-- saw an issue, when it changed class, and when it stopped appearing. Nothing here
-- is ever updated or deleted, and nothing here can make an entity look reconciled.
CREATE TABLE IF NOT EXISTS financial_integrity_runs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor            TEXT        NOT NULL,
  trigger          TEXT        NOT NULL CHECK (trigger IN ('manual','api','scheduled','test')),
  exception_count  INTEGER     NOT NULL CHECK (exception_count  >= 0),
  incomplete_count INTEGER     NOT NULL CHECK (incomplete_count >= 0),
  advisory_count   INTEGER     NOT NULL CHECK (advisory_count   >= 0),
  new_count        INTEGER     NOT NULL CHECK (new_count        >= 0),
  changed_count    INTEGER     NOT NULL CHECK (changed_count    >= 0),
  resolved_count   INTEGER     NOT NULL CHECK (resolved_count   >= 0)
);

CREATE TABLE IF NOT EXISTS financial_integrity_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID        NOT NULL REFERENCES financial_integrity_runs(id) ON DELETE RESTRICT,
  fingerprint  TEXT        NOT NULL,
  event_type   TEXT        NOT NULL CHECK (event_type IN ('detected','changed','resolved')),
  issue_code   TEXT        NOT NULL,
  state        TEXT        NOT NULL CHECK (state IN ('exception','incomplete','advisory')),
  entity_type  TEXT        NOT NULL,
  entity_id    TEXT        NOT NULL,
  evidence     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS financial_integrity_events_fp_idx
  ON financial_integrity_events (fingerprint, observed_at DESC, id);
CREATE INDEX IF NOT EXISTS financial_integrity_events_run_idx
  ON financial_integrity_events (run_id);

CREATE OR REPLACE FUNCTION financial_integrity_block_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KVRN_INTEGRITY|APPEND_ONLY|% on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS fi_runs_append_only ON financial_integrity_runs;
CREATE TRIGGER fi_runs_append_only
  BEFORE UPDATE OR DELETE ON financial_integrity_runs
  FOR EACH ROW EXECUTE FUNCTION financial_integrity_block_mutation();
DROP TRIGGER IF EXISTS fi_runs_no_truncate ON financial_integrity_runs;
CREATE TRIGGER fi_runs_no_truncate
  BEFORE TRUNCATE ON financial_integrity_runs
  FOR EACH STATEMENT EXECUTE FUNCTION financial_integrity_block_mutation();

DROP TRIGGER IF EXISTS fi_events_append_only ON financial_integrity_events;
CREATE TRIGGER fi_events_append_only
  BEFORE UPDATE OR DELETE ON financial_integrity_events
  FOR EACH ROW EXECUTE FUNCTION financial_integrity_block_mutation();
DROP TRIGGER IF EXISTS fi_events_no_truncate ON financial_integrity_events;
CREATE TRIGGER fi_events_no_truncate
  BEFORE TRUNCATE ON financial_integrity_events
  FOR EACH STATEMENT EXECUTE FUNCTION financial_integrity_block_mutation();

-- The identity of an issue. Same code on the same entity is the same issue across
-- runs; a different code on the same entity is a different issue.
CREATE OR REPLACE FUNCTION fi_fingerprint(p_code TEXT, p_entity_type TEXT, p_entity_id TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT p_code || '|' || p_entity_type || '|' || p_entity_id;
$$;

-- Open set = every fingerprint whose latest event is not 'resolved'.
CREATE OR REPLACE FUNCTION financial_integrity_open_history()
RETURNS TABLE (fingerprint TEXT, state TEXT, detected_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT DISTINCT ON (e.fingerprint) e.fingerprint, e.event_type, e.state
    FROM financial_integrity_events e
    ORDER BY e.fingerprint, e.observed_at DESC, e.id DESC
  ),
  episode AS (
    -- Start of the CURRENT episode: the latest 'detected' event. A resolved issue
    -- that recurs gets a new 'detected' event and so a new detected_at.
    SELECT e.fingerprint, MAX(e.observed_at) AS detected_at
    FROM financial_integrity_events e WHERE e.event_type = 'detected'
    GROUP BY e.fingerprint
  )
  SELECT l.fingerprint, l.state, ep.detected_at
  FROM latest l JOIN episode ep ON ep.fingerprint = l.fingerprint
  WHERE l.event_type <> 'resolved';
$$;

-- Run the scan and append what changed since the previous run.
CREATE OR REPLACE FUNCTION record_financial_integrity_run(
  p_actor TEXT, p_trigger TEXT DEFAULT 'manual'
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_run     UUID;
  v_new     INTEGER := 0;
  v_changed INTEGER := 0;
  v_res     INTEGER := 0;
  v_ex      INTEGER;
  v_inc     INTEGER;
  v_adv     INTEGER;
BEGIN
  IF p_actor IS NULL OR p_actor ~ '^\s*$' THEN
    RAISE EXCEPTION 'KVRN_INTEGRITY|ACTOR_REQUIRED';
  END IF;

  -- One recorder at a time so two overlapping runs cannot both claim "new".
  PERFORM pg_advisory_xact_lock(hashtext('kvrn_financial_integrity_run'));

  DROP TABLE IF EXISTS pg_temp.fi_now;
  CREATE TEMP TABLE fi_now ON COMMIT DROP AS
    SELECT s.*, fi_fingerprint(s.issue_code, s.entity_type, s.entity_id) AS fingerprint
    FROM financial_integrity_scan() s;

  SELECT COUNT(*) FILTER (WHERE state='exception'),
         COUNT(*) FILTER (WHERE state='incomplete'),
         COUNT(*) FILTER (WHERE state='advisory')
    INTO v_ex, v_inc, v_adv FROM fi_now;

  -- Counted first, inserted after the run row exists.
  SELECT COUNT(*) INTO v_new FROM fi_now n
    WHERE NOT EXISTS (SELECT 1 FROM financial_integrity_open_history() h WHERE h.fingerprint = n.fingerprint);
  SELECT COUNT(*) INTO v_changed FROM fi_now n
    JOIN financial_integrity_open_history() h ON h.fingerprint = n.fingerprint
    WHERE h.state <> n.state;
  SELECT COUNT(*) INTO v_res FROM financial_integrity_open_history() h
    WHERE NOT EXISTS (SELECT 1 FROM fi_now n WHERE n.fingerprint = h.fingerprint);

  INSERT INTO financial_integrity_runs
    (actor, trigger, exception_count, incomplete_count, advisory_count,
     new_count, changed_count, resolved_count)
  VALUES (p_actor, p_trigger, v_ex, v_inc, v_adv, v_new, v_changed, v_res)
  RETURNING id INTO v_run;

  INSERT INTO financial_integrity_events
    (run_id, fingerprint, event_type, issue_code, state, entity_type, entity_id, evidence)
  SELECT v_run, n.fingerprint,
         CASE WHEN h.fingerprint IS NULL THEN 'detected' ELSE 'changed' END,
         n.issue_code, n.state, n.entity_type, n.entity_id, n.evidence
  FROM fi_now n
  LEFT JOIN financial_integrity_open_history() h ON h.fingerprint = n.fingerprint
  WHERE h.fingerprint IS NULL OR h.state <> n.state;

  INSERT INTO financial_integrity_events
    (run_id, fingerprint, event_type, issue_code, state, entity_type, entity_id, evidence)
  SELECT v_run, h.fingerprint, 'resolved',
         split_part(h.fingerprint,'|',1), h.state,
         split_part(h.fingerprint,'|',2), regexp_replace(h.fingerprint, '^[^|]*\|[^|]*\|', ''),
         '{}'::jsonb
  FROM financial_integrity_open_history() h
  WHERE NOT EXISTS (SELECT 1 FROM fi_now n WHERE n.fingerprint = h.fingerprint);

  RETURN jsonb_build_object('run_id',v_run,'exception_count',v_ex,'incomplete_count',v_inc,
    'advisory_count',v_adv,'new_count',v_new,'changed_count',v_changed,'resolved_count',v_res);
END;
$$;

-- Live findings + when each was first (currently) detected. detected_at is NULL for
-- an issue the recorder has not observed yet; it is never invented.
CREATE OR REPLACE FUNCTION financial_integrity_findings()
RETURNS TABLE (
  fingerprint TEXT, issue_code TEXT, state TEXT, domain TEXT, entity_type TEXT,
  entity_id TEXT, entity_label TEXT, order_id UUID, summary TEXT, evidence JSONB,
  resolution TEXT, action_path TEXT, detected_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT fi_fingerprint(s.issue_code, s.entity_type, s.entity_id),
         s.issue_code, s.state, s.domain, s.entity_type, s.entity_id, s.entity_label,
         s.order_id, s.summary, s.evidence, s.resolution, s.action_path, h.detected_at
  FROM financial_integrity_scan() s
  LEFT JOIN financial_integrity_open_history() h
         ON h.fingerprint = fi_fingerprint(s.issue_code, s.entity_type, s.entity_id)
  ORDER BY CASE s.state WHEN 'exception' THEN 0 WHEN 'incomplete' THEN 1 ELSE 2 END,
           s.issue_code, s.entity_label;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Paid affiliate payout history is protected
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 020 states paid payout history is the authoritative cash record and refuses to
-- void a paid payout in void_affiliate_payout(), but nothing at the table level
-- stopped a direct UPDATE or DELETE. These triggers close that gap:
--
--   * a PAID payout can never be DELETEd
--   * a PAID payout's cash identity (affiliate, number, amount, paid_at, method,
--     reference) can never be changed
--   * payout LINES of a paid payout can never be inserted, changed or deleted
--   * the legal transitions are untouched: draft -> paid (mark_affiliate_payout_paid)
--     and draft -> void (void_affiliate_payout)
--
-- DELIBERATE EXCEPTION, kept for backward compatibility: a direct paid -> void
-- status flip is NOT blocked. The frozen 020 regression fixture rev2c performs
-- exactly that update to exercise the payable/overpaid arithmetic, and the 020
-- fixture gate must keep passing unchanged. The flip cannot erase the cash fact
-- (paid_at, amount and lines all stay) and it is made PERMANENTLY DETECTABLE: a
-- void payout that still carries paid_at can only have been paid first, and the
-- scan reports it as AFFILIATE_PAYOUT_VOIDED_AFTER_PAID (exception).
CREATE OR REPLACE FUNCTION affiliate_paid_payout_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE|DELETE %', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'paid'
     AND (NEW.affiliate_id, NEW.payout_number, NEW.amount_cents, NEW.paid_at, NEW.method, NEW.reference)
         IS DISTINCT FROM
         (OLD.affiliate_id, OLD.payout_number, OLD.amount_cents, OLD.paid_at, OLD.method, OLD.reference) THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE|UPDATE %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'paid' AND NEW.status NOT IN ('paid','void') THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE|STATUS %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS affiliate_paid_payout_guard_trg ON affiliate_payouts;
CREATE TRIGGER affiliate_paid_payout_guard_trg
  BEFORE UPDATE OR DELETE ON affiliate_payouts
  FOR EACH ROW EXECUTE FUNCTION affiliate_paid_payout_guard();

-- A line change touches EVERY payout it names: INSERT -> NEW.payout_id, DELETE ->
-- OLD.payout_id, UPDATE -> BOTH. Checking only OLD on UPDATE let a line be re-parented
-- from a draft payout INTO a paid one (the new parent was never inspected), which would
-- silently change what a paid payout "contains" after the cash had left.
CREATE OR REPLACE FUNCTION affiliate_paid_payout_line_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_payout UUID;
BEGIN
  FOR v_payout IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.payout_id END,
      CASE WHEN TG_OP IN ('DELETE','UPDATE') THEN OLD.payout_id END]) AS x
    WHERE x IS NOT NULL
  LOOP
    -- A payout that is already gone (cascade from deleting a draft) has nothing to protect.
    IF EXISTS (SELECT 1 FROM affiliate_payouts WHERE id = v_payout AND status = 'paid') THEN
      RAISE EXCEPTION 'KVRN_PAYOUT|PAID_PAYOUT_IMMUTABLE|% line on payout %', TG_OP, v_payout
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS affiliate_paid_payout_line_guard_trg ON affiliate_payout_lines;
CREATE TRIGGER affiliate_paid_payout_line_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON affiliate_payout_lines
  FOR EACH ROW EXECUTE FUNCTION affiliate_paid_payout_line_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. Replacement-shipment cost writer
-- ═══════════════════════════════════════════════════════════════════════════
--
-- order_exchanges.replacement_shipping_cost_cents was read by reporting but had no
-- writer anywhere, so every replacement shipment stayed "cost unknown" forever.
-- WRITE-ONCE by design: the first recorded value is final; re-sending the same
-- value is an idempotent no-op; a different value is refused rather than
-- overwritten (history is not rewritten).
CREATE OR REPLACE FUNCTION record_exchange_replacement_shipping_cost(
  p_exchange_id UUID, p_cost_cents INTEGER, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE e RECORD;
BEGIN
  IF p_actor IS NULL OR p_actor ~ '^\s*$' THEN
    RAISE EXCEPTION 'KVRN_EXCHANGE|ACTOR_REQUIRED';
  END IF;
  IF p_cost_cents IS NULL OR p_cost_cents < 0 THEN
    RAISE EXCEPTION 'KVRN_EXCHANGE|INVALID_COST';
  END IF;
  SELECT id, status, replacement_shipping_cost_cents AS cost INTO e
  FROM order_exchanges WHERE id = p_exchange_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_EXCHANGE|NOT_FOUND|%', p_exchange_id; END IF;
  IF e.status NOT IN ('shipped','completed') THEN
    RAISE EXCEPTION 'KVRN_EXCHANGE|NOT_SHIPPED|%', e.status;
  END IF;
  IF e.cost IS NOT NULL THEN
    IF e.cost = p_cost_cents THEN
      RETURN jsonb_build_object('outcome','already_recorded','exchange_id',p_exchange_id,'cost_cents',e.cost);
    END IF;
    RAISE EXCEPTION 'KVRN_EXCHANGE|COST_ALREADY_RECORDED|%', e.cost;
  END IF;

  UPDATE order_exchanges SET replacement_shipping_cost_cents = p_cost_cents, updated_at = now()
  WHERE id = p_exchange_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'record_replacement_shipping_cost', 'order_exchanges', p_exchange_id::text,
          jsonb_build_object('cost_cents', p_cost_cents));

  RETURN jsonb_build_object('outcome','recorded','exchange_id',p_exchange_id,'cost_cents',p_cost_cents);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. COGS snapshots are immutable once known
-- ═══════════════════════════════════════════════════════════════════════════
--
-- order_items.unit_cogs_cents / line_cogs_cents are the cost recognised for a sale.
-- finalize_paid_order() writes them exactly once, from the FIFO consumption. Nothing
-- in the application updates them afterwards, but nothing STOPPED an UPDATE either,
-- and a silent edit would rewrite the historical economics of a closed period.
--
-- Rule: a KNOWN snapshot can never change. An UNKNOWN (NULL) one may be filled in
-- once, because supplying a missing cost is a correction of an unknown, not a
-- rewrite of a fact. Wrong-after-the-fact values are additionally caught by
-- ORDER_FIFO_COST_MISMATCH.
CREATE OR REPLACE FUNCTION order_item_cogs_snapshot_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.unit_cogs_cents IS NOT NULL AND NEW.unit_cogs_cents IS DISTINCT FROM OLD.unit_cogs_cents)
  OR (OLD.line_cogs_cents IS NOT NULL AND NEW.line_cogs_cents IS DISTINCT FROM OLD.line_cogs_cents) THEN
    RAISE EXCEPTION 'KVRN_COGS|SNAPSHOT_IMMUTABLE|order item %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_item_cogs_snapshot_guard_trg ON order_items;
CREATE TRIGGER order_item_cogs_snapshot_guard_trg
  BEFORE UPDATE OF unit_cogs_cents, line_cogs_cents ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_item_cogs_snapshot_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. A recorded replacement shipping cost is immutable (DB level)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- record_exchange_replacement_shipping_cost() is write-once, but a direct UPDATE could
-- still overwrite the amount or clear it back to "unknown". Once the cost is known it
-- can never change; the official first write (NULL -> value) stays allowed. No second
-- economic record is introduced: the same column is simply protected.
CREATE OR REPLACE FUNCTION order_exchange_shipping_cost_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.replacement_shipping_cost_cents IS NOT NULL
     AND NEW.replacement_shipping_cost_cents IS DISTINCT FROM OLD.replacement_shipping_cost_cents THEN
    RAISE EXCEPTION 'KVRN_EXCHANGE|SHIPPING_COST_IMMUTABLE|exchange % has % recorded', OLD.id, OLD.replacement_shipping_cost_cents
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_exchange_shipping_cost_guard_trg ON order_exchanges;
CREATE TRIGGER order_exchange_shipping_cost_guard_trg
  BEFORE UPDATE OF replacement_shipping_cost_cents ON order_exchanges
  FOR EACH ROW EXECUTE FUNCTION order_exchange_shipping_cost_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. Refund fee return: the only way to turn "unknown" into a known amount
-- ═══════════════════════════════════════════════════════════════════════════
--
-- order_refunds.fee_refunded_cents is NULL = UNKNOWN (migration 015, unchanged). The
-- Stripe webhook always records NULL, so with unknown now blocking exact profit there
-- must be an attributable way to state the fact. Write-once, audited and bounded:
-- record 0 when Stripe returned nothing. A known value never changes.
CREATE OR REPLACE FUNCTION record_refund_fee_returned(p_refund_id UUID, p_fee_cents INTEGER, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE r RECORD; ord_fee INTEGER; others BIGINT;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_REFUND|ACTOR_REQUIRED'; END IF;
  IF p_fee_cents IS NULL OR p_fee_cents < 0 THEN RAISE EXCEPTION 'KVRN_REFUND|INVALID_FEE'; END IF;
  SELECT id, order_id, status, fee_refunded_cents AS fee INTO r
  FROM order_refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_REFUND|NOT_FOUND|%', p_refund_id; END IF;
  IF r.status <> 'succeeded' THEN RAISE EXCEPTION 'KVRN_REFUND|NOT_SUCCEEDED|%', r.status; END IF;
  IF r.fee IS NOT NULL THEN
    IF r.fee = p_fee_cents THEN
      RETURN jsonb_build_object('outcome','already_recorded','refund_id',p_refund_id,'fee_refunded_cents',r.fee);
    END IF;
    RAISE EXCEPTION 'KVRN_REFUND|FEE_ALREADY_RECORDED|%', r.fee;
  END IF;
  SELECT stripe_fee_cents INTO ord_fee FROM orders WHERE id = r.order_id;
  SELECT COALESCE(SUM(fee_refunded_cents),0) INTO others
  FROM order_refunds WHERE order_id = r.order_id AND status = 'succeeded' AND id <> p_refund_id;
  IF ord_fee IS NOT NULL AND others + p_fee_cents > ord_fee THEN
    RAISE EXCEPTION 'KVRN_REFUND|FEE_EXCEEDS_ORDER_FEE|order fee %, already returned %', ord_fee, others;
  END IF;
  UPDATE order_refunds SET fee_refunded_cents = p_fee_cents, updated_at = now() WHERE id = p_refund_id;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (BTRIM(p_actor), 'record_refund_fee_returned', 'order_refunds', p_refund_id::text,
          jsonb_build_object('fee_refunded_cents', p_fee_cents, 'order_id', r.order_id));
  RETURN jsonb_build_object('outcome','recorded','refund_id',p_refund_id,'fee_refunded_cents',p_fee_cents);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 14b. A recorded refund fee return is immutable (DB level)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- record_refund_fee_returned() is write-once, but a direct UPDATE could still overwrite a
-- known fee_refunded_cents or clear it back to "unknown", silently rewriting historical fee
-- economics. Once the value is known it can never change; the first write (NULL -> value)
-- stays allowed, re-asserting the SAME value is a harmless no-op, and every other refund
-- update (status, reason, metadata ...) is unaffected because the trigger fires only when
-- fee_refunded_cents is in the UPDATE's SET list and raises only when its value changes.
-- The 015/018 upsert (COALESCE(p_fee_refunded, fee_refunded_cents)) therefore keeps working:
-- a webhook that passes NULL keeps the known value; a conflicting non-NULL value is refused.
-- Non-negativity is already enforced by the 015 CHECK constraint (migration 015 is untouched).
CREATE OR REPLACE FUNCTION order_refund_fee_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.fee_refunded_cents IS NOT NULL
     AND NEW.fee_refunded_cents IS DISTINCT FROM OLD.fee_refunded_cents THEN
    RAISE EXCEPTION 'KVRN_REFUND|FEE_IMMUTABLE|refund % has % recorded', OLD.id, OLD.fee_refunded_cents
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_refund_fee_guard_trg ON order_refunds;
CREATE TRIGGER order_refund_fee_guard_trg
  BEFORE UPDATE OF fee_refunded_cents ON order_refunds
  FOR EACH ROW EXECUTE FUNCTION order_refund_fee_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- 15. Findings RELEVANT to a reporting period
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "Exact profit" for a period may only be claimed when everything that period's profit
-- is built from is reconciled. The scan is global; a P&L must consume only the part
-- that can change ITS figure, so an unrelated old exception never poisons every report:
--
--   (a) ORDER COHORT  every exception/incomplete finding tied to an order PAID in the
--       window (the order itself, its refunds, returns, exchanges, disputes, affiliate
--       commission, FIFO/COGS, shipping, Stripe fee ...). Cohort basis = the order and
--       all its lifetime effects, exactly as the calculator builds order contribution.
--   (b) EXPENSES      active rows recognised in the window (same predicate as
--       lib/financials.ts fetchExpenseRows), plus rows that cannot be placed in ANY
--       period (no paid date and no service period): their period is unknown, so no
--       period can claim exactness.
--   (c) AD SPEND      active rows whose campaign period overlaps the window.
--   (d) WRITE-OFFS    inventory write-offs created in the window.
--
-- Not period-relevant by design: advisories (disclosures, never a state), affiliate
-- payout CASH findings (profit recognises the commission, not the payout), inventory
-- stock/layer/purchase findings (purchases are capitalised, not expensed; consumption
-- reaches profit only through order COGS which (a) already covers).
CREATE OR REPLACE FUNCTION financial_integrity_period_findings(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ)
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
  WITH w AS (
    SELECT (p_start AT TIME ZONE 'UTC')::date                              AS d0,
           ((p_end - INTERVAL '1 microsecond') AT TIME ZONE 'UTC')::date   AS d1
  )
  SELECT f.*
  FROM financial_integrity_scan() f, w
  WHERE f.state IN ('exception','incomplete')
    AND (
      (f.order_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM orders o
         WHERE o.id = f.order_id AND o.paid_at IS NOT NULL AND o.paid_at >= p_start AND o.paid_at < p_end))
      OR (f.entity_type = 'expense' AND EXISTS (
         SELECT 1 FROM expense_transactions t
         WHERE t.id::text = f.entity_id AND t.voided_at IS NULL AND (
              (t.paid_at IS NULL AND t.period_start IS NULL AND t.period_end IS NULL)
           OR (t.paid_at IS NOT NULL AND t.period_start IS NULL AND t.paid_at BETWEEN w.d0 AND w.d1)
           OR (t.paid_at IS NOT NULL AND t.period_start IS NOT NULL
               AND t.period_start <= w.d1 AND COALESCE(t.period_end, t.period_start) >= w.d0))))
      OR (f.entity_type = 'ad_spend' AND EXISTS (
         SELECT 1 FROM ad_spend a
         WHERE a.id::text = f.entity_id AND a.voided_at IS NULL
           AND a.period_start <= w.d1 AND a.period_end >= w.d0))
      OR (f.entity_type = 'inventory_write_off' AND EXISTS (
         SELECT 1 FROM inventory_write_offs wo
         WHERE wo.id::text = f.entity_id AND wo.created_at >= p_start AND wo.created_at < p_end))
    );
$$;

-- Roll-up for the P&L: RECONCILED / INCOMPLETE / EXCEPTION for the period, the issue
-- codes behind it, and the per-order states (orders absent from "orders" are RECONCILED).
CREATE OR REPLACE FUNCTION financial_integrity_period_state(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE AS $$
  WITH f AS (SELECT * FROM financial_integrity_period_findings(p_start, p_end)),
  codes AS (
    SELECT issue_code, state, domain, COUNT(*)::int AS n FROM f GROUP BY issue_code, state, domain
  ),
  ord AS (
    SELECT order_id, CASE WHEN bool_or(state = 'exception') THEN 'EXCEPTION' ELSE 'INCOMPLETE' END AS st
    FROM f WHERE order_id IS NOT NULL GROUP BY order_id
  )
  SELECT jsonb_build_object(
    'state', CASE WHEN EXISTS (SELECT 1 FROM f WHERE state = 'exception') THEN 'EXCEPTION'
                  WHEN EXISTS (SELECT 1 FROM f)                            THEN 'INCOMPLETE'
                  ELSE 'RECONCILED' END,
    'exception_count',   (SELECT COUNT(*) FROM f WHERE state = 'exception'),
    'incomplete_count',  (SELECT COUNT(*) FROM f WHERE state = 'incomplete'),
    'order_cohort_count',(SELECT COUNT(*) FROM orders o
                          WHERE o.paid_at IS NOT NULL AND o.paid_at >= p_start AND o.paid_at < p_end),
    'by_code', COALESCE((SELECT jsonb_agg(jsonb_build_object('issue_code',issue_code,'state',state,
                                     'domain',domain,'count',n)
                                 ORDER BY CASE state WHEN 'exception' THEN 0 ELSE 1 END, issue_code)
                         FROM codes), '[]'::jsonb),
    'orders', COALESCE((SELECT jsonb_object_agg(order_id::text, st) FROM ord), '{}'::jsonb)
  );
$$;

COMMIT;
