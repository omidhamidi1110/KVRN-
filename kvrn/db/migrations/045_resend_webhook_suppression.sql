-- KVRN migration 045: Resend provider-originated marketing suppression.
-- DEVELOPMENT ONLY. Apply AFTER 044 in isolated staging with approval.
-- No provider webhook is enabled by this migration; application flag remains OFF.
-- Atomic event-idempotency + canonical suppression. No raw webhook payloads stored.
BEGIN;

CREATE TABLE IF NOT EXISTS marketing_provider_suppression_events (
  provider_event_id text PRIMARY KEY CHECK (length(provider_event_id) BETWEEN 8 AND 150),
  provider text NOT NULL DEFAULT 'resend' CHECK (provider='resend'),
  reason text NOT NULL CHECK (reason IN ('contact_unsubscribed','email_complaint','permanent_bounce','email_suppressed')),
  received_at timestamptz NOT NULL DEFAULT NOW()
);

-- The existing consent history (044) deliberately allows only known source types.
-- Extend it additively for independently verified Resend webhook events.
ALTER TABLE marketing_email_consent_events DROP CONSTRAINT IF EXISTS marketing_email_consent_events_source_check;
ALTER TABLE marketing_email_consent_events ADD CONSTRAINT marketing_email_consent_events_source_check
  CHECK (source IN ('homepage','footer','waitlist','signed_self_service','support_staff','resend_webhook'));

CREATE OR REPLACE FUNCTION kvrn_resend_suppress_marketing(
  p_event_id text, p_email text, p_reason text
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_recorded boolean;
  v_subscriber_id uuid;
  v_email text := lower(btrim(p_email));
BEGIN
  IF length(p_event_id) NOT BETWEEN 8 AND 150 OR p_event_id !~ '^[A-Za-z0-9_-]+$' OR
     length(v_email)>254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' OR
     p_reason NOT IN ('contact_unsubscribed','email_complaint','permanent_bounce','email_suppressed')
  THEN RAISE EXCEPTION 'INVALID_RESEND_SUPPRESSION_EVENT'; END IF;

  INSERT INTO marketing_provider_suppression_events(provider_event_id,reason)
  VALUES(p_event_id,p_reason)
  ON CONFLICT(provider_event_id) DO NOTHING
  RETURNING true INTO v_recorded;
  IF NOT coalesce(v_recorded,false) THEN RETURN false; END IF;

  -- A provider STOP or hard bounce suppresses even a previously unknown address.
  -- consented_at is mandatory legacy schema, NOT verified consent for this row.
  INSERT INTO marketing_subscribers(email,status,consent_source,consented_at,unsubscribed_at,sync_status)
  VALUES(v_email,'unsubscribed','manual_admin',NOW(),NOW(),'pending')
  ON CONFLICT(email) DO UPDATE
    SET status='unsubscribed',unsubscribed_at=coalesce(marketing_subscribers.unsubscribed_at,NOW()),
        sync_status='pending',updated_at=NOW()
  RETURNING id INTO v_subscriber_id;

  INSERT INTO marketing_email_consent_events(subscriber_id,event_type,source,statement_version)
  VALUES(v_subscriber_id,'unsubscribed','resend_webhook','KVRN-resend-verified-webhook-2026-10-08');
  RETURN true;
END; $$;

-- Provider events are append-only. Retention requires a separate, reviewed policy.
CREATE OR REPLACE FUNCTION kvrn_resend_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'RESEND_SUPPRESSION_EVENTS_APPEND_ONLY'; END; $$;
CREATE TRIGGER marketing_provider_suppression_events_immutable
  BEFORE UPDATE OR DELETE ON marketing_provider_suppression_events
  FOR EACH ROW EXECUTE FUNCTION kvrn_resend_event_immutable();
COMMIT;
