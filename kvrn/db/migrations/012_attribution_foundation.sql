-- KVRN Migration 012 — Attribution columns on reservations and orders
-- Phase A: schema only. No application code populates these columns yet.
-- Checkout instrumentation is wired in Phase C.
--
-- Design:
--   reservations.attribution — JSONB snapshot captured at checkout start
--   orders.attribution       — immutable copy from reservation at finalization
--
-- Attribution JSONB shape (both columns):
--   {
--     "first_touch": { "source", "medium", "campaign", "content", "term",
--                      "referrer", "landing_page" },
--     "last_touch":  { "source", "medium", "campaign", "content", "term",
--                      "referrer", "landing_page" },
--     "session_id":  "uuid"
--   }
--
-- finalize_paid_order will be extended in Phase B to copy
--   reservations.attribution → orders.attribution.
-- Until then both columns remain NULL on new rows (correct; data unavailable).
--
-- Run after 001-011:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/012_attribution_foundation.sql

BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reservations' AND column_name = 'attribution'
  ) THEN
    ALTER TABLE reservations ADD COLUMN attribution JSONB;
    RAISE NOTICE 'Added reservations.attribution';
  ELSE
    RAISE NOTICE 'reservations.attribution already exists — skipping';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'attribution'
  ) THEN
    ALTER TABLE orders ADD COLUMN attribution JSONB;
    RAISE NOTICE 'Added orders.attribution';
  ELSE
    RAISE NOTICE 'orders.attribution already exists — skipping';
  END IF;
END $$;

-- Index on orders.attribution for campaign reporting queries (Phase C+)
CREATE INDEX IF NOT EXISTS idx_orders_attribution_source
  ON orders USING GIN (attribution);

COMMIT;

-- Verify
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name IN ('reservations','orders')
  AND column_name = 'attribution'
ORDER BY table_name;
