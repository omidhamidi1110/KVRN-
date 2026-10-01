-- KVRN Migration 019 — FIFO inventory cost layers, write-offs and purchases
--
-- Phase B Batch 3, part 2 of 3 (018 -> 019 -> 020).
--
-- ⚠️ THIS MIGRATION REPLACES finalize_paid_order — the function that creates every
-- paid order. The replacement was diffed line-by-line against migration 017. The
-- ONLY intended behavioural change is that sale COGS now comes from authoritative
-- FIFO layer consumption instead of a date-effective cost lookup. Every other
-- behaviour is preserved verbatim; see the function header for the full audit.
--
-- ── WHY FIFO ────────────────────────────────────────────────────────────────
--
-- resolve_cost_batch assigns whichever cost batch was in force on the sale date.
-- That cannot value remaining inventory correctly once acquisition cost changes:
-- 20 units at $25 followed by 20 at $32 would value all remaining stock at $32.
-- Sales, write-offs, promos, restocks and valuation now share ONE costing method,
-- so inventory value and COGS reconcile.
--
-- ── LAYERS TRACK PHYSICAL STOCK, NOT AVAILABILITY ───────────────────────────
--
-- Audited reservation lifecycle (unchanged by this migration):
--   reserve  -> reserved_quantity +qty, stock_on_hand UNCHANGED
--   release  -> reserved_quantity -qty, stock_on_hand UNCHANGED
--   paid     -> stock_on_hand -qty AND reserved_quantity -qty
--
-- stock_on_hand is therefore PHYSICAL on-hand, including reserved-but-unpaid
-- units. Layers mirror it exactly, so reservations must NOT touch layers. FIFO
-- consumption happens only at the paid DEDUCT point, in the same transaction as
-- the stock decrement.
--
--   available = stock_on_hand - reserved_quantity        (unchanged)
--   SUM(layer units_remaining) = stock_on_hand           (invariant)
--
-- units_remaining is a DECOMPOSITION of stock_on_hand, not a second counter.
--
-- ── UNKNOWN COST IS NEVER ZERO ──────────────────────────────────────────────
--
-- A layer may have unit_landed_cost_cents = NULL when no authoritative cost
-- exists. Consumption of such a layer yields NULL cost, and the order line's
-- COGS becomes NULL — "unknown", never 0.
--
-- A layer SHORTAGE never aborts an already-paid customer order. The uncovered
-- quantity is recorded as an explicit accounting exception so quantity still
-- reconciles while the cost gap is visible.
--
-- ── CUTOVER ─────────────────────────────────────────────────────────────────
--
-- Orders paid BEFORE this migration keep their date-effective COGS snapshots and
-- are immutable. Opening-balance layers are seeded from current stock_on_hand.
-- No pre-cutover FIFO history exists and none is claimed; reconciliation applies
-- from the cutover forward only.
--
-- Run after 001-018.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- INVENTORY PURCHASES — capitalised cost vs actual cash
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cash and cost recognition are deliberately different tables. A supplier
-- deposit paid in March for goods received in May is cash in March and inventory
-- cost from May, consumed into COGS only as units sell.
CREATE TABLE IF NOT EXISTS inventory_purchases (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier        TEXT        NOT NULL,
  reference       TEXT,
  status          TEXT        NOT NULL DEFAULT 'ordered'
    CHECK (status IN ('draft','ordered','received','closed','cancelled')),

  -- Expected total; the authoritative capitalised cost lives on the cost batch.
  total_cents     INTEGER     CHECK (total_cents IS NULL OR total_cents >= 0),
  currency        TEXT        NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),

  ordered_at      DATE,
  received_at     DATE,

  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ip_supplier ON inventory_purchases(supplier, ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_status   ON inventory_purchases(status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_ip_updated_at') THEN
    CREATE TRIGGER set_ip_updated_at BEFORE UPDATE ON inventory_purchases
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ACTUAL CASH ONLY. paid_at is the authoritative cash date and is the ONLY thing
-- cash-flow reporting reads. These rows are never operating expenses and never
-- COGS: supplier, freight, duty and brokerage dollars capitalise into inventory
-- and reach the P&L solely through FIFO consumption.
CREATE TABLE IF NOT EXISTS inventory_purchase_payments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id     UUID        NOT NULL REFERENCES inventory_purchases(id) ON DELETE RESTRICT,

  payment_type    TEXT        NOT NULL
    CHECK (payment_type IN ('deposit','partial','final','supplier','freight',
                            'duties','tariffs','customs_brokerage','other')),
  amount_cents    INTEGER     NOT NULL CHECK (amount_cents >= 0),
  currency        TEXT        NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),

  -- The date money actually left KVRN. NOT a receipt date.
  paid_at         DATE        NOT NULL,

  method          TEXT,
  reference       TEXT,
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ipp_paid     ON inventory_purchase_payments(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_ipp_purchase ON inventory_purchase_payments(purchase_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- product_cost_batches — received quantity and batch-level landed totals
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Freight and duties arrive as a batch total, not per unit. When units_received
-- is supplied the per-unit components are DERIVED at batch creation and written
-- into the existing per-unit columns, so nothing downstream changes. Existing
-- per-unit entry keeps working unchanged, and no historical snapshot is touched.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product_cost_batches' AND column_name = 'units_received'
  ) THEN
    ALTER TABLE product_cost_batches ADD COLUMN units_received INTEGER
      CHECK (units_received IS NULL OR units_received > 0);
    ALTER TABLE product_cost_batches ADD COLUMN purchase_id UUID
      REFERENCES inventory_purchases(id) ON DELETE SET NULL;

    ALTER TABLE product_cost_batches ADD COLUMN freight_total_cents    INTEGER
      CHECK (freight_total_cents    IS NULL OR freight_total_cents    >= 0);
    ALTER TABLE product_cost_batches ADD COLUMN duties_total_cents     INTEGER
      CHECK (duties_total_cents     IS NULL OR duties_total_cents     >= 0);
    ALTER TABLE product_cost_batches ADD COLUMN tariffs_total_cents    INTEGER
      CHECK (tariffs_total_cents    IS NULL OR tariffs_total_cents    >= 0);
    ALTER TABLE product_cost_batches ADD COLUMN import_tax_total_cents INTEGER
      CHECK (import_tax_total_cents IS NULL OR import_tax_total_cents >= 0);
    ALTER TABLE product_cost_batches ADD COLUMN other_landed_total_cents INTEGER
      CHECK (other_landed_total_cents IS NULL OR other_landed_total_cents >= 0);

    -- AUTHORITATIVE capitalised total for the whole intended batch, in cents,
    -- INCLUDING remainder cents that the floored per-unit columns cannot hold.
    -- Reporting must read this, never unit_cogs_cents x units_received: $100
    -- across 3 units floors to 3333 and multiplies back to 9999, fabricating a
    -- 1-cent variance against inventory that is in fact exactly correct.
    ALTER TABLE product_cost_batches ADD COLUMN capitalized_total_cents INTEGER
      CHECK (capitalized_total_cents IS NULL OR capitalized_total_cents >= 0);

    -- Set once derive_batch_unit_costs has written the per-unit components.
    -- Without it, a second derivation would see its OWN output sitting in the
    -- per-unit columns and wrongly reject the batch as mixed-mode entry.
    ALTER TABLE product_cost_batches ADD COLUMN landed_derived_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pcb_purchase ON product_cost_batches(purchase_id)
  WHERE purchase_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- INVENTORY COST LAYERS — the FIFO queue
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS inventory_cost_layers (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id            UUID        NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  cost_batch_id         UUID        REFERENCES product_cost_batches(id) ON DELETE SET NULL,

  units_received        INTEGER     NOT NULL CHECK (units_received > 0),
  -- Decomposition of stock_on_hand. Never a second counter.
  units_remaining       INTEGER     NOT NULL CHECK (units_remaining >= 0),

  -- NULL = cost genuinely unknown. NEVER interpret as zero.
  unit_landed_cost_cents INTEGER
    CHECK (unit_landed_cost_cents IS NULL OR unit_landed_cost_cents >= 0),

  source                TEXT        NOT NULL
    CHECK (source IN ('purchase','opening_balance','return_restock','manual_adjustment')),

  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Opening-balance provenance. These make clear the layer is a migration
  -- valuation, not reconstructed historical FIFO.
  opening_cutover_at    TIMESTAMPTZ,
  cost_basis_source     TEXT
    CHECK (cost_basis_source IS NULL
           OR cost_basis_source IN ('date_effective_at_cutover','cost_batch',
                                    'return_snapshot','unknown')),
  is_migration_opening  BOOLEAN     NOT NULL DEFAULT FALSE,
  cost_basis_note       TEXT,

  -- Traceability for restock layers.
  return_item_id        UUID REFERENCES order_return_items(id) ON DELETE SET NULL,

  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT icl_remaining_le_received CHECK (units_remaining <= units_received)
);

-- The FIFO queue itself: oldest layer with stock left, per variant.
CREATE INDEX IF NOT EXISTS idx_icl_fifo
  ON inventory_cost_layers(variant_id, received_at, id)
  WHERE units_remaining > 0;
CREATE INDEX IF NOT EXISTS idx_icl_variant ON inventory_cost_layers(variant_id);
CREATE INDEX IF NOT EXISTS idx_icl_batch   ON inventory_cost_layers(cost_batch_id)
  WHERE cost_batch_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- INVENTORY BATCH RECEIPTS — append-only receipt progress per cost batch
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A cost batch may be received in several physical shipments. Two things go
-- wrong without an authoritative record of receipt progress:
--
--   1. REMAINDER CENTS LEAK. Scaling the remainder independently on each call
--      (round(remainder x qty / units)) loses money on fine partitions: a 1c
--      remainder over 3 units received 1+1+1 rounds to zero every time, so the
--      cent vanishes even though the completed batch should reconcile exactly.
--      Allocation is therefore CUMULATIVE — the same telescoping method used for
--      partial return allocation in 018:
--          premium_this = round(rem x (received_before + qty) / units)
--                       - round(rem x  received_before        / units)
--      Summed over any partition of the batch this collapses to round(rem) = rem.
--
--   2. DOUBLE RECEIPT. Without cumulative progress the same batch could add
--      stock more than once. received_to_date is derived from these rows and
--      guarded against units_received.
CREATE TABLE IF NOT EXISTS inventory_batch_receipts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_batch_id     UUID        NOT NULL REFERENCES product_cost_batches(id) ON DELETE RESTRICT,
  variant_id        UUID        NOT NULL REFERENCES product_variants(id)     ON DELETE RESTRICT,

  quantity          INTEGER     NOT NULL CHECK (quantity > 0),
  -- Cumulative premium units allocated AFTER this receipt, so the telescoping
  -- decision is auditable rather than recomputed.
  premium_units_after INTEGER   NOT NULL DEFAULT 0 CHECK (premium_units_after >= 0),
  premium_units_this  INTEGER   NOT NULL DEFAULT 0 CHECK (premium_units_this  >= 0),

  base_layer_id     UUID REFERENCES inventory_cost_layers(id) ON DELETE SET NULL,
  premium_layer_id  UUID REFERENCES inventory_cost_layers(id) ON DELETE SET NULL,
  movement_id       UUID REFERENCES inventory_movements(id)   ON DELETE SET NULL,

  -- Optional caller-supplied key. A retried request with the same key is a
  -- no-op rather than a second stock addition.
  idempotency_key   TEXT,

  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT,

  CONSTRAINT ibr_idempotency_uq UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ibr_batch   ON inventory_batch_receipts(cost_batch_id, received_at);
CREATE INDEX IF NOT EXISTS idx_ibr_variant ON inventory_batch_receipts(variant_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- INVENTORY LAYER CONSUMPTIONS — append-only
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every unit leaving physical stock is recorded here against the layer it came
-- from. coverage='uncovered' rows carry layer_id NULL and represent an
-- accounting exception: the quantity left, but no layer covered it, so its cost
-- is unknown rather than invented.
CREATE TABLE IF NOT EXISTS inventory_layer_consumptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id          UUID        REFERENCES inventory_cost_layers(id) ON DELETE RESTRICT,
  variant_id        UUID        NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  movement_id       UUID        REFERENCES inventory_movements(id) ON DELETE SET NULL,

  quantity          INTEGER     NOT NULL CHECK (quantity > 0),

  -- NULL when the layer's cost is unknown, or when uncovered.
  unit_cost_cents   INTEGER     CHECK (unit_cost_cents  IS NULL OR unit_cost_cents  >= 0),
  total_cost_cents  INTEGER     CHECK (total_cost_cents IS NULL OR total_cost_cents >= 0),

  coverage          TEXT        NOT NULL DEFAULT 'layer'
    CHECK (coverage IN ('layer','uncovered')),

  consumption_type  TEXT        NOT NULL
    CHECK (consumption_type IN ('sale','write_off','promo','exchange_out','adjustment')),

  order_id          UUID REFERENCES orders(id)             ON DELETE SET NULL,
  order_item_id     UUID REFERENCES order_items(id)        ON DELETE SET NULL,
  write_off_id      UUID,
  exchange_id       UUID REFERENCES order_exchanges(id)    ON DELETE SET NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- An uncovered consumption has no layer and no cost, by definition.
  CONSTRAINT ilc_uncovered_has_no_layer CHECK (
    (coverage = 'uncovered' AND layer_id IS NULL AND unit_cost_cents IS NULL)
    OR (coverage = 'layer' AND layer_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ilc_layer    ON inventory_layer_consumptions(layer_id);
CREATE INDEX IF NOT EXISTS idx_ilc_variant  ON inventory_layer_consumptions(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ilc_type     ON inventory_layer_consumptions(consumption_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ilc_order    ON inventory_layer_consumptions(order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ilc_uncovered ON inventory_layer_consumptions(created_at DESC)
  WHERE coverage = 'uncovered';

-- ═══════════════════════════════════════════════════════════════════════════
-- INVENTORY WRITE-OFFS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Physical removal that produces NO sales revenue. Reasons stay distinguishable
-- so promotional cost can be separated from loss, and both from sale COGS.
CREATE TABLE IF NOT EXISTS inventory_write_offs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id          UUID        NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity            INTEGER     NOT NULL CHECK (quantity > 0),

  reason              TEXT        NOT NULL
    CHECK (reason IN ('damaged','defective','lost','sample','giveaway',
                      'influencer','photography','promotional','other')),

  -- Cost consumed from FIFO layers. NULL when no layer cost was known.
  total_cost_cents    INTEGER CHECK (total_cost_cents IS NULL OR total_cost_cents >= 0),
  known_cost_quantity   INTEGER NOT NULL DEFAULT 0,
  unknown_cost_quantity INTEGER NOT NULL DEFAULT 0,

  inventory_movement_id UUID REFERENCES inventory_movements(id) ON DELETE SET NULL,

  notes               TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_iwo_variant ON inventory_write_offs(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_iwo_reason  ON inventory_write_offs(reason, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- inventory_movements — traceability columns
-- ═══════════════════════════════════════════════════════════════════════════
-- movement_type is TEXT with no CHECK constraint (verified in migration 001), so
-- new values need no constraint change. New values used by 019:
--   RETURN_RESTOCK, WRITE_OFF, PROMO_OUT, EXCHANGE_OUT
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_movements' AND column_name = 'return_id'
  ) THEN
    ALTER TABLE inventory_movements ADD COLUMN return_id    UUID
      REFERENCES order_returns(id)   ON DELETE SET NULL;
    ALTER TABLE inventory_movements ADD COLUMN write_off_id UUID
      REFERENCES inventory_write_offs(id) ON DELETE SET NULL;
    ALTER TABLE inventory_movements ADD COLUMN exchange_id  UUID
      REFERENCES order_exchanges(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Late FK now that inventory_write_offs exists.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ilc_write_off_fk'
  ) THEN
    ALTER TABLE inventory_layer_consumptions
      ADD CONSTRAINT ilc_write_off_fk FOREIGN KEY (write_off_id)
      REFERENCES inventory_write_offs(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- derive_batch_unit_costs() — batch totals -> cent-exact per-unit components
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When units_received and batch-level totals are supplied, the per-unit
-- components are DERIVED here and written into the existing per-unit columns, so
-- everything downstream (resolve_cost_batch, unit_cogs_cents) is unchanged.
--
-- WHY A REMAINDER MATTERS. $100.00 freight across 3 units is 3333.33c each. Any
-- single integer loses money: floor gives 9999 (1c lost), round gives 10002
-- (2c invented). Per-unit integers alone therefore CANNOT represent the total.
--
-- The per-unit columns take the FLOOR, and the leftover cents are returned so the
-- caller can split the FIFO layer: (units - remainder) at the base cost plus
-- (remainder) at base+1. That reconstructs the batch total exactly.
--
-- Mixing modes is rejected rather than silently reconciled: supplying a batch
-- total AND a contradictory per-unit figure for the same component is a data
-- error the operator must resolve.
CREATE OR REPLACE FUNCTION derive_batch_unit_costs(p_batch_id UUID)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  b            product_cost_batches;
  v_units      INTEGER;
  v_unit_total INTEGER := 0;   -- floored per-unit landed cost
  v_grand      INTEGER := 0;   -- authoritative capitalised batch total
  v_remainder  INTEGER := 0;   -- cents that do not divide evenly
  -- component => (batch total, existing per-unit)
  v_freight    INTEGER; v_duties INTEGER; v_tariffs INTEGER;
  v_import     INTEGER; v_other  INTEGER;
BEGIN
  SELECT * INTO b FROM product_cost_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_COST|BATCH_NOT_FOUND|%', p_batch_id;
  END IF;

  v_units := b.units_received;
  IF v_units IS NULL THEN
    -- Per-unit entry mode, unchanged. Nothing to derive.
    RETURN jsonb_build_object('outcome','per_unit_mode',
      'unit_cogs_cents', b.unit_cogs_cents, 'remainder_cents', 0);
  END IF;
  IF v_units <= 0 THEN
    RAISE EXCEPTION 'KVRN_COST|INVALID_UNITS|%', v_units;
  END IF;

  -- Reject contradictory dual entry per component — but only on the FIRST
  -- derivation. Afterwards the per-unit columns hold OUR derived output, and
  -- re-deriving from the authoritative totals must stay idempotent.
  IF b.landed_derived_at IS NULL AND (
     (b.freight_total_cents    IS NOT NULL AND COALESCE(b.freight_cents,0)      <> 0)
  OR (b.duties_total_cents     IS NOT NULL AND COALESCE(b.duties_cents,0)       <> 0)
  OR (b.tariffs_total_cents    IS NOT NULL AND COALESCE(b.tariffs_cents,0)      <> 0)
  OR (b.import_tax_total_cents IS NOT NULL AND COALESCE(b.import_tax_cents,0)   <> 0)
  OR (b.other_landed_total_cents IS NOT NULL AND COALESCE(b.other_landed_cents,0) <> 0))
  THEN
    RAISE EXCEPTION 'KVRN_COST|MIXED_ENTRY_MODE|supply a batch total OR a per-unit amount, not both';
  END IF;

  -- Manufacturing stays per-unit: it is a genuine per-garment price.
  -- Every other component is a batch charge apportioned across the units.
  v_freight := COALESCE(b.freight_total_cents,    COALESCE(b.freight_cents,0)    * v_units);
  v_duties  := COALESCE(b.duties_total_cents,     COALESCE(b.duties_cents,0)     * v_units);
  v_tariffs := COALESCE(b.tariffs_total_cents,    COALESCE(b.tariffs_cents,0)    * v_units);
  v_import  := COALESCE(b.import_tax_total_cents, COALESCE(b.import_tax_cents,0) * v_units);
  v_other   := COALESCE(b.other_landed_total_cents, COALESCE(b.other_landed_cents,0) * v_units);

  -- Authoritative capitalised total for the whole batch.
  v_grand := (COALESCE(b.manufacturing_cents,0) + COALESCE(b.packaging_cents,0)) * v_units
           + v_freight + v_duties + v_tariffs + v_import + v_other;

  -- Floor per unit; the leftover is carried by a split layer, never discarded.
  v_unit_total := v_grand / v_units;              -- integer division = floor
  v_remainder  := v_grand - (v_unit_total * v_units);

  UPDATE product_cost_batches
  SET freight_cents      = v_freight / v_units,
      duties_cents       = v_duties  / v_units,
      tariffs_cents      = v_tariffs / v_units,
      import_tax_cents   = v_import  / v_units,
      other_landed_cents = v_other   / v_units,
      -- Exact, remainder cents included. The authoritative figure for reporting.
      capitalized_total_cents = v_grand,
      landed_derived_at  = NOW(),
      updated_at         = NOW()
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'outcome','derived',
    'units_received',       v_units,
    'batch_total_cents',    v_grand,
    'base_unit_cost_cents', v_unit_total,
    'remainder_cents',      v_remainder,
    -- The exact split a FIFO layer must use to preserve every cent.
    'base_units',           v_units - v_remainder,
    'premium_units',        v_remainder,
    'premium_unit_cost_cents', v_unit_total + 1
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- receive_batch_units() — cent-exact, idempotent, guarded batch receipt
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Replaces the earlier create_layers_from_batch, which scaled the remainder
-- independently on every call and therefore leaked cents on fine partitions.
--
-- CUMULATIVE ALLOCATION. The premium units for THIS receipt are the difference
-- between the cumulative target after it and the cumulative target before it:
--
--     premium_this = round(rem x (received_before + qty) / units)
--                  - round(rem x  received_before        / units)
--
-- Summed over ANY partition of the batch this telescopes to round(rem) = rem, so
-- 3-at-once, 1+2, 2+1 and 1+1+1 all reconcile to the identical capitalised total.
-- This is the same technique 018 uses for partial return allocation.
--
-- VARIANT VALIDATION. product_cost_batches applies at product level, optionally
-- narrowed by variant_id or color_name (see migration 013). A receipt is valid
-- only when the variant falls inside the batch's scope, so a hoodie batch can
-- never create layers for an unrelated variant through caller error.
--
-- OVER-RECEIPT GUARD. Cumulative received quantity may not exceed units_received.
--
-- IDEMPOTENCY. A repeated call carrying the same idempotency_key returns the
-- original receipt without adding stock again.
CREATE OR REPLACE FUNCTION receive_batch_units(
  p_batch_id        UUID,
  p_variant_id      UUID,
  p_quantity        INTEGER,
  p_idempotency_key TEXT DEFAULT NULL,
  p_actor           TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  b              product_cost_batches;
  v_variant      RECORD;
  v_derived      JSONB;
  v_units        INTEGER;
  v_remainder    INTEGER := 0;
  v_base_cost    INTEGER;
  v_before       INTEGER := 0;
  v_prem_before  INTEGER := 0;
  v_prem_after   INTEGER := 0;
  v_prem_this    INTEGER := 0;
  v_base_this    INTEGER := 0;
  v_movement     UUID;
  v_l1           UUID;
  v_l2           UUID;
  v_receipt      UUID;
  v_existing     RECORD;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'KVRN_RECEIPT|INVALID_QUANTITY';
  END IF;

  -- ── Idempotency: replay only when the request is genuinely the same ──────
  --
  -- A key alone is not enough. If the same key arrives with a different batch,
  -- variant or quantity it is NOT a replay — it is a materially different
  -- request that happens to reuse a key. Returning the original receipt would
  -- acknowledge work that was never performed, so that case fails closed.
  --
  -- The advisory lock makes the check race-safe: concurrent calls carrying the
  -- same key serialise here, so the second one reliably observes the first one's
  -- committed receipt instead of both passing the check and racing to INSERT.
  -- It is transaction-scoped and released automatically. The UNIQUE constraint
  -- on idempotency_key remains the final backstop and is untouched.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));

    SELECT id, cost_batch_id, variant_id, quantity INTO v_existing
    FROM inventory_batch_receipts WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      IF v_existing.cost_batch_id = p_batch_id
         AND v_existing.variant_id = p_variant_id
         AND v_existing.quantity   = p_quantity THEN
        -- Genuine replay. Nothing is mutated.
        RETURN jsonb_build_object('outcome','duplicate_receipt',
          'receipt_id', v_existing.id, 'quantity', v_existing.quantity);
      END IF;

      -- Different request, same key. Raise BEFORE any stock, movement, layer or
      -- receipt row is touched.
      RAISE EXCEPTION
        'KVRN_RECEIPT|IDEMPOTENCY_CONFLICT|key:% existing(batch:% variant:% qty:%) requested(batch:% variant:% qty:%)',
        p_idempotency_key,
        v_existing.cost_batch_id, v_existing.variant_id, v_existing.quantity,
        p_batch_id, p_variant_id, p_quantity;
    END IF;
  END IF;

  SELECT * INTO b FROM product_cost_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_RECEIPT|BATCH_NOT_FOUND|%', p_batch_id;
  END IF;

  SELECT id, product_id, color_name INTO v_variant
  FROM product_variants WHERE id = p_variant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_RECEIPT|VARIANT_NOT_FOUND|%', p_variant_id;
  END IF;

  -- ── Batch scope validation ──────────────────────────────────────────────
  IF v_variant.product_id <> b.product_id THEN
    RAISE EXCEPTION 'KVRN_RECEIPT|PRODUCT_MISMATCH|batch product % variant product %',
      b.product_id, v_variant.product_id;
  END IF;
  IF b.variant_id IS NOT NULL AND b.variant_id <> p_variant_id THEN
    RAISE EXCEPTION 'KVRN_RECEIPT|VARIANT_SCOPE_MISMATCH|batch targets variant %', b.variant_id;
  END IF;
  IF b.color_name IS NOT NULL AND b.color_name IS DISTINCT FROM v_variant.color_name THEN
    RAISE EXCEPTION 'KVRN_RECEIPT|COLOUR_SCOPE_MISMATCH|batch targets colour %', b.color_name;
  END IF;

  v_derived := derive_batch_unit_costs(p_batch_id);

  IF v_derived->>'outcome' = 'per_unit_mode' THEN
    -- No batch totals: a single layer at the per-unit cost, which may be NULL.
    v_base_cost := (v_derived->>'unit_cogs_cents')::INTEGER;
    v_base_this := p_quantity;
    v_prem_this := 0;
  ELSE
    v_units     := (v_derived->>'units_received')::INTEGER;
    v_remainder := (v_derived->>'remainder_cents')::INTEGER;
    v_base_cost := (v_derived->>'base_unit_cost_cents')::INTEGER;

    -- Authoritative receipt progress for this batch.
    SELECT COALESCE(SUM(quantity), 0) INTO v_before
    FROM inventory_batch_receipts WHERE cost_batch_id = p_batch_id;

    IF v_before + p_quantity > v_units THEN
      RAISE EXCEPTION 'KVRN_RECEIPT|OVER_RECEIPT|intended:% received:% requested:%',
        v_units, v_before, p_quantity;
    END IF;

    -- Cumulative telescoping: no cent is lost on any partition.
    v_prem_before := ROUND(v_remainder::NUMERIC * v_before              / v_units)::INTEGER;
    v_prem_after  := ROUND(v_remainder::NUMERIC * (v_before+p_quantity) / v_units)::INTEGER;
    v_prem_this   := v_prem_after - v_prem_before;
    v_base_this   := p_quantity - v_prem_this;
  END IF;

  UPDATE product_variants
  SET stock_on_hand = stock_on_hand + p_quantity, updated_at = NOW()
  WHERE id = p_variant_id;

  INSERT INTO inventory_movements
    (variant_id, quantity_delta, movement_type, reason, note, actor_email)
  VALUES (p_variant_id, p_quantity, 'ADD', 'batch_receipt',
          'cost_batch:' || p_batch_id, COALESCE(p_actor,'system@kvrn.internal'))
  RETURNING id INTO v_movement;

  IF v_base_this > 0 THEN
    v_l1 := add_inventory_layer(p_variant_id, v_base_this, v_base_cost, 'purchase',
                                p_batch_id, NULL, 'cost_batch', p_actor);
  END IF;
  IF v_prem_this > 0 THEN
    -- Carries the leftover cents so integer division loses nothing.
    v_l2 := add_inventory_layer(p_variant_id, v_prem_this, v_base_cost + 1, 'purchase',
                                p_batch_id, NULL, 'cost_batch', p_actor);
  END IF;

  INSERT INTO inventory_batch_receipts (
    cost_batch_id, variant_id, quantity, premium_units_after, premium_units_this,
    base_layer_id, premium_layer_id, movement_id, idempotency_key, created_by
  ) VALUES (
    p_batch_id, p_variant_id, p_quantity, v_prem_after, v_prem_this,
    v_l1, v_l2, v_movement, p_idempotency_key, p_actor
  ) RETURNING id INTO v_receipt;

  RETURN jsonb_build_object(
    'outcome','received','receipt_id',v_receipt,'movement_id',v_movement,
    'quantity',p_quantity,
    'base_units',v_base_this,'base_unit_cost_cents',v_base_cost,
    'premium_units',v_prem_this,
    'received_to_date', v_before + p_quantity,
    'intended_units',   v_units,
    'remaining_to_receive', COALESCE(v_units,0) - (v_before + p_quantity),
    'receipt_value_cents',
      CASE WHEN v_base_cost IS NULL THEN NULL
           ELSE v_base_this * v_base_cost + v_prem_this * (v_base_cost + 1) END,
    'derived', v_derived
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- batch_receipt_status() — intended vs received, both cent-exact
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CAPITALISATION IS NEVER unit_cogs_cents x units_received. That per-unit column
-- is FLOORED, so the multiplication drops the remainder cents FIFO deliberately
-- carries on a split layer: $100 over 3 units floors to 3333 and multiplies back
-- to 9999, inventing a 1-cent variance against inventory that is exactly right.
--
-- Two DIFFERENT figures, deliberately kept apart:
--
--   intended_capitalized_cents  the exact total for the WHOLE batch, from the
--                               landed-cost derivation, remainder cents included.
--   received_capitalized_cents  what has ACTUALLY been capitalised so far, summed
--                               from the authoritative FIFO layers.
--
-- For a partially received batch these legitimately differ, and conflating them
-- would make every open batch look like a variance.
CREATE OR REPLACE FUNCTION batch_receipt_status()
RETURNS TABLE (
  cost_batch_id              UUID,
  product_id                 UUID,
  product_name               TEXT,
  batch_label                TEXT,
  intended_units             INTEGER,
  received_units             INTEGER,
  remaining_units            INTEGER,
  unit_cogs_cents            INTEGER,
  intended_capitalized_cents BIGINT,
  received_capitalized_cents BIGINT,
  fully_received             BOOLEAN,
  -- TRUE only when the batch is complete AND received value equals the intended
  -- total exactly. A partially received batch is never flagged as a variance.
  capitalization_reconciled  BOOLEAN
)
LANGUAGE sql STABLE AS $$
  SELECT b.id, b.product_id, p.name, b.batch_label,
         b.units_received,
         COALESCE(r.qty, 0)::int,
         COALESCE(b.units_received, 0) - COALESCE(r.qty, 0),
         b.unit_cogs_cents,
         -- Authoritative intended total. Falls back to the floored product only
         -- for per-unit-mode batches, where there is no remainder to lose.
         COALESCE(
           b.capitalized_total_cents::bigint,
           (COALESCE(b.unit_cogs_cents,0)::bigint * COALESCE(b.units_received,0))
         )::bigint,
         -- Actually capitalised so far, straight from the FIFO layers.
         COALESCE(l.value_cents, 0)::bigint,
         b.units_received IS NOT NULL AND COALESCE(r.qty,0) >= b.units_received,
         b.units_received IS NOT NULL
           AND COALESCE(r.qty,0) >= b.units_received
           AND COALESCE(l.value_cents, 0) = COALESCE(
                 b.capitalized_total_cents::bigint,
                 (COALESCE(b.unit_cogs_cents,0)::bigint * COALESCE(b.units_received,0)))
  FROM product_cost_batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN LATERAL (
    SELECT SUM(quantity) AS qty FROM inventory_batch_receipts br
    WHERE br.cost_batch_id = b.id
  ) r ON TRUE
  LEFT JOIN LATERAL (
    SELECT SUM(units_received * COALESCE(unit_landed_cost_cents,0)) AS value_cents
    FROM inventory_cost_layers icl WHERE icl.cost_batch_id = b.id
  ) l ON TRUE;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- purchase_reconciliation() — cash paid vs value ACTUALLY received
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Aggregates the exact authoritative capitalised values of linked batches. No
-- floored per-unit multiplication, so no remainder cents are lost.
--
-- LABELLING MATTERS. Cash paid is compared against value RECEIVED TO DATE, not
-- against the intended cost of units that have not physically arrived. Both
-- figures are returned so the admin can see the difference:
--
--   intended_capitalized_cents  full cost of everything ordered
--   received_capitalized_cents  value of what has actually arrived
--   cash_paid_cents             money that has actually left
--   variance_cents              received value MINUS cash paid
--
-- A non-zero variance is expected and is NOT an error: a deposit paid before
-- receipt shows negative variance, and goods received before final payment show
-- positive. It is a review signal, never enforced to zero.
CREATE OR REPLACE FUNCTION purchase_reconciliation()
RETURNS TABLE (
  purchase_id                UUID,
  supplier                   TEXT,
  reference                  TEXT,
  status                     TEXT,
  expected_total_cents       INTEGER,
  cost_batch_count           INTEGER,
  intended_capitalized_cents BIGINT,
  received_capitalized_cents BIGINT,
  cash_paid_cents            BIGINT,
  variance_cents             BIGINT,
  fully_received             BOOLEAN
)
LANGUAGE sql STABLE AS $$
  SELECT ip.id, ip.supplier, ip.reference, ip.status, ip.total_cents,
         COALESCE(b.batch_count, 0)::int,
         COALESCE(b.intended, 0)::bigint,
         COALESCE(b.received, 0)::bigint,
         COALESCE(pay.paid, 0)::bigint,
         -- Received value vs cash out. Deliberately NOT intended-vs-cash.
         COALESCE(b.received, 0)::bigint - COALESCE(pay.paid, 0)::bigint,
         COALESCE(b.all_received, TRUE)
  FROM inventory_purchases ip
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS batch_count,
           SUM(s.intended_capitalized_cents) AS intended,
           SUM(s.received_capitalized_cents) AS received,
           bool_and(s.fully_received)        AS all_received
    FROM product_cost_batches pcb
    JOIN batch_receipt_status() s ON s.cost_batch_id = pcb.id
    WHERE pcb.purchase_id = ip.id
  ) b ON TRUE
  LEFT JOIN LATERAL (
    SELECT SUM(amount_cents)::bigint AS paid
    FROM inventory_purchase_payments ipp WHERE ipp.purchase_id = ip.id
  ) pay ON TRUE;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- consume_inventory_fifo() — THE single costing primitive
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Used by sales, write-offs, promos, exchanges and downward manual adjustments,
-- so every path that removes physical stock costs it the same way. Walks layers
-- oldest-first, decrements units_remaining, and writes append-only consumption
-- rows.
--
-- NEVER RAISES ON SHORTAGE. If layers cannot cover the quantity, whatever exists
-- is consumed and the remainder is written as coverage='uncovered' with NULL
-- cost. A paid customer order must not fail because accounting metadata is
-- incomplete; quantity still reconciles and the gap is explicitly visible.
--
-- Returns:
--   known_cost_cents   total cost of layers whose cost was known
--   known_quantity     units drawn from known-cost layers
--   unknown_quantity   units from layers with NULL cost
--   uncovered_quantity units with no layer at all (accounting exception)
--   total_cost_cents   known cost, or NULL if ANY unit was unknown/uncovered
--                      — a partial cost must never masquerade as a full one
CREATE OR REPLACE FUNCTION consume_inventory_fifo(
  p_variant_id       UUID,
  p_quantity         INTEGER,
  p_consumption_type TEXT,
  p_movement_id      UUID DEFAULT NULL,
  p_order_id         UUID DEFAULT NULL,
  p_order_item_id    UUID DEFAULT NULL,
  p_write_off_id     UUID DEFAULT NULL,
  p_exchange_id      UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_remaining   INTEGER := p_quantity;
  v_take        INTEGER;
  v_layer       RECORD;
  v_known_cost  INTEGER := 0;
  v_known_qty   INTEGER := 0;
  v_unknown_qty INTEGER := 0;
  v_uncovered   INTEGER := 0;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('known_cost_cents',0,'known_quantity',0,
      'unknown_quantity',0,'uncovered_quantity',0,'total_cost_cents',0);
  END IF;

  -- Oldest first. FOR UPDATE serialises concurrent consumption of one variant.
  FOR v_layer IN
    SELECT id, units_remaining, unit_landed_cost_cents
    FROM inventory_cost_layers
    WHERE variant_id = p_variant_id AND units_remaining > 0
    ORDER BY received_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_layer.units_remaining, v_remaining);

    UPDATE inventory_cost_layers
    SET units_remaining = units_remaining - v_take
    WHERE id = v_layer.id;

    INSERT INTO inventory_layer_consumptions (
      layer_id, variant_id, movement_id, quantity,
      unit_cost_cents, total_cost_cents, coverage, consumption_type,
      order_id, order_item_id, write_off_id, exchange_id
    ) VALUES (
      v_layer.id, p_variant_id, p_movement_id, v_take,
      v_layer.unit_landed_cost_cents,
      CASE WHEN v_layer.unit_landed_cost_cents IS NULL THEN NULL
           ELSE v_layer.unit_landed_cost_cents * v_take END,
      'layer', p_consumption_type,
      p_order_id, p_order_item_id, p_write_off_id, p_exchange_id
    );

    IF v_layer.unit_landed_cost_cents IS NULL THEN
      v_unknown_qty := v_unknown_qty + v_take;
    ELSE
      v_known_qty  := v_known_qty + v_take;
      v_known_cost := v_known_cost + (v_layer.unit_landed_cost_cents * v_take);
    END IF;

    v_remaining := v_remaining - v_take;
  END LOOP;

  -- Shortage: record the exception, never invent cost, never fail the caller.
  IF v_remaining > 0 THEN
    v_uncovered := v_remaining;
    INSERT INTO inventory_layer_consumptions (
      layer_id, variant_id, movement_id, quantity,
      unit_cost_cents, total_cost_cents, coverage, consumption_type,
      order_id, order_item_id, write_off_id, exchange_id
    ) VALUES (
      NULL, p_variant_id, p_movement_id, v_remaining,
      NULL, NULL, 'uncovered', p_consumption_type,
      p_order_id, p_order_item_id, p_write_off_id, p_exchange_id
    );
  END IF;

  RETURN jsonb_build_object(
    'known_cost_cents',   v_known_cost,
    'known_quantity',     v_known_qty,
    'unknown_quantity',   v_unknown_qty,
    'uncovered_quantity', v_uncovered,
    -- NULL unless EVERY unit had a known cost.
    'total_cost_cents',
      CASE WHEN v_unknown_qty = 0 AND v_uncovered = 0 THEN v_known_cost ELSE NULL END
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- add_inventory_layer() — the only way stock enters a layer
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION add_inventory_layer(
  p_variant_id     UUID,
  p_quantity       INTEGER,
  p_unit_cost      INTEGER,
  p_source         TEXT,
  p_cost_batch_id  UUID DEFAULT NULL,
  p_return_item_id UUID DEFAULT NULL,
  p_basis_source   TEXT DEFAULT NULL,
  p_actor          TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RETURN NULL; END IF;

  INSERT INTO inventory_cost_layers (
    variant_id, cost_batch_id, units_received, units_remaining,
    unit_landed_cost_cents, source, return_item_id, cost_basis_source, created_by
  ) VALUES (
    p_variant_id, p_cost_batch_id, p_quantity, p_quantity,
    p_unit_cost,                      -- NULL stays NULL: unknown, never 0
    p_source, p_return_item_id,
    COALESCE(p_basis_source, CASE WHEN p_unit_cost IS NULL THEN 'unknown' ELSE 'cost_batch' END),
    p_actor
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- adjust_inventory_with_layers() — atomic manual stock adjustment
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Replaces the previous three-statement TypeScript path in lib/inventory.ts,
-- which was not transactional and did not maintain layers. An admin edit that
-- changed stock_on_hand without matching layer treatment would silently break
-- the SUM(units_remaining) = stock_on_hand invariant.
--
-- ADD / SET-up   -> creates a layer at the currently effective cost (or unknown)
-- REMOVE / SET-down -> consumes FIFO with consumption_type='adjustment'
--
-- Preserves the original guards: no negative stock, and never below reserved.
CREATE OR REPLACE FUNCTION adjust_inventory_with_layers(
  p_variant_id UUID,
  p_type       TEXT,
  p_quantity   INTEGER,
  p_reason     TEXT,
  p_note       TEXT,
  p_actor      TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_variant   RECORD;
  v_new_stock INTEGER;
  v_delta     INTEGER;
  v_movement  UUID;
  v_batch     product_cost_batches;
  v_unit_cost INTEGER;
  v_fifo      JSONB;
BEGIN
  IF p_type NOT IN ('SET','ADD','REMOVE') THEN
    RAISE EXCEPTION 'KVRN_INVENTORY|INVALID_TYPE|%', p_type;
  END IF;
  IF p_quantity IS NULL OR p_quantity < 0 THEN
    RAISE EXCEPTION 'KVRN_INVENTORY|INVALID_QUANTITY';
  END IF;

  SELECT id, stock_on_hand, reserved_quantity INTO v_variant
  FROM product_variants WHERE id = p_variant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_INVENTORY|VARIANT_NOT_FOUND|%', p_variant_id;
  END IF;

  IF p_type = 'SET' THEN
    v_new_stock := p_quantity;              v_delta := p_quantity - v_variant.stock_on_hand;
  ELSIF p_type = 'ADD' THEN
    v_new_stock := v_variant.stock_on_hand + p_quantity; v_delta := p_quantity;
  ELSE
    v_new_stock := v_variant.stock_on_hand - p_quantity; v_delta := -p_quantity;
  END IF;

  IF v_new_stock < 0 THEN
    RAISE EXCEPTION 'KVRN_INVENTORY|BELOW_ZERO';
  END IF;
  IF v_new_stock < v_variant.reserved_quantity THEN
    RAISE EXCEPTION 'KVRN_INVENTORY|BELOW_RESERVED';
  END IF;

  UPDATE product_variants
  SET stock_on_hand = v_new_stock, updated_at = NOW()
  WHERE id = p_variant_id;

  INSERT INTO inventory_movements
    (variant_id, quantity_delta, movement_type, reason, note, actor_email)
  VALUES (p_variant_id, v_delta, p_type, p_reason, p_note, p_actor)
  RETURNING id INTO v_movement;

  IF v_delta > 0 THEN
    -- Stock in: value it at the currently effective cost, or unknown.
    v_batch := resolve_cost_batch(p_variant_id, (NOW() AT TIME ZONE 'UTC')::DATE);
    v_unit_cost := v_batch.unit_cogs_cents;   -- NULL when no batch applies
    PERFORM add_inventory_layer(
      p_variant_id, v_delta, v_unit_cost, 'manual_adjustment',
      v_batch.id, NULL,
      CASE WHEN v_unit_cost IS NULL THEN 'unknown' ELSE 'cost_batch' END, p_actor);
  ELSIF v_delta < 0 THEN
    v_fifo := consume_inventory_fifo(p_variant_id, -v_delta, 'adjustment', v_movement);
  END IF;

  RETURN jsonb_build_object(
    'outcome','adjusted','variant_id',p_variant_id,
    'new_stock',v_new_stock,'delta',v_delta,
    'movement_id',v_movement,'fifo',v_fifo
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- restock_return_item() — the ONLY way returned goods re-enter inventory
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Only a SELLABLE unit may restock. Damaged, defective, lost and disposed units
-- never silently re-enter available inventory, and keep their original COGS
-- because the goods really were consumed.
--
-- The new layer is priced at the returned item's SNAPSHOTTED COGS basis, so the
-- COGS credit equals the layer value exactly. If that snapshot is unknown, the
-- restock layer is unknown too — never zero.
CREATE OR REPLACE FUNCTION restock_return_item(
  p_return_item_id UUID,
  p_actor          TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_item     RECORD;
  v_variant  UUID;
  v_layer    UUID;
  v_movement UUID;
  v_credit   INTEGER;
BEGIN
  SELECT ri.id, ri.return_id, ri.order_item_id, ri.quantity, ri.disposition,
         ri.restocked, ri.unit_cogs_cents_snapshot, r.order_id
  INTO v_item
  FROM order_return_items ri
  JOIN order_returns r ON r.id = ri.return_id
  WHERE ri.id = p_return_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_RETURN|ITEM_NOT_FOUND|%', p_return_item_id;
  END IF;
  IF v_item.disposition <> 'sellable' THEN
    RAISE EXCEPTION 'KVRN_RETURN|NOT_SELLABLE|%', v_item.disposition;
  END IF;
  IF v_item.restocked THEN
    -- Idempotent: a repeated restock must not add stock twice.
    RETURN jsonb_build_object('outcome','already_restocked','return_item_id',p_return_item_id);
  END IF;

  SELECT variant_id INTO v_variant FROM order_items WHERE id = v_item.order_item_id;
  IF v_variant IS NULL THEN
    RAISE EXCEPTION 'KVRN_RETURN|VARIANT_NOT_FOUND';
  END IF;

  UPDATE product_variants
  SET stock_on_hand = stock_on_hand + v_item.quantity, updated_at = NOW()
  WHERE id = v_variant;

  INSERT INTO inventory_movements
    (variant_id, quantity_delta, movement_type, reason, note, actor_email, return_id)
  VALUES (v_variant, v_item.quantity, 'RETURN_RESTOCK', 'sellable_return',
          'return_item:' || p_return_item_id, p_actor, v_item.return_id)
  RETURNING id INTO v_movement;

  v_layer := add_inventory_layer(
    v_variant, v_item.quantity, v_item.unit_cogs_cents_snapshot,
    'return_restock', NULL, p_return_item_id,
    CASE WHEN v_item.unit_cogs_cents_snapshot IS NULL THEN 'unknown'
         ELSE 'return_snapshot' END,
    p_actor);

  -- COGS credit only for a genuine sellable restock, and only when known.
  v_credit := CASE WHEN v_item.unit_cogs_cents_snapshot IS NULL THEN NULL
                   ELSE v_item.unit_cogs_cents_snapshot * v_item.quantity END;

  UPDATE order_return_items
  SET restocked = TRUE, restocked_at = NOW(), cogs_credit_cents = v_credit
  WHERE id = p_return_item_id;

  RETURN jsonb_build_object(
    'outcome','restocked','return_item_id',p_return_item_id,
    'variant_id',v_variant,'quantity',v_item.quantity,
    'layer_id',v_layer,'cogs_credit_cents',v_credit
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- record_inventory_write_off() — physical removal with NO sales revenue
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION record_inventory_write_off(
  p_variant_id UUID,
  p_quantity   INTEGER,
  p_reason     TEXT,
  p_notes      TEXT,
  p_actor      TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_variant   RECORD;
  v_write_off UUID;
  v_movement  UUID;
  v_fifo      JSONB;
  v_type      TEXT;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'KVRN_INVENTORY|INVALID_QUANTITY';
  END IF;

  SELECT id, stock_on_hand, reserved_quantity INTO v_variant
  FROM product_variants WHERE id = p_variant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_INVENTORY|VARIANT_NOT_FOUND|%', p_variant_id;
  END IF;
  IF v_variant.stock_on_hand - p_quantity < v_variant.reserved_quantity THEN
    RAISE EXCEPTION 'KVRN_INVENTORY|BELOW_RESERVED';
  END IF;

  -- Promotional use is distinguishable from loss for reporting.
  v_type := CASE WHEN p_reason IN ('sample','giveaway','influencer','photography','promotional')
                 THEN 'promo' ELSE 'write_off' END;

  INSERT INTO inventory_write_offs (variant_id, quantity, reason, notes, created_by)
  VALUES (p_variant_id, p_quantity, p_reason, p_notes, p_actor)
  RETURNING id INTO v_write_off;

  UPDATE product_variants
  SET stock_on_hand = stock_on_hand - p_quantity, updated_at = NOW()
  WHERE id = p_variant_id;

  INSERT INTO inventory_movements
    (variant_id, quantity_delta, movement_type, reason, note, actor_email, write_off_id)
  VALUES (p_variant_id, -p_quantity,
          CASE WHEN v_type = 'promo' THEN 'PROMO_OUT' ELSE 'WRITE_OFF' END,
          p_reason, p_notes, p_actor, v_write_off)
  RETURNING id INTO v_movement;

  v_fifo := consume_inventory_fifo(
    p_variant_id, p_quantity, v_type, v_movement, NULL, NULL, v_write_off, NULL);

  UPDATE inventory_write_offs
  SET total_cost_cents      = (v_fifo->>'total_cost_cents')::INTEGER,
      known_cost_quantity   = (v_fifo->>'known_quantity')::INTEGER,
      unknown_cost_quantity = (v_fifo->>'unknown_quantity')::INTEGER
                            + (v_fifo->>'uncovered_quantity')::INTEGER,
      inventory_movement_id = v_movement
  WHERE id = v_write_off;

  RETURN jsonb_build_object(
    'outcome','written_off','write_off_id',v_write_off,
    'quantity',p_quantity,'reason',p_reason,'type',v_type,'fifo',v_fifo
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ship_exchange_items() — replacement units leave stock, consuming FIFO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- AN EXCHANGE IS NOT A SALE. This creates replacement COGS and an inventory
-- movement, and NO merchandise revenue. Any price difference is settled entirely
-- separately through the 018 payment/refund path and is untouched here.
--
-- IDEMPOTENT: only an exchange in 'pending' status ships, and the status moves to
-- 'shipped' inside the same transaction, so a retried fulfilment cannot consume
-- inventory twice.
--
-- Works for a same-SKU exchange, a different-SKU exchange, and a replacement sent
-- without any return — all three simply ship the listed exchange items.
CREATE OR REPLACE FUNCTION ship_exchange_items(
  p_exchange_id UUID,
  p_actor       TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_exchange  RECORD;
  v_item      RECORD;
  v_movement  UUID;
  v_fifo      JSONB;
  v_shipped   INTEGER := 0;
  v_unknown   INTEGER := 0;
  v_uncovered INTEGER := 0;
  v_cost      INTEGER := 0;
  v_any_null  BOOLEAN := FALSE;
BEGIN
  SELECT id, status, order_id INTO v_exchange
  FROM order_exchanges WHERE id = p_exchange_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_EXCHANGE|NOT_FOUND|%', p_exchange_id;
  END IF;

  -- Idempotency guard: a retry is a harmless no-op, never a second consumption.
  IF v_exchange.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome','already_shipped',
      'exchange_id',p_exchange_id,'status',v_exchange.status);
  END IF;

  FOR v_item IN
    SELECT id, variant_id, sku, quantity
    FROM order_exchange_items WHERE exchange_id = p_exchange_id ORDER BY sku
  LOOP
    -- Physical stock leaves through the canonical path.
    UPDATE product_variants
    SET stock_on_hand = stock_on_hand - v_item.quantity, updated_at = NOW()
    WHERE id = v_item.variant_id
      AND stock_on_hand - v_item.quantity >= reserved_quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_EXCHANGE|INSUFFICIENT_STOCK|%', v_item.sku;
    END IF;

    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email,
       order_id, exchange_id)
    VALUES (v_item.variant_id, -v_item.quantity, 'EXCHANGE_OUT', 'replacement_shipped',
            'exchange:' || p_exchange_id, p_actor, v_exchange.order_id, p_exchange_id)
    RETURNING id INTO v_movement;

    v_fifo := consume_inventory_fifo(
      v_item.variant_id, v_item.quantity, 'exchange_out',
      v_movement, v_exchange.order_id, NULL, NULL, p_exchange_id);

    -- Snapshot the ACTUAL resulting cost. Unknown stays NULL, never 0.
    UPDATE order_exchange_items
    SET line_cogs_cents = (v_fifo->>'total_cost_cents')::INTEGER,
        unit_cogs_cents_snapshot = CASE
          WHEN (v_fifo->>'total_cost_cents') IS NULL THEN NULL
          ELSE ROUND((v_fifo->>'total_cost_cents')::NUMERIC / v_item.quantity)::INTEGER END
    WHERE id = v_item.id;

    v_shipped   := v_shipped + v_item.quantity;
    v_unknown   := v_unknown   + (v_fifo->>'unknown_quantity')::INTEGER;
    v_uncovered := v_uncovered + (v_fifo->>'uncovered_quantity')::INTEGER;
    IF (v_fifo->>'total_cost_cents') IS NULL THEN
      v_any_null := TRUE;
    ELSE
      v_cost := v_cost + (v_fifo->>'total_cost_cents')::INTEGER;
    END IF;
  END LOOP;

  UPDATE order_exchanges
  SET status = 'shipped', shipped_at = NOW(), updated_at = NOW()
  WHERE id = p_exchange_id;

  RETURN jsonb_build_object(
    'outcome','shipped','exchange_id',p_exchange_id,
    'units_shipped',v_shipped,
    'unknown_cost_units',v_unknown,'uncovered_units',v_uncovered,
    -- NULL when any line was unknown: a partial cost must not look complete.
    'replacement_cogs_cents', CASE WHEN v_any_null THEN NULL ELSE v_cost END
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- inventory_valuation() — derived, never manually maintained
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Unknown-cost quantity is reported SEPARATELY so it cannot poison the
-- known-value subtotal. Cost basis only — MSRP is never used.
CREATE OR REPLACE FUNCTION inventory_valuation()
RETURNS TABLE (
  variant_id            UUID,
  sku                   TEXT,
  product_name          TEXT,
  stock_on_hand         INTEGER,
  layer_units_remaining INTEGER,
  known_cost_units      INTEGER,
  unknown_cost_units    INTEGER,
  value_at_cost_cents   BIGINT,
  reconciled            BOOLEAN
)
LANGUAGE sql STABLE AS $$
  SELECT pv.id, pv.sku, p.name, pv.stock_on_hand,
         COALESCE(l.total_units, 0)::int,
         COALESCE(l.known_units, 0)::int,
         COALESCE(l.unknown_units, 0)::int,
         COALESCE(l.value_cents, 0)::bigint,
         COALESCE(l.total_units, 0) = pv.stock_on_hand
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  LEFT JOIN LATERAL (
    SELECT SUM(units_remaining) AS total_units,
           SUM(units_remaining) FILTER (WHERE unit_landed_cost_cents IS NOT NULL) AS known_units,
           SUM(units_remaining) FILTER (WHERE unit_landed_cost_cents IS NULL)     AS unknown_units,
           SUM(units_remaining * COALESCE(unit_landed_cost_cents,0))              AS value_cents
    FROM inventory_cost_layers icl
    WHERE icl.variant_id = pv.id AND icl.units_remaining > 0
  ) l ON TRUE;
$$;

-- Invariant check: SUM(units_remaining) must equal stock_on_hand per variant.
-- Reported, not enforced by constraint: a transient mismatch must surface for
-- review rather than crash inventory operations.
CREATE OR REPLACE FUNCTION reconcile_inventory_layers()
RETURNS TABLE (variant_id UUID, sku TEXT, stock_on_hand INTEGER,
               layer_units INTEGER, difference INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT v.variant_id, v.sku, v.stock_on_hand, v.layer_units_remaining,
         v.layer_units_remaining - v.stock_on_hand
  FROM inventory_valuation() v
  WHERE v.layer_units_remaining <> v.stock_on_hand;
$$;
-- ═══════════════════════════════════════════════════════════════════════════
-- finalize_paid_order() — REPLACED. Identical 11-argument signature.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Diffed line-by-line against migration 017. PRESERVED VERBATIM:
--   webhook idempotency lock and already_processed / already_had_order paths
--   reservation lock, hint fallback and session-mismatch handling
--   reservation eligibility check, currency guard
--   merchandise total, discount and shipping snapshot resolution
--   the AMOUNT_MISMATCH invariant (discount subtracted exactly once)
--   customer/address snapshot selection
--   order number generation and the orders INSERT
--   the inventory decrement, its guard and DEDUCT_INVARIANT
--   the inventory_movements row
--   reservation status transition
--   discount claim/redemption finalization and the limited-code guard
--   transactional email outbox insert
--   every return shape
--
-- THE ONLY CHANGE: sale COGS is drawn from FIFO layer consumption instead of
-- resolve_cost_batch. The order line is inserted before the decrement so its id
-- can be attached to consumption records, then updated with the resulting cost.
--
-- Pre-cutover orders keep their date-effective snapshots; they are immutable and
-- are not recomputed.
CREATE OR REPLACE FUNCTION finalize_paid_order(
  p_stripe_session_id     TEXT,
  p_reservation_id_hint   UUID,
  p_stripe_payment_intent TEXT,
  p_stripe_event_id       TEXT,
  p_event_type            TEXT,
  p_expected_currency     TEXT,
  p_amount_total          INTEGER,
  p_customer_email        TEXT,
  p_customer_name         TEXT,
  p_customer_phone        TEXT,
  p_shipping_address      JSONB
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_res              RECORD;
  v_item             RECORD;
  v_order_id         UUID;
  v_order_num        TEXT;
  v_merch_total      INTEGER := 0;
  v_discount_cents   INTEGER := 0;   -- merchandise/order discount only
  v_ship_before      INTEGER := 0;   -- shipping before any discount
  v_ship_discount    INTEGER := 0;   -- shipping reduction
  v_ship_final       INTEGER := 0;   -- actual net shipping charged
  v_expected         INTEGER := 0;
  v_cust_email       TEXT;
  v_cust_name        TEXT;
  v_cust_phone       TEXT;
  v_ship_addr        JSONB;
  v_ship_method      TEXT;
  v_claim_id         UUID;
  v_redemption_id    UUID;
  v_is_limited_code  BOOLEAN;
  -- 019: FIFO consumption replaces the date-effective cost lookup.
  v_order_item_id    UUID;
  v_movement_id      UUID;
  v_fifo             JSONB;
BEGIN
  -- Idempotency lock
  INSERT INTO webhook_events (stripe_event_id, event_type, payload, processed)
  VALUES (p_stripe_event_id, p_event_type, '{"auto":true}'::jsonb, false)
  ON CONFLICT (stripe_event_id) DO NOTHING;
  PERFORM id FROM webhook_events WHERE stripe_event_id=p_stripe_event_id FOR UPDATE;
  IF (SELECT processed FROM webhook_events WHERE stripe_event_id=p_stripe_event_id) THEN
    SELECT id, order_number INTO v_order_id, v_order_num
    FROM orders WHERE stripe_checkout_session_id=p_stripe_session_id;
    RETURN jsonb_build_object('outcome','already_processed','order_id',v_order_id,
           'order_number',v_order_num,'already_processed',true);
  END IF;

  -- Lock reservation  (NEW: also selects attribution + shipping quote columns)
  SELECT id, status, stripe_checkout_session_id,
         customer_email, customer_name, customer_phone,
         shipping_address, shipping_method, shipping_cents,
         discount_id, discount_code, discount_type, discount_cents,
         shipping_before_discount_cents, shipping_discount_cents, shipping_final_cents,
         shipping_quoted_cents, shipping_auto_free_discount_cents, attribution
  INTO v_res
  FROM reservations WHERE stripe_checkout_session_id=p_stripe_session_id FOR UPDATE;

  IF NOT FOUND AND p_reservation_id_hint IS NOT NULL THEN
    SELECT id, status, stripe_checkout_session_id,
           customer_email, customer_name, customer_phone,
           shipping_address, shipping_method, shipping_cents,
           discount_id, discount_code, discount_type, discount_cents,
           shipping_before_discount_cents, shipping_discount_cents, shipping_final_cents,
           shipping_quoted_cents, shipping_auto_free_discount_cents, attribution
    INTO v_res
    FROM reservations WHERE id=p_reservation_id_hint FOR UPDATE;
    IF FOUND THEN
      IF v_res.stripe_checkout_session_id IS NOT NULL
         AND v_res.stripe_checkout_session_id <> p_stripe_session_id THEN
        v_res.id := NULL;
      ELSIF v_res.stripe_checkout_session_id IS NULL THEN
        UPDATE reservations SET stripe_checkout_session_id=p_stripe_session_id, updated_at=NOW()
        WHERE id=v_res.id;
      END IF;
    END IF;
  END IF;

  SELECT id, order_number INTO v_order_id, v_order_num
  FROM orders WHERE stripe_checkout_session_id=p_stripe_session_id;
  IF FOUND THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='already_had_order'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','already_had_order','order_id',v_order_id,
           'order_number',v_order_num,'already_processed',true);
  END IF;

  IF v_res.id IS NULL THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='no_reservation'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','no_reservation','already_processed',false);
  END IF;
  IF v_res.status NOT IN ('open','awaiting_payment','creating') THEN
    UPDATE webhook_events SET processed=true, processed_at=NOW(), result='reservation_not_eligible'
    WHERE stripe_event_id=p_stripe_event_id;
    RETURN jsonb_build_object('outcome','reservation_not_eligible','already_processed',false);
  END IF;

  IF lower(p_expected_currency) <> 'usd' THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|CURRENCY_MISMATCH|got:%', p_expected_currency;
  END IF;

  SELECT COALESCE(SUM(unit_price_cents * quantity), 0) INTO v_merch_total
  FROM reservation_items WHERE reservation_id=v_res.id;

  -- Resolve discount and shipping values from reservation snapshot
  v_discount_cents := COALESCE(v_res.discount_cents, 0);          -- merchandise only
  v_ship_before    := COALESCE(v_res.shipping_before_discount_cents,
                                v_res.shipping_cents, 0);
  v_ship_discount  := COALESCE(v_res.shipping_discount_cents, 0);
  v_ship_final     := COALESCE(v_res.shipping_final_cents,
                                v_res.shipping_cents, 0);

  -- Expected = merch - merch_discount + final_shipping
  -- shipping_final already contains the shipping reduction
  -- Never subtract shipping_discount twice
  v_expected := GREATEST(0, v_merch_total - v_discount_cents) + v_ship_final;

  IF p_amount_total <> v_expected THEN
    RAISE EXCEPTION 'KVRN_RESERVATION|AMOUNT_MISMATCH|stripe:% expected:%', p_amount_total, v_expected;
  END IF;

  -- Use snapshot values
  IF v_res.shipping_method IS NOT NULL THEN
    v_cust_email  := v_res.customer_email;
    v_cust_name   := v_res.customer_name;
    v_cust_phone  := v_res.customer_phone;
    v_ship_addr   := v_res.shipping_address;
    v_ship_method := v_res.shipping_method;
  ELSE
    v_cust_email  := p_customer_email;
    v_cust_name   := p_customer_name;
    v_cust_phone  := p_customer_phone;
    v_ship_addr   := p_shipping_address;
    v_ship_method := NULL;
  END IF;

  v_order_num := 'KVRN-' || LPAD(nextval('order_number_seq')::TEXT, 6, '0');

  INSERT INTO orders (
    order_number, stripe_checkout_session_id, stripe_payment_intent_id,
    reservation_id, payment_status, currency,
    subtotal_cents, shipping_cents, discount_cents, total_cents, shipping_method,
    discount_code, discount_id, discount_type,
    shipping_before_discount_cents, shipping_discount_cents,
    shipping_quoted_cents, shipping_auto_free_discount_cents, attribution,
    customer_email, customer_name, customer_phone, shipping_address, paid_at
  ) VALUES (
    v_order_num, p_stripe_session_id, NULLIF(p_stripe_payment_intent,''),
    v_res.id, 'paid', 'usd',
    v_merch_total,
    v_ship_final,     -- shipping_cents = final charged (backwards compatible)
    v_discount_cents, -- merchandise discount only
    p_amount_total,   -- total_cents = actual paid amount
    v_ship_method,
    v_res.discount_code, v_res.discount_id, v_res.discount_type,
    v_ship_before, v_ship_discount,
    -- NEW: carrier quote before any reduction + automatic free-shipping waiver + attribution
    v_res.shipping_quoted_cents,
    COALESCE(v_res.shipping_auto_free_discount_cents, 0),
    v_res.attribution,
    v_cust_email, v_cust_name, v_cust_phone, v_ship_addr, NOW()
  ) RETURNING id INTO v_order_id;

  -- Deduct inventory
  FOR v_item IN
    SELECT ri.variant_id, ri.sku, ri.product_name, ri.size, ri.color,
           ri.quantity, ri.unit_price_cents
    FROM reservation_items ri WHERE ri.reservation_id=v_res.id ORDER BY ri.sku
  LOOP
    -- ── 019: COGS now comes from FIFO layer consumption ────────────────────
    -- The order line is inserted first so its id can be attached to the
    -- consumption records, then costed once the layers are actually drawn.
    INSERT INTO order_items (
      order_id, variant_id, sku, product_name, size, color,
      quantity, unit_price_cents, line_total_cents
    ) VALUES (
      v_order_id, v_item.variant_id, v_item.sku, v_item.product_name,
      v_item.size, v_item.color, v_item.quantity, v_item.unit_price_cents,
      v_item.unit_price_cents * v_item.quantity
    ) RETURNING id INTO v_order_item_id;

    -- UNCHANGED from 017: same decrement, same guard, same exception.
    UPDATE product_variants
    SET stock_on_hand=stock_on_hand-v_item.quantity,
        reserved_quantity=reserved_quantity-v_item.quantity, updated_at=NOW()
    WHERE id=v_item.variant_id
      AND stock_on_hand>=v_item.quantity AND reserved_quantity>=v_item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_RESERVATION|DEDUCT_INVARIANT|%', v_item.sku;
    END IF;

    -- UNCHANGED from 017 except RETURNING, needed to link the consumptions.
    INSERT INTO inventory_movements
      (variant_id, quantity_delta, movement_type, reason, note, actor_email, order_id, reservation_id)
    VALUES (v_item.variant_id, -v_item.quantity, 'DEDUCT', 'paid_order',
            'order:' || v_order_id || ' reservation:' || v_res.id,
            'system@kvrn.internal', v_order_id, v_res.id)
    RETURNING id INTO v_movement_id;

    -- Atomic with the decrement above: same transaction, so quantity and cost
    -- can never diverge. A layer shortage records an accounting exception and
    -- returns NULL cost rather than failing this already-paid order.
    v_fifo := consume_inventory_fifo(
      v_item.variant_id, v_item.quantity, 'sale',
      v_movement_id, v_order_id, v_order_item_id);

    -- Component columns stay NULL: FIFO gives a blended landed cost per layer,
    -- not a component breakdown. cost_batch_id is recorded when the whole line
    -- came from a single batch-backed layer, otherwise left NULL.
    UPDATE order_items
    SET unit_cogs_cents = CASE
          WHEN (v_fifo->>'total_cost_cents') IS NULL THEN NULL
          ELSE ROUND((v_fifo->>'total_cost_cents')::NUMERIC / v_item.quantity)::INTEGER END,
        line_cogs_cents = (v_fifo->>'total_cost_cents')::INTEGER,
        -- Recorded only when the whole line came from a single batch-backed
        -- layer. PostgreSQL has no MIN(uuid), so the comparison is done on text
        -- and cast back.
        cost_batch_id = (
          SELECT CASE WHEN COUNT(DISTINCT l.cost_batch_id) = 1
                      THEN MAX(l.cost_batch_id::TEXT)::UUID END
          FROM inventory_layer_consumptions c
          JOIN inventory_cost_layers l ON l.id = c.layer_id
          WHERE c.order_item_id = v_order_item_id
        )
    WHERE id = v_order_item_id;
  END LOOP;

  UPDATE reservations SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=v_res.id;

  -- ── Discount finalization (strictly idempotent via INSERT RETURNING) ──────────
  IF v_res.discount_id IS NOT NULL THEN
    -- Determine if this is a limited-use code (requires a valid claim)
    SELECT (single_use OR max_redemptions IS NOT NULL)
    INTO v_is_limited_code
    FROM discounts WHERE id = v_res.discount_id;

    -- Find active finalizable claim for this reservation
    SELECT id INTO v_claim_id
    FROM discount_claims
    WHERE reservation_id = v_res.id
      AND discount_id = v_res.discount_id
      AND finalized_at IS NULL
      AND released_at IS NULL
    FOR UPDATE;

    -- For limited codes: require a valid claim (invariant guard)
    IF v_is_limited_code AND v_claim_id IS NULL THEN
      RAISE EXCEPTION 'KVRN_DISCOUNT|NO_CLAIM_FOR_LIMITED_CODE|discount:%|reservation:%',
        v_res.discount_id, v_res.id;
    END IF;

    -- Insert redemption (idempotent: ON CONFLICT DO NOTHING)
    INSERT INTO discount_redemptions (
      discount_id, order_id, claim_id, subscriber_id, customer_email
    )
    SELECT v_res.discount_id, v_order_id::TEXT, v_claim_id,
           d.subscriber_id, v_cust_email
    FROM discounts d WHERE d.id = v_res.discount_id
    ON CONFLICT (discount_id, order_id) DO NOTHING
    RETURNING id INTO v_redemption_id;

    -- Only increment counter if this is a NEW redemption
    IF v_redemption_id IS NOT NULL THEN
      UPDATE discounts
      SET redemption_count = redemption_count + 1, updated_at = NOW()
      WHERE id = v_res.discount_id;

      IF v_claim_id IS NOT NULL THEN
        UPDATE discount_claims SET finalized_at = NOW() WHERE id = v_claim_id;
      END IF;
    END IF;
  END IF;

  -- Email outbox
  IF v_cust_email IS NOT NULL AND v_cust_email <> '' THEN
    INSERT INTO transactional_emails
      (order_id, email_type, recipient_email, status, idempotency_key)
    VALUES (v_order_id, 'order_confirmation', v_cust_email,
            'pending', 'order-confirmation/' || v_order_id)
    ON CONFLICT (order_id, email_type) DO NOTHING;
  END IF;

  UPDATE webhook_events SET processed=true, processed_at=NOW(), result='order_created'
  WHERE stripe_event_id=p_stripe_event_id;

  RETURN jsonb_build_object('outcome','order_created','order_id',v_order_id,
         'order_number',v_order_num,'already_processed',false);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- OPENING-BALANCE CUTOVER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Seeds one layer per variant holding physical stock, so
-- SUM(units_remaining) = stock_on_hand holds from this instant.
--
-- Cost basis is the currently effective landed cost WHERE ONE ACTUALLY EXISTS;
-- otherwise the layer is explicitly unknown. Cost is never invented.
--
-- THIS IS A MIGRATION OPENING VALUATION, NOT RECONSTRUCTED HISTORY. No FIFO
-- history existed before this migration and none is claimed. Orders paid before
-- the cutover keep their date-effective COGS snapshots and are left untouched.
DO $$
DECLARE
  v_row     RECORD;
  v_batch   product_cost_batches;
  v_cutover TIMESTAMPTZ := NOW();
  v_seeded  INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT pv.id, pv.stock_on_hand
    FROM product_variants pv
    WHERE pv.stock_on_hand > 0
      AND NOT EXISTS (
        SELECT 1 FROM inventory_cost_layers l WHERE l.variant_id = pv.id
      )
  LOOP
    v_batch := resolve_cost_batch(v_row.id, (v_cutover AT TIME ZONE 'UTC')::DATE);

    INSERT INTO inventory_cost_layers (
      variant_id, cost_batch_id, units_received, units_remaining,
      unit_landed_cost_cents, source, received_at,
      opening_cutover_at, cost_basis_source, is_migration_opening, cost_basis_note
    ) VALUES (
      v_row.id, v_batch.id, v_row.stock_on_hand, v_row.stock_on_hand,
      v_batch.unit_cogs_cents,          -- NULL when no batch applies: unknown
      'opening_balance', v_cutover,
      v_cutover,
      CASE WHEN v_batch.unit_cogs_cents IS NULL THEN 'unknown'
           ELSE 'date_effective_at_cutover' END,
      TRUE,
      'Migration 019 opening valuation. Seeded from stock_on_hand at cutover. '
      || 'No pre-cutover FIFO history exists; reconciliation applies from this point forward.'
    );
    v_seeded := v_seeded + 1;
  END LOOP;

  RAISE NOTICE 'Migration 019: seeded % opening-balance layer(s)', v_seeded;
END $$;

COMMIT;

-- Post-migration verification.
SELECT 'layers'       AS tbl, COUNT(*) FROM inventory_cost_layers
UNION ALL SELECT 'consumptions',  COUNT(*) FROM inventory_layer_consumptions
UNION ALL SELECT 'write_offs',    COUNT(*) FROM inventory_write_offs
UNION ALL SELECT 'purchases',     COUNT(*) FROM inventory_purchases
UNION ALL SELECT 'payments',      COUNT(*) FROM inventory_purchase_payments;

-- Must return zero rows: layers reconcile to physical stock.
SELECT * FROM reconcile_inventory_layers();
