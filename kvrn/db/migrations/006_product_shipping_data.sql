-- KVRN Migration 006 — Populate product shipping weights and dimensions
-- Schema columns already exist from migration 001 (no DDL changes needed).
-- Safe to re-run: WHERE clause guards against overwriting non-null values.
--
-- Weight architecture:
--   products.shipping_weight_lb stores GARMENT WEIGHT ONLY.
--   Packaging weight (0.3 oz KVRN poly mailer) is added per physical parcel
--   in lib/shippo.ts at calculation time — NOT stored here.
--   This keeps product weight independent of packaging choice.
--
-- Garment weights:
--   Hoodie:     38.4 oz garment = 2.4 lb
--   Sweatpants: 28.8 oz garment = 1.8 lb
--
-- Current packaging: KVRN 17×14 poly mailer (0.3 oz — added in code, not here).
--
-- Packed height (package_height_in) is an ESTIMATE — not yet physically measured.
-- These values are the current working estimates:
--   Hoodie:     3 in (estimate)
--   Sweatpants: 2 in (estimate)
-- Update these rows once measured without any code change.
--
-- Run after migrations 001–005:
--   Test:       psql "$TEST_DATABASE_URL"        -v ON_ERROR_STOP=1 -f db/migrations/006_product_shipping_data.sql
--   Production: psql "$PRODUCTION_MIGRATION_URL"  -v ON_ERROR_STOP=1 -f db/migrations/006_product_shipping_data.sql

BEGIN;

UPDATE products
SET
  shipping_weight_lb = 2.4,   -- 38.4 oz garment weight only (packaging added at calc time)
  package_length_in  = 17,    -- KVRN poly mailer length (inches)
  package_width_in   = 14,    -- KVRN poly mailer width (inches)
  package_height_in  = 3,     -- ESTIMATE: packed thickness — update when measured
  updated_at         = NOW()
WHERE product_code = 'PKHH'
  AND (
    shipping_weight_lb IS NULL OR
    package_length_in  IS NULL OR
    package_width_in   IS NULL OR
    package_height_in  IS NULL
  );

UPDATE products
SET
  shipping_weight_lb = 1.8,   -- 28.8 oz garment weight only (packaging added at calc time)
  package_length_in  = 17,    -- KVRN poly mailer length (inches)
  package_width_in   = 14,    -- KVRN poly mailer width (inches)
  package_height_in  = 2,     -- ESTIMATE: packed thickness — update when measured
  updated_at         = NOW()
WHERE product_code = 'PKHSP'
  AND (
    shipping_weight_lb IS NULL OR
    package_length_in  IS NULL OR
    package_width_in   IS NULL OR
    package_height_in  IS NULL
  );

COMMIT;

-- Verify
SELECT
  product_code,
  shipping_weight_lb,
  ROUND(shipping_weight_lb * 16, 2) AS "garment_oz",
  package_length_in,
  package_width_in,
  package_height_in
FROM products
WHERE product_code IN ('PKHH', 'PKHSP')
ORDER BY product_code;
