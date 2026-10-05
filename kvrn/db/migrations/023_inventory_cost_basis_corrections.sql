-- 023_inventory_cost_basis_corrections.sql
--
-- Supplies a previously-unknown landed-cost basis to a migration opening
-- inventory layer without fabricating inventory or rewriting known economics.
--
-- Economic event history (quantity, order, movement, timestamps) remains
-- unchanged. Only previously-NULL cost metadata may be enriched once.
--
-- The correction is:
--   * atomic
--   * batch-backed
--   * product / variant / color scoped
--   * recorded in an append-only correction ledger
--   * recorded in admin_audit_logs
--   * idempotent for the same layer + batch
--   * forbidden from changing any already-known cost
--
-- This supports the intentional rule established in migration 021:
-- UNKNOWN COGS may be supplied once; KNOWN COGS is immutable.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Append-only correction ledger
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inventory_cost_basis_corrections (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id          UUID        NOT NULL
                    REFERENCES inventory_cost_layers(id) ON DELETE RESTRICT,
  cost_batch_id     UUID        NOT NULL
                    REFERENCES product_cost_batches(id) ON DELETE RESTRICT,
  unit_cost_cents   INTEGER     NOT NULL CHECK (unit_cost_cents >= 0),
  reason            TEXT        NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_email       TEXT        NOT NULL CHECK (length(btrim(actor_email)) > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT inventory_cost_basis_corrections_layer_uq UNIQUE (layer_id)
);

CREATE INDEX IF NOT EXISTS idx_icbc_batch
  ON inventory_cost_basis_corrections(cost_batch_id);

CREATE INDEX IF NOT EXISTS idx_icbc_created
  ON inventory_cost_basis_corrections(created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Correction ledger is truly append-only
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION inventory_cost_basis_correction_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'KVRN_COST_CORRECTION|APPEND_ONLY|operation % is not permitted',
    TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS inventory_cost_basis_correction_append_only
  ON inventory_cost_basis_corrections;

CREATE TRIGGER inventory_cost_basis_correction_append_only
  BEFORE UPDATE OR DELETE ON inventory_cost_basis_corrections
  FOR EACH ROW
  EXECUTE FUNCTION inventory_cost_basis_correction_append_only_guard();

DROP TRIGGER IF EXISTS inventory_cost_basis_correction_no_truncate
  ON inventory_cost_basis_corrections;

CREATE TRIGGER inventory_cost_basis_correction_no_truncate
  BEFORE TRUNCATE ON inventory_cost_basis_corrections
  FOR EACH STATEMENT
  EXECUTE FUNCTION inventory_cost_basis_correction_append_only_guard();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Once an inventory layer cost is known, it cannot change.
--
-- A NULL -> known transition is permitted ONLY when a matching correction
-- ledger row already exists in the same transaction.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION inventory_layer_cost_basis_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_correction inventory_cost_basis_corrections;
BEGIN
  -- A known landed cost is immutable.
  IF OLD.unit_landed_cost_cents IS NOT NULL THEN
    IF NEW.unit_landed_cost_cents IS DISTINCT FROM OLD.unit_landed_cost_cents
       OR NEW.cost_batch_id IS DISTINCT FROM OLD.cost_batch_id THEN
      RAISE EXCEPTION
        'KVRN_COST_CORRECTION|LAYER_COST_IMMUTABLE|layer %',
        OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- Do not attach/change a cost batch while cost remains unknown.
  IF NEW.unit_landed_cost_cents IS NULL THEN
    IF NEW.cost_batch_id IS DISTINCT FROM OLD.cost_batch_id THEN
      RAISE EXCEPTION
        'KVRN_COST_CORRECTION|BATCH_WITHOUT_COST|layer %',
        OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- NULL -> known requires the append-only correction record.
  SELECT *
  INTO v_correction
  FROM inventory_cost_basis_corrections
  WHERE layer_id = OLD.id;

  IF NOT FOUND
     OR v_correction.unit_cost_cents <> NEW.unit_landed_cost_cents
     OR v_correction.cost_batch_id IS DISTINCT FROM NEW.cost_batch_id THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|UNAUTHORIZED_LAYER_ENRICHMENT|layer %',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_layer_cost_basis_guard_trg
  ON inventory_cost_layers;

CREATE TRIGGER inventory_layer_cost_basis_guard_trg
  BEFORE UPDATE OF unit_landed_cost_cents, cost_batch_id
  ON inventory_cost_layers
  FOR EACH ROW
  EXECUTE FUNCTION inventory_layer_cost_basis_guard();


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Consumption cost enrichment guard
--
-- The sale-consumption row remains the original economic event. Its quantity,
-- layer identity, order identity, movement and timestamp never change.
--
-- Only its previously-NULL cost metadata may be supplied once, and only from
-- the correction registered for its layer.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION inventory_consumption_cost_basis_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_correction inventory_cost_basis_corrections;
BEGIN
  -- Any already-known cost is immutable.
  IF OLD.unit_cost_cents IS NOT NULL OR OLD.total_cost_cents IS NOT NULL THEN
    IF NEW.unit_cost_cents IS DISTINCT FROM OLD.unit_cost_cents
       OR NEW.total_cost_cents IS DISTINCT FROM OLD.total_cost_cents THEN
      RAISE EXCEPTION
        'KVRN_COST_CORRECTION|CONSUMPTION_COST_IMMUTABLE|consumption %',
        OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- Leaving both unknown is harmless.
  IF NEW.unit_cost_cents IS NULL AND NEW.total_cost_cents IS NULL THEN
    RETURN NEW;
  END IF;

  -- A partial cost is never valid.
  IF NEW.unit_cost_cents IS NULL OR NEW.total_cost_cents IS NULL THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|PARTIAL_CONSUMPTION_COST|consumption %',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.coverage <> 'layer' OR OLD.layer_id IS NULL THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|UNCOVERED_CONSUMPTION|consumption %',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT *
  INTO v_correction
  FROM inventory_cost_basis_corrections
  WHERE layer_id = OLD.layer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|MISSING_CORRECTION|consumption %',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.unit_cost_cents <> v_correction.unit_cost_cents
     OR NEW.total_cost_cents <> v_correction.unit_cost_cents * OLD.quantity THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|CONSUMPTION_COST_MISMATCH|consumption %',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_consumption_cost_basis_guard_trg
  ON inventory_layer_consumptions;

CREATE TRIGGER inventory_consumption_cost_basis_guard_trg
  BEFORE UPDATE OF unit_cost_cents, total_cost_cents
  ON inventory_layer_consumptions
  FOR EACH ROW
  EXECUTE FUNCTION inventory_consumption_cost_basis_guard();


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Official correction function
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION supply_missing_inventory_cost_basis(
  p_layer_id       UUID,
  p_cost_batch_id  UUID,
  p_actor          TEXT,
  p_reason         TEXT
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_layer               inventory_cost_layers;
  v_batch               product_cost_batches;
  v_variant             product_variants;
  v_existing            inventory_cost_basis_corrections;
  v_correction_id       UUID;
  v_unit_cost           INTEGER;
  v_consumptions        INTEGER := 0;
  v_order_items_updated INTEGER := 0;
BEGIN
  IF p_layer_id IS NULL OR p_cost_batch_id IS NULL THEN
    RAISE EXCEPTION 'KVRN_COST_CORRECTION|MISSING_IDENTIFIER';
  END IF;

  IF p_actor IS NULL OR length(btrim(p_actor)) = 0 THEN
    RAISE EXCEPTION 'KVRN_COST_CORRECTION|MISSING_ACTOR';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'KVRN_COST_CORRECTION|MISSING_REASON';
  END IF;

  -- Serialize correction attempts for this layer.
  SELECT *
  INTO v_layer
  FROM inventory_cost_layers
  WHERE id = p_layer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|LAYER_NOT_FOUND|%',
      p_layer_id;
  END IF;

  -- Exact retry is idempotent.
  SELECT *
  INTO v_existing
  FROM inventory_cost_basis_corrections
  WHERE layer_id = p_layer_id;

  IF FOUND THEN
    IF v_existing.cost_batch_id = p_cost_batch_id THEN
      RETURN jsonb_build_object(
        'outcome', 'already_corrected',
        'correction_id', v_existing.id,
        'layer_id', p_layer_id,
        'cost_batch_id', p_cost_batch_id,
        'unit_cost_cents', v_existing.unit_cost_cents
      );
    END IF;

    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|LAYER_ALREADY_CORRECTED|%',
      p_layer_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- This mechanism is intentionally limited to migration opening balances.
  IF v_layer.source <> 'opening_balance'
     OR NOT v_layer.is_migration_opening THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|NOT_MIGRATION_OPENING_LAYER|%',
      p_layer_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_layer.unit_landed_cost_cents IS NOT NULL
     OR v_layer.cost_batch_id IS NOT NULL THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|LAYER_COST_ALREADY_KNOWN|%',
      p_layer_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT *
  INTO v_batch
  FROM product_cost_batches
  WHERE id = p_cost_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|COST_BATCH_NOT_FOUND|%',
      p_cost_batch_id;
  END IF;

  SELECT *
  INTO v_variant
  FROM product_variants
  WHERE id = v_layer.variant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|VARIANT_NOT_FOUND|%',
      v_layer.variant_id;
  END IF;

  -- Batch must belong to this product.
  IF v_batch.product_id <> v_variant.product_id THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|PRODUCT_SCOPE_MISMATCH'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Variant-specific batch must match this exact variant.
  IF v_batch.variant_id IS NOT NULL
     AND v_batch.variant_id <> v_variant.id THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|VARIANT_SCOPE_MISMATCH'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Color batch must match this variant's color.
  IF v_batch.variant_id IS NULL
     AND v_batch.color_name IS NOT NULL
     AND v_batch.color_name <> v_variant.color_name THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|COLOR_SCOPE_MISMATCH'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Do not allow a future-dated batch to establish today's historical basis.
  IF v_batch.effective_from > (NOW() AT TIME ZONE 'UTC')::DATE THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|FUTURE_COST_BATCH|%',
      v_batch.effective_from
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_unit_cost := v_batch.unit_cogs_cents;

  IF v_unit_cost IS NULL OR v_unit_cost < 0 THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|INVALID_BATCH_COST'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- This first version intentionally supports sale history only. If the same
  -- unknown opening layer fed a write-off/exchange/etc, that needs its own
  -- economically-aware correction path rather than guessing.
  IF EXISTS (
    SELECT 1
    FROM inventory_layer_consumptions
    WHERE layer_id = p_layer_id
      AND consumption_type <> 'sale'
  ) THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|UNSUPPORTED_CONSUMPTION_TYPE'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Existing consumption costs must still be fully unknown.
  IF EXISTS (
    SELECT 1
    FROM inventory_layer_consumptions
    WHERE layer_id = p_layer_id
      AND (
        unit_cost_cents IS NOT NULL
        OR total_cost_cents IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|CONSUMPTION_COST_ALREADY_KNOWN'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Every sale consumption must point back to its finalized order line.
  IF EXISTS (
    SELECT 1
    FROM inventory_layer_consumptions
    WHERE layer_id = p_layer_id
      AND consumption_type = 'sale'
      AND order_item_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|SALE_WITHOUT_ORDER_ITEM'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Do not rewrite an order line that already has any COGS fact.
  IF EXISTS (
    SELECT 1
    FROM order_items oi
    WHERE oi.id IN (
      SELECT c.order_item_id
      FROM inventory_layer_consumptions c
      WHERE c.layer_id = p_layer_id
        AND c.consumption_type = 'sale'
        AND c.order_item_id IS NOT NULL
    )
    AND (
      oi.unit_cogs_cents IS NOT NULL
      OR oi.line_cogs_cents IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION
      'KVRN_COST_CORRECTION|ORDER_COGS_ALREADY_KNOWN'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Ledger row is inserted FIRST. The guards below then authorize the
  -- NULL -> known enrichments. Everything is in this same transaction.
  INSERT INTO inventory_cost_basis_corrections (
    layer_id,
    cost_batch_id,
    unit_cost_cents,
    reason,
    actor_email
  ) VALUES (
    p_layer_id,
    p_cost_batch_id,
    v_unit_cost,
    btrim(p_reason),
    btrim(p_actor)
  )
  RETURNING id INTO v_correction_id;

  -- Supply the landed-cost basis to the physical opening layer.
  UPDATE inventory_cost_layers
  SET
    unit_landed_cost_cents = v_unit_cost,
    cost_batch_id = p_cost_batch_id,
    cost_basis_source = 'cost_batch',
    cost_basis_note =
      concat_ws(
        ' ',
        NULLIF(btrim(COALESCE(cost_basis_note, '')), ''),
        'Previously unknown opening-balance cost supplied by correction '
        || v_correction_id::text || '.'
      )
  WHERE id = p_layer_id;

  -- Enrich ONLY the cost metadata on historical covered sale consumptions.
  -- Quantity, layer, movement, order, order-item and timestamps are untouched.
  UPDATE inventory_layer_consumptions
  SET
    unit_cost_cents = v_unit_cost,
    total_cost_cents = v_unit_cost * quantity
  WHERE layer_id = p_layer_id
    AND consumption_type = 'sale'
    AND coverage = 'layer'
    AND unit_cost_cents IS NULL
    AND total_cost_cents IS NULL;

  GET DIAGNOSTICS v_consumptions = ROW_COUNT;

  -- Recompute affected order-line COGS from ALL of that order line's FIFO sale
  -- consumptions. Only complete, fully-known coverage may become a known COGS
  -- snapshot. The migration-021 snapshot guard then freezes it forever.
  WITH affected AS (
    SELECT DISTINCT order_item_id
    FROM inventory_layer_consumptions
    WHERE layer_id = p_layer_id
      AND consumption_type = 'sale'
      AND order_item_id IS NOT NULL
  ),
  calculated AS (
    SELECT
      oi.id AS order_item_id,
      oi.quantity,
      SUM(c.total_cost_cents)::INTEGER AS line_cost_cents,
      BOOL_OR(
        c.coverage = 'uncovered'
        OR c.total_cost_cents IS NULL
        OR c.unit_cost_cents IS NULL
      ) AS has_unknown,
      CASE
        WHEN COUNT(*) FILTER (WHERE l.cost_batch_id IS NULL) = 0
         AND COUNT(DISTINCT l.cost_batch_id) = 1
        THEN MAX(l.cost_batch_id::TEXT)::UUID
        ELSE NULL
      END AS single_cost_batch_id
    FROM affected a
    JOIN order_items oi
      ON oi.id = a.order_item_id
    JOIN inventory_layer_consumptions c
      ON c.order_item_id = oi.id
     AND c.consumption_type = 'sale'
    LEFT JOIN inventory_cost_layers l
      ON l.id = c.layer_id
    GROUP BY oi.id, oi.quantity
  )
  UPDATE order_items oi
  SET
    unit_cogs_cents =
      ROUND(calculated.line_cost_cents::NUMERIC / oi.quantity)::INTEGER,
    line_cogs_cents = calculated.line_cost_cents,
    cost_batch_id = calculated.single_cost_batch_id
  FROM calculated
  WHERE oi.id = calculated.order_item_id
    AND calculated.has_unknown = FALSE
    AND oi.unit_cogs_cents IS NULL
    AND oi.line_cogs_cents IS NULL;

  GET DIAGNOSTICS v_order_items_updated = ROW_COUNT;

  INSERT INTO admin_audit_logs (
    actor_email,
    action,
    resource,
    resource_id,
    payload
  ) VALUES (
    btrim(p_actor),
    'supply_missing_inventory_cost_basis',
    'inventory_cost_layers',
    p_layer_id::TEXT,
    jsonb_build_object(
      'correction_id', v_correction_id,
      'cost_batch_id', p_cost_batch_id,
      'unit_cost_cents', v_unit_cost,
      'variant_id', v_layer.variant_id,
      'units_received', v_layer.units_received,
      'units_remaining', v_layer.units_remaining,
      'sale_consumptions_enriched', v_consumptions,
      'order_items_enriched', v_order_items_updated,
      'reason', btrim(p_reason)
    )
  );

  RETURN jsonb_build_object(
    'outcome', 'corrected',
    'correction_id', v_correction_id,
    'layer_id', p_layer_id,
    'cost_batch_id', p_cost_batch_id,
    'unit_cost_cents', v_unit_cost,
    'sale_consumptions_enriched', v_consumptions,
    'order_items_enriched', v_order_items_updated
  );
END;
$$;

COMMENT ON TABLE inventory_cost_basis_corrections IS
  'Append-only ledger for supplying a previously unknown migration-opening inventory cost basis.';

COMMENT ON FUNCTION supply_missing_inventory_cost_basis(UUID, UUID, TEXT, TEXT) IS
  'Atomically supplies a missing opening-layer cost basis from an authoritative product cost batch; only NULL costs may be enriched and known costs remain immutable.';

COMMIT;
