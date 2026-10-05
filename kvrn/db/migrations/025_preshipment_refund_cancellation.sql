-- 025_preshipment_refund_cancellation.sql
--
-- FIRST-CLASS PRE-SHIPMENT CANCELLATION OF A FULLY REFUNDED ORDER
--
-- THE PROBLEM
--   An order is paid, never shipped (no label, no shipment row, no physical
--   return), and then FULLY refunded. Today KVRN keeps it at fulfillment_status
--   'processing' forever, its inventory is never restored, its sale COGS still
--   counts as a cost, and its shipping cost is permanently UNKNOWN. The Returns
--   subsystem cannot fix it: restocking through a "return" would assert that
--   goods came back from a customer, when in fact they never left the building.
--
-- THE MODEL (a refund is money; a cancellation is goods; neither implies the other)
--   * order_cancellations / order_cancellation_items: an append-only, auditable
--     record that an unshipped order was cancelled and exactly which units, at
--     which cost, went back into stock. One successful cancellation per order.
--   * HISTORY IS NEVER REWRITTEN. order_items.unit_cogs_cents / line_cogs_cents and
--     the original 'sale' rows in inventory_layer_consumptions are untouched. The
--     sale really happened; the cost really was incurred. The cancellation adds its
--     OWN COGS credit (equal to the value of the layers it restores) and canonical
--     profit subtracts it, exactly as it already subtracts a sellable-return credit.
--   * Restored units re-enter FIFO as NEW layers (source 'cancellation_restock')
--     that MIRROR each original sale consumption: same quantity, same unit cost,
--     so a mixed-cost FIFO sale is restored cent-exact. A consumption whose cost
--     was unknown (or uncovered) restores at an UNKNOWN cost, never zero, and the
--     cancellation's COGS credit is then UNKNOWN (NULL) and the order INCOMPLETE.
--   * The cost batch is copied onto the layer for provenance only.
--     batch_receipt_status() (024) counts inventory_batch_receipts alone, so a
--     cancellation restock never looks like a newly received batch.
--   * No order_returns row, no shipments row, no label cost is fabricated.
--     fi_order_shipping() (021) already defines "no shipment AND fulfillment_status
--     = 'cancelled'" as an exact merchant shipping cost of 0, so ORDER_SHIPPING_COST
--     _MISSING resolves by itself once the order is truly cancelled.
--
-- ATOMICITY / CONCURRENCY
--   cancel_fully_refunded_unshipped_order() locks the order row (the same lock
--   record_order_refund() and mark_order_shipped() take), then the affected variant
--   rows in id order, and does everything in one transaction. A second caller waits,
--   then sees the cancellation and returns 'already_cancelled' without touching
--   stock. UNIQUE(order_id) and UNIQUE(source consumption) are the backstop.
--
-- Migrations 001-024 are frozen (023/024 are live in production); nothing here edits them.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Layer provenance: allow the new source / basis and link to the cancellation
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 019 declared the two CHECKs inline (auto-named, but located here by definition
-- rather than by guessed name). The widening only ADDS an allowed value.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'inventory_cost_layers'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%return_restock%'
      AND pg_get_constraintdef(oid) NOT LIKE '%cancellation_restock%'
  LOOP
    EXECUTE format('ALTER TABLE inventory_cost_layers DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'inventory_cost_layers'::regclass AND conname = 'icl_source_chk') THEN
    ALTER TABLE inventory_cost_layers ADD CONSTRAINT icl_source_chk
      CHECK (source IN ('purchase','opening_balance','return_restock','manual_adjustment','cancellation_restock'));
  END IF;

  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'inventory_cost_layers'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%return_snapshot%'
      AND pg_get_constraintdef(oid) NOT LIKE '%cancellation_snapshot%'
  LOOP
    EXECUTE format('ALTER TABLE inventory_cost_layers DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'inventory_cost_layers'::regclass AND conname = 'icl_cost_basis_source_chk') THEN
    ALTER TABLE inventory_cost_layers ADD CONSTRAINT icl_cost_basis_source_chk
      CHECK (cost_basis_source IS NULL
             OR cost_basis_source IN ('date_effective_at_cutover','cost_batch','return_snapshot',
                                      'cancellation_snapshot','unknown'));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The cancellation record (append-only)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS order_cancellations (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  UUID        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

  cancellation_type         TEXT        NOT NULL DEFAULT 'preshipment_full_refund'
    CHECK (cancellation_type = 'preshipment_full_refund'),

  reason                    TEXT        NOT NULL
    CHECK (char_length(reason) BETWEEN 3 AND 500),
  cancelled_by              TEXT        NOT NULL
    CHECK (char_length(cancelled_by) BETWEEN 1 AND 254),

  -- Facts the eligibility decision was made on, frozen for audit.
  prior_fulfillment_status  TEXT        NOT NULL
    CHECK (prior_fulfillment_status IN ('unfulfilled','processing')),
  order_total_cents         INTEGER     NOT NULL CHECK (order_total_cents > 0),
  refunded_cents            INTEGER     NOT NULL CHECK (refunded_cents >= order_total_cents),

  restocked_units           INTEGER     NOT NULL CHECK (restocked_units > 0),
  unknown_cost_units        INTEGER     NOT NULL DEFAULT 0 CHECK (unknown_cost_units >= 0),
  -- NULL = at least one restored unit has an UNKNOWN cost. NEVER read it as zero.
  cogs_credit_cents         INTEGER     CHECK (cogs_credit_cents IS NULL OR cogs_credit_cents >= 0),

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT oc_one_per_order UNIQUE (order_id),
  CONSTRAINT oc_unknown_iff_null_credit
    CHECK ((cogs_credit_cents IS NULL) = (unknown_cost_units > 0)),
  CONSTRAINT oc_unknown_le_units CHECK (unknown_cost_units <= restocked_units)
);

CREATE TABLE IF NOT EXISTS order_cancellation_items (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cancellation_id       UUID        NOT NULL REFERENCES order_cancellations(id) ON DELETE RESTRICT,
  order_item_id         UUID        NOT NULL REFERENCES order_items(id)          ON DELETE RESTRICT,
  variant_id            UUID        NOT NULL REFERENCES product_variants(id)     ON DELETE RESTRICT,

  -- The original sale consumption this row mirrors. NULL only for a pre-FIFO order
  -- line that never had consumption rows (restored at its immutable COGS snapshot).
  source_consumption_id UUID        REFERENCES inventory_layer_consumptions(id)  ON DELETE RESTRICT,

  -- What was actually restored.
  layer_id              UUID        REFERENCES inventory_cost_layers(id)         ON DELETE RESTRICT,
  movement_id           UUID        REFERENCES inventory_movements(id)           ON DELETE RESTRICT,

  quantity              INTEGER     NOT NULL CHECK (quantity > 0),
  -- NULL = the original cost was unknown. Carried over, never zeroed.
  unit_cost_cents       INTEGER     CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  cogs_credit_cents     INTEGER     CHECK (cogs_credit_cents IS NULL OR cogs_credit_cents >= 0),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT oci_credit_matches_cost CHECK (
    (unit_cost_cents IS NULL AND cogs_credit_cents IS NULL)
    OR (unit_cost_cents IS NOT NULL AND cogs_credit_cents = unit_cost_cents * quantity))
);

-- A sale consumption can be restored AT MOST ONCE, and one layer belongs to one row.
CREATE UNIQUE INDEX IF NOT EXISTS oci_one_restore_per_consumption
  ON order_cancellation_items(source_consumption_id) WHERE source_consumption_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS oci_one_row_per_layer
  ON order_cancellation_items(layer_id) WHERE layer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oci_cancellation ON order_cancellation_items(cancellation_id);
CREATE INDEX IF NOT EXISTS idx_oci_order_item   ON order_cancellation_items(order_item_id);

-- Traceability from a restored layer back to its cancellation (mirrors return_item_id).
ALTER TABLE inventory_cost_layers
  ADD COLUMN IF NOT EXISTS cancellation_id UUID REFERENCES order_cancellations(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_icl_cancellation ON inventory_cost_layers(cancellation_id)
  WHERE cancellation_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'inventory_cost_layers'::regclass AND conname = 'icl_cancellation_source_chk') THEN
    ALTER TABLE inventory_cost_layers ADD CONSTRAINT icl_cancellation_source_chk
      CHECK ((source = 'cancellation_restock') = (cancellation_id IS NOT NULL));
  END IF;
END $$;

-- Append-only: a cancellation is a fact. A mistake is corrected by a new, explicit
-- event, never by editing or deleting this one (same convention as the other ledgers).
CREATE OR REPLACE FUNCTION order_cancellation_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KVRN_CANCEL|APPEND_ONLY|% % is immutable', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS oc_append_only ON order_cancellations;
CREATE TRIGGER oc_append_only BEFORE UPDATE OR DELETE ON order_cancellations
  FOR EACH ROW EXECUTE FUNCTION order_cancellation_append_only();
DROP TRIGGER IF EXISTS oc_no_truncate ON order_cancellations;
CREATE TRIGGER oc_no_truncate BEFORE TRUNCATE ON order_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION order_cancellation_append_only();
DROP TRIGGER IF EXISTS oci_append_only ON order_cancellation_items;
CREATE TRIGGER oci_append_only BEFORE UPDATE OR DELETE ON order_cancellation_items
  FOR EACH ROW EXECUTE FUNCTION order_cancellation_append_only();
DROP TRIGGER IF EXISTS oci_no_truncate ON order_cancellation_items;
CREATE TRIGGER oci_no_truncate BEFORE TRUNCATE ON order_cancellation_items
  FOR EACH STATEMENT EXECUTE FUNCTION order_cancellation_append_only();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The restock plan: what an order's sale actually consumed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per ORIGINAL sale consumption (so mixed-cost sales are mirrored exactly),
-- or, for a pre-FIFO line with no consumption rows at all, one row at its immutable
-- COGS snapshot. unit_cost_cents is NULL when the original cost was unknown/uncovered.
-- Reads the facts as they stand today; it never uses an editable product cost.
CREATE OR REPLACE FUNCTION cancellation_plan(p_order_id UUID)
RETURNS TABLE (order_item_id UUID, variant_id UUID, source_consumption_id UUID,
               quantity INTEGER, unit_cost_cents INTEGER, cost_batch_id UUID, basis TEXT)
LANGUAGE sql STABLE AS $$
  SELECT oi.id, COALESCE(c.variant_id, oi.variant_id), c.id, c.quantity,
         CASE WHEN c.coverage = 'layer' THEN c.unit_cost_cents ELSE NULL END,
         l.cost_batch_id, 'consumption'::text
  FROM order_items oi
  JOIN inventory_layer_consumptions c
    ON c.order_item_id = oi.id AND c.consumption_type = 'sale'
  LEFT JOIN inventory_cost_layers l ON l.id = c.layer_id
  WHERE oi.order_id = p_order_id
  UNION ALL
  SELECT oi.id, oi.variant_id, NULL::uuid, oi.quantity, oi.unit_cogs_cents, NULL::uuid, 'snapshot'::text
  FROM order_items oi
  WHERE oi.order_id = p_order_id
    AND NOT EXISTS (SELECT 1 FROM inventory_layer_consumptions c
                    WHERE c.order_item_id = oi.id AND c.consumption_type = 'sale');
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. cancel_fully_refunded_unshipped_order()
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Errors are raised as  KVRN_CANCEL|<CODE>|<detail>  (callers map the CODE).
--   outcome 'cancelled'          done now
--   outcome 'already_cancelled'  an exact repeat; NOTHING was changed
CREATE OR REPLACE FUNCTION cancel_fully_refunded_unshipped_order(
  p_order_id UUID, p_actor TEXT, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_actor    TEXT := BTRIM(COALESCE(p_actor, ''));
  v_reason   TEXT := BTRIM(COALESCE(p_reason, ''));
  o          RECORD;
  ex         RECORD;
  v_refunded BIGINT;
  v_units    INTEGER;
  v_unknown  INTEGER;
  v_credit   INTEGER;
  v_cid      UUID;
  v_layer    UUID;
  v_move     UUID;
  v_moves    JSONB := '{}'::jsonb;
  p          RECORD;
  vr         RECORD;
  v_layers   UUID[] := ARRAY[]::uuid[];
BEGIN
  -- ── input validation (before any lock) ──────────────────────────────────
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'KVRN_CANCEL|ORDER_REQUIRED'; END IF;
  IF v_actor = '' THEN RAISE EXCEPTION 'KVRN_CANCEL|ACTOR_REQUIRED'; END IF;
  IF char_length(v_actor) > 254 OR v_actor ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'KVRN_CANCEL|ACTOR_INVALID';
  END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'KVRN_CANCEL|REASON_REQUIRED'; END IF;
  IF char_length(v_reason) < 3 THEN RAISE EXCEPTION 'KVRN_CANCEL|REASON_TOO_SHORT'; END IF;
  IF char_length(v_reason) > 500 OR v_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'KVRN_CANCEL|REASON_INVALID';
  END IF;

  -- ── the serialisation point: the same row lock record_order_refund() and
  --    mark_order_shipped() take, so a refund or a shipment cannot race us ──
  SELECT id, order_number, payment_status, fulfillment_status, total_cents, paid_at
  INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_CANCEL|ORDER_NOT_FOUND|%', p_order_id; END IF;

  -- ── idempotency: an exact repeat is a harmless no-op ────────────────────
  SELECT * INTO ex FROM order_cancellations WHERE order_id = p_order_id;
  IF FOUND THEN
    IF ex.reason = v_reason THEN
      RETURN jsonb_build_object('outcome','already_cancelled','order_id',p_order_id,
        'cancellation_id',ex.id,'restocked_units',ex.restocked_units,
        'cogs_credit_cents',ex.cogs_credit_cents,'unknown_cost_units',ex.unknown_cost_units);
    END IF;
    RAISE EXCEPTION 'KVRN_CANCEL|ALREADY_CANCELLED_DIFFERENT_REASON|%', ex.id;
  END IF;

  -- ── strict eligibility ──────────────────────────────────────────────────
  IF o.paid_at IS NULL THEN RAISE EXCEPTION 'KVRN_CANCEL|NOT_PAID'; END IF;
  IF o.fulfillment_status IN ('shipped','delivered') THEN
    RAISE EXCEPTION 'KVRN_CANCEL|ALREADY_SHIPPED|%', o.fulfillment_status;
  END IF;
  IF o.fulfillment_status NOT IN ('unfulfilled','processing') THEN
    RAISE EXCEPTION 'KVRN_CANCEL|INVALID_FULFILLMENT_STATUS|%', o.fulfillment_status;
  END IF;
  IF o.payment_status <> 'refunded' THEN
    RAISE EXCEPTION 'KVRN_CANCEL|NOT_REFUNDED|%', o.payment_status;
  END IF;
  IF o.total_cents IS NULL OR o.total_cents <= 0 THEN
    RAISE EXCEPTION 'KVRN_CANCEL|NO_PAYMENT_TO_REFUND';
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO v_refunded
  FROM order_refunds WHERE order_id = p_order_id AND status = 'succeeded';
  IF v_refunded < o.total_cents THEN
    RAISE EXCEPTION 'KVRN_CANCEL|PARTIAL_REFUND|refunded %, total %', v_refunded, o.total_cents;
  END IF;
  IF v_refunded > o.total_cents THEN
    RAISE EXCEPTION 'KVRN_CANCEL|REFUND_EXCEEDS_TOTAL|refunded %, total %', v_refunded, o.total_cents;
  END IF;

  -- Never shipped: no shipment row of any kind (a purchased label, quote-only or not).
  IF EXISTS (SELECT 1 FROM shipments WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'KVRN_CANCEL|SHIPMENT_EXISTS';
  END IF;
  -- Goods that came back, a replacement, or a chargeback make this a different case.
  IF EXISTS (SELECT 1 FROM order_returns   WHERE order_id = p_order_id AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'KVRN_CANCEL|HAS_RETURN';
  END IF;
  IF EXISTS (SELECT 1 FROM order_exchanges WHERE order_id = p_order_id AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'KVRN_CANCEL|HAS_EXCHANGE';
  END IF;
  IF EXISTS (SELECT 1 FROM order_disputes  WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'KVRN_CANCEL|HAS_DISPUTE';
  END IF;

  -- ── the plan must account for EXACTLY the sold quantity of every line ────
  IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'KVRN_CANCEL|NO_ITEMS';
  END IF;
  IF EXISTS (SELECT 1 FROM cancellation_plan(p_order_id) x WHERE x.variant_id IS NULL) THEN
    RAISE EXCEPTION 'KVRN_CANCEL|VARIANT_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.order_id = p_order_id
      AND oi.quantity <> COALESCE((SELECT SUM(x.quantity) FROM cancellation_plan(p_order_id) x
                                   WHERE x.order_item_id = oi.id), 0)
  ) THEN
    RAISE EXCEPTION 'KVRN_CANCEL|FIFO_QUANTITY_MISMATCH';
  END IF;

  -- Lock every affected variant, in id order (no deadlock between two cancellations).
  PERFORM 1 FROM product_variants
  WHERE id IN (SELECT x.variant_id FROM cancellation_plan(p_order_id) x)
  ORDER BY id FOR UPDATE;

  SELECT COALESCE(SUM(x.quantity), 0)::int,
         COALESCE(SUM(x.quantity) FILTER (WHERE x.unit_cost_cents IS NULL), 0)::int,
         CASE WHEN COUNT(*) FILTER (WHERE x.unit_cost_cents IS NULL) > 0 THEN NULL
              ELSE SUM(x.unit_cost_cents * x.quantity)::int END
  INTO v_units, v_unknown, v_credit
  FROM cancellation_plan(p_order_id) x;
  IF v_units <= 0 THEN RAISE EXCEPTION 'KVRN_CANCEL|NO_ITEMS'; END IF;

  -- ── write the cancellation ───────────────────────────────────────────────
  INSERT INTO order_cancellations (
    order_id, reason, cancelled_by, prior_fulfillment_status,
    order_total_cents, refunded_cents, restocked_units, unknown_cost_units, cogs_credit_cents
  ) VALUES (
    p_order_id, v_reason, v_actor, o.fulfillment_status,
    o.total_cents, v_refunded::int, v_units, v_unknown, v_credit
  ) RETURNING id INTO v_cid;

  -- Stock + ONE audited movement per variant (explicit type, order-linked, no return_id).
  FOR vr IN
    SELECT x.variant_id, SUM(x.quantity)::int AS qty
    FROM cancellation_plan(p_order_id) x GROUP BY x.variant_id ORDER BY x.variant_id
  LOOP
    UPDATE product_variants
    SET stock_on_hand = stock_on_hand + vr.qty, updated_at = NOW()
    WHERE id = vr.variant_id;

    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, order_id)
    VALUES (vr.variant_id, vr.qty, 'CANCEL_RESTOCK', 'preshipment_cancellation',
            'cancellation:' || v_cid, v_actor, p_order_id)
    RETURNING id INTO v_move;
    v_moves := v_moves || jsonb_build_object(vr.variant_id::text, v_move);
  END LOOP;

  -- One layer per original consumption: same quantity, same unit cost (NULL stays NULL).
  FOR p IN
    SELECT * FROM cancellation_plan(p_order_id) x
    ORDER BY x.order_item_id, x.source_consumption_id NULLS LAST
  LOOP
    INSERT INTO inventory_cost_layers (
      variant_id, cost_batch_id, units_received, units_remaining, unit_landed_cost_cents,
      source, cost_basis_source, cost_basis_note, cancellation_id, created_by
    ) VALUES (
      p.variant_id, p.cost_batch_id, p.quantity, p.quantity, p.unit_cost_cents,
      'cancellation_restock',
      CASE WHEN p.unit_cost_cents IS NULL THEN 'unknown' ELSE 'cancellation_snapshot' END,
      'Restored from ' || CASE WHEN p.source_consumption_id IS NULL
                               THEN 'the order line''s COGS snapshot'
                               ELSE 'sale consumption ' || p.source_consumption_id END
        || ' by cancellation ' || v_cid,
      v_cid, v_actor
    ) RETURNING id INTO v_layer;
    v_layers := v_layers || v_layer;

    INSERT INTO order_cancellation_items (
      cancellation_id, order_item_id, variant_id, source_consumption_id, layer_id, movement_id,
      quantity, unit_cost_cents, cogs_credit_cents
    ) VALUES (
      v_cid, p.order_item_id, p.variant_id, p.source_consumption_id, v_layer,
      (v_moves ->> p.variant_id::text)::uuid,
      p.quantity, p.unit_cost_cents,
      CASE WHEN p.unit_cost_cents IS NULL THEN NULL ELSE p.unit_cost_cents * p.quantity END
    );
  END LOOP;

  -- Fulfilment: cancelled. NO shipment row, NO label cost. fi_order_shipping() maps
  -- "cancelled + zero shipments" to an exact $0 on its own.
  UPDATE orders SET fulfillment_status = 'cancelled', updated_at = NOW() WHERE id = p_order_id;

  -- Audit: ids, counts and amounts only (no customer data; the free-text reason lives
  -- on the cancellation row itself).
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'cancel_unshipped_order', 'order_cancellation', v_cid::text,
          jsonb_build_object(
            'order_id', p_order_id, 'order_number', o.order_number, 'cancellation_id', v_cid,
            'prior_fulfillment_status', o.fulfillment_status,
            'refunded_cents', v_refunded, 'order_total_cents', o.total_cents,
            'restocked_units', v_units, 'layers_created', COALESCE(array_length(v_layers, 1), 0),
            'unknown_cost_units', v_unknown, 'cogs_credit_cents', v_credit));

  RETURN jsonb_build_object('outcome','cancelled','order_id',p_order_id,'cancellation_id',v_cid,
    'restocked_units',v_units,'cogs_credit_cents',v_credit,'unknown_cost_units',v_unknown,
    'layer_ids',to_jsonb(v_layers),'movement_ids',v_moves);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Integrity scan: fi_scan_cancellations(), folded into financial_integrity_scan()
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every finding is carried by the ORDER (entity_type 'order') so it rolls up into the
-- order's RECONCILED / INCOMPLETE / EXCEPTION state and into the period gate.
CREATE OR REPLACE FUNCTION fi_scan_cancellations()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
WITH
c AS (
  SELECT x.id AS cid, x.order_id, x.cogs_credit_cents, x.unknown_cost_units, x.restocked_units,
         o.order_number, o.payment_status, o.fulfillment_status, o.total_cents,
         (SELECT COALESCE(SUM(r.amount_cents),0) FROM order_refunds r
            WHERE r.order_id = o.id AND r.status = 'succeeded')::bigint              AS refunded,
         (SELECT COUNT(*) FROM shipments s WHERE s.order_id = o.id)                  AS shipments,
         (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id)::bigint AS sold_units,
         (SELECT COALESCE(SUM(i.quantity),0) FROM order_cancellation_items i
            WHERE i.cancellation_id = x.id)::bigint                                  AS restored_units
  FROM order_cancellations x JOIN orders o ON o.id = x.order_id
)
-- ── a fully refunded, never-shipped order that is still open ────────────────
SELECT fi_f('ORDER_REFUNDED_UNSHIPPED_NOT_CANCELLED','incomplete','order','order',o.id::text,o.order_number,o.id,
  'The order is fully refunded and was never shipped, but is still ' || o.fulfillment_status ||
  '. Cancel it (restoring the inventory) so its product cost and shipping cost are settled; until then its profit cannot be stated.',
  jsonb_build_object('payment_status',o.payment_status,'fulfillment_status',o.fulfillment_status,
                     'refunds_total_cents',x.refunded,'order_total_cents',o.total_cents),
  'manual_data','/admin/orders')
FROM orders o
JOIN LATERAL (SELECT COALESCE(SUM(r.amount_cents),0)::bigint AS refunded FROM order_refunds r
              WHERE r.order_id = o.id AND r.status = 'succeeded') x ON TRUE
WHERE o.paid_at IS NOT NULL AND o.payment_status = 'refunded'
  AND o.fulfillment_status IN ('unfulfilled','processing')
  AND o.total_cents > 0 AND x.refunded = o.total_cents
  AND NOT EXISTS (SELECT 1 FROM shipments s       WHERE s.order_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM order_returns t   WHERE t.order_id = o.id AND t.status <> 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM order_exchanges e WHERE e.order_id = o.id AND e.status <> 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM order_disputes d  WHERE d.order_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM order_cancellations k WHERE k.order_id = o.id)

-- ── a cancellation on an order that was not fully refunded ──────────────────
UNION ALL
SELECT fi_f('CANCELLATION_ORDER_NOT_FULLY_REFUNDED','exception','order','order',c.order_id::text,c.order_number,c.order_id,
  'A pre-shipment cancellation is recorded, but the order is not fully refunded.',
  jsonb_build_object('payment_status',c.payment_status,'refunds_total_cents',c.refunded,'order_total_cents',c.total_cents),
  'manual_review','/admin/orders')
FROM c WHERE c.payment_status <> 'refunded' OR c.refunded < c.total_cents

-- ── a cancellation on an order that shipped ─────────────────────────────────
UNION ALL
SELECT fi_f('CANCELLATION_ORDER_SHIPPED','exception','order','order',c.order_id::text,c.order_number,c.order_id,
  'A pre-shipment cancellation is recorded, but the order has a shipment or is shipped / delivered.',
  jsonb_build_object('fulfillment_status',c.fulfillment_status,'shipments',c.shipments),
  'manual_review','/admin/orders')
FROM c WHERE c.fulfillment_status IN ('shipped','delivered') OR c.shipments > 0

UNION ALL
SELECT fi_f('CANCELLATION_FULFILLMENT_MISMATCH','exception','order','order',c.order_id::text,c.order_number,c.order_id,
  'A pre-shipment cancellation is recorded, but the order is not marked cancelled.',
  jsonb_build_object('fulfillment_status',c.fulfillment_status),
  'manual_review','/admin/orders')
FROM c WHERE c.fulfillment_status NOT IN ('cancelled','shipped','delivered')

-- ── restored quantity vs sold quantity (in total, per line, per order) ──────
UNION ALL
SELECT fi_f('CANCELLATION_QUANTITY_MISMATCH','exception','inventory','order',c.order_id::text,c.order_number,c.order_id,
  'The quantity restored by the cancellation is not the quantity the order sold.',
  jsonb_build_object('sold_units',c.sold_units,'restored_units',c.restored_units,'recorded_units',c.restocked_units),
  'manual_review','/admin/financials/inventory')
FROM c
WHERE c.restored_units <> c.sold_units OR c.restocked_units <> c.restored_units
   OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = c.order_id
              AND oi.quantity <> COALESCE((SELECT SUM(i.quantity) FROM order_cancellation_items i
                                           WHERE i.cancellation_id = c.cid AND i.order_item_id = oi.id),0))
   OR EXISTS (SELECT 1 FROM order_cancellation_items i JOIN order_items oi ON oi.id = i.order_item_id
              WHERE i.cancellation_id = c.cid AND oi.order_id <> c.order_id)

-- ── restored layer missing / wrong ──────────────────────────────────────────
UNION ALL
SELECT fi_f('CANCELLATION_LAYER_MISSING','exception','inventory','order',c.order_id::text,c.order_number,c.order_id,
  'A cancelled order''s restored units are not backed by a matching cancellation-restock inventory layer.',
  jsonb_build_object('items',(SELECT jsonb_agg(jsonb_build_object('item_id',i.id,'layer_id',i.layer_id,'quantity',i.quantity) ORDER BY i.id)
                              FROM order_cancellation_items i WHERE i.cancellation_id = c.cid)),
  'manual_review','/admin/financials/inventory')
FROM c
WHERE EXISTS (
  SELECT 1 FROM order_cancellation_items i
  WHERE i.cancellation_id = c.cid
    AND NOT EXISTS (SELECT 1 FROM inventory_cost_layers l
                    WHERE l.id = i.layer_id AND l.source = 'cancellation_restock'
                      AND l.cancellation_id = c.cid AND l.variant_id = i.variant_id
                      AND l.units_received = i.quantity))

-- ── restock movement missing / wrong ────────────────────────────────────────
UNION ALL
SELECT fi_f('CANCELLATION_MOVEMENT_MISSING','exception','inventory','order',c.order_id::text,c.order_number,c.order_id,
  'The stock movement for a cancelled order is missing or does not equal the quantity restored.',
  jsonb_build_object('restored_units',c.restored_units,
    'movement_units',(SELECT COALESCE(SUM(m.quantity_delta),0) FROM inventory_movements m
                      WHERE m.order_id = c.order_id AND m.movement_type = 'CANCEL_RESTOCK')),
  'manual_review','/admin/financials/inventory')
FROM c
WHERE EXISTS (SELECT 1 FROM order_cancellation_items i WHERE i.cancellation_id = c.cid AND i.movement_id IS NULL)
   OR EXISTS (
        SELECT 1 FROM (SELECT i.variant_id, SUM(i.quantity)::bigint AS q
                       FROM order_cancellation_items i WHERE i.cancellation_id = c.cid
                       GROUP BY i.variant_id) v
        WHERE v.q IS DISTINCT FROM (SELECT SUM(m.quantity_delta)::bigint FROM inventory_movements m
                                    WHERE m.order_id = c.order_id AND m.movement_type = 'CANCEL_RESTOCK'
                                      AND m.variant_id = v.variant_id))
   OR EXISTS (SELECT 1 FROM inventory_movements m
              WHERE m.order_id = c.order_id AND m.movement_type = 'CANCEL_RESTOCK'
                AND NOT EXISTS (SELECT 1 FROM order_cancellation_items i
                                WHERE i.cancellation_id = c.cid AND i.variant_id = m.variant_id))

-- ── COGS credit vs the restored layers and the original consumptions ────────
UNION ALL
SELECT fi_f('CANCELLATION_COGS_CREDIT_MISMATCH','exception','inventory','order',c.order_id::text,c.order_number,c.order_id,
  'The cancellation''s COGS credit does not equal the value of the layers it restored, or a restored cost differs from the original sale cost.',
  jsonb_build_object('recorded_credit_cents',c.cogs_credit_cents,
    'layer_value_cents',(SELECT CASE WHEN bool_or(l.unit_landed_cost_cents IS NULL) THEN NULL
                                     ELSE SUM(l.units_received * l.unit_landed_cost_cents)::int END
                         FROM order_cancellation_items i JOIN inventory_cost_layers l ON l.id = i.layer_id
                         WHERE i.cancellation_id = c.cid)),
  'manual_review','/admin/financials/inventory')
FROM c
WHERE c.cogs_credit_cents IS DISTINCT FROM
        (SELECT CASE WHEN bool_or(l.unit_landed_cost_cents IS NULL) THEN NULL
                     ELSE SUM(l.units_received * l.unit_landed_cost_cents)::int END
         FROM order_cancellation_items i JOIN inventory_cost_layers l ON l.id = i.layer_id
         WHERE i.cancellation_id = c.cid)
   OR EXISTS (SELECT 1 FROM order_cancellation_items i
              LEFT JOIN inventory_layer_consumptions k ON k.id = i.source_consumption_id
              WHERE i.cancellation_id = c.cid AND i.source_consumption_id IS NOT NULL
                AND (k.id IS NULL
                     OR i.unit_cost_cents IS DISTINCT FROM CASE WHEN k.coverage = 'layer' THEN k.unit_cost_cents END
                     OR i.quantity <> k.quantity))

-- ── duplicate cancellation / restock ────────────────────────────────────────
UNION ALL
SELECT fi_f('CANCELLATION_DUPLICATE','exception','inventory','order',o.id::text,o.order_number,o.id,
  'The same order was cancelled or restocked more than once.',
  jsonb_build_object('cancellations',d.n_cancellations,'restores_of_one_consumption',d.n_dup_consumptions,
                     'restock_movements',d.n_movements,'variants_restored',d.n_variants),
  'manual_review','/admin/financials/inventory')
FROM orders o
JOIN LATERAL (
  SELECT (SELECT COUNT(*) FROM order_cancellations k WHERE k.order_id = o.id)::int AS n_cancellations,
         (SELECT COUNT(*) FROM (SELECT i.source_consumption_id
                                FROM order_cancellation_items i
                                JOIN order_cancellations k ON k.id = i.cancellation_id
                                WHERE k.order_id = o.id AND i.source_consumption_id IS NOT NULL
                                GROUP BY i.source_consumption_id HAVING COUNT(*) > 1) z)::int AS n_dup_consumptions,
         (SELECT COUNT(*) FROM inventory_movements m
            WHERE m.order_id = o.id AND m.movement_type = 'CANCEL_RESTOCK')::int AS n_movements,
         (SELECT COUNT(DISTINCT i.variant_id) FROM order_cancellation_items i
            JOIN order_cancellations k ON k.id = i.cancellation_id WHERE k.order_id = o.id)::int AS n_variants
) d ON TRUE
WHERE d.n_cancellations > 1 OR d.n_dup_consumptions > 0
   OR (d.n_cancellations >= 1 AND d.n_movements > d.n_variants)

-- ── unknown restored cost: INCOMPLETE, never zero ───────────────────────────
UNION ALL
SELECT fi_f('CANCELLATION_RESTOCK_COST_UNKNOWN','incomplete','inventory','order',c.order_id::text,c.order_number,c.order_id,
  'Some restored units have an unknown original cost, so the cancellation''s COGS credit is unknown (not zero) and the order''s profit cannot be stated.',
  jsonb_build_object('unknown_cost_units',c.unknown_cost_units,'cogs_credit_cents',c.cogs_credit_cents),
  'manual_data','/admin/financials/inventory')
FROM c
WHERE c.cogs_credit_cents IS NULL OR c.unknown_cost_units > 0
   OR EXISTS (SELECT 1 FROM order_cancellation_items i
              WHERE i.cancellation_id = c.cid AND i.unit_cost_cents IS NULL)
$$;

CREATE OR REPLACE FUNCTION financial_integrity_scan()
RETURNS SETOF financial_integrity_finding
LANGUAGE sql STABLE AS $$
  SELECT * FROM fi_scan_orders()
  UNION ALL SELECT * FROM fi_scan_refunds()
  UNION ALL SELECT * FROM fi_scan_disputes()
  UNION ALL SELECT * FROM fi_scan_inventory()
  UNION ALL SELECT * FROM fi_scan_affiliates()
  UNION ALL SELECT * FROM fi_scan_expenses()
  UNION ALL SELECT * FROM fi_scan_cancellations();
$$;

COMMIT;
