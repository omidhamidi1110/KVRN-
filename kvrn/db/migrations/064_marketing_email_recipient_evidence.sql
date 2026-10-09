-- KVRN 064: owner-reviewed recipient-specific email delivery evidence writer.
-- DEVELOPMENT ONLY. Requires 038–060. No sending or automatic campaign jobs.
-- The email's deterministic per-subscriber unsubscribe token changes the exact
-- final message hash per recipient. Migration 058 validates that hash on claim;
-- its audience-total verification correctly requires all members' evidence,
-- NOT identical hashes for all members (fixed in unapplied 058).
BEGIN;
CREATE OR REPLACE FUNCTION kvrn_marketing_record_email_recipient_evidence(
 p_plan uuid,p_member bigint,p_approval uuid,p_owner_sha256 text,
 p_provider_proof text,p_jurisdiction_proof text,p_frequency_proof text,
 p_price_proof text,p_final_sha256 text,p_timezone text,p_worst_micros bigint
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_plan marketing_staged_delivery_plans%ROWTYPE;
 v_snapshot marketing_audience_snapshots%ROWTYPE;
 v_campaign marketing_campaign_drafts%ROWTYPE;
 v_approval marketing_owner_approvals%ROWTYPE;
 v_rec marketing_audience_members%ROWTYPE;
 v_sub marketing_subscribers%ROWTYPE;
 v_count integer;
 v_recent integer;
 v_id uuid;
BEGIN
 IF p_plan IS NULL OR p_member IS NULL OR p_member<=0 OR p_approval IS NULL
 OR p_owner_sha256 IS NULL OR p_owner_sha256 !~ '^[a-f0-9]{64}$'
 OR p_provider_proof IS NULL OR p_provider_proof !~ '^[a-f0-9]{64}$'
 OR p_jurisdiction_proof IS NULL OR p_jurisdiction_proof !~ '^[a-f0-9]{64}$'
 OR p_frequency_proof IS NULL OR p_frequency_proof !~ '^[a-f0-9]{64}$'
 OR p_price_proof IS NULL OR p_price_proof !~ '^[a-f0-9]{64}$'
 OR p_final_sha256 IS NULL OR p_final_sha256 !~ '^[a-f0-9]{64}$'
 OR p_timezone IS NULL OR length(p_timezone) NOT BETWEEN 4 AND 80
 OR p_worst_micros IS NULL OR p_worst_micros NOT BETWEEN 1 AND 2000000
 THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(48112026046::bigint);
 PERFORM pg_advisory_xact_lock(48112026050::bigint);
 SELECT * INTO v_plan FROM marketing_staged_delivery_plans WHERE id=p_plan FOR SHARE;
 IF NOT FOUND OR v_plan.state<>'staged' THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_PLAN_INACTIVE'; END IF;
 SELECT * INTO v_snapshot FROM marketing_audience_snapshots WHERE id=v_plan.snapshot_id FOR SHARE;
 IF NOT FOUND OR v_snapshot.channel<>'email' THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_EMAIL_ONLY'; END IF;
 SELECT * INTO v_campaign FROM marketing_campaign_drafts WHERE id=v_snapshot.campaign_id FOR SHARE;
 IF NOT FOUND OR v_campaign.state<>'reviewed' OR v_campaign.channel<>'email'
 OR v_campaign.version<>v_snapshot.campaign_version THEN
 RAISE EXCEPTION 'MARKETING_EVIDENCE_COPY_CHANGED'; END IF;
 SELECT * INTO v_approval FROM marketing_owner_approvals WHERE id=p_approval FOR SHARE;
 IF NOT FOUND OR v_approval.plan_id<>p_plan OR v_approval.campaign_id<>v_campaign.id
 OR v_approval.campaign_version<>v_campaign.version OR v_approval.state<>'approved'
 OR v_approval.expires_at<=NOW() OR v_approval.owner_identity_sha256<>p_owner_sha256
 THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_OWNER_APPROVAL_INVALID'; END IF;
 SELECT COUNT(*)::integer INTO v_count FROM marketing_staged_delivery_items
 WHERE plan_id=p_plan AND state='staged';
 IF v_count NOT BETWEEN 1 AND 50 OR v_count<>v_approval.recipient_count
 THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_AUDIENCE_CHANGED'; END IF;
 SELECT * INTO v_rec FROM marketing_audience_members WHERE id=p_member AND snapshot_id=v_snapshot.id FOR SHARE;
 IF NOT FOUND OR v_rec.email_subscriber_id IS NULL OR v_rec.sms_subscriber_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM marketing_staged_delivery_items
  WHERE plan_id=p_plan AND audience_member_id=p_member AND state='staged')
 THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_MEMBER_NOT_STAGED'; END IF;
 SELECT * INTO v_sub FROM marketing_subscribers WHERE id=v_rec.email_subscriber_id FOR SHARE;
 IF NOT FOUND OR v_sub.status<>'subscribed' OR v_sub.unsubscribed_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM marketing_email_consent_events
  WHERE subscriber_id=v_sub.id AND event_type='affirmative_checkbox')
 OR EXISTS(SELECT 1 FROM marketing_email_consent_events
  WHERE subscriber_id=v_sub.id AND event_type='unsubscribed')
 THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_CONSENT_REVOKED'; END IF;
 SELECT COUNT(*)::integer INTO v_recent FROM marketing_delivery_attempts a
 JOIN marketing_audience_members member ON member.id=a.audience_member_id
 LEFT JOIN marketing_delivery_attempt_outcomes o ON o.attempt_id=a.id
 WHERE member.email_subscriber_id=v_sub.id
 AND (o.id IS NULL OR (o.outcome='provider_accepted'
 AND a.claimed_at>NOW()-INTERVAL '72 hours'));
 IF v_recent>0 THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_FREQUENCY_BLOCK'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_timezone)
 OR EXTRACT(HOUR FROM NOW() AT TIME ZONE p_timezone)<9
 OR EXTRACT(HOUR FROM NOW() AT TIME ZONE p_timezone)>=20
 THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_QUIET_HOURS'; END IF;
 IF NOT EXISTS(SELECT 1 FROM marketing_budget_reservations b
  WHERE b.campaign_id=v_campaign.id AND b.channel='email'
    AND b.state='reserved' AND b.budget_utc_day=(NOW() AT TIME ZONE 'UTC')::date
    AND b.budget_utc_month=date_trunc('month',NOW() AT TIME ZONE 'UTC')::date
    AND b.reserved_micros>=p_worst_micros)
 OR NOT EXISTS(SELECT 1 FROM marketing_budget_policy WHERE id=1 AND dispatch_enabled=true)
 THEN RAISE EXCEPTION 'MARKETING_EVIDENCE_BUDGET_BLOCKED'; END IF;
 -- Reject a duplicate while the previous proof remains current. A stale proof
 -- may be renewed but never updated; SQL 058 always takes the newest record.
 INSERT INTO marketing_recipient_delivery_evidence(
  plan_id,audience_member_id,approval_id,reviewer_sha256,
  provider_suppression_proof_sha256,jurisdiction_proof_sha256,
  frequency_proof_sha256,provider_price_proof_sha256,approved_message_sha256,
  recipient_timezone,per_recipient_worst_micros,expires_at)
 VALUES(p_plan,p_member,p_approval,p_owner_sha256,
  p_provider_proof,p_jurisdiction_proof,p_frequency_proof,p_price_proof,
  p_final_sha256,p_timezone,p_worst_micros,NOW()+INTERVAL '4 minutes')
 RETURNING id INTO v_id;
 RETURN v_id;
END; $$;
COMMIT;
