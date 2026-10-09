-- KVRN 050: internal delivery PREPARATION only. STAGING ONLY, NOT APPLIED.
-- Requires 038, 043, 044, 049. This schema deliberately offers ZERO send-able
-- state, NO provider identifiers, NO message body, NO outbound delivery worker,
-- NO campaign or budget approval, and NO automatic publish/schedule trigger.
-- Revalidate consent/suppression, owner approval, recipient timezone, prices and
-- budget atomically BEFORE any future physical send, in a separately audited phase.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_staged_delivery_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL UNIQUE REFERENCES marketing_audience_snapshots(id) ON DELETE RESTRICT,
  request_key text NOT NULL UNIQUE CHECK(request_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
  state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','cancelled')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  cancelled_at timestamptz,
  CONSTRAINT cancelled_stage_timestamp CHECK (
    (state='staged' AND cancelled_at IS NULL) OR (state='cancelled' AND cancelled_at IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS marketing_staged_delivery_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES marketing_staged_delivery_plans(id) ON DELETE RESTRICT,
  audience_member_id bigint NOT NULL REFERENCES marketing_audience_members(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','cancelled')),
  CONSTRAINT unique_staged_recipient UNIQUE(plan_id,audience_member_id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_delivery_plan_state ON marketing_staged_delivery_plans(state,created_at DESC);

CREATE OR REPLACE FUNCTION kvrn_marketing_stage_delivery_plan(p_snapshot uuid,p_request_key text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_snapshot marketing_audience_snapshots%ROWTYPE;
 v_existing marketing_staged_delivery_plans%ROWTYPE;
 v_campaign_state text;
 v_campaign_version integer;
 v_count integer;
 v_eligible integer;
 v_id uuid;
BEGIN
 IF p_snapshot IS NULL OR p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9:_-]{12,120}$'
 THEN RAISE EXCEPTION 'DELIVERY_PLAN_INVALID_INPUT'; END IF;
 -- Serialize preparation and cancellation without requiring sessionful DB driver.
 PERFORM pg_advisory_xact_lock(48112026050::bigint);
 SELECT * INTO v_existing FROM marketing_staged_delivery_plans WHERE request_key=p_request_key;
 IF FOUND THEN
   IF v_existing.snapshot_id=p_snapshot THEN RETURN v_existing.id; END IF;
   RAISE EXCEPTION 'DELIVERY_PLAN_KEY_CONFLICT';
 END IF;
 SELECT * INTO v_snapshot FROM marketing_audience_snapshots WHERE id=p_snapshot;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_SNAPSHOT_MISSING'; END IF;
 SELECT state,version INTO v_campaign_state,v_campaign_version FROM marketing_campaign_drafts
 WHERE id=v_snapshot.campaign_id FOR SHARE;
 IF v_campaign_state IS DISTINCT FROM 'reviewed' OR v_campaign_version IS DISTINCT FROM v_snapshot.campaign_version
 THEN RAISE EXCEPTION 'DELIVERY_CAMPAIGN_COPY_STALE'; END IF;
 SELECT COUNT(*) INTO v_count FROM marketing_audience_members WHERE snapshot_id=p_snapshot;
 IF v_count<1 OR v_count>50 THEN RAISE EXCEPTION 'DELIVERY_INITIAL_RECIPIENT_CAP'; END IF;
 -- Even this non-sending preparation refuses subscribers revoked since the
 -- snapshot. The future sender must check provider opt-outs AGAIN just-in-time.
 SELECT COUNT(*) INTO v_eligible FROM marketing_audience_members m
 LEFT JOIN sms_subscribers sms ON sms.id=m.sms_subscriber_id
 LEFT JOIN marketing_subscribers em ON em.id=m.email_subscriber_id
 WHERE m.snapshot_id=p_snapshot AND (
   (v_snapshot.channel='sms' AND sms.id IS NOT NULL
     AND sms.status='subscribed' AND sms.unsubscribed_at IS NULL
     AND sms.consent_source='sms_keyword' AND sms.twilio_opt_out_state='opted_in'
     AND EXISTS (SELECT 1 FROM sms_keyword_consent_proofs proof
       WHERE proof.subscriber_id=sms.id AND proof.confirmed_at>=sms.consented_at))
   OR
   (v_snapshot.channel='email' AND em.id IS NOT NULL
     AND em.status='subscribed' AND em.unsubscribed_at IS NULL
     AND EXISTS (SELECT 1 FROM marketing_email_consent_events e
       WHERE e.subscriber_id=em.id AND e.event_type='affirmative_checkbox')
     AND NOT EXISTS (SELECT 1 FROM marketing_email_consent_events e
       WHERE e.subscriber_id=em.id AND e.event_type='unsubscribed'))
 );
 IF v_eligible<>v_count THEN RAISE EXCEPTION 'DELIVERY_RECENT_CONSENT_REVOKED'; END IF;
 INSERT INTO marketing_staged_delivery_plans(snapshot_id,request_key)
 VALUES(p_snapshot,p_request_key) RETURNING id INTO v_id;
 INSERT INTO marketing_staged_delivery_items(plan_id,audience_member_id)
 SELECT v_id,m.id FROM marketing_audience_members m WHERE m.snapshot_id=p_snapshot;
 RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION kvrn_marketing_cancel_staged_delivery(p_plan uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
 IF p_plan IS NULL THEN RAISE EXCEPTION 'DELIVERY_PLAN_INVALID_ID'; END IF;
 PERFORM pg_advisory_xact_lock(48112026050::bigint);
 SELECT state INTO v_state FROM marketing_staged_delivery_plans WHERE id=p_plan FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_PLAN_NOT_FOUND'; END IF;
 IF v_state='cancelled' THEN RETURN false; END IF;
 UPDATE marketing_staged_delivery_items SET state='cancelled' WHERE plan_id=p_plan AND state='staged';
 UPDATE marketing_staged_delivery_plans SET state='cancelled',cancelled_at=NOW() WHERE id=p_plan;
 RETURN true;
END; $$;
-- No transition to 'ready', 'sending', 'sent' or 'approved' exists.
-- No cron, Twilio or Resend workers may consume these preparation tables.
COMMIT;
