-- KVRN 043 — verified KVRN marketing SMS JOIN -> YES consent evidence.
-- STAGING ONLY, NOT APPLIED; apply after 040 with owner review.
-- Captures proof ONLY after validated Twilio signature and consumed pending JOIN intent.
-- Historical 'opted_in' rows cannot be backfilled or treated as newly verified.
BEGIN;
CREATE TABLE IF NOT EXISTS sms_keyword_consent_proofs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES sms_subscribers(id) ON DELETE RESTRICT,
  confirmation_message_sid text NOT NULL UNIQUE CHECK(confirmation_message_sid ~ '^(SM|MM)[A-Za-z0-9]{32}$'),
  join_requested_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT NOW(),
  verification_method text NOT NULL DEFAULT 'twilio_signed_inbound_join_yes'
    CHECK(verification_method='twilio_signed_inbound_join_yes'),
  CONSTRAINT sms_consent_evidence_temporal CHECK(confirmed_at>=join_requested_at)
);
CREATE INDEX IF NOT EXISTS idx_sms_verified_proofs_subscriber
  ON sms_keyword_consent_proofs(subscriber_id,confirmed_at DESC);
CREATE OR REPLACE FUNCTION kvrn_sms_consent_proofs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SMS_CONSENT_PROOF_IS_APPEND_ONLY'; END; $$;
CREATE TRIGGER sms_consent_proofs_immutable BEFORE UPDATE OR DELETE ON sms_keyword_consent_proofs
  FOR EACH ROW EXECUTE FUNCTION kvrn_sms_consent_proofs_immutable();
-- Proof is historical evidence only. An active subscriber also requires no
-- later STOP, current program-specific consent and a fresh eligibility check.
COMMIT;
