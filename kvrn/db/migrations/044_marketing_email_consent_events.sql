-- KVRN 044 — append-only email consent history. NOT APPLIED.
-- Must follow 038–043 in owner-approved isolated staging first.
-- This stores proof of a form assertion, NOT proof of mailbox ownership.
-- Existing marketing subscribers are left unchanged and unverified by this migration.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_email_consent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES marketing_subscribers(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK(event_type IN ('affirmative_checkbox','resubscribe_requested','unsubscribed')),
  source text NOT NULL CHECK(source IN ('homepage','footer','waitlist','signed_self_service','support_staff')),
  statement_version text NOT NULL CHECK(length(statement_version) BETWEEN 6 AND 80),
  recorded_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_consent_events_subscriber
  ON marketing_email_consent_events (subscriber_id,recorded_at DESC,id DESC);
CREATE OR REPLACE FUNCTION kvrn_email_consent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'KVRN_EMAIL_CONSENT_EVENTS_APPEND_ONLY'; END; $$;
DROP TRIGGER IF EXISTS kvrn_email_consent_events_immutable ON marketing_email_consent_events;
CREATE TRIGGER kvrn_email_consent_events_immutable
  BEFORE UPDATE OR DELETE ON marketing_email_consent_events
  FOR EACH ROW EXECUTE FUNCTION kvrn_email_consent_immutable();
COMMIT;
