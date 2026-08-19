-- KVRN Migration 014 — Order financial enrichment + actual shipment cost
--
-- CORE ACCOUNTING SEPARATION (do not conflate these):
--
--   orders.shipping_cents                  = SHIPPING REVENUE. What the customer paid KVRN.
--   shipments.label_cost_cents             = SHIPPING COST.    What KVRN paid the carrier.
--
-- These are different numbers and are stored on different tables on purpose.
-- shipments is the AUTHORITATIVE source of actual outbound shipping cost.
-- orders carries no denormalised copy, so the two can never drift.
--
-- Existing shipping columns keep their current meaning exactly:
--   shipping_before_discount_cents = basis before a MANUAL shipping promo code
--   shipping_discount_cents        = reduction from a MANUAL shipping promo code
--   shipping_cents                 = final amount charged to the customer (revenue)
--
-- NEW, to make automatic free shipping measurable:
--   shipping_quoted_cents             = live carrier quote for the selected method,
--                                       captured BEFORE any reduction of any kind.
--   shipping_auto_free_discount_cents = amount waived by the automatic $150+ benefit.
--
-- Without shipping_quoted_cents an automatically-free-shipped order records 0 / 0 / 0
-- and the business cannot see what the benefit gave away. See migration 017 + the
-- checkout handler change that populates it.
--
-- Run after 001-013.

BEGIN;

-- ── orders: shipping quote snapshot ──────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'shipping_quoted_cents'
  ) THEN
    -- NULL = unknown (orders paid before this migration). Never treat as 0.
    ALTER TABLE orders ADD COLUMN shipping_quoted_cents INTEGER
      CHECK (shipping_quoted_cents IS NULL OR shipping_quoted_cents >= 0);

    ALTER TABLE orders ADD COLUMN shipping_auto_free_discount_cents INTEGER NOT NULL DEFAULT 0
      CHECK (shipping_auto_free_discount_cents >= 0);
  END IF;
END $$;

-- ── orders: Stripe processing fee (actual, never estimated) ──────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'stripe_fee_cents'
  ) THEN
    -- NULL = not yet reconciled. Distinct from a genuine 0.
    ALTER TABLE orders ADD COLUMN stripe_fee_cents INTEGER
      CHECK (stripe_fee_cents IS NULL OR stripe_fee_cents >= 0);

    -- Provenance. 'stripe_api' is the only trusted value; 'manual' is admin-entered.
    ALTER TABLE orders ADD COLUMN stripe_fee_source TEXT
      CHECK (stripe_fee_source IS NULL OR stripe_fee_source IN ('stripe_api','manual'));

    -- Reconciliation identifiers, kept so a fee can always be re-derived from Stripe.
    ALTER TABLE orders ADD COLUMN stripe_charge_id              TEXT;
    ALTER TABLE orders ADD COLUMN stripe_balance_transaction_id TEXT;
    ALTER TABLE orders ADD COLUMN stripe_fee_reconciled_at      TIMESTAMPTZ;

    -- Backoff bookkeeping for the reconciliation cron (never blocks an order)
    ALTER TABLE orders ADD COLUMN stripe_fee_attempts    INTEGER NOT NULL DEFAULT 0
      CHECK (stripe_fee_attempts >= 0);
    ALTER TABLE orders ADD COLUMN stripe_fee_last_error  TEXT;
  END IF;
END $$;

-- Worklist index for the fee reconciliation cron: paid orders still missing a fee.
CREATE INDEX IF NOT EXISTS idx_orders_fee_pending
  ON orders(paid_at)
  WHERE stripe_fee_cents IS NULL AND paid_at IS NOT NULL;

-- Financial reporting index: revenue is always keyed on paid_at.
CREATE INDEX IF NOT EXISTS idx_orders_paid_at
  ON orders(paid_at DESC) WHERE paid_at IS NOT NULL;

-- ── shipments: actual carrier / label cost ───────────────────────────────────
-- This is KVRN's real outbound shipping expense. It is NOT what the customer paid.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shipments' AND column_name = 'label_cost_cents'
  ) THEN
    ALTER TABLE shipments ADD COLUMN shippo_transaction_id TEXT;
    ALTER TABLE shipments ADD COLUMN service_level         TEXT;

    -- NULL = not recorded yet. Never display or sum as 0.
    ALTER TABLE shipments ADD COLUMN label_cost_cents      INTEGER
      CHECK (label_cost_cents IS NULL OR label_cost_cents >= 0);
    ALTER TABLE shipments ADD COLUMN label_cost_currency   TEXT NOT NULL DEFAULT 'usd';

    -- Provenance, strongest first:
    --   shippo_label = actual purchased label amount (authoritative)
    --   shippo_quote = rate quoted at checkout (estimate only)
    --   manual       = admin entered from a carrier invoice
    ALTER TABLE shipments ADD COLUMN cost_source TEXT
      CHECK (cost_source IS NULL OR cost_source IN ('shippo_label','shippo_quote','manual'));

    ALTER TABLE shipments ADD COLUMN label_purchased_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipments_cost
  ON shipments(order_id) WHERE label_cost_cents IS NOT NULL;

COMMIT;

SELECT
  COUNT(*) FILTER (WHERE stripe_fee_cents IS NULL AND paid_at IS NOT NULL) AS orders_awaiting_fee,
  COUNT(*) FILTER (WHERE paid_at IS NOT NULL)                              AS paid_orders
FROM orders;
