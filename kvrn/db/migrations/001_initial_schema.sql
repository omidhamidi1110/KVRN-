-- KVRN Drop 001 initial schema
-- Run: psql "$DATABASE_URL" -f db/migrations/001_initial_schema.sql

-- Products
CREATE TABLE IF NOT EXISTS products (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_code            TEXT        NOT NULL,
  product_code         TEXT        NOT NULL,
  name                 TEXT        NOT NULL,
  slug                 TEXT        NOT NULL UNIQUE,
  description          TEXT,
  price_cents          INTEGER     NOT NULL CHECK (price_cents >= 0),
  currency             TEXT        NOT NULL DEFAULT 'usd',
  active               BOOLEAN     NOT NULL DEFAULT true,
  garment_weight_lb    NUMERIC,
  shipping_weight_lb   NUMERIC,
  package_length_in    NUMERIC,
  package_width_in     NUMERIC,
  package_height_in    NUMERIC,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Product variants
CREATE TABLE IF NOT EXISTS product_variants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku                TEXT        NOT NULL UNIQUE,
  color_name         TEXT        NOT NULL,
  color_code         TEXT        NOT NULL,
  size               TEXT        NOT NULL,
  size_sort          INTEGER     NOT NULL,
  stock_on_hand      INTEGER     NOT NULL DEFAULT 0 CHECK (stock_on_hand >= 0),
  reserved_quantity  INTEGER     NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  active             BOOLEAN     NOT NULL DEFAULT true,
  image_set          TEXT,
  stripe_product_id  TEXT,
  stripe_price_id    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reserved_le_stock CHECK (reserved_quantity <= stock_on_hand)
);

-- Inventory movement log
CREATE TABLE IF NOT EXISTS inventory_movements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id      UUID        NOT NULL REFERENCES product_variants(id),
  quantity_delta  INTEGER     NOT NULL,
  movement_type   TEXT        NOT NULL, -- SET | ADD | REMOVE | RESERVE | RELEASE | DEDUCT
  reason          TEXT        NOT NULL,
  note            TEXT,
  actor_email     TEXT        NOT NULL,
  order_id        UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin audit log
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_email  TEXT        NOT NULL,
  action       TEXT        NOT NULL,
  resource     TEXT        NOT NULL,
  resource_id  TEXT,
  payload      JSONB,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Future-ready tables (unused this phase)
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id           UUID        NOT NULL REFERENCES product_variants(id),
  checkout_session_id  TEXT        NOT NULL,
  quantity             INTEGER     NOT NULL CHECK (quantity > 0),
  expires_at           TIMESTAMPTZ NOT NULL,
  released_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,
  customer_email       TEXT,
  status               TEXT        NOT NULL DEFAULT 'pending',
  subtotal_cents       INTEGER     NOT NULL DEFAULT 0,
  currency             TEXT        NOT NULL DEFAULT 'usd',
  shipping_address     JSONB,
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID        NOT NULL REFERENCES orders(id),
  variant_id    UUID        NOT NULL REFERENCES product_variants(id),
  sku           TEXT        NOT NULL,
  quantity      INTEGER     NOT NULL CHECK (quantity > 0),
  price_cents   INTEGER     NOT NULL CHECK (price_cents >= 0),
  currency      TEXT        NOT NULL DEFAULT 'usd',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             UUID        NOT NULL REFERENCES orders(id),
  stripe_payment_intent_id TEXT,
  amount_cents         INTEGER     NOT NULL,
  currency             TEXT        NOT NULL DEFAULT 'usd',
  status               TEXT        NOT NULL DEFAULT 'pending',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID        NOT NULL REFERENCES orders(id),
  tracking_number TEXT,
  carrier         TEXT,
  shipped_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_session_id         TEXT        NOT NULL UNIQUE,
  stripe_checkout_url       TEXT        NOT NULL,
  status                    TEXT        NOT NULL DEFAULT 'open', -- open | complete | expired
  items                     JSONB       NOT NULL,
  customer_email            TEXT,
  expires_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT        NOT NULL UNIQUE,
  event_type      TEXT        NOT NULL,
  processed       BOOLEAN     NOT NULL DEFAULT false,
  payload         JSONB       NOT NULL,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_sku        ON product_variants(sku);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_variant ON inventory_movements(variant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_session ON inventory_reservations(checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status               ON orders(status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type         ON webhook_events(event_type, processed);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_products_updated_at') THEN
    CREATE TRIGGER set_products_updated_at BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_variants_updated_at') THEN
    CREATE TRIGGER set_variants_updated_at BEFORE UPDATE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
