-- KVRN 066 — Legacy SMS provider exports: quarantine + suppression evidence.
-- NO subscriber opt-ins created. No marketing sends. Import requires explicit owner action.
BEGIN;
CREATE TABLE IF NOT EXISTS legacy_sms_import_contacts (
  phone_e164 text PRIMARY KEY CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  legacy_customer_id text,
  record_state text NOT NULL CHECK(record_state IN ('review_required','suppressed')),
  reported_keyword text,
  legacy_created_at timestamptz,
  opted_out_at timestamptz,
  opted_out_reason text,
  import_batch_sha256 text NOT NULL CHECK(import_batch_sha256 ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_sms_optout_state CHECK(record_state <> 'suppressed' OR opted_out_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_legacy_sms_state ON legacy_sms_import_contacts(record_state);
COMMENT ON TABLE legacy_sms_import_contacts IS 'Quarantined legacy provider data; NEVER use as recipient eligibility or as proof of current KVRN consent.';
COMMIT;
