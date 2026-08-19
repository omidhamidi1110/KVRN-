-- KVRN Migration 013 — Product COGS (landed cost) foundation
--
-- Two concerns, deliberately separated:
--   1. product_cost_batches  = CURRENT/HISTORICAL cost definitions (mutable catalogue)
--   2. order_items.*_snapshot = IMMUTABLE per-sale cost snapshot (never recalculated)
--
-- Changing a cost batch NEVER changes the profitability of an already-paid order,
-- because finalize_paid_order (migration 017) copies the resolved cost onto
-- order_items at the moment of sale.
--
-- LANDED UNIT COGS =
--   manufacturing + inbound freight + duties + tariffs + import tax
--   + packaging + other landed costs
--
-- Cost resolution precedence at sale time (see resolve_cost_batch in 017):
--   1. variant-specific batch  (variant_id matches)
--   2. colour-group batch      (color_name matches, variant_id IS NULL)
--   3. product default batch   (both NULL)
--   Within each tier: latest effective_from <= sale date wins.
--
-- Append-only effective dating: effective_from only, no effective_to.
-- A new production run is simply a new row with a later effective_from.
-- This makes overlapping/contradictory validity windows structurally impossible.
--
-- Run after 001-012.

BEGIN;

-- ── product_cost_batches ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_cost_batches (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Target. product_id is always required; variant_id / color_name narrow the scope.
  product_id               UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id               UUID        REFERENCES product_variants(id) ON DELETE CASCADE,
  color_name               TEXT,

  -- Human-readable production run label, e.g. 'Run-2025-Q1'
  batch_label              TEXT,

  -- Landed cost components, USD integer cents, all non-negative.
  manufacturing_cents      INTEGER     NOT NULL DEFAULT 0 CHECK (manufacturing_cents      >= 0),
  freight_cents            INTEGER     NOT NULL DEFAULT 0 CHECK (freight_cents            >= 0),
  duties_cents             INTEGER     NOT NULL DEFAULT 0 CHECK (duties_cents             >= 0),
  tariffs_cents            INTEGER     NOT NULL DEFAULT 0 CHECK (tariffs_cents            >= 0),
  import_tax_cents         INTEGER     NOT NULL DEFAULT 0 CHECK (import_tax_cents         >= 0),
  packaging_cents          INTEGER     NOT NULL DEFAULT 0 CHECK (packaging_cents          >= 0),
  other_landed_cents       INTEGER     NOT NULL DEFAULT 0 CHECK (other_landed_cents       >= 0),

  -- Derived landed unit cost. STORED so it can be indexed and selected cheaply.
  unit_cogs_cents          INTEGER     GENERATED ALWAYS AS (
    manufacturing_cents + freight_cents + duties_cents +
    tariffs_cents + import_tax_cents + packaging_cents + other_landed_cents
  ) STORED,

  currency                 TEXT        NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),

  -- Append-only effective dating
  effective_from           DATE        NOT NULL,

  note                     TEXT,
  created_by               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A batch may narrow by variant OR by colour, not both (avoids ambiguous precedence)
  CONSTRAINT pcb_scope_chk CHECK (variant_id IS NULL OR color_name IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_pcb_product_eff
  ON product_cost_batches(product_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_pcb_variant_eff
  ON product_cost_batches(variant_id, effective_from DESC)
  WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pcb_color_eff
  ON product_cost_batches(product_id, color_name, effective_from DESC)
  WHERE color_name IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_pcb_updated_at') THEN
    CREATE TRIGGER set_pcb_updated_at BEFORE UPDATE ON product_cost_batches
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── order_items COGS snapshot columns ────────────────────────────────────────
-- All nullable. NULL means "cost not known at time of sale" — it must NEVER be
-- displayed or summed as $0. Rows created before this migration keep NULL forever.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_items' AND column_name = 'unit_cogs_cents'
  ) THEN
    -- Which batch was resolved (audit trail back to the cost definition)
    ALTER TABLE order_items ADD COLUMN cost_batch_id UUID REFERENCES product_cost_batches(id);

    -- Per-unit component snapshot (auditable breakdown, frozen at sale time)
    ALTER TABLE order_items ADD COLUMN unit_manufacturing_cents INTEGER CHECK (unit_manufacturing_cents >= 0);
    ALTER TABLE order_items ADD COLUMN unit_freight_cents       INTEGER CHECK (unit_freight_cents       >= 0);
    ALTER TABLE order_items ADD COLUMN unit_duties_cents        INTEGER CHECK (unit_duties_cents        >= 0);
    ALTER TABLE order_items ADD COLUMN unit_tariffs_cents       INTEGER CHECK (unit_tariffs_cents       >= 0);
    ALTER TABLE order_items ADD COLUMN unit_import_tax_cents    INTEGER CHECK (unit_import_tax_cents    >= 0);
    ALTER TABLE order_items ADD COLUMN unit_packaging_cents     INTEGER CHECK (unit_packaging_cents     >= 0);
    ALTER TABLE order_items ADD COLUMN unit_other_landed_cents  INTEGER CHECK (unit_other_landed_cents  >= 0);

    -- Rolled-up per-unit and per-line landed cost
    ALTER TABLE order_items ADD COLUMN unit_cogs_cents INTEGER CHECK (unit_cogs_cents >= 0);
    ALTER TABLE order_items ADD COLUMN line_cogs_cents INTEGER CHECK (line_cogs_cents >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_oi_cost_batch
  ON order_items(cost_batch_id) WHERE cost_batch_id IS NOT NULL;

COMMIT;

SELECT 'product_cost_batches' AS tbl, COUNT(*) FROM product_cost_batches;
