-- KVRN 055 reusable Marketing Suite COPY TEMPLATES.
-- STAGING ONLY; not applied. Editing templates does NOT authorize sends.
-- Content may include ONLY vetted, data-free brand tokens. No raw HTML.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_copy_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 channel text NOT NULL CHECK(channel IN ('sms','email')),
 label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 100),
 category text NOT NULL CHECK(category IN ('launch','restock','promotion','update','post_purchase')),
 subject text CHECK(subject IS NULL OR length(subject) BETWEEN 1 AND 140),
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 10000),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','ready','archived')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 updated_at timestamptz NOT NULL DEFAULT NOW(),
 CONSTRAINT mct_sms_no_subject CHECK(channel='email' OR subject IS NULL),
 CONSTRAINT mct_email_subject CHECK(channel<>'email' OR subject IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mct_state ON marketing_copy_templates(channel,state,updated_at DESC);
CREATE TABLE IF NOT EXISTS marketing_copy_template_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 template_id uuid NOT NULL REFERENCES marketing_copy_templates(id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN ('create','edit','ready','reopen','archive')),
 old_version integer,
 new_version integer NOT NULL CHECK(new_version>0),
 recorded_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION kvrn_template_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MARKETING_TEMPLATE_AUDIT_APPEND_ONLY'; END; $$;
CREATE TRIGGER marketing_template_audit_immutable BEFORE UPDATE OR DELETE
 ON marketing_copy_template_audit FOR EACH ROW EXECUTE FUNCTION kvrn_template_audit_immutable();
CREATE OR REPLACE FUNCTION kvrn_marketing_template_create(
 p_channel text,p_label text,p_category text,p_subject text,p_body text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
 -- Table constraints will fail closed on unsupported input.
 INSERT INTO marketing_copy_templates(channel,label,category,subject,body)
 VALUES(p_channel,p_label,p_category,p_subject,p_body) RETURNING id INTO v_id;
 INSERT INTO marketing_copy_template_audit(template_id,action,new_version) VALUES(v_id,'create',1);
 RETURN v_id;
END; $$;
CREATE OR REPLACE FUNCTION kvrn_marketing_template_update(
 p_id uuid,p_expected_version integer,p_label text,p_category text,p_subject text,p_body text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_old marketing_copy_templates%ROWTYPE;v_new integer;
BEGIN
 IF p_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1 THEN
  RAISE EXCEPTION 'MARKETING_TEMPLATE_INVALID_UPDATE'; END IF;
 SELECT * INTO v_old FROM marketing_copy_templates WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_old.state='archived' OR v_old.version<>p_expected_version
 THEN RAISE EXCEPTION 'MARKETING_TEMPLATE_STALE_OR_ARCHIVED'; END IF;
 UPDATE marketing_copy_templates SET label=p_label,category=p_category,subject=p_subject,body=p_body,
    state='draft',version=version+1,updated_at=NOW() WHERE id=p_id RETURNING version INTO v_new;
 INSERT INTO marketing_copy_template_audit(template_id,action,old_version,new_version)
 VALUES(p_id,'edit',v_old.version,v_new);
 RETURN v_new;
END; $$;
CREATE OR REPLACE FUNCTION kvrn_marketing_template_transition(
 p_id uuid,p_expected_version integer,p_target text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_old marketing_copy_templates%ROWTYPE;v_next integer;v_action text;
BEGIN
 IF p_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1
    OR p_target NOT IN ('ready','draft','archived')
 THEN RAISE EXCEPTION 'MARKETING_TEMPLATE_INVALID_TRANSITION'; END IF;
 SELECT * INTO v_old FROM marketing_copy_templates WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_old.version<>p_expected_version OR v_old.state='archived' OR v_old.state=p_target
 THEN RAISE EXCEPTION 'MARKETING_TEMPLATE_TRANSITION_CONFLICT'; END IF;
 -- Ready means reusable copy, NOT human approval of any campaign/delivery.
 v_action:=CASE WHEN p_target='ready' THEN 'ready' WHEN p_target='draft' THEN 'reopen' ELSE 'archive' END;
 UPDATE marketing_copy_templates SET state=p_target,version=version+1,updated_at=NOW()
 WHERE id=p_id RETURNING version INTO v_next;
 INSERT INTO marketing_copy_template_audit(template_id,action,old_version,new_version)
 VALUES(p_id,v_action,v_old.version,v_next);
 RETURN v_next;
END; $$;
COMMIT;
