// ─────────────────────────────────────────────────────────────────────────────
// DATABASE CLIENT — Neon Serverless Postgres
//
// Uses the Neon serverless HTTP driver which works in:
//   - Cloudflare Workers (no TCP connections)
//   - Next.js API routes (both edge and Node runtimes)
//   - Cloudflare Pages Functions
//
// SETUP:
//   npm install @neondatabase/serverless
//   Add DATABASE_URL to .env.local
//   Get connection string from: https://console.neon.tech
//
// The DATABASE_URL should use the pooled connection string (ends in -pooler):
//   postgresql://user:pass@ep-xxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
// ─────────────────────────────────────────────────────────────────────────────

// ─── TYPE-SAFE SQL QUERY HELPER ──────────────────────────────────────────────
// Until @neondatabase/serverless is installed, this exports a stub.
// Swap the stub for the real import once the package is installed.

type QueryResult<T = Record<string, unknown>> = T[]

// Stub implementation — replace entire block with:
//   import { neon } from '@neondatabase/serverless'
//   export const sql = neon(process.env.DATABASE_URL!)
class DatabaseStub {
  async query<T = Record<string, unknown>>(
    _query: string,
    _params?: unknown[]
  ): Promise<QueryResult<T>> {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[db] DATABASE_URL not set — returning empty result.')
    }
    return []
  }

  /** Tagged template literal interface matching neon()'s API */
  async sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    if (process.env.NODE_ENV === 'development') {
      const query = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), '')
      console.warn('[db] DATABASE_URL not set. Would run:', query.trim())
    }
    return []
  }
}

// ─── PRODUCTION CONNECTION ────────────────────────────────────────────────────
// Uncomment this block and delete the stub above once @neondatabase/serverless
// is installed:
//
// import { neon, neonConfig } from '@neondatabase/serverless'
//
// // Cache the connection across serverless function invocations
// // (Neon uses HTTP — no persistent connection to manage)
// let _sql: ReturnType<typeof neon> | null = null
//
// function getDb() {
//   if (!_sql) {
//     if (!process.env.DATABASE_URL) {
//       throw new Error('DATABASE_URL environment variable is not set.')
//     }
//     _sql = neon(process.env.DATABASE_URL)
//   }
//   return _sql
// }
//
// export const sql = getDb()

export const db = new DatabaseStub()

// ─── SCHEMA (run once to initialise the database) ────────────────────────────
// Run this SQL against your Neon database via the Neon SQL Editor or psql:
//
// See: /db/schema.sql (create this file and run it)
//
export const SCHEMA_SQL = `
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Customers / waitlist
CREATE TABLE IF NOT EXISTS customers (
  id                    TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email                 TEXT        UNIQUE,
  phone                 TEXT,
  first_name            TEXT,
  last_name             TEXT,
  segment               TEXT        DEFAULT 'B',
  email_consent         BOOLEAN     DEFAULT false,
  email_consent_at      TIMESTAMPTZ,
  email_consent_source  TEXT,
  sms_consent           BOOLEAN     DEFAULT false,
  sms_consent_at        TIMESTAMPTZ,
  sms_consent_source    TEXT,
  email_unsubscribed    BOOLEAN     DEFAULT false,
  email_unsubscribed_at TIMESTAMPTZ,
  sms_unsubscribed      BOOLEAN     DEFAULT false,
  total_orders          INTEGER     DEFAULT 0,
  total_spend_pence     INTEGER     DEFAULT 0,
  first_order_at        TIMESTAMPTZ,
  last_order_at         TIMESTAMPTZ,
  is_vip                BOOLEAN     DEFAULT false,
  acquisition_source    TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  type        TEXT NOT NULL,
  price_pence INTEGER NOT NULL,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Variants (color × size combinations)
CREATE TABLE IF NOT EXISTS variants (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  product_id     TEXT REFERENCES products(id),
  color          TEXT NOT NULL,
  size           TEXT NOT NULL,
  sku            TEXT UNIQUE NOT NULL,
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, color, size)
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  stripe_payment_intent  TEXT UNIQUE,
  customer_email         TEXT NOT NULL,
  customer_name          TEXT,
  shipping_address       JSONB,
  line_items             JSONB,
  shipping_method        TEXT,
  shipping_cost_pence    INTEGER DEFAULT 0,
  subtotal_pence         INTEGER NOT NULL,
  tax_pence              INTEGER DEFAULT 0,
  total_pence            INTEGER NOT NULL,
  status                 TEXT DEFAULT 'pending',
  tracking_number        TEXT,
  carrier                TEXT,
  shippo_shipment_id     TEXT,
  sms_consent            BOOLEAN DEFAULT false,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  fulfilled_at           TIMESTAMPTZ,
  shipped_at             TIMESTAMPTZ,
  delivered_at           TIMESTAMPTZ
);

-- Returns
CREATE TABLE IF NOT EXISTS returns (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id         TEXT REFERENCES orders(id),
  items            JSONB,
  reason           TEXT,
  label_url        TEXT,
  tracking_number  TEXT,
  status           TEXT DEFAULT 'requested',
  refund_pence     INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Drop waitlist (which drop each subscriber is waiting for)
CREATE TABLE IF NOT EXISTS drop_waitlist (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  customer_id TEXT REFERENCES customers(id),
  drop_id     TEXT NOT NULL,
  notified_at TIMESTAMPTZ,
  converted   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Automation sends (prevent duplicate emails/SMS)
CREATE TABLE IF NOT EXISTS automation_sends (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  customer_id   TEXT REFERENCES customers(id),
  automation_id TEXT NOT NULL,
  order_id      TEXT,
  channel       TEXT,
  sent_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, automation_id, order_id)
);

-- Stock alerts ("notify me" for out-of-stock variants)
CREATE TABLE IF NOT EXISTS stock_alerts (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email      TEXT NOT NULL,
  variant_id TEXT REFERENCES variants(id),
  notified   BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update customer segment on order count change
CREATE OR REPLACE FUNCTION update_customer_segment()
RETURNS TRIGGER AS \$\$
BEGIN
  IF NEW.total_orders >= 5 THEN
    NEW.segment  = 'E';
    NEW.is_vip   = true;
  ELSIF NEW.total_orders >= 2 THEN
    NEW.segment  = 'D';
  ELSIF NEW.total_orders >= 1 THEN
    NEW.segment  = 'C';
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
\$\$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER customer_segment_update
  BEFORE UPDATE ON customers
  FOR EACH ROW
  WHEN (OLD.total_orders IS DISTINCT FROM NEW.total_orders)
  EXECUTE FUNCTION update_customer_segment();
`
