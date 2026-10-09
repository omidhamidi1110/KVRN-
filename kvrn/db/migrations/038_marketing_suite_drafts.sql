-- KVRN 038 — marketing campaign drafting and consent-proof storage (schema ONLY).
-- NOT APPLIED. Review and apply to isolated staging first; prod requires owner approval and backup.
-- No sending, account sync, billing or contact import is triggered by this migration.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_campaign_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  subject text CHECK (subject IS NULL OR length(subject)<=140),
  body text NOT NULL DEFAULT '' CHECK (length(body)<=10000),
  audience text NOT NULL DEFAULT 'all-consenting' CHECK (audience IN ('all-consenting','recent-opt-ins','existing-customers')),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','reviewed','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT market_subject_channel CHECK (channel='email' OR subject IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_mcd_created ON marketing_campaign_drafts(created_at DESC);
-- No phone/email identifiers, message bodies or raw CSV values in audit metadata.
CREATE TABLE IF NOT EXISTS marketing_campaign_draft_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES marketing_campaign_drafts(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('create','edit','review','reopen','archive')),
  old_version integer,
  new_version integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT NOW()
);
-- All writes through small transactional DB functions (Neon HTTP one-call semantics).
CREATE OR REPLACE FUNCTION marketing_draft_create(
  p_channel text,p_title text,p_subject text,p_body text,p_audience text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO marketing_campaign_drafts(channel,title,subject,body,audience)
  VALUES(p_channel,p_title,p_subject,p_body,p_audience) RETURNING id INTO v_id;
  INSERT INTO marketing_campaign_draft_audit(campaign_id,action,new_version) VALUES(v_id,'create',1);
  RETURN v_id;
END; $$;
CREATE OR REPLACE FUNCTION marketing_draft_edit(
  p_id uuid,p_version int,p_title text,p_subject text,p_body text,p_audience text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_version integer;
BEGIN
  UPDATE marketing_campaign_drafts SET title=p_title,subject=p_subject,body=p_body,audience=p_audience,
    version=version+1,updated_at=NOW(),reviewed_at=NULL,reviewed_by=NULL
  WHERE id=p_id AND version=p_version AND state='draft' RETURNING version INTO v_version;
  IF v_version IS NULL THEN RAISE EXCEPTION 'CAMPAIGN_DRAFT_CONFLICT'; END IF;
  INSERT INTO marketing_campaign_draft_audit(campaign_id,action,old_version,new_version)
  VALUES(p_id,'edit',p_version,v_version);
  RETURN v_version;
END; $$;
CREATE OR REPLACE FUNCTION marketing_draft_state(
  p_id uuid,p_version int,p_action text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_version integer; v_old text; v_new text;
BEGIN
  SELECT state INTO v_old FROM marketing_campaign_drafts WHERE id=p_id AND version=p_version FOR UPDATE;
  IF v_old IS NULL THEN RAISE EXCEPTION 'CAMPAIGN_DRAFT_CONFLICT'; END IF;
  IF p_action='review' AND v_old='draft' THEN
    IF NOT EXISTS (SELECT 1 FROM marketing_campaign_drafts WHERE id=p_id AND length(trim(body))>0)
      THEN RAISE EXCEPTION 'CAMPAIGN_EMPTY_MESSAGE'; END IF;
    v_new:='reviewed';
  ELSIF p_action='reopen' AND v_old='reviewed' THEN v_new:='draft';
  ELSIF p_action='archive' AND v_old IN ('draft','reviewed') THEN v_new:='archived';
  ELSE RAISE EXCEPTION 'CAMPAIGN_BAD_TRANSITION'; END IF;
  UPDATE marketing_campaign_drafts SET state=v_new,version=version+1,updated_at=NOW(),
    reviewed_at=CASE WHEN v_new='reviewed' THEN NOW() ELSE NULL END,
    reviewed_by=CASE WHEN v_new='reviewed' THEN 'admin' ELSE NULL END
  WHERE id=p_id RETURNING version INTO v_version;
  INSERT INTO marketing_campaign_draft_audit(campaign_id,action,old_version,new_version)
  VALUES(p_id,p_action,p_version,v_version);
  RETURN v_version;
END; $$;
COMMIT;
