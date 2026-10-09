-- KVRN 040: pending keyword double opt-in staging foundation, not applied.
-- Production application requires explicit owner approval and verified Twilio A2P.
BEGIN;
CREATE TABLE IF NOT EXISTS sms_keyword_pending (
 phone_e164 text PRIMARY KEY CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
 claim_token_hash text CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[0-9a-f]{64}$'),
 requested_at timestamptz NOT NULL DEFAULT NOW(),
 expires_at timestamptz NOT NULL DEFAULT (NOW()+INTERVAL '30 minutes')
);
CREATE INDEX IF NOT EXISTS idx_sms_keyword_pending_exp ON sms_keyword_pending(expires_at);
-- No magic automatic confirmation: STOP clears this state, and YES is the only final step.
COMMIT;
