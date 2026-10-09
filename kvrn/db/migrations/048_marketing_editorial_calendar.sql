-- KVRN 048 — marketing editorial calendar. STAGING-ONLY, UNAPPLIED.
-- This is NOT a send queue; there is no recipient list, provider request,
-- automated runner, or dispatch authorization in this schema.
-- Copy review != owner send approval. A planned time triggers NO delivery.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_editorial_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES marketing_campaign_drafts(id) ON DELETE RESTRICT,
  campaign_version integer NOT NULL CHECK (campaign_version>0),
  planned_for timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','cancelled')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  cancelled_at timestamptz,
  CONSTRAINT editorial_calendar_cancel_consistency CHECK (
    (state='planned' AND cancelled_at IS NULL) OR
    (state='cancelled' AND cancelled_at IS NOT NULL)
  )
);
-- At most one current editorial plan per campaign. Cancelled entries retained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_one_active_plan
  ON marketing_editorial_calendar(campaign_id) WHERE state='planned';
CREATE INDEX IF NOT EXISTS idx_marketing_plans_planned_for
  ON marketing_editorial_calendar(planned_for) WHERE state='planned';
CREATE TABLE IF NOT EXISTS marketing_editorial_calendar_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  calendar_id uuid NOT NULL REFERENCES marketing_editorial_calendar(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('plan','cancel')),
  occurred_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION kvrn_marketing_editorial_plan(
  p_campaign uuid,p_version integer,p_planned timestamptz
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_campaign marketing_campaign_drafts%ROWTYPE; v_id uuid;
BEGIN
  IF p_campaign IS NULL OR p_version IS NULL OR p_version<1 OR p_planned IS NULL
    OR p_planned<=NOW()+INTERVAL '15 minutes'
    OR p_planned>NOW()+INTERVAL '365 days' THEN
    RAISE EXCEPTION 'EDITORIAL_PLAN_INVALID';
  END IF;
  SELECT * INTO v_campaign FROM marketing_campaign_drafts
    WHERE id=p_campaign FOR UPDATE;
  IF NOT FOUND OR v_campaign.version<>p_version OR v_campaign.state<>'reviewed'
    OR length(trim(v_campaign.body))=0 THEN
    RAISE EXCEPTION 'EDITORIAL_PLAN_CAMPAIGN_CONFLICT';
  END IF;
  INSERT INTO marketing_editorial_calendar(campaign_id,campaign_version,planned_for)
    VALUES(p_campaign,p_version,p_planned) RETURNING id INTO v_id;
  INSERT INTO marketing_editorial_calendar_audit(calendar_id,action) VALUES(v_id,'plan');
  RETURN v_id;
END; $$;
CREATE OR REPLACE FUNCTION kvrn_marketing_editorial_cancel(p_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_changed uuid;
BEGIN
  IF p_id IS NULL THEN RAISE EXCEPTION 'EDITORIAL_PLAN_INVALID'; END IF;
  UPDATE marketing_editorial_calendar SET state='cancelled',cancelled_at=NOW()
    WHERE id=p_id AND state='planned' RETURNING id INTO v_changed;
  IF v_changed IS NULL THEN RETURN false; END IF;
  INSERT INTO marketing_editorial_calendar_audit(calendar_id,action) VALUES(v_changed,'cancel');
  RETURN true;
END; $$;
-- Prevent unauthorized edits/deletes: all transitions are through the above
-- audited functions. Application uses only SQL function calls for mutations.
CREATE OR REPLACE FUNCTION kvrn_editorial_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'EDITORIAL_AUDIT_APPEND_ONLY'; END; $$;
CREATE TRIGGER marketing_editorial_audit_immutable BEFORE UPDATE OR DELETE
  ON marketing_editorial_calendar_audit FOR EACH ROW EXECUTE FUNCTION kvrn_editorial_audit_immutable();
COMMIT;
