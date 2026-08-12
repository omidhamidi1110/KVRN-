-- KVRN Migration 008 — SMS Subscribers + Message Log
-- Neon is the source of truth for SMS consent.
-- A2P 10DLC Brand/Campaign approval is required before production marketing sends at scale.
-- Migration is safe to apply now — infrastructure only; no sends triggered by this migration.
--
-- twilio_opt_out_state semantics: explicit values only
--   'opted_in'  — subscriber sent a START/JOIN keyword → Twilio confirmed opt-in
--   'opted_out' — subscriber sent a STOP keyword → Twilio confirmed opt-out
--   NULL        — state not yet confirmed via Twilio keyword; uses local consent_source
--
-- Run after migrations 001–007:
--   Test:       psql "$TEST_DATABASE_URL"        -v ON_ERROR_STOP=1 -f db/migrations/008_sms_subscribers.sql
--   Production: psql "$PRODUCTION_MIGRATION_URL"  -v ON_ERROR_STOP=1 -f db/migrations/008_sms_subscribers.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sms_subscribers (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164            TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'subscribed'
    CONSTRAINT ss_status_chk     CHECK (status IN ('subscribed', 'unsubscribed')),
  consent_source        TEXT        NOT NULL
    CONSTRAINT ss_source_chk     CHECK (
      consent_source IN ('homepage','waitlist','checkout','footer','giveaway','manual_admin','sms_keyword')
    ),
  consented_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at       TIMESTAMPTZ,
  -- Explicit Twilio keyword opt-out state. NULL = not yet confirmed via keyword.
  -- 'opted_in'  = subscriber sent START/JOIN to Twilio
  -- 'opted_out' = subscriber sent STOP to Twilio
  twilio_opt_out_state  TEXT
    CONSTRAINT ss_twilio_state_chk CHECK (
      twilio_opt_out_state IN ('opted_in', 'opted_out') OR twilio_opt_out_state IS NULL
    ),
  last_twilio_message_sid TEXT,
  sync_status           TEXT
    CONSTRAINT ss_sync_chk       CHECK (sync_status IN ('synced','pending','failed') OR sync_status IS NULL),
  sync_error            TEXT,
  last_synced_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sms_subscribers_phone_uq UNIQUE (phone_e164)
);

CREATE INDEX IF NOT EXISTS idx_ss_status     ON sms_subscribers(status);
CREATE INDEX IF NOT EXISTS idx_ss_created_at ON sms_subscribers(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_ss_updated_at') THEN
    CREATE TRIGGER set_ss_updated_at BEFORE UPDATE ON sms_subscribers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── sms_messages — idempotent outbound message log ────────────────────────────
-- Tracks sent message SIDs for status callback correlation.
-- Does not store message body.
-- UPSERT on twilio_message_sid handles race between send + status callback.

CREATE TABLE IF NOT EXISTS sms_messages (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_message_sid  TEXT        NOT NULL,
  phone_e164          TEXT        NOT NULL,
  direction           TEXT        NOT NULL DEFAULT 'outbound'
    CONSTRAINT sms_dir_chk CHECK (direction IN ('outbound','inbound')),
  message_type        TEXT,
  status              TEXT,
  error_code          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sms_messages_sid_uq UNIQUE (twilio_message_sid)
);

CREATE INDEX IF NOT EXISTS idx_sms_msg_phone ON sms_messages(phone_e164);
CREATE INDEX IF NOT EXISTS idx_sms_msg_sid   ON sms_messages(twilio_message_sid);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_sms_msg_updated_at') THEN
    CREATE TRIGGER set_sms_msg_updated_at BEFORE UPDATE ON sms_messages
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;

SELECT 'sms_subscribers' AS tbl, COUNT(*) FROM sms_subscribers
UNION ALL
SELECT 'sms_messages',           COUNT(*) FROM sms_messages;
