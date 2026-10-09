-- KVRN 058: fail-closed at-most-once marketing delivery claim.
-- STAGING DESIGN ONLY, NOT APPLIED. Prereqs 038,039,043,044,046,049,050,052,054.
-- NO provider calls, no cron consumer, no sendable queue and no bypass of consent.
-- A claim reserves one local delivery slot in UNCERTAIN status *before* any future
-- provider call. Retrying the claim does not grant permission to send again.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_recipient_delivery_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 plan_id uuid NOT NULL REFERENCES marketing_staged_delivery_plans(id) ON DELETE RESTRICT,
 audience_member_id bigint NOT NULL REFERENCES marketing_audience_members(id) ON DELETE RESTRICT,
 approval_id uuid NOT NULL REFERENCES marketing_owner_approvals(id) ON DELETE RESTRICT,
 reviewer_sha256 text NOT NULL CHECK(reviewer_sha256 ~ '^[0-9a-f]{64}$'),
 -- Provider opt-outs, region, time-zone and frequency must each be verified
 -- through independent trusted evidence. Never infer timezone from dial code.
 provider_suppression_proof_sha256 text NOT NULL CHECK(provider_suppression_proof_sha256 ~ '^[0-9a-f]{64}$'),
 jurisdiction_proof_sha256 text NOT NULL CHECK(jurisdiction_proof_sha256 ~ '^[0-9a-f]{64}$'),
 frequency_proof_sha256 text NOT NULL CHECK(frequency_proof_sha256 ~ '^[0-9a-f]{64}$'),
 provider_price_proof_sha256 text NOT NULL CHECK(provider_price_proof_sha256 ~ '^[0-9a-f]{64}$'),
 -- The exact owner-reviewed final message, not just mutable draft text.
 approved_message_sha256 text NOT NULL CHECK(approved_message_sha256 ~ '^[0-9a-f]{64}$'),
 recipient_timezone text NOT NULL CHECK(length(recipient_timezone) BETWEEN 4 AND 80),
 per_recipient_worst_micros bigint NOT NULL CHECK(per_recipient_worst_micros BETWEEN 1 AND 2000000),
 verified_at timestamptz NOT NULL DEFAULT NOW(),
 expires_at timestamptz NOT NULL,
 CONSTRAINT marketing_evidence_expiry CHECK(expires_at>verified_at AND expires_at<=verified_at+INTERVAL '5 minutes'),
 CONSTRAINT marketing_evidence_unique UNIQUE(plan_id,audience_member_id,approval_id,verified_at)
);
CREATE INDEX IF NOT EXISTS idx_marketing_evidence_latest ON marketing_recipient_delivery_evidence(plan_id,audience_member_id,approval_id,verified_at DESC);
CREATE TABLE IF NOT EXISTS marketing_delivery_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 plan_id uuid NOT NULL REFERENCES marketing_staged_delivery_plans(id) ON DELETE RESTRICT,
 audience_member_id bigint NOT NULL REFERENCES marketing_audience_members(id) ON DELETE RESTRICT,
 approval_id uuid NOT NULL REFERENCES marketing_owner_approvals(id) ON DELETE RESTRICT,
 budget_reservation_id uuid NOT NULL REFERENCES marketing_budget_reservations(id) ON DELETE RESTRICT,
 evidence_id uuid NOT NULL UNIQUE REFERENCES marketing_recipient_delivery_evidence(id) ON DELETE RESTRICT,
 message_sha256 text NOT NULL CHECK(message_sha256 ~ '^[0-9a-f]{64}$'),
 claim_key text NOT NULL UNIQUE CHECK(claim_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
 provider text NOT NULL CHECK(provider IN ('twilio','resend')),
 -- Uncertain is terminal for retries: an HTTP timeout cannot be assumed unsent.
 state text NOT NULL DEFAULT 'unknown' CHECK(state='unknown'),
 claimed_at timestamptz NOT NULL DEFAULT NOW(),
 CONSTRAINT marketing_attempt_one_per_recipient UNIQUE(plan_id,audience_member_id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_attempt_member ON marketing_delivery_attempts(audience_member_id,claimed_at DESC);
-- A provider-verifiable final result must exist before ANY uncertain contact may
-- be considered for another campaign. A timeout is never 'not submitted'.
CREATE TABLE IF NOT EXISTS marketing_delivery_attempt_outcomes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 attempt_id uuid NOT NULL UNIQUE REFERENCES marketing_delivery_attempts(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK(outcome IN ('provider_accepted','verified_not_submitted')),
 verified_source text NOT NULL CHECK(verified_source IN ('provider_final_status','provider_invoice','verified_provider_rejection')),
 provider_reference_sha256 text NOT NULL UNIQUE CHECK(provider_reference_sha256 ~ '^[0-9a-f]{64}$'),
 verified_at timestamptz NOT NULL DEFAULT NOW(),
 CONSTRAINT marketing_attempt_evidence_type CHECK(
   (outcome='provider_accepted' AND verified_source IN ('provider_final_status','provider_invoice')) OR
   (outcome='verified_not_submitted' AND verified_source='verified_provider_rejection')
 )
);


CREATE OR REPLACE FUNCTION kvrn_marketing_claim_at_most_once(
 p_plan uuid,p_member bigint,p_approval uuid,p_reservation uuid,p_evidence uuid,
 p_message_sha256 text,p_claim_key text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_plan marketing_staged_delivery_plans%ROWTYPE;
 v_snap marketing_audience_snapshots%ROWTYPE;
 v_member marketing_audience_members%ROWTYPE;
 v_approval marketing_owner_approvals%ROWTYPE;
 v_res marketing_budget_reservations%ROWTYPE;
 v_evidence marketing_recipient_delivery_evidence%ROWTYPE;
 v_campaign marketing_campaign_drafts%ROWTYPE;
 v_policy marketing_budget_policy%ROWTYPE;
 v_count integer;
 v_claim uuid;
 v_recent integer;
 v_local_hour integer;
 v_evidenced_members integer;
 v_total_verified_price numeric;
 v_latest_evidence uuid;
BEGIN
 IF p_plan IS NULL OR p_member IS NULL OR p_member<=0 OR p_approval IS NULL
  OR p_reservation IS NULL OR p_evidence IS NULL
  OR p_message_sha256 IS NULL OR p_message_sha256 !~ '^[0-9a-f]{64}$'
  OR p_claim_key IS NULL OR p_claim_key !~ '^[A-Za-z0-9:_-]{12,120}$'
 THEN RAISE EXCEPTION 'MARKETING_CLAIM_BAD_INPUT'; END IF;
 -- Shared budget lock, THEN staging lock. Keep this order in future writers.
 PERFORM pg_advisory_xact_lock(48112026046::bigint);
 PERFORM pg_advisory_xact_lock(48112026050::bigint);
 SELECT * INTO v_policy FROM marketing_budget_policy WHERE id=1 FOR SHARE;
 IF NOT FOUND OR v_policy.dispatch_enabled IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'MARKETING_DISPATCH_DISABLED'; END IF;
 -- Any retry returns an error and therefore MUST NOT cause another provider call.
 IF EXISTS(SELECT 1 FROM marketing_delivery_attempts WHERE plan_id=p_plan AND audience_member_id=p_member)
  OR EXISTS(SELECT 1 FROM marketing_delivery_attempts WHERE claim_key=p_claim_key)
 THEN RAISE EXCEPTION 'MARKETING_CLAIM_ALREADY_ATTEMPTED_NO_RETRY'; END IF;
 SELECT * INTO v_plan FROM marketing_staged_delivery_plans WHERE id=p_plan FOR UPDATE;
 IF NOT FOUND OR v_plan.state<>'staged' THEN RAISE EXCEPTION 'MARKETING_PLAN_INACTIVE'; END IF;
 SELECT * INTO v_snap FROM marketing_audience_snapshots WHERE id=v_plan.snapshot_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKETING_SNAPSHOT_MISSING'; END IF;
 SELECT * INTO v_campaign FROM marketing_campaign_drafts WHERE id=v_snap.campaign_id FOR SHARE;
 IF NOT FOUND OR v_campaign.state<>'reviewed' OR v_campaign.version<>v_snap.campaign_version
 THEN RAISE EXCEPTION 'MARKETING_CAMPAIGN_STALE'; END IF;
 SELECT * INTO v_member FROM marketing_audience_members WHERE id=p_member AND snapshot_id=v_snap.id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM marketing_staged_delivery_items
   WHERE plan_id=p_plan AND audience_member_id=p_member AND state='staged')
 THEN RAISE EXCEPTION 'MARKETING_MEMBER_NOT_STAGED'; END IF;
 SELECT * INTO v_approval FROM marketing_owner_approvals WHERE id=p_approval FOR SHARE;
 IF NOT FOUND OR v_approval.plan_id<>p_plan OR v_approval.campaign_id<>v_campaign.id
  OR v_approval.campaign_version<>v_campaign.version OR v_approval.state<>'approved'
  OR v_approval.expires_at<=NOW() THEN RAISE EXCEPTION 'MARKETING_APPROVAL_INVALID'; END IF;
 SELECT COUNT(*)::integer INTO v_count FROM marketing_staged_delivery_items
  WHERE plan_id=p_plan AND state='staged';
 IF v_count<>v_approval.recipient_count OR v_count NOT BETWEEN 1 AND 50
 THEN RAISE EXCEPTION 'MARKETING_RECIPIENT_SET_CHANGED'; END IF;
 SELECT * INTO v_res FROM marketing_budget_reservations WHERE id=p_reservation FOR SHARE;
 IF NOT FOUND OR v_res.campaign_id<>v_campaign.id OR v_res.channel<>v_campaign.channel
  OR v_res.state<>'reserved' OR v_res.budget_utc_day<>(NOW() AT TIME ZONE 'UTC')::date
  OR v_res.budget_utc_month<>date_trunc('month',NOW() AT TIME ZONE 'UTC')::date
 THEN RAISE EXCEPTION 'MARKETING_BUDGET_NOT_RESERVED_OR_STALE'; END IF;
 SELECT * INTO v_evidence FROM marketing_recipient_delivery_evidence WHERE id=p_evidence FOR SHARE;
 IF NOT FOUND OR v_evidence.plan_id<>p_plan OR v_evidence.audience_member_id<>p_member
  OR v_evidence.approval_id<>p_approval
  OR v_evidence.reviewer_sha256<>v_approval.owner_identity_sha256
  OR v_evidence.approved_message_sha256<>p_message_sha256
  OR v_evidence.expires_at<=NOW() OR v_evidence.verified_at>NOW()
 THEN RAISE EXCEPTION 'MARKETING_RECIPIENT_EVIDENCE_MISSING_OR_STALE'; END IF;
 -- Short-lived evidence can be renewed while the owner approval is valid.
 -- A stale reference may NEVER be used after a newer verification supersedes it.
 SELECT ev.id INTO v_latest_evidence FROM marketing_recipient_delivery_evidence ev
 WHERE ev.plan_id=p_plan AND ev.audience_member_id=p_member AND ev.approval_id=p_approval
 ORDER BY ev.verified_at DESC,ev.id DESC LIMIT 1;
 IF v_latest_evidence IS DISTINCT FROM p_evidence
 THEN RAISE EXCEPTION 'MARKETING_RECIPIENT_EVIDENCE_SUPERSEDED'; END IF;
 -- Require provider-reviewed evidence for EVERY recipient, not merely the one
 -- being claimed. Cost can differ by recipient/country; sum actual worst-case
 -- quotes rather than multiplying one recipient's price by the full audience.
 SELECT COUNT(ev.id)::integer,COALESCE(SUM(ev.per_recipient_worst_micros::numeric),0)
 INTO v_evidenced_members,v_total_verified_price
 FROM marketing_staged_delivery_items i
 LEFT JOIN LATERAL (
  SELECT ev2.* FROM marketing_recipient_delivery_evidence ev2
  WHERE ev2.plan_id=i.plan_id AND ev2.audience_member_id=i.audience_member_id
   AND ev2.approval_id=p_approval
  ORDER BY ev2.verified_at DESC,ev2.id DESC LIMIT 1
 ) ev ON ev.expires_at>NOW() AND ev.verified_at<=NOW()
   AND ev.reviewer_sha256=v_approval.owner_identity_sha256
   -- Each email recipient has a DIFFERENT signed unsubscribe URL and therefore
   -- its own exact approved final-message hash. Require every member's fresh
   -- evidence here, then verify the specific recipient hash separately above.
 WHERE i.plan_id=p_plan AND i.state='staged';
 IF v_evidenced_members<>v_count OR v_total_verified_price<=0
  OR v_total_verified_price>v_approval.maximum_cost_micros::numeric
  OR v_total_verified_price>v_res.reserved_micros::numeric
 THEN RAISE EXCEPTION 'MARKETING_AUDIENCE_PRICING_OR_APPROVAL_MISSING'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=v_evidence.recipient_timezone)
 THEN RAISE EXCEPTION 'MARKETING_TIMEZONE_INVALID'; END IF;
 v_local_hour:=EXTRACT(HOUR FROM NOW() AT TIME ZONE v_evidence.recipient_timezone)::integer;
 IF v_local_hour<9 OR v_local_hour>=20
 THEN RAISE EXCEPTION 'MARKETING_QUIET_HOURS'; END IF;
 -- Do NOT infer fresh consent from a frozen list or from old CSV data.
 IF v_campaign.channel='sms' THEN
  IF v_member.sms_subscriber_id IS NULL OR v_member.email_subscriber_id IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM sms_subscribers s WHERE s.id=v_member.sms_subscriber_id
    AND s.status='subscribed' AND s.consent_source='sms_keyword'
    AND s.twilio_opt_out_state='opted_in' AND s.unsubscribed_at IS NULL
    AND EXISTS(SELECT 1 FROM sms_keyword_consent_proofs pr
      WHERE pr.subscriber_id=s.id AND pr.confirmed_at>=s.consented_at))
  THEN RAISE EXCEPTION 'MARKETING_SMS_CONSENT_REVOKED'; END IF;
 ELSE
  IF v_member.email_subscriber_id IS NULL OR v_member.sms_subscriber_id IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM marketing_subscribers s WHERE s.id=v_member.email_subscriber_id
    AND s.status='subscribed' AND s.unsubscribed_at IS NULL
    AND EXISTS(SELECT 1 FROM marketing_email_consent_events e
      WHERE e.subscriber_id=s.id AND e.event_type='affirmative_checkbox')
    AND NOT EXISTS(SELECT 1 FROM marketing_email_consent_events e
      WHERE e.subscriber_id=s.id AND e.event_type='unsubscribed'))
  THEN RAISE EXCEPTION 'MARKETING_EMAIL_CONSENT_REVOKED'; END IF;
 END IF;
 -- An unknown provider outcome remains blocked indefinitely, not just
 -- for 72h. Confirmed sends have a separate 72h frequency limit. Only a
 -- signed/verified definitely-not-submitted record can clear the unknown risk.
 SELECT COUNT(*)::integer INTO v_recent FROM marketing_delivery_attempts a
 JOIN marketing_audience_members m ON m.id=a.audience_member_id
 LEFT JOIN marketing_delivery_attempt_outcomes o ON o.attempt_id=a.id
 WHERE ((v_member.sms_subscriber_id IS NOT NULL AND m.sms_subscriber_id=v_member.sms_subscriber_id)
  OR (v_member.email_subscriber_id IS NOT NULL AND m.email_subscriber_id=v_member.email_subscriber_id))
  AND (o.id IS NULL OR (o.outcome='provider_accepted' AND a.claimed_at>NOW()-INTERVAL '72 hours'));
 IF v_recent>0 THEN RAISE EXCEPTION 'MARKETING_RECIPIENT_FREQUENCY_LIMIT'; END IF;
 INSERT INTO marketing_delivery_attempts(plan_id,audience_member_id,approval_id,budget_reservation_id,
  evidence_id,message_sha256,claim_key,provider)
 VALUES(p_plan,p_member,p_approval,p_reservation,p_evidence,p_message_sha256,p_claim_key,
  CASE WHEN v_campaign.channel='sms' THEN 'twilio' ELSE 'resend' END)
 RETURNING id INTO v_claim;
 RETURN v_claim;
