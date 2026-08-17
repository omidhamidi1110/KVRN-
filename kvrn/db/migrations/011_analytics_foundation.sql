-- KVRN Migration 011 — First-party analytics schema foundation
-- Phase A: schema only. No application code reads/writes these tables yet.
-- Instrumentation is wired in Phase C.
--
-- Design notes:
--   analytics_sessions: one row per anonymous browser tab session
--     session_id generated client-side (UUID, stored in sessionStorage)
--     UTM attribution stored as compact JSONB; not repeated per-event
--   analytics_events: append-only funnel records per session
--     product_id / variant_id are typed UUIDs (public catalog; low-trust risk acceptable)
--     order_id / reservation_id are NOT foreign keys; server sets authoritative
--     purchase events via Stripe webhook, not browser self-report
--
-- Run after 001-010:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/011_analytics_foundation.sql

BEGIN;

-- ── analytics_sessions ────────────────────────────────────────────────────────
-- One row per anonymous browser tab session.
-- session_id is a client-generated UUID stored in sessionStorage.
-- UTM/attribution stored here (compact JSONB); not repeated on every event.

CREATE TABLE IF NOT EXISTS analytics_sessions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     TEXT        NOT NULL,
  device_type    TEXT        CHECK (device_type IN ('mobile','desktop','tablet')),
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  landing_page   TEXT,
  referrer       TEXT,
  -- First-touch attribution (captured at session start; never overwritten)
  first_touch_utm  JSONB,
  -- Last-touch attribution (updated on each new entry with UTM params)
  last_touch_utm   JSONB,
  -- { source, medium, campaign, content, term }
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT as_session_id_uq UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_as_session_id  ON analytics_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_as_first_seen  ON analytics_sessions(first_seen_at DESC);

-- ── analytics_events ─────────────────────────────────────────────────────────
-- Append-only funnel event records.
-- Trust model:
--   product_id / variant_id: typed UUIDs, browser-supplied, low risk (public catalog)
--   variant_sku: text snapshot for history
--   reservation_id / order_id: NOT foreign keys; must be set server-side only
--   purchase_completed events with authoritative order_id come from Stripe webhook,
--   not from browser self-report.
--
-- Funnel event_name values (Phase C will instrument these):
--   session_start | product_viewed | size_selected | add_to_cart | cart_viewed
--   checkout_started | contact_completed | shipping_entered | rate_loaded
--   payment_redirect | purchase_completed

CREATE TABLE IF NOT EXISTS analytics_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     TEXT        NOT NULL,
  event_name     TEXT        NOT NULL,
  -- Typed catalog refs (browser-supplied; low-trust risk for public catalog data)
  product_id     UUID        REFERENCES products(id) ON DELETE SET NULL,
  variant_id     UUID        REFERENCES product_variants(id) ON DELETE SET NULL,
  variant_sku    TEXT,
  -- Server-set only (NOT enforced as FK — populated via Stripe webhook / server path)
  reservation_id UUID,
  order_id       UUID,
  -- Optional value (e.g. cart total at add_to_cart, order total at purchase)
  value_cents    INTEGER,
  -- Compact event-specific metadata (no PII)
  meta           JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ae_session_time ON analytics_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_event_time   ON analytics_events(event_name, created_at DESC);

COMMIT;

-- Verify
SELECT 'analytics_sessions' AS tbl, COUNT(*) FROM analytics_sessions
UNION ALL
SELECT 'analytics_events',           COUNT(*) FROM analytics_events;
