-- KVRN 047: durable suppression from a verified Resend topic-level opt-out.
-- STAGING DESIGN ONLY; NOT APPLIED. Requires 044 and 045. No provider calls.
-- An explicit Resend topic opt_out for the exact KVRN email is a revocation,
-- not permission to add/remove recipients or activate marketing.
BEGIN;
ALTER TABLE marketing_email_consent_events
  DROP CONSTRAINT IF EXISTS marketing_email_consent_events_source_check;
ALTER TABLE marketing_email_consent_events
  ADD CONSTRAINT marketing_email_consent_events_source_check
  CHECK (source IN (
    'homepage','footer','waitlist','signed_self_service','support_staff',
    'resend_webhook','resend_topic_reconciliation'
  ));

CREATE OR REPLACE FUNCTION kvrn_resend_topic_suppress_marketing(
  p_id uuid, p_email text, p_provider_contact_id text
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_email text := lower(btrim(p_email));
BEGIN
  IF p_id IS NULL OR v_email IS NULL OR length(v_email) > 254 OR
     v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' OR
     p_provider_contact_id IS NULL OR length(p_provider_contact_id) NOT BETWEEN 8 AND 150 OR
     p_provider_contact_id !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'INVALID_RESEND_TOPIC_SUPPRESSION'; END IF;

  UPDATE marketing_subscribers
     SET status='unsubscribed',
         unsubscribed_at=COALESCE(unsubscribed_at,NOW()),
         resend_contact_id=p_provider_contact_id,
         sync_status='pending', updated_at=NOW()
   WHERE id=p_id AND email=v_email AND status='subscribed'
   RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN false; END IF;

  INSERT INTO marketing_email_consent_events(
    subscriber_id,event_type,source,statement_version
  ) VALUES(
    v_id,'unsubscribed','resend_topic_reconciliation',
    'KVRN-resend-topic-optout-2026-10-08'
  );
  RETURN true;
END; $$;
COMMIT;