END; $$;

CREATE OR REPLACE FUNCTION kvrn_marketing_delivery_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MARKETING_DELIVERY_EVIDENCE_APPEND_ONLY'; END; $$;
CREATE TRIGGER delivery_evidence_immutable BEFORE UPDATE OR DELETE
 ON marketing_recipient_delivery_evidence FOR EACH ROW EXECUTE FUNCTION kvrn_marketing_delivery_evidence_immutable();
CREATE OR REPLACE FUNCTION kvrn_marketing_delivery_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MARKETING_DELIVERY_ATTEMPTS_APPEND_ONLY'; END; $$;
CREATE TRIGGER marketing_delivery_attempt_immutable BEFORE UPDATE OR DELETE
 ON marketing_delivery_attempts FOR EACH ROW EXECUTE FUNCTION kvrn_marketing_delivery_attempt_immutable();
CREATE OR REPLACE FUNCTION kvrn_marketing_outcome_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MARKETING_DELIVERY_OUTCOMES_APPEND_ONLY'; END; $$;
CREATE TRIGGER marketing_delivery_outcome_immutable BEFORE UPDATE OR DELETE
 ON marketing_delivery_attempt_outcomes FOR EACH ROW EXECUTE FUNCTION kvrn_marketing_outcome_immutable();
-- No application caller, no transport adapter and no network access installed.
COMMIT;
