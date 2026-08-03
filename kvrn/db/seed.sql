-- KVRN Drop 001 safe upsert seed
-- Price: $80 = 8000 cents (confirmed from data/products.ts FOUNDER_PRICE)
-- Run: psql "$DATABASE_URL" -f db/seed.sql

BEGIN;

-- Upsert products (do not overwrite price if already set)
INSERT INTO products (drop_code, product_code, name, slug, price_cents, currency, active)
VALUES
  ('D001', 'PKHH',  'Project KVRN Heavyweight Hoodie',      'project-kvrn-heavyweight-hoodie',      8000, 'usd', true),
  ('D001', 'PKHSP', 'Project KVRN Heavyweight Sweatpants',  'project-kvrn-heavyweight-sweatpants',  8000, 'usd', true)
ON CONFLICT (slug) DO UPDATE
  SET name         = EXCLUDED.name,
      product_code = EXCLUDED.product_code,
      drop_code    = EXCLUDED.drop_code,
      active       = EXCLUDED.active,
      updated_at   = NOW()
  -- Never overwrite price_cents once set to protect live orders
  WHERE products.price_cents = EXCLUDED.price_cents OR products.price_cents = 0;

-- Upsert variants (never overwrite existing stock counts)
INSERT INTO product_variants
  (product_id, sku, color_name, color_code, size, size_sort, stock_on_hand, reserved_quantity, active, image_set)
SELECT
  p.id,
  v.sku,
  v.color_name,
  v.color_code,
  v.size,
  v.size_sort,
  0,  -- stock_on_hand: seed at zero
  0,  -- reserved_quantity: seed at zero
  true,
  v.image_set
FROM (VALUES
  ('project-kvrn-heavyweight-hoodie', 'KVRN-D001-PKHH-BLK-XS',  'Black', 'BLK', 'XS',  1, 'project-kvrn-heavyweight-hoodie-black'),
  ('project-kvrn-heavyweight-hoodie', 'KVRN-D001-PKHH-BLK-S',   'Black', 'BLK', 'S',   2, 'project-kvrn-heavyweight-hoodie-black'),
  ('project-kvrn-heavyweight-hoodie', 'KVRN-D001-PKHH-BLK-M',   'Black', 'BLK', 'M',   3, 'project-kvrn-heavyweight-hoodie-black'),
  ('project-kvrn-heavyweight-hoodie', 'KVRN-D001-PKHH-BLK-L',   'Black', 'BLK', 'L',   4, 'project-kvrn-heavyweight-hoodie-black'),
  ('project-kvrn-heavyweight-hoodie', 'KVRN-D001-PKHH-BLK-XL',  'Black', 'BLK', 'XL',  5, 'project-kvrn-heavyweight-hoodie-black'),
  ('project-kvrn-heavyweight-hoodie', 'KVRN-D001-PKHH-BLK-XXL', 'Black', 'BLK', 'XXL', 6, 'project-kvrn-heavyweight-hoodie-black'),
  ('project-kvrn-heavyweight-sweatpants', 'KVRN-D001-PKHSP-BLK-XS',  'Black', 'BLK', 'XS',  1, 'project-kvrn-heavyweight-sweatpants-black'),
  ('project-kvrn-heavyweight-sweatpants', 'KVRN-D001-PKHSP-BLK-S',   'Black', 'BLK', 'S',   2, 'project-kvrn-heavyweight-sweatpants-black'),
  ('project-kvrn-heavyweight-sweatpants', 'KVRN-D001-PKHSP-BLK-M',   'Black', 'BLK', 'M',   3, 'project-kvrn-heavyweight-sweatpants-black'),
  ('project-kvrn-heavyweight-sweatpants', 'KVRN-D001-PKHSP-BLK-L',   'Black', 'BLK', 'L',   4, 'project-kvrn-heavyweight-sweatpants-black'),
  ('project-kvrn-heavyweight-sweatpants', 'KVRN-D001-PKHSP-BLK-XL',  'Black', 'BLK', 'XL',  5, 'project-kvrn-heavyweight-sweatpants-black'),
  ('project-kvrn-heavyweight-sweatpants', 'KVRN-D001-PKHSP-BLK-XXL', 'Black', 'BLK', 'XXL', 6, 'project-kvrn-heavyweight-sweatpants-black')
) AS v(slug, sku, color_name, color_code, size, size_sort, image_set)
JOIN products p ON p.slug = v.slug
ON CONFLICT (sku) DO UPDATE
  SET color_name  = EXCLUDED.color_name,
      color_code  = EXCLUDED.color_code,
      size        = EXCLUDED.size,
      size_sort   = EXCLUDED.size_sort,
      image_set   = EXCLUDED.image_set,
      active      = true,
      updated_at  = NOW()
  -- CRITICAL: never overwrite stock_on_hand or reserved_quantity
  WHERE true;

COMMIT;

-- Verify
SELECT 'Products:' AS check, COUNT(*)::text AS count FROM products WHERE drop_code = 'D001'
UNION ALL
SELECT 'Variants:', COUNT(*)::text FROM product_variants pv
  JOIN products p ON p.id = pv.product_id WHERE p.drop_code = 'D001';
