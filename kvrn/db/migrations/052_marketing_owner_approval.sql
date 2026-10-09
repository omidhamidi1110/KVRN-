-- KVRN 052: bounded, reversible owner approval evidence. NOT APPLIED.
-- Requires migrations 038, 049, 050. APPROVAL DOES NOT TRIGGER SENDING.
-- Even approved plans still require live provider, recipient, jurisdiction,
-- quiet-hour, frequency, cost and transactional budget checks.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_owner_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL UNIQUE REFERENCES marketing_staged_delivery_plans(id) ON DELETE RESTRICT,
  campaign_id uuid NOT NULL REFERENCES marketing_campaign_drafts(id) ON DELETE RESTRICT,
  campaign_version integer NOT NULL CHECK(campaign_version>0),
  recipient_count integer NOT NULL CHECK(recipient_count BETWEEN 1 AND 50),
  maximum_cost_micros bigint NOT NULL CHECK(maximum_cost_micros BETWEEN 1 AND 2000000),
  owner_identity_sha256 text NOT NULL CHECK(owner_identity_sha256 ~ '^[0-9a-f]{64}$'),
  request_key text NOT NULL UNIQUE CHECK(request_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
  state text NOT NULL DEFAULT 'approved' CHECK(state IN ('approved','revoked')),
  approved_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT marketing_approval_lifecycle CHECK(
    (state='approved' AND revoked_at IS NULL) OR
    (state='revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_moa_lifecycle ON marketing_owner_approvals(state,expires_at);
CREATE TABLE IF NOT EXISTS marketing_owner_approval_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES marketing_owner_approvals(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('approve','revoke')),
  happened_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION kvrn_marketing_owner_approve(
 p_plan uuid,p_identity_hash text,p_request_key text,p_worst_micros bigint
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_plan marketing_staged_delivery_plans%ROWTYPE;
  v_snap marketing_audience_snapshots%ROWTYPE;
  v_campaign marketing_campaign_drafts%ROWTYPE;
  v_existing marketing_owner_approvals%ROWTYPE;
  v_count integer;
  v_approval uuid;
BEGIN
  IF p_plan IS NULL OR p_identity_hash IS NULL OR p_identity_hash !~ '^[0-9a-f]{64}$'
     OR p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9:_-]{12,120}$'
     OR p_worst_micros IS NULL OR p_worst_micros NOT BETWEEN 1 AND 2000000
  THEN RAISE EXCEPTION 'OWNER_APPROVAL_INVALID_INPUT'; END IF;
  PERFORM pg_advisory_xact_lock(48112026052::bigint);
  SELECT * INTO v_existing FROM marketing_owner_approvals WHERE request_key=p_request_key;
  IF FOUND THEN
    IF v_existing.plan_id=p_plan AND v_existing.owner_identity_sha256=p_identity_hash
      AND v_existing.maximum_cost_micros=p_worst_micros AND v_existing.state='approved'
      AND v_existing.expires_at>NOW() THEN RETURN v_existing.id; END IF;
    RAISE EXCEPTION 'OWNER_APPROVAL_IDEMPOTENCY_CONFLICT';
  END IF;
  IF EXISTS(SELECT 1 FROM marketing_owner_approvals WHERE plan_id=p_plan)
  THEN RAISE EXCEPTION 'OWNER_APPROVAL_PLAN_ALREADY_DECIDED'; END IF;
  SELECT * INTO v_plan FROM marketing_staged_delivery_plans WHERE id=p_plan FOR UPDATE;
  IF NOT FOUND OR v_plan.state<>'staged' THEN RAISE EXCEPTION 'OWNER_APPROVAL_PLAN_CANCELLED'; END IF;
  SELECT * INTO v_snap FROM marketing_audience_snapshots WHERE id=v_plan.snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'OWNER_APPROVAL_SNAPSHOT_MISSING'; END IF;
  SELECT * INTO v_campaign FROM marketing_campaign_drafts WHERE id=v_snap.campaign_id FOR SHARE;
  IF NOT FOUND OR v_campaign.state<>'reviewed' OR v_campaign.version<>v_snap.campaign_version
    OR btrim(v_campaign.body)='' THEN RAISE EXCEPTION 'OWNER_APPROVAL_CAMPAIGN_STALE'; END IF;
  SELECT COUNT(*) INTO v_count FROM marketing_staged_delivery_items WHERE plan_id=p_plan AND state='staged';
  IF v_count<1 OR v_count>50 THEN RAISE EXCEPTION 'OWNER_APPROVAL_RECIPIENT_COUNT'; END IF;
  -- Approval freezes the human-reviewed bounds. The future dispatcher MUST
  -- still validate segment/price per recipient, provider stop and actual consent.
  INSERT INTO marketing_owner_approvals(
    plan_id,campaign_id,campaign_version,recipient_count,
    maximum_cost_micros,owner_identity_sha256,request_key,expires_at
  ) VALUES (p_plan,v_campaign.id,v_campaign.version,v_count,p_worst_micros,
    p_identity_hash,p_request_key,NOW()+INTERVAL '1 hour') RETURNING id INTO v_approval;
  INSERT INTO marketing_owner_approval_audit(approval_id,action) VALUES(v_approval,'approve');
  RETURN v_approval;
END; $$;
CREATE OR REPLACE FUNCTION kvrn_marketing_owner_revoke(p_approval uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
 IF p_approval IS NULL THEN RAISE EXCEPTION 'OWNER_APPROVAL_INVALID_ID'; END IF;
 PERFORM pg_advisory_xact_lock(48112026052::bigint);
 UPDATE marketing_owner_approvals SET state='revoked',revoked_at=NOW()
 WHERE id=p_approval AND state='approved' RETURNING id INTO v_id;
 IF v_id IS NULL THEN RETURN false; END IF;
 INSERT INTO marketing_owner_approval_audit(approval_id,action) VALUES(v_id,'revoke');
 RETURN true;
END; $$;
CREATE OR REPLACE FUNCTION kvrn_marketing_approval_audit_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OWNER_APPROVAL_AUDIT_APPEND_ONLY'; END; $$;
CREATE TRIGGER owner_approval_audit_immutable BEFORE UPDATE OR DELETE
ON marketing_owner_approval_audit FOR EACH ROW EXECUTE FUNCTION kvrn_marketing_approval_audit_append_only();
-- Deliberately no send job, cron consumer, provider API, or budget settlement.
COMMIT;
