-- KVRN 049: immutable, per-campaign recipient-reference snapshots.
-- UNAPPLIED; STAGING FIRST. NEVER schedules or sends messages.
-- Requires 038, 043, 044. Foreign keys hold only internal subscriber IDs.
-- Consent/suppressions/provider status MUST be rechecked at delivery time;
-- freezing a list NEVER authorizes delivery, creates marketing consent, or
-- converts unverified imported records to valid opt-ins.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_audience_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES marketing_campaign_drafts(id) ON DELETE RESTRICT,
 campaign_version integer NOT NULL CHECK(campaign_version>=1),
 channel text NOT NULL CHECK(channel IN ('sms','email')),
 audience text NOT NULL CHECK(audience IN ('all-consenting','recent-opt-ins')),
 request_key text NOT NULL UNIQUE CHECK(request_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
 created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_aud_campaign ON marketing_audience_snapshots(campaign_id,created_at DESC);
CREATE TABLE IF NOT EXISTS marketing_audience_members (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 snapshot_id uuid NOT NULL REFERENCES marketing_audience_snapshots(id) ON DELETE RESTRICT,
 sms_subscriber_id uuid REFERENCES sms_subscribers(id) ON DELETE RESTRICT,
 email_subscriber_id uuid REFERENCES marketing_subscribers(id) ON DELETE RESTRICT,
 CONSTRAINT audience_exactly_one_channel CHECK ((sms_subscriber_id IS NOT NULL) <> (email_subscriber_id IS NOT NULL))
);
-- PostgreSQL unique NULL semantics require channel-specific unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ma_s_unique ON marketing_audience_members(snapshot_id,sms_subscriber_id)
 WHERE sms_subscriber_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ma_e_unique ON marketing_audience_members(snapshot_id,email_subscriber_id)
 WHERE email_subscriber_id IS NOT NULL;
CREATE OR REPLACE FUNCTION kvrn_marketing_prepare_snapshot(p_campaign uuid,p_version integer,p_request_key text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_campaign marketing_campaign_drafts%ROWTYPE;
 v_existing marketing_audience_snapshots%ROWTYPE;
 v_snapshot uuid;
 v_count integer;
BEGIN
 IF p_campaign IS NULL OR p_version IS NULL OR p_version<1 OR p_request_key IS NULL
    OR p_request_key !~ '^[A-Za-z0-9:_-]{12,120}$'
 THEN RAISE EXCEPTION 'AUDIENCE_SNAPSHOT_INVALID_INPUT'; END IF;
 -- One lock serializes competing freezes with other freezes of the same draft.
 SELECT * INTO v_campaign FROM marketing_campaign_drafts WHERE id=p_campaign FOR UPDATE;
 IF NOT FOUND OR v_campaign.state<>'reviewed' OR v_campaign.version<>p_version
    OR v_campaign.audience NOT IN ('all-consenting','recent-opt-ins')
 THEN RAISE EXCEPTION 'AUDIENCE_SNAPSHOT_CAMPAIGN_NOT_READY'; END IF;
 SELECT * INTO v_existing FROM marketing_audience_snapshots WHERE request_key=p_request_key;
 IF FOUND THEN
   IF v_existing.campaign_id=p_campaign AND v_existing.campaign_version=p_version
      AND v_existing.channel=v_campaign.channel AND v_existing.audience=v_campaign.audience
   THEN RETURN v_existing.id; END IF;
   RAISE EXCEPTION 'AUDIENCE_SNAPSHOT_KEY_CONFLICT';
 END IF;
 INSERT INTO marketing_audience_snapshots(campaign_id,campaign_version,channel,audience,request_key)
 VALUES(p_campaign,p_version,v_campaign.channel,v_campaign.audience,p_request_key)
 RETURNING id INTO v_snapshot;
 IF v_campaign.channel='sms' THEN
   INSERT INTO marketing_audience_members(snapshot_id,sms_subscriber_id)
   SELECT v_snapshot,s.id FROM sms_subscribers s
   WHERE s.status='subscribed' AND s.unsubscribed_at IS NULL
    AND s.consent_source='sms_keyword' AND s.twilio_opt_out_state='opted_in'
    AND EXISTS (SELECT 1 FROM sms_keyword_consent_proofs p
      WHERE p.subscriber_id=s.id AND p.confirmed_at>=s.consented_at
      AND (v_campaign.audience='all-consenting' OR p.confirmed_at>NOW()-INTERVAL '30 days'));
 ELSE
   INSERT INTO marketing_audience_members(snapshot_id,email_subscriber_id)
   SELECT v_snapshot,s.id FROM marketing_subscribers s
   WHERE s.status='subscribed' AND s.unsubscribed_at IS NULL
    AND EXISTS (SELECT 1 FROM marketing_email_consent_events e
      WHERE e.subscriber_id=s.id AND e.event_type='affirmative_checkbox'
      AND (v_campaign.audience='all-consenting' OR e.recorded_at>NOW()-INTERVAL '30 days'))
    AND NOT EXISTS (SELECT 1 FROM marketing_email_consent_events e
      WHERE e.subscriber_id=s.id AND e.event_type='unsubscribed');
 END IF;
 SELECT COUNT(*) INTO v_count FROM marketing_audience_members WHERE snapshot_id=v_snapshot;
 IF v_count<1 OR v_count>50 THEN RAISE EXCEPTION 'AUDIENCE_SNAPSHOT_COUNT_BLOCKED'; END IF;
 RETURN v_snapshot;
END; $$;
-- Never mutate a frozen audience after creation, including direct SQL clients.
CREATE OR REPLACE FUNCTION kvrn_marketing_audience_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AUDIENCE_SNAPSHOT_IMMUTABLE'; END; $$;
CREATE TRIGGER marketing_audience_snapshot_immutable BEFORE UPDATE OR DELETE ON marketing_audience_snapshots
  FOR EACH ROW EXECUTE FUNCTION kvrn_marketing_audience_immutable();
CREATE TRIGGER marketing_audience_member_immutable BEFORE UPDATE OR DELETE ON marketing_audience_members
  FOR EACH ROW EXECUTE FUNCTION kvrn_marketing_audience_immutable();
-- No provider senders, schedules, AI calls, or message tables are created.
COMMIT;
