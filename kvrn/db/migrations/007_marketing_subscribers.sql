-- KVRN Migration 007 — Marketing Subscribers
-- Creates the marketing_subscribers table.
-- Email is stored normalized (lowercase, trimmed) via the application layer.
-- This table is the source of truth for marketing consent — Resend is a delivery platform.
--
-- Run after migrations 001–006:
--   Test:       psql "$TEST_DATABASE_URL"        -v ON_ERROR_STOP=1 -f db/migrations/007_marketing_subscribers.sql
--   Production: psql "$PRODUCTION_MIGRATION_URL"  -v ON_ERROR_STOP=1 -f db/migrations/007_marketing_subscribers.sql

BEGIN;

CREATE TABLE IF NOT EXISTS marketing_subscribers (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT        NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  status            TEXT        NOT NULL DEFAULT 'subscribed'
    CONSTRAINT ms_status_chk CHECK (status IN ('subscribed', 'unsubscribed')),
  consent_source    TEXT        NOT NULL
    CONSTRAINT ms_source_chk CHECK (
      consent_source IN ('homepage', 'waitlist', 'checkout', 'footer', 'giveaway', 'manual_admin')
    ),
  consented_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at   TIMESTAMPTZ,
  resend_contact_id TEXT,
  last_synced_at    TIMESTAMPTZ,
  sync_status       TEXT
    CONSTRAINT ms_sync_status_chk CHECK (sync_status IN ('synced', 'pending', 'failed') OR sync_status IS NULL),
  sync_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Case-insensitive uniqueness enforced by application normalisation + this constraint
  CONSTRAINT marketing_subscribers_email_uq UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_ms_status       ON marketing_subscribers(status);
CREATE INDEX IF NOT EXISTS idx_ms_sync_status  ON marketing_subscribers(sync_status) WHERE sync_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ms_created_at   ON marketing_subscribers(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_ms_updated_at') THEN
    CREATE TRIGGER set_ms_updated_at BEFORE UPDATE ON marketing_subscribers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;

SELECT 'marketing_subscribers' AS tbl, COUNT(*) FROM marketing_subscribers;
