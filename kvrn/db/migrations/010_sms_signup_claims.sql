-- KVRN Migration 010 — SMS Signup Claims
-- Short-lived browser claim tokens that securely link a browser session to a
-- Twilio-authenticated inbound JOIN message.
--
-- Lifecycle:
--   PENDING  → (Twilio inbound webhook confirms) → CONFIRMED
--            → (browser checkout resolves)        → CONSUMED
--   Any status that is past expires_at is treated as expired.
--
-- Security invariants:
--   - Only raw token (not hash) is returned to browser
--   - Only token_hash is stored in DB — DB breach yields no usable tokens
--   - Only authenticated Twilio inbound can transition PENDING → CONFIRMED
--   - Browser cannot specify which subscriber a claim belongs to
--   - CONSUMED claims cannot be replayed
--
-- Migrations 008 and 009 are already deployed. This is the next sequential migration.
-- Run AFTER 001–009:
--   psql "$URL" -v ON_ERROR_STOP=1 -f db/migrations/010_sms_signup_claims.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sms_signup_claims (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hex of the raw base64url token returned to browser
  token_hash    TEXT        NOT NULL,
  -- Set only by authenticated Twilio inbound webhook (never by browser)
  subscriber_id UUID        REFERENCES sms_subscribers(id),
  status        TEXT        NOT NULL DEFAULT 'pending'
    CONSTRAINT ssc_status_chk CHECK (status IN ('pending','confirmed','consumed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  confirmed_at  TIMESTAMPTZ,
  consumed_at   TIMESTAMPTZ,
  CONSTRAINT ssc_token_uq UNIQUE (token_hash)
);

-- Fast lookup by hash (primary access pattern)
CREATE INDEX IF NOT EXISTS idx_ssc_hash    ON sms_signup_claims(token_hash);
-- Cleanup query: find expired pending claims
CREATE INDEX IF NOT EXISTS idx_ssc_expires ON sms_signup_claims(expires_at);

COMMIT;

SELECT 'sms_signup_claims' AS tbl, COUNT(*) FROM sms_signup_claims;
