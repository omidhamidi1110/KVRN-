-- KVRN Migration 033 — Affiliate program core
-- (public application -> owner approval -> canonical identity -> versioned terms)
--
-- Additive only. Nothing in 001-027 is altered, dropped or replaced. Idempotent: IF NOT EXISTS,
-- CREATE OR REPLACE of THIS migration's own functions, guarded constraints/triggers. Re-applying is a no-op.
-- Run after 001-027. NOT applied to production by the implementation batch.
--
-- ONE CANONICAL IDENTITY
-- ----------------------
-- The financial `affiliates` row (020) stays authoritative for code, commission terms, attribution,
-- ledger and payouts. `affiliate_profiles` is the PROGRAM identity layered on top: one profile per
-- affiliate (PK = affiliates.id). Approval creates the affiliate through the EXISTING create_affiliate().
-- A trigger on `affiliates` guarantees every affiliate row (admin manual create, approval, direct SQL)
-- has exactly one profile, so there are never two incompatible systems.
--
-- STATUS DOMAINS (never one overloaded field)
--   application status   affiliate_applications.status
--   program status       affiliate_profiles.program_status  (onboarding/active/suspended/terminated)
--   kyc / tax / payout   affiliate_profiles.kyc_status / tax_status / payout_method_status
--   financial status     affiliates.status + affiliate_status_events (020, effective-dated)
--
-- program_status -> financial status mapping (code is live ONLY when the program is Active):
--   onboarding  -> 'paused'      (affiliate_active_at() = FALSE: nothing can attribute)
--   active      -> 'active'
--   suspended   -> 'paused'
--   terminated  -> 'terminated'
-- In addition the customer discount row and the referral links are switched off outside Active
-- (profile.code_disabled_at, disabled_discount_active, disabled_link_ids remember what to restore).
-- Historical commissions, attribution and ledger rows are never touched.
--
-- NO RAW SENSITIVE DATA: no table here has a column for SSN/TIN, bank/routing, ID or tax documents.
-- Only statuses and provider reference ids exist. See the schema-introspection test.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- DOCUMENTS (versioned, immutable once published)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_documents (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type       TEXT        NOT NULL
    CONSTRAINT affiliate_documents_type_chk
    CHECK (doc_type IN ('program_terms','disclosure_policy','privacy_notice','brand_rules','ugc_license')),
  version        TEXT        NOT NULL
    CONSTRAINT affiliate_documents_version_chk CHECK (version ~ '^v[0-9]{1,6}$'),
  version_no     INTEGER     GENERATED ALWAYS AS (substring(version from 2)::integer) STORED,
  title          TEXT        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  -- Markdown-lite (headings, paragraphs, "- " lists, **bold**). Rendered as text nodes, never as raw HTML.
  body           TEXT        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 200000),
  effective_at   TIMESTAMPTZ,
  published_at   TIMESTAMPTZ,
  is_placeholder BOOLEAN     NOT NULL DEFAULT FALSE,
  material_change BOOLEAN    NOT NULL DEFAULT FALSE,
  change_summary TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT affiliate_documents_type_version_uq UNIQUE (doc_type, version),
  CONSTRAINT affiliate_documents_published_chk CHECK (published_at IS NULL OR effective_at IS NOT NULL)
);
-- At most one unpublished draft per document type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_documents_draft
  ON affiliate_documents(doc_type) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_affiliate_documents_current
  ON affiliate_documents(doc_type, version_no DESC) WHERE published_at IS NOT NULL;

CREATE OR REPLACE FUNCTION affiliate_documents_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|DOCUMENT_IMMUTABLE|a published document version can never be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_documents_immutable_trg') THEN
    CREATE TRIGGER affiliate_documents_immutable_trg BEFORE UPDATE OR DELETE ON affiliate_documents
      FOR EACH ROW EXECUTE FUNCTION affiliate_documents_immutable();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- APPLICATIONS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_applications (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  status           TEXT        NOT NULL DEFAULT 'pending'
    CONSTRAINT aff_app_status_chk
    CHECK (status IN ('pending','under_review','needs_info','approved_onboarding','rejected','withdrawn')),
  source           TEXT        NOT NULL DEFAULT 'public' CHECK (source IN ('public','invite')),
  invite_id        UUID,
  idempotency_key  TEXT,

  applicant_name   TEXT,
  display_name     TEXT,
  email            TEXT,
  email_normalized TEXT,
  email_dedupe_key TEXT,
  country          TEXT,
  state_region     TEXT,
  social_links     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  social_keys      TEXT[]      NOT NULL DEFAULT '{}',
  website          TEXT,
  audience_size    INTEGER     CHECK (audience_size IS NULL OR (audience_size >= 0 AND audience_size <= 2000000000)),
  content_category TEXT,
  motivation       TEXT,
  promotion_plan   TEXT,
  preferred_code   TEXT,
  heard_about      TEXT,
  applicant_notes  TEXT,

  -- 18+ attestation and consents. The database itself refuses an application without them.
  age_attested         BOOLEAN     NOT NULL DEFAULT FALSE,
  age_attested_at      TIMESTAMPTZ,
  accuracy_confirmed_at TIMESTAMPTZ NOT NULL,
  esign_consented_at   TIMESTAMPTZ NOT NULL,
  terms_version        TEXT        NOT NULL,
  disclosure_version   TEXT        NOT NULL,
  privacy_version      TEXT        NOT NULL,

  ip_hash          TEXT,
  user_agent_hash  TEXT,
  duplicate_flags  JSONB       NOT NULL DEFAULT '[]'::jsonb,

  affiliate_id     UUID        REFERENCES affiliates(id) ON DELETE RESTRICT,
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  -- Written for the applicant. Internal notes live in affiliate_notes and are NEVER emailed.
  decision_message TEXT,
  anonymized_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT aff_app_age_attested CHECK (age_attested = TRUE AND age_attested_at IS NOT NULL),
  CONSTRAINT aff_app_fields_present CHECK (
    anonymized_at IS NOT NULL
    OR (applicant_name IS NOT NULL AND email IS NOT NULL AND email_normalized IS NOT NULL
        AND email_dedupe_key IS NOT NULL AND country IS NOT NULL)),
  CONSTRAINT aff_app_approved_has_affiliate CHECK (status <> 'approved_onboarding' OR affiliate_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_app_idempotency
  ON affiliate_applications(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- One OPEN application per (de-aliased) email: a second submit returns the existing one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_app_open_email
  ON affiliate_applications(email_dedupe_key)
  WHERE status IN ('pending','under_review','needs_info') AND email_dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aff_app_status  ON affiliate_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aff_app_email   ON affiliate_applications(email_dedupe_key);
CREATE INDEX IF NOT EXISTS idx_aff_app_social  ON affiliate_applications USING GIN (social_keys);
CREATE INDEX IF NOT EXISTS idx_aff_app_iphash  ON affiliate_applications(ip_hash, created_at DESC) WHERE ip_hash IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_aff_app_updated_at') THEN
    CREATE TRIGGER set_aff_app_updated_at BEFORE UPDATE ON affiliate_applications
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- INVITES (direct recruitment). An invite is NOT an approval and NOT an acceptance.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_invites (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT        NOT NULL,
  email_normalized TEXT        NOT NULL,
  display_name     TEXT        NOT NULL,
  social_links     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  proposed_code    TEXT,
  proposed_commission_type      TEXT CHECK (proposed_commission_type IS NULL OR proposed_commission_type IN ('percentage','fixed')),
  proposed_commission_rate_bps  INTEGER CHECK (proposed_commission_rate_bps IS NULL OR (proposed_commission_rate_bps > 0 AND proposed_commission_rate_bps <= 10000)),
  proposed_commission_fixed_cents INTEGER CHECK (proposed_commission_fixed_cents IS NULL OR proposed_commission_fixed_cents >= 0),
  proposed_discount_type        TEXT CHECK (proposed_discount_type IS NULL OR proposed_discount_type IN ('percentage','fixed_amount')),
  proposed_discount_bps         INTEGER CHECK (proposed_discount_bps IS NULL OR (proposed_discount_bps > 0 AND proposed_discount_bps <= 10000)),
  proposed_discount_cents       INTEGER CHECK (proposed_discount_cents IS NULL OR proposed_discount_cents > 0),
  proposed_start_at TIMESTAMPTZ,
  proposed_end_at   TIMESTAMPTZ,
  internal_note    TEXT,
  -- SHA-256 of the one-time token. The raw token exists only in the email and is never stored.
  token_hash       TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','used','expired','revoked')),
  expires_at       TIMESTAMPTZ NOT NULL,
  email_status     TEXT        NOT NULL DEFAULT 'held' CHECK (email_status IN ('held','sent','failed')),
  email_sent_at    TIMESTAMPTZ,
  send_count       INTEGER     NOT NULL DEFAULT 0,
  application_id   UUID        REFERENCES affiliate_applications(id) ON DELETE SET NULL,
  created_by       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at          TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT affiliate_invites_token_uq UNIQUE (token_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_invites_open_email
  ON affiliate_invites(email_normalized) WHERE status = 'open';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_aff_invite_updated_at') THEN
    CREATE TRIGGER set_aff_invite_updated_at BEFORE UPDATE ON affiliate_invites
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aff_app_invite_fk') THEN
    ALTER TABLE affiliate_applications
      ADD CONSTRAINT aff_app_invite_fk FOREIGN KEY (invite_id) REFERENCES affiliate_invites(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PROFILES — the program identity (CONTRACT with the affiliate-portal workstream; columns exact)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_profiles (
  affiliate_id     UUID        PRIMARY KEY REFERENCES affiliates(id) ON DELETE RESTRICT,
  email_normalized TEXT        NOT NULL,
  display_name     TEXT,
  application_id   UUID        REFERENCES affiliate_applications(id) ON DELETE SET NULL,
  program_status   TEXT        NOT NULL DEFAULT 'onboarding'
    CONSTRAINT affiliate_profiles_program_status_chk
    CHECK (program_status IN ('onboarding','active','suspended','terminated')),
  kyc_status       TEXT        NOT NULL DEFAULT 'not_started'
    CHECK (kyc_status IN ('not_started','pending','verified','problem')),
  tax_status       TEXT        NOT NULL DEFAULT 'not_started'
    CHECK (tax_status IN ('not_started','pending','complete','problem')),
  payout_method_status TEXT    NOT NULL DEFAULT 'not_started'
    CHECK (payout_method_status IN ('not_started','pending','ready','failed')),
  payout_provider     TEXT,
  payout_provider_ref TEXT,
  portal_access    TEXT        NOT NULL DEFAULT 'enabled'
    CHECK (portal_access IN ('enabled','read_only','revoked')),
  paid_ads_policy  TEXT        NOT NULL DEFAULT 'not_permitted'
    CHECK (paid_ads_policy IN ('not_permitted','written_approval','approved')),
  payout_threshold_cents INTEGER CHECK (payout_threshold_cents IS NULL OR payout_threshold_cents >= 0),
  payout_schedule  TEXT,
  country          TEXT,
  state_region     TEXT,
  social_links     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  website          TEXT,
  accepted_program_terms_version TEXT,
  accepted_disclosure_version    TEXT,
  requires_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at     TIMESTAMPTZ,
  suspended_at     TIMESTAMPTZ,
  terminated_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- affcore additions (additive; the portal workstream does not rely on them)
  program_start_at TIMESTAMPTZ,
  program_end_at   TIMESTAMPTZ,
  code_disabled_at TIMESTAMPTZ,
  disabled_discount_active BOOLEAN NOT NULL DEFAULT FALSE,
  disabled_link_ids UUID[]     NOT NULL DEFAULT '{}',
  CONSTRAINT affiliate_profiles_email_uq UNIQUE (email_normalized)
);
CREATE INDEX IF NOT EXISTS idx_affiliate_profiles_status ON affiliate_profiles(program_status);
CREATE INDEX IF NOT EXISTS idx_affiliate_profiles_reaccept ON affiliate_profiles(requires_reacceptance) WHERE requires_reacceptance;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_affiliate_profiles_updated_at') THEN
    CREATE TRIGGER set_affiliate_profiles_updated_at BEFORE UPDATE ON affiliate_profiles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ACCEPTANCES — append-only evidence of exactly which document version was accepted
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_acceptances (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id    UUID        REFERENCES affiliates(id) ON DELETE RESTRICT,
  application_id  UUID        REFERENCES affiliate_applications(id) ON DELETE RESTRICT,
  doc_type        TEXT        NOT NULL,
  version         TEXT        NOT NULL,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash         TEXT,
  user_agent_hash TEXT,
  method          TEXT        NOT NULL CHECK (method IN ('application','portal','admin_recorded')),
  CONSTRAINT aff_acc_subject_chk CHECK (affiliate_id IS NOT NULL OR application_id IS NOT NULL),
  CONSTRAINT aff_acc_document_fk FOREIGN KEY (doc_type, version)
    REFERENCES affiliate_documents(doc_type, version) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_acc_affiliate
  ON affiliate_acceptances(affiliate_id, doc_type, version) WHERE affiliate_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_acc_application
  ON affiliate_acceptances(application_id, doc_type, version) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aff_acc_affiliate ON affiliate_acceptances(affiliate_id, doc_type, accepted_at DESC);

-- Append-only: no DELETE; the only permitted UPDATE links an application's acceptance to the affiliate
-- it produced (affiliate_id NULL -> value) and changes nothing else.
CREATE OR REPLACE FUNCTION affiliate_acceptances_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|ACCEPTANCE_APPEND_ONLY|acceptances cannot be deleted';
  END IF;
  IF OLD.affiliate_id IS NULL AND NEW.affiliate_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.application_id IS NOT DISTINCT FROM OLD.application_id
     AND NEW.doc_type = OLD.doc_type AND NEW.version = OLD.version
     AND NEW.accepted_at = OLD.accepted_at AND NEW.method = OLD.method
     AND NEW.ip_hash IS NOT DISTINCT FROM OLD.ip_hash
     AND NEW.user_agent_hash IS NOT DISTINCT FROM OLD.user_agent_hash THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'KVRN_AFFPROG|ACCEPTANCE_APPEND_ONLY|acceptances cannot be changed';
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_acceptances_guard_trg') THEN
    CREATE TRIGGER affiliate_acceptances_guard_trg BEFORE UPDATE OR DELETE ON affiliate_acceptances
      FOR EACH ROW EXECUTE FUNCTION affiliate_acceptances_guard();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTES, RATE LIMITS, EMAIL OUTBOX
-- ═══════════════════════════════════════════════════════════════════════════
-- Internal review notes. Never emailed, never shown to the applicant.
CREATE TABLE IF NOT EXISTS affiliate_notes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID        REFERENCES affiliate_applications(id) ON DELETE CASCADE,
  affiliate_id   UUID        REFERENCES affiliates(id) ON DELETE RESTRICT,
  author         TEXT        NOT NULL,
  body           TEXT        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT affiliate_notes_subject_chk CHECK (application_id IS NOT NULL OR affiliate_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_affiliate_notes_app ON affiliate_notes(application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_affiliate_notes_aff ON affiliate_notes(affiliate_id, created_at);

-- DB-backed rate limit windows (there is no KV). key_hash is a salted hash, never a raw IP or email.
CREATE TABLE IF NOT EXISTS affiliate_rate_limit_events (
  id         BIGSERIAL   PRIMARY KEY,
  scope      TEXT        NOT NULL,
  key_hash   TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aff_rl_lookup ON affiliate_rate_limit_events(scope, key_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aff_rl_created ON affiliate_rate_limit_events(created_at);

-- Why an outbox here: transactional_emails (004) is bound to orders (order_id NOT NULL, CHECK
-- email_type = 'order_confirmation'), so program emails cannot use it without altering 004. This small
-- outbox mirrors its claim/retry/idempotency design. Rows are enqueued INSIDE the same transaction as the
-- state change (so an email is never lost) and sent best-effort afterwards; failures never roll anything back.
CREATE TABLE IF NOT EXISTS affiliate_email_outbox (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT        NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  recipient_email  TEXT        NOT NULL,
  payload          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempt_count    INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  idempotency_key  TEXT        NOT NULL,
  provider_message_id TEXT,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  affiliate_id     UUID        REFERENCES affiliates(id) ON DELETE SET NULL,
  application_id   UUID        REFERENCES affiliate_applications(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT affiliate_email_outbox_key_uq UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_aff_outbox_due ON affiliate_email_outbox(next_attempt_at)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_aff_outbox_created ON affiliate_email_outbox(created_at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_aff_outbox_updated_at') THEN
    CREATE TRIGGER set_aff_outbox_updated_at BEFORE UPDATE ON affiliate_email_outbox
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — helpers, profile trigger, backfill
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION affiliate_email_dedupe_key(p_email TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v TEXT := lower(btrim(coalesce(p_email,''))); l TEXT; d TEXT;
BEGIN
  IF position('@' in v) = 0 THEN RETURN v; END IF;
  l := split_part(v,'@',1); d := substring(v from position('@' in v)+1);
  l := split_part(l,'+',1);
  IF d IN ('gmail.com','googlemail.com') THEN l := replace(l,'.',''); d := 'gmail.com'; END IF;
  RETURN l || '@' || d;
END $$;

CREATE OR REPLACE FUNCTION affiliate_placeholder_email(p_affiliate_id UUID) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT 'no-email-' || p_affiliate_id::text || '@affiliate.invalid' $$;

CREATE OR REPLACE FUNCTION affiliate_program_allowed_countries() RETURNS TEXT[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT ARRAY(SELECT upper(c) FROM jsonb_array_elements_text(value->'countries') c)
       FROM site_settings WHERE key = 'affiliate.program' AND jsonb_typeof(value->'countries') = 'array'),
    ARRAY['US']::TEXT[])
$$;

CREATE OR REPLACE FUNCTION affiliate_current_document(p_doc_type TEXT) RETURNS affiliate_documents
LANGUAGE sql STABLE AS $$
  SELECT d.* FROM affiliate_documents d
   WHERE d.doc_type = p_doc_type AND d.published_at IS NOT NULL AND d.effective_at <= now()
   ORDER BY d.version_no DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION affiliate_enqueue_email(
  p_kind TEXT, p_recipient TEXT, p_payload JSONB, p_key TEXT, p_affiliate_id UUID, p_application_id UUID
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  IF p_recipient IS NULL OR btrim(p_recipient) = '' OR p_recipient LIKE '%@affiliate.invalid' THEN
    RETURN NULL;
  END IF;
  INSERT INTO affiliate_email_outbox (kind, recipient_email, payload, idempotency_key, affiliate_id, application_id)
  VALUES (p_kind, p_recipient, COALESCE(p_payload,'{}'::jsonb), p_key, p_affiliate_id, p_application_id)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION affiliate_rate_limit_check(
  p_scope TEXT, p_key_hash TEXT, p_max INTEGER, p_window_seconds INTEGER
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('affrl:' || p_scope || ':' || p_key_hash, 0));
  SELECT count(*) INTO v_count FROM affiliate_rate_limit_events
   WHERE scope = p_scope AND key_hash = p_key_hash
     AND created_at > clock_timestamp() - make_interval(secs => p_window_seconds);
  IF v_count >= p_max THEN RETURN FALSE; END IF;
  INSERT INTO affiliate_rate_limit_events (scope, key_hash, created_at) VALUES (p_scope, p_key_hash, clock_timestamp());
  DELETE FROM affiliate_rate_limit_events WHERE created_at < clock_timestamp() - interval '3 days';
  RETURN TRUE;
END $$;

-- Every affiliates row gets exactly one profile (manual create, approval, direct SQL).
CREATE OR REPLACE FUNCTION affiliates_create_profile() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_email TEXT; v_prog TEXT;
BEGIN
  v_email := NULLIF(lower(btrim(coalesce(NEW.email,''))),'');
  IF v_email IS NULL OR EXISTS (SELECT 1 FROM affiliate_profiles WHERE email_normalized = v_email) THEN
    v_email := affiliate_placeholder_email(NEW.id);
  END IF;
  v_prog := CASE WHEN current_setting('kvrn.affiliate_origin', true) = 'approval' THEN 'onboarding'
                 WHEN NEW.status = 'terminated' THEN 'terminated'
                 WHEN NEW.status = 'paused' THEN 'suspended'
                 ELSE 'active' END;
  BEGIN
    INSERT INTO affiliate_profiles (affiliate_id, email_normalized, display_name, program_status, activated_at)
    VALUES (NEW.id, v_email, NEW.name, v_prog, CASE WHEN v_prog = 'active' THEN NOW() END)
    ON CONFLICT (affiliate_id) DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO affiliate_profiles (affiliate_id, email_normalized, display_name, program_status, activated_at)
    VALUES (NEW.id, affiliate_placeholder_email(NEW.id), NEW.name, v_prog, CASE WHEN v_prog = 'active' THEN NOW() END)
    ON CONFLICT (affiliate_id) DO NOTHING;
  END;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliates_create_profile_trg') THEN
    CREATE TRIGGER affiliates_create_profile_trg AFTER INSERT ON affiliates
      FOR EACH ROW EXECUTE FUNCTION affiliates_create_profile();
  END IF;
END $$;

-- The financial status projection is the truth about whether a code can attribute; keep the program
-- status in step with it even when someone calls set_affiliate_status() directly.
CREATE OR REPLACE FUNCTION affiliates_sync_program_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'terminated' THEN
    UPDATE affiliate_profiles SET program_status = 'terminated', terminated_at = COALESCE(terminated_at, NOW()),
           portal_access = CASE WHEN portal_access = 'enabled' THEN 'read_only' ELSE portal_access END
     WHERE affiliate_id = NEW.id AND program_status <> 'terminated';
  ELSIF NEW.status = 'paused' THEN
    UPDATE affiliate_profiles SET program_status = 'suspended', suspended_at = NOW(),
           portal_access = CASE WHEN portal_access = 'enabled' THEN 'read_only' ELSE portal_access END
     WHERE affiliate_id = NEW.id AND program_status = 'active';
  ELSIF NEW.status = 'active' THEN
    UPDATE affiliate_profiles SET program_status = 'active', suspended_at = NULL, terminated_at = NULL,
           activated_at = COALESCE(activated_at, NOW()),
           portal_access = CASE WHEN portal_access = 'read_only' THEN 'enabled' ELSE portal_access END
     WHERE affiliate_id = NEW.id AND program_status IN ('onboarding','suspended','terminated');
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliates_sync_program_status_trg') THEN
    CREATE TRIGGER affiliates_sync_program_status_trg AFTER UPDATE OF status ON affiliates
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION affiliates_sync_program_status();
  END IF;
END $$;

-- Backfill profiles for affiliates that already exist (idempotent). Legacy affiliates keep their
-- current behaviour: nothing is flagged for reacceptance and no payout rule changes here.
INSERT INTO affiliate_profiles (affiliate_id, email_normalized, display_name, program_status, portal_access,
                                activated_at, suspended_at, terminated_at)
SELECT x.id,
       CASE WHEN x.em IS NOT NULL AND x.rn = 1
                 AND NOT EXISTS (SELECT 1 FROM affiliate_profiles p2 WHERE p2.email_normalized = x.em)
            THEN x.em ELSE affiliate_placeholder_email(x.id) END,
       x.name,
       CASE x.status WHEN 'active' THEN 'active' WHEN 'paused' THEN 'suspended' ELSE 'terminated' END,
       CASE x.status WHEN 'active' THEN 'enabled' ELSE 'read_only' END,
       CASE WHEN x.status = 'active' THEN x.created_at END,
       CASE WHEN x.status = 'paused' THEN (SELECT max(e.effective_at) FROM affiliate_status_events e WHERE e.affiliate_id = x.id AND e.to_status = 'paused') END,
       CASE WHEN x.status = 'terminated' THEN (SELECT max(e.effective_at) FROM affiliate_status_events e WHERE e.affiliate_id = x.id AND e.to_status = 'terminated') END
  FROM (SELECT a.*, NULLIF(lower(btrim(coalesce(a.email,''))),'') AS em,
               row_number() OVER (PARTITION BY NULLIF(lower(btrim(coalesce(a.email,''))),'') ORDER BY a.created_at, a.id) AS rn
          FROM affiliates a) x
 WHERE NOT EXISTS (SELECT 1 FROM affiliate_profiles p WHERE p.affiliate_id = x.id)
ON CONFLICT DO NOTHING;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3 — placeholder documents, document versioning, acceptances
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- Clearly-marked PLACEHOLDER v1 of each document. Headings list the topics the final text must cover.
-- They are NOT legal text. The public application stays closed while a placeholder is current
-- (site_settings affiliate.program.allowPlaceholderDocuments overrides this for staging only).
INSERT INTO affiliate_documents (doc_type, version, title, body, effective_at, published_at, is_placeholder, created_by)
VALUES
('program_terms','v1','Affiliate Program Terms (placeholder)', $doc$# Affiliate Program Terms

**DRAFT PLACEHOLDER - Pending attorney review - not for launch.**

This outline lists the topics the final terms must cover. It is not an agreement.

## Eligibility
- 18 years of age or older
- Application and approval are at KVRN's discretion
## Commission
- Commission structure and the commissionable sale definition
- Attribution model, referral window and code-versus-link precedence
- Discount and bundle interaction
## Refunds and reversals
- Refunds, cancellations, disputes and chargebacks
- Reversal and recovery rules
- Commission maturation and hold period
## Payouts and taxes
- Payout schedule and threshold
- Taxes and required tax and identity onboarding
## Conduct
- Prohibited conduct, self-referrals and fraud
- FTC disclosures, brand and trademark use, paid advertising rules
- Email and SMS restrictions
- Privacy and confidentiality
## Relationship
- No authority to bind KVRN
- Independent-business relationship language appropriate to the actual relationship
## Ending the program
- Suspension and termination
- Treatment of legitimately earned pending commissions after termination
- Treatment of fraudulent commissions
## Legal
- Governing law and dispute terms after legal review
- Modification, versioning and reacceptance process
$doc$, NOW(), NOW(), TRUE, 'system'),
('disclosure_policy','v1','Affiliate Disclosure Policy (placeholder)', $doc$# Affiliate Disclosure Policy

**DRAFT PLACEHOLDER - Pending attorney review - not for launch.**

## When disclosure is required
- Commission, cash compensation, free product, discounted product, gifts and other material benefits
## How to disclose
- Clear and conspicuous, near or within the endorsement
- Examples: #ad, Sponsored, an unambiguous "KVRN affiliate" statement
- Not only a profile bio, a buried page, vague wording or a platform tool when more is needed
- Video, audio and live content
## Claims
- Truthful experience only
- No unsupported material or performance claims
$doc$, NOW(), NOW(), TRUE, 'system'),
('privacy_notice','v1','Applicant Privacy Notice (placeholder)', $doc$# Applicant Privacy Notice

**DRAFT PLACEHOLDER - Pending attorney review - not for launch.**

## What we collect and why
- Application details used to review your application
- No SSN, tax documents, bank details or ID images are collected in the application
## Retention and access
- Reasonable retention periods
- Access limited to authorised KVRN staff
- Deletion or anonymization where legally appropriate, except records KVRN must keep for tax, payout, accounting, fraud or legal purposes
$doc$, NOW(), NOW(), TRUE, 'system'),
('brand_rules','v1','Brand and Promotion Rules (placeholder)', $doc$# Brand and Promotion Rules

**DRAFT PLACEHOLDER - Pending attorney review - not for launch.**

## Not allowed
- Impersonating KVRN or registering misleading KVRN domains or handles
- Altering trademarks or logos
- False product, pricing or promotion claims, expired promotions, fabricated scarcity
- Misleading links, coupon or deal-site distribution, coupon scraping, browser-extension injection
- Paid-search bidding on KVRN terms and direct-link paid ads unless explicitly approved
## Email and SMS
- No scraped or purchased lists, no deceptive sender or subject, no spam
- No campaign representing KVRN without separate written approval
$doc$, NOW(), NOW(), TRUE, 'system'),
('ugc_license','v1','Content License (placeholder)', $doc$# Content License

**DRAFT PLACEHOLDER - Pending attorney review - not for launch.**

Being an affiliate grants KVRN no rights to your content. Any license is separate and explicit.

## Rights that may be granted
- Organic social reposting, KVRN website, email
- Paid advertising and whitelisting
- Editing and cropping, creator name and likeness
## Terms
- Duration, territory, channels, compensation if separate, revocation and expiry
$doc$, NOW(), NOW(), TRUE, 'system')
ON CONFLICT (doc_type, version) DO NOTHING;

CREATE OR REPLACE FUNCTION save_affiliate_document_draft(
  p_doc_type TEXT, p_title TEXT, p_body TEXT, p_change_summary TEXT, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_draft affiliate_documents; v_next INTEGER; v_id UUID;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('affdoc:' || p_doc_type, 0));
  SELECT * INTO v_draft FROM affiliate_documents WHERE doc_type = p_doc_type AND published_at IS NULL;
  IF FOUND THEN
    UPDATE affiliate_documents SET title = p_title, body = p_body, change_summary = p_change_summary,
           updated_at = NOW(), created_by = p_actor WHERE id = v_draft.id;
    v_id := v_draft.id;
  ELSE
    SELECT COALESCE(MAX(version_no),0) + 1 INTO v_next FROM affiliate_documents WHERE doc_type = p_doc_type;
    INSERT INTO affiliate_documents (doc_type, version, title, body, change_summary, created_by)
    VALUES (p_doc_type, 'v' || v_next, p_title, p_body, p_change_summary, p_actor) RETURNING id INTO v_id;
  END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.document.draft', 'affiliate_documents', v_id::text, jsonb_build_object('doc_type', p_doc_type));
  RETURN jsonb_build_object('document_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION discard_affiliate_document_draft(p_document_id UUID, p_actor TEXT) RETURNS JSONB
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  DELETE FROM affiliate_documents WHERE id = p_document_id AND published_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND|no such draft'; END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.document.discard', 'affiliate_documents', p_document_id::text, '{}'::jsonb);
  RETURN jsonb_build_object('outcome','discarded');
END $$;

-- Publish makes a version immutable. A MATERIAL change flags every affiliate who accepted an older
-- version of program_terms / disclosure_policy as requiring reacceptance and queues one notice each.
CREATE OR REPLACE FUNCTION publish_affiliate_document(p_document_id UUID, p_material BOOLEAN, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE d affiliate_documents; v_flagged INTEGER := 0; r RECORD;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  SELECT * INTO d FROM affiliate_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND|no such document'; END IF;
  IF d.published_at IS NOT NULL THEN RAISE EXCEPTION 'KVRN_AFFPROG|ALREADY_PUBLISHED'; END IF;
  IF d.body ILIKE '%pending attorney review%' OR d.title ILIKE '%placeholder%' THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|PLACEHOLDER_TEXT|remove the placeholder wording before publishing';
  END IF;
  UPDATE affiliate_documents SET published_at = NOW(), effective_at = NOW(),
         material_change = COALESCE(p_material, FALSE), updated_at = NOW() WHERE id = d.id;

  IF COALESCE(p_material, FALSE) AND d.doc_type IN ('program_terms','disclosure_policy') THEN
    FOR r IN
      SELECT p.affiliate_id, a.email, p.display_name FROM affiliate_profiles p JOIN affiliates a ON a.id = p.affiliate_id
       WHERE p.program_status IN ('onboarding','active','suspended')
         AND CASE d.doc_type WHEN 'program_terms' THEN p.accepted_program_terms_version ELSE p.accepted_disclosure_version END IS NOT NULL
         AND CASE d.doc_type WHEN 'program_terms' THEN p.accepted_program_terms_version ELSE p.accepted_disclosure_version END <> d.version
    LOOP
      UPDATE affiliate_profiles SET requires_reacceptance = TRUE WHERE affiliate_id = r.affiliate_id;
      v_flagged := v_flagged + 1;
      PERFORM affiliate_enqueue_email('terms_update', r.email,
        jsonb_build_object('displayName', r.display_name, 'docType', d.doc_type, 'version', d.version),
        'terms_update:' || r.affiliate_id || ':' || d.doc_type || ':' || d.version, r.affiliate_id, NULL);
    END LOOP;
  END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.document.publish', 'affiliate_documents', d.id::text,
          jsonb_build_object('doc_type', d.doc_type, 'version', d.version, 'material', COALESCE(p_material,FALSE), 'flagged', v_flagged));
  RETURN jsonb_build_object('document_id', d.id, 'doc_type', d.doc_type, 'version', d.version, 'flagged', v_flagged);
END $$;

-- Record that an applicant/affiliate accepted an exact, published version. Idempotent. Only the CURRENT
-- version can be accepted unless an admin records an older one explicitly.
CREATE OR REPLACE FUNCTION record_affiliate_acceptance(
  p_affiliate_id UUID, p_application_id UUID, p_doc_type TEXT, p_version TEXT,
  p_ip_hash TEXT, p_ua_hash TEXT, p_method TEXT, p_allow_noncurrent BOOLEAN DEFAULT FALSE
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE d affiliate_documents; cur affiliate_documents; v_id UUID; v_new BOOLEAN := FALSE; p affiliate_profiles;
        v_terms affiliate_documents; v_disc affiliate_documents;
BEGIN
  IF p_affiliate_id IS NULL AND p_application_id IS NULL THEN RAISE EXCEPTION 'KVRN_AFFPROG|SUBJECT_REQUIRED'; END IF;
  SELECT * INTO d FROM affiliate_documents WHERE doc_type = p_doc_type AND version = p_version AND published_at IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|DOCUMENT_NOT_FOUND|%/%', p_doc_type, p_version; END IF;
  cur := affiliate_current_document(p_doc_type);
  IF NOT COALESCE(p_allow_noncurrent, FALSE) AND cur.id IS DISTINCT FROM d.id THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|DOCUMENT_VERSION_CHANGED|current is %', cur.version;
  END IF;

  IF p_affiliate_id IS NOT NULL THEN
    SELECT id INTO v_id FROM affiliate_acceptances WHERE affiliate_id = p_affiliate_id AND doc_type = p_doc_type AND version = p_version;
  ELSE
    SELECT id INTO v_id FROM affiliate_acceptances WHERE application_id = p_application_id AND doc_type = p_doc_type AND version = p_version;
  END IF;
  IF v_id IS NULL THEN
    -- ON CONFLICT: two identical requests racing (double click, retry) must both succeed with ONE row.
    INSERT INTO affiliate_acceptances (affiliate_id, application_id, doc_type, version, ip_hash, user_agent_hash, method)
    VALUES (p_affiliate_id, p_application_id, p_doc_type, p_version, p_ip_hash, p_ua_hash, p_method)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_new := TRUE;
    ELSIF p_affiliate_id IS NOT NULL THEN
      SELECT id INTO v_id FROM affiliate_acceptances WHERE affiliate_id = p_affiliate_id AND doc_type = p_doc_type AND version = p_version;
    ELSE
      SELECT id INTO v_id FROM affiliate_acceptances WHERE application_id = p_application_id AND doc_type = p_doc_type AND version = p_version;
    END IF;
  END IF;

  IF p_affiliate_id IS NOT NULL THEN
    SELECT * INTO p FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
    IF FOUND THEN
      IF p_doc_type = 'program_terms' THEN
        UPDATE affiliate_profiles SET accepted_program_terms_version = p_version
         WHERE affiliate_id = p_affiliate_id
           AND (accepted_program_terms_version IS NULL OR substring(accepted_program_terms_version from 2)::int <= d.version_no);
      ELSIF p_doc_type = 'disclosure_policy' THEN
        UPDATE affiliate_profiles SET accepted_disclosure_version = p_version
         WHERE affiliate_id = p_affiliate_id
           AND (accepted_disclosure_version IS NULL OR substring(accepted_disclosure_version from 2)::int <= d.version_no);
      END IF;
      v_terms := affiliate_current_document('program_terms'); v_disc := affiliate_current_document('disclosure_policy');
      UPDATE affiliate_profiles SET requires_reacceptance = FALSE
       WHERE affiliate_id = p_affiliate_id AND requires_reacceptance
         AND accepted_program_terms_version IS NOT DISTINCT FROM v_terms.version
         AND accepted_disclosure_version IS NOT DISTINCT FROM v_disc.version;
    END IF;
    IF v_new THEN
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES ('affiliate:' || p_affiliate_id, 'affiliate.accept_terms', 'affiliates', p_affiliate_id::text,
              jsonb_build_object('doc_type', p_doc_type, 'version', p_version, 'method', p_method));
    END IF;
  END IF;
  RETURN jsonb_build_object('outcome', CASE WHEN v_new THEN 'recorded' ELSE 'already_recorded' END, 'acceptance_id', v_id);
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4 — invites and application submission
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION create_affiliate_invite(p JSONB, p_token_hash TEXT, p_expires_at TIMESTAMPTZ, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_email TEXT := lower(btrim(coalesce(p->>'email',''))); v_id UUID; v_code TEXT;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  IF v_email = '' OR coalesce(btrim(p->>'displayName'),'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|email and name are required'; END IF;
  IF EXISTS (SELECT 1 FROM affiliate_profiles WHERE email_normalized = v_email) THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|EMAIL_ALREADY_AFFILIATE';
  END IF;
  IF EXISTS (SELECT 1 FROM affiliate_invites WHERE email_normalized = v_email AND status = 'open' AND expires_at > now()) THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|INVITE_EXISTS';
  END IF;
  UPDATE affiliate_invites SET status = 'expired' WHERE email_normalized = v_email AND status = 'open' AND expires_at <= now();
  v_code := NULLIF(upper(btrim(coalesce(p->>'proposedCode',''))),'');
  IF v_code IS NOT NULL AND (EXISTS (SELECT 1 FROM affiliates WHERE code = v_code) OR EXISTS (SELECT 1 FROM discounts WHERE code = v_code)) THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|CODE_TAKEN';
  END IF;
  INSERT INTO affiliate_invites (email, email_normalized, display_name, social_links, proposed_code,
      proposed_commission_type, proposed_commission_rate_bps, proposed_commission_fixed_cents,
      proposed_discount_type, proposed_discount_bps, proposed_discount_cents,
      proposed_start_at, proposed_end_at, internal_note, token_hash, expires_at, created_by)
  VALUES (btrim(p->>'email'), v_email, btrim(p->>'displayName'), COALESCE(p->'socialLinks','[]'::jsonb), v_code,
      NULLIF(p->>'commissionType',''), (p->>'commissionRateBps')::int, (p->>'commissionFixedCents')::int,
      NULLIF(p->>'discountType',''), (p->>'discountBps')::int, (p->>'discountCents')::int,
      (p->>'startAt')::timestamptz, (p->>'endAt')::timestamptz, NULLIF(btrim(coalesce(p->>'internalNote','')),''),
      p_token_hash, p_expires_at, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.invite.create', 'affiliate_invites', v_id::text, jsonb_build_object('proposed_code', v_code));
  RETURN jsonb_build_object('invite_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION rotate_affiliate_invite_token(p_invite_id UUID, p_token_hash TEXT, p_expires_at TIMESTAMPTZ, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE i affiliate_invites;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  SELECT * INTO i FROM affiliate_invites WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  IF i.status IN ('used','revoked') THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_STATE|invite is %', i.status; END IF;
  IF EXISTS (SELECT 1 FROM affiliate_profiles WHERE email_normalized = i.email_normalized) THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|EMAIL_ALREADY_AFFILIATE';
  END IF;
  -- Only one OPEN invite per email (unique index). A newer invite may already hold the slot.
  UPDATE affiliate_invites SET status = 'expired'
   WHERE email_normalized = i.email_normalized AND id <> i.id AND status = 'open' AND expires_at <= now();
  IF EXISTS (SELECT 1 FROM affiliate_invites WHERE email_normalized = i.email_normalized AND id <> i.id AND status = 'open') THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|INVITE_EXISTS';
  END IF;
  UPDATE affiliate_invites SET token_hash = p_token_hash, expires_at = p_expires_at, status = 'open',
         email_status = 'held', send_count = send_count + 1 WHERE id = p_invite_id;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.invite.resend', 'affiliate_invites', p_invite_id::text, '{}'::jsonb);
  RETURN jsonb_build_object('invite_id', p_invite_id, 'send_count', i.send_count + 1);
END $$;

CREATE OR REPLACE FUNCTION revoke_affiliate_invite(p_invite_id UUID, p_actor TEXT) RETURNS JSONB
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  UPDATE affiliate_invites SET status = 'revoked', revoked_at = NOW()
   WHERE id = p_invite_id AND status IN ('open','expired');
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_STATE|only unused invites can be revoked'; END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.invite.revoke', 'affiliate_invites', p_invite_id::text, '{}'::jsonb);
  RETURN jsonb_build_object('outcome','revoked');
END $$;

-- Public application. Never approves. Returns outcome created | existing | already_affiliate.
CREATE OR REPLACE FUNCTION submit_affiliate_application(p JSONB) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_key TEXT := NULLIF(btrim(coalesce(p->>'idempotencyKey','')),'');
  v_email TEXT := lower(btrim(coalesce(p->>'email','')));
  v_dedupe TEXT := affiliate_email_dedupe_key(p->>'email');
  v_country TEXT := upper(btrim(coalesce(p->>'country','')));
  v_social JSONB := COALESCE(p->'socialLinks','[]'::jsonb);
  v_keys TEXT[]; v_flags JSONB := '[]'::jsonb;
  v_terms affiliate_documents; v_disc affiliate_documents; v_priv affiliate_documents;
  v_id UUID; v_existing UUID; v_invite affiliate_invites; v_invite_hash TEXT := NULLIF(p->>'inviteTokenHash','');
  v_now TIMESTAMPTZ := NOW(); v_code TEXT; r RECORD; v_name TEXT := lower(btrim(coalesce(p->>'applicantName','')));
BEGIN
  IF v_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM affiliate_applications WHERE idempotency_key = v_key;
    IF FOUND THEN RETURN jsonb_build_object('outcome','existing','application_id',v_existing); END IF;
  END IF;
  IF NOT COALESCE((p->>'ageAttested')::boolean, FALSE) THEN RAISE EXCEPTION 'KVRN_AFFPROG|AGE_ATTESTATION_REQUIRED'; END IF;
  IF NOT COALESCE((p->>'accuracyConfirmed')::boolean, FALSE) THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACCURACY_CONFIRMATION_REQUIRED'; END IF;
  IF NOT COALESCE((p->>'esignConsent')::boolean, FALSE) THEN RAISE EXCEPTION 'KVRN_AFFPROG|ESIGN_CONSENT_REQUIRED'; END IF;
  IF v_email = '' OR position('@' in v_email) = 0 THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|email'; END IF;
  IF NOT (v_country = ANY (affiliate_program_allowed_countries())) THEN RAISE EXCEPTION 'KVRN_AFFPROG|COUNTRY_NOT_ALLOWED'; END IF;

  v_terms := affiliate_current_document('program_terms');
  v_disc  := affiliate_current_document('disclosure_policy');
  v_priv  := affiliate_current_document('privacy_notice');
  IF v_terms.id IS NULL OR v_disc.id IS NULL OR v_priv.id IS NULL THEN RAISE EXCEPTION 'KVRN_AFFPROG|DOCUMENTS_UNAVAILABLE'; END IF;
  IF v_terms.version IS DISTINCT FROM p->>'termsVersion' OR v_disc.version IS DISTINCT FROM p->>'disclosureVersion'
     OR v_priv.version IS DISTINCT FROM p->>'privacyVersion' THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|DOCUMENT_VERSION_CHANGED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('affapp:' || v_dedupe, 0));
  IF v_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM affiliate_applications WHERE idempotency_key = v_key;
    IF FOUND THEN RETURN jsonb_build_object('outcome','existing','application_id',v_existing); END IF;
  END IF;

  IF v_invite_hash IS NOT NULL THEN
    SELECT * INTO v_invite FROM affiliate_invites WHERE token_hash = v_invite_hash FOR UPDATE;
    IF NOT FOUND OR v_invite.status <> 'open' OR v_invite.expires_at <= now() OR v_invite.email_normalized <> v_email THEN
      RAISE EXCEPTION 'KVRN_AFFPROG|INVITE_INVALID';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM affiliate_profiles WHERE email_normalized = v_email) THEN
    RETURN jsonb_build_object('outcome','already_affiliate');
  END IF;
  SELECT id INTO v_existing FROM affiliate_applications
   WHERE email_dedupe_key = v_dedupe AND status IN ('pending','under_review','needs_info');
  IF FOUND THEN RETURN jsonb_build_object('outcome','existing','application_id',v_existing); END IF;

  v_keys := ARRAY(SELECT e->>'key' FROM jsonb_array_elements(v_social) e WHERE e->>'key' IS NOT NULL);

  -- Duplicate / suspicion warnings for the reviewer. Warnings only; nothing is rejected automatically.
  FOR r IN SELECT id, status FROM affiliate_applications WHERE email_dedupe_key = v_dedupe AND anonymized_at IS NULL LOOP
    v_flags := v_flags || jsonb_build_array(jsonb_build_object('kind','prior_application','severity','medium','ref',r.id,'detail',r.status));
  END LOOP;
  FOR r IN SELECT affiliate_id FROM affiliate_profiles p2 JOIN affiliates a ON a.id = p2.affiliate_id
            WHERE affiliate_email_dedupe_key(a.email) = v_dedupe LOOP
    v_flags := v_flags || jsonb_build_array(jsonb_build_object('kind','similar_email_affiliate','severity','high','ref',r.affiliate_id));
  END LOOP;
  IF array_length(v_keys,1) IS NOT NULL THEN
    FOR r IN SELECT id, status, ARRAY(SELECT k FROM unnest(social_keys) k WHERE k = ANY (v_keys)) AS shared
               FROM affiliate_applications WHERE social_keys && v_keys LOOP
      v_flags := v_flags || jsonb_build_array(jsonb_build_object('kind','duplicate_social','severity','high','ref',r.id,'detail',to_jsonb(r.shared)));
    END LOOP;
    FOR r IN SELECT DISTINCT p2.affiliate_id FROM affiliate_profiles p2, jsonb_array_elements(p2.social_links) e WHERE e->>'key' = ANY (v_keys) LOOP
      v_flags := v_flags || jsonb_build_array(jsonb_build_object('kind','duplicate_social_affiliate','severity','high','ref',r.affiliate_id));
    END LOOP;
  END IF;
  IF NULLIF(p->>'ipHash','') IS NOT NULL THEN
    FOR r IN SELECT id FROM affiliate_applications WHERE ip_hash = p->>'ipHash' AND email_dedupe_key <> v_dedupe
                AND created_at > now() - interval '30 days' LIMIT 3 LOOP
      v_flags := v_flags || jsonb_build_array(jsonb_build_object('kind','shared_network','severity','low','ref',r.id));
    END LOOP;
  END IF;
  IF v_name <> '' THEN
    FOR r IN SELECT id FROM affiliate_applications WHERE lower(btrim(applicant_name)) = v_name AND email_dedupe_key <> v_dedupe LIMIT 3 LOOP
      v_flags := v_flags || jsonb_build_array(jsonb_build_object('kind','same_name','severity','low','ref',r.id));
    END LOOP;
  END IF;
  v_code := NULLIF(upper(btrim(coalesce(p->>'preferredCode',''))),'');
  IF v_code IS NOT NULL AND (EXISTS (SELECT 1 FROM affiliates WHERE code = v_code) OR EXISTS (SELECT 1 FROM discounts WHERE code = v_code)) THEN
    v_flags := v_flags || jsonb_build_array(jsonb_build_object('kind','code_unavailable','severity','low'));
  END IF;

  INSERT INTO affiliate_applications (
    source, invite_id, idempotency_key, applicant_name, display_name, email, email_normalized, email_dedupe_key,
    country, state_region, social_links, social_keys, website, audience_size, content_category, motivation,
    promotion_plan, preferred_code, heard_about, applicant_notes,
    age_attested, age_attested_at, accuracy_confirmed_at, esign_consented_at,
    terms_version, disclosure_version, privacy_version, ip_hash, user_agent_hash, duplicate_flags)
  VALUES (
    CASE WHEN v_invite_hash IS NOT NULL THEN 'invite' ELSE 'public' END, v_invite.id, v_key,
    btrim(p->>'applicantName'), NULLIF(btrim(coalesce(p->>'displayName','')),''), btrim(p->>'email'), v_email, v_dedupe,
    v_country, NULLIF(btrim(coalesce(p->>'stateRegion','')),''), v_social, v_keys, NULLIF(btrim(coalesce(p->>'website','')),''),
    (p->>'audienceSize')::int, NULLIF(btrim(coalesce(p->>'contentCategory','')),''), NULLIF(btrim(coalesce(p->>'motivation','')),''),
    NULLIF(btrim(coalesce(p->>'promotionPlan','')),''), v_code, NULLIF(btrim(coalesce(p->>'heardAbout','')),''),
    NULLIF(btrim(coalesce(p->>'applicantNotes','')),''),
    TRUE, v_now, v_now, v_now, v_terms.version, v_disc.version, v_priv.version,
    NULLIF(p->>'ipHash',''), NULLIF(p->>'userAgentHash',''), v_flags)
  RETURNING id INTO v_id;

  INSERT INTO affiliate_acceptances (application_id, doc_type, version, accepted_at, ip_hash, user_agent_hash, method)
  VALUES (v_id,'program_terms',v_terms.version,v_now,NULLIF(p->>'ipHash',''),NULLIF(p->>'userAgentHash',''),'application'),
         (v_id,'disclosure_policy',v_disc.version,v_now,NULLIF(p->>'ipHash',''),NULLIF(p->>'userAgentHash',''),'application'),
         (v_id,'privacy_notice',v_priv.version,v_now,NULLIF(p->>'ipHash',''),NULLIF(p->>'userAgentHash',''),'application');

  IF v_invite.id IS NOT NULL THEN
    UPDATE affiliate_invites SET status = 'used', used_at = v_now, application_id = v_id WHERE id = v_invite.id;
  END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES ('public:affiliate-apply', 'affiliate.application.submit', 'affiliate_applications', v_id::text,
          jsonb_build_object('source', CASE WHEN v_invite.id IS NOT NULL THEN 'invite' ELSE 'public' END,
                             'terms_version', v_terms.version, 'flags', jsonb_array_length(v_flags)));
  PERFORM affiliate_enqueue_email('application_received', btrim(p->>'email'),
    jsonb_build_object('displayName', COALESCE(NULLIF(btrim(coalesce(p->>'displayName','')),''), btrim(p->>'applicantName'))),
    'app_received:' || v_id, NULL, v_id);
  RETURN jsonb_build_object('outcome','created','application_id',v_id,'flags',jsonb_array_length(v_flags));
EXCEPTION WHEN unique_violation THEN
  -- A concurrent identical submission won the race: return it (idempotent), never create a second.
  SELECT id INTO v_existing FROM affiliate_applications
   WHERE idempotency_key = v_key OR (email_dedupe_key = v_dedupe AND status IN ('pending','under_review','needs_info')) LIMIT 1;
  IF v_existing IS NULL THEN RAISE; END IF;
  RETURN jsonb_build_object('outcome','existing','application_id',v_existing);
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5 — application review: status, notes, reject, anonymize, approve
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION add_affiliate_note(p_application_id UUID, p_affiliate_id UUID, p_body TEXT, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  INSERT INTO affiliate_notes (application_id, affiliate_id, author, body) VALUES (p_application_id, p_affiliate_id, p_actor, btrim(p_body))
  RETURNING id INTO v_id;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.note.add', CASE WHEN p_application_id IS NOT NULL THEN 'affiliate_applications' ELSE 'affiliates' END,
          COALESCE(p_application_id, p_affiliate_id)::text, jsonb_build_object('note_id', v_id));
  RETURN jsonb_build_object('note_id', v_id);
END $$;

-- under_review / needs_info / withdrawn. needs_info carries a message written FOR the applicant.
CREATE OR REPLACE FUNCTION set_affiliate_application_status(p_id UUID, p_to TEXT, p_message TEXT, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a affiliate_applications;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  IF p_to NOT IN ('under_review','needs_info','withdrawn') THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|status'; END IF;
  SELECT * INTO a FROM affiliate_applications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  IF a.status NOT IN ('pending','under_review','needs_info') THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_STATE|application is %', a.status; END IF;
  IF a.status = p_to THEN RETURN jsonb_build_object('outcome','no_change'); END IF;
  IF p_to = 'needs_info' AND coalesce(btrim(p_message),'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|MESSAGE_REQUIRED'; END IF;
  UPDATE affiliate_applications SET status = p_to, reviewed_by = p_actor, reviewed_at = NOW(),
         decision_message = CASE WHEN p_to = 'needs_info' THEN btrim(p_message) ELSE decision_message END
   WHERE id = p_id;
  IF p_to = 'needs_info' THEN
    PERFORM affiliate_enqueue_email('application_needs_info', a.email,
      jsonb_build_object('displayName', COALESCE(a.display_name, a.applicant_name), 'message', btrim(p_message)),
      'app_needs_info:' || p_id || ':' || extract(epoch from clock_timestamp())::text, NULL, p_id);
  END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.application.' || p_to, 'affiliate_applications', p_id::text, jsonb_build_object('from', a.status, 'to', p_to));
  RETURN jsonb_build_object('outcome','updated','from',a.status,'to',p_to);
END $$;

-- Reject: creates NO affiliate. The email carries only the message written for the applicant.
CREATE OR REPLACE FUNCTION reject_affiliate_application(p_id UUID, p_message TEXT, p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a affiliate_applications;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  SELECT * INTO a FROM affiliate_applications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  IF a.status NOT IN ('pending','under_review','needs_info') THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_STATE|application is %', a.status; END IF;
  UPDATE affiliate_applications SET status = 'rejected', reviewed_by = p_actor, reviewed_at = NOW(),
         decision_message = NULLIF(btrim(coalesce(p_message,'')),'') WHERE id = p_id;
  PERFORM affiliate_enqueue_email('application_rejected', a.email,
    jsonb_build_object('displayName', COALESCE(a.display_name, a.applicant_name), 'message', NULLIF(btrim(coalesce(p_message,'')),'')),
    'app_rejected:' || p_id, NULL, p_id);
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.reject', 'affiliate_applications', p_id::text, jsonb_build_object('from', a.status));
  RETURN jsonb_build_object('outcome','rejected');
END $$;

-- Privacy: scrub marketing/profile fields of a rejected or withdrawn application. Never touches
-- financial rows, audit logs or acceptance evidence.
CREATE OR REPLACE FUNCTION anonymize_affiliate_application(p_id UUID, p_actor TEXT) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE a affiliate_applications;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  SELECT * INTO a FROM affiliate_applications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  IF a.status NOT IN ('rejected','withdrawn') THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_STATE|only rejected or withdrawn applications can be anonymized'; END IF;
  IF a.anonymized_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','already_anonymized'); END IF;
  UPDATE affiliate_applications SET
    applicant_name = 'Anonymized', display_name = NULL,
    email = 'anonymized-' || id::text || '@affiliate.invalid', email_normalized = 'anonymized-' || id::text || '@affiliate.invalid',
    email_dedupe_key = 'anonymized-' || id::text || '@affiliate.invalid',
    state_region = NULL, social_links = '[]'::jsonb, social_keys = '{}', website = NULL, audience_size = NULL,
    content_category = NULL, motivation = NULL, promotion_plan = NULL, preferred_code = NULL, heard_about = NULL,
    applicant_notes = NULL, ip_hash = NULL, user_agent_hash = NULL, duplicate_flags = '[]'::jsonb, decision_message = NULL,
    anonymized_at = NOW()
  WHERE id = p_id;
  UPDATE affiliate_notes SET body = '[removed]' WHERE application_id = p_id;
  UPDATE affiliate_email_outbox SET recipient_email = 'anonymized@affiliate.invalid', payload = '{}'::jsonb
   WHERE application_id = p_id AND status <> 'pending';
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.application.anonymize', 'affiliate_applications', p_id::text, '{}'::jsonb);
  RETURN jsonb_build_object('outcome','anonymized');
END $$;

-- Approve: creates ONE canonical affiliate through create_affiliate(), links profile + acceptances,
-- creates the (initially inactive) discount and referral link, all in one transaction.
CREATE OR REPLACE FUNCTION approve_affiliate_application(p_id UUID, c JSONB, p_actor TEXT) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  a affiliate_applications; v_code TEXT := upper(btrim(coalesce(c->>'code','')));
  v_type TEXT := coalesce(c->>'commissionType','percentage'); v_activate BOOLEAN := COALESCE((c->>'activateNow')::boolean, FALSE);
  v_disc_type TEXT := NULLIF(c->>'discountType',''); v_disc_id UUID; v_aff UUID; v_res JSONB; v_slug TEXT;
  v_link JSONB; v_link_id UUID; v_terms affiliate_documents; v_disc affiliate_documents; v_prog_terms TEXT; v_prog_disc TEXT;
  v_start TIMESTAMPTZ := (c->>'programStartAt')::timestamptz; v_end TIMESTAMPTZ := (c->>'programEndAt')::timestamptz;
  v_now TIMESTAMPTZ := transaction_timestamp(); v_name TEXT;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  SELECT * INTO a FROM affiliate_applications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  IF a.status NOT IN ('pending','under_review','needs_info') THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_STATE|application is %', a.status; END IF;
  IF a.anonymized_at IS NOT NULL THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_STATE|anonymized'; END IF;
  IF NOT a.age_attested THEN RAISE EXCEPTION 'KVRN_AFFPROG|AGE_ATTESTATION_REQUIRED'; END IF;
  IF NOT (a.country = ANY (affiliate_program_allowed_countries())) THEN RAISE EXCEPTION 'KVRN_AFFPROG|COUNTRY_NOT_ALLOWED'; END IF;
  IF (SELECT count(*) FROM affiliate_acceptances WHERE application_id = a.id
        AND doc_type IN ('program_terms','disclosure_policy','privacy_notice')) < 3 THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|ACCEPTANCES_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM affiliate_profiles WHERE email_normalized = a.email_normalized) THEN RAISE EXCEPTION 'KVRN_AFFPROG|EMAIL_ALREADY_AFFILIATE'; END IF;
  IF v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|code'; END IF;
  IF EXISTS (SELECT 1 FROM affiliates WHERE code = v_code) OR EXISTS (SELECT 1 FROM discounts WHERE code = v_code) THEN RAISE EXCEPTION 'KVRN_AFFPROG|CODE_TAKEN'; END IF;
  v_slug := COALESCE(NULLIF(lower(btrim(coalesce(c->>'linkSlug',''))),''), regexp_replace(lower(v_code), '_', '-', 'g'));
  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,40}$' THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|link slug'; END IF;
  IF EXISTS (SELECT 1 FROM affiliate_links WHERE slug = v_slug) THEN RAISE EXCEPTION 'KVRN_AFFPROG|LINK_SLUG_TAKEN'; END IF;
  IF v_end IS NOT NULL AND v_start IS NOT NULL AND v_end <= v_start THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|end date'; END IF;

  v_terms := affiliate_current_document('program_terms'); v_disc := affiliate_current_document('disclosure_policy');
  SELECT version INTO v_prog_terms FROM affiliate_acceptances WHERE application_id = a.id AND doc_type = 'program_terms' ORDER BY accepted_at DESC LIMIT 1;
  SELECT version INTO v_prog_disc  FROM affiliate_acceptances WHERE application_id = a.id AND doc_type = 'disclosure_policy' ORDER BY accepted_at DESC LIMIT 1;
  IF v_activate AND (v_prog_terms IS DISTINCT FROM v_terms.version OR v_prog_disc IS DISTINCT FROM v_disc.version
                     OR (v_start IS NOT NULL AND v_start > now())) THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|ACTIVATION_NOT_ALLOWED|accepted documents are not current or the start date is in the future';
  END IF;

  IF v_disc_type IS NOT NULL THEN
    INSERT INTO discounts (code, name, description, type, amount_cents, percentage_bps, active, system_managed, priority, created_by)
    VALUES (v_code, 'Affiliate ' || v_code, 'Affiliate customer discount. Managed by the affiliate program.', v_disc_type,
            CASE WHEN v_disc_type = 'fixed_amount' THEN (c->>'discountCents')::int END,
            CASE WHEN v_disc_type = 'percentage' THEN (c->>'discountBps')::int END,
            v_activate, TRUE, 10, p_actor)
    RETURNING id INTO v_disc_id;
  END IF;

  PERFORM set_config('kvrn.affiliate_origin', 'approval', true);
  v_name := COALESCE(a.display_name, a.applicant_name);
  v_res := create_affiliate(v_code, v_name, a.email, v_type,
      (c->>'commissionRateBps')::int, (c->>'commissionFixedCents')::int,
      COALESCE(c->>'fixedReversalPolicy','proportional'), COALESCE((c->>'attributionWindowDays')::int, 30),
      COALESCE((c->>'commissionHoldDays')::int, 30), v_disc_id, NULL, p_actor);
  v_aff := (v_res->>'affiliate_id')::uuid;
  PERFORM set_config('kvrn.affiliate_origin', '', true);

  IF NOT v_activate THEN
    -- Onboarding: the code must not attribute. create_affiliate() seeded an 'active' event at this
    -- transaction's instant, so the 'paused' event is appended with a strictly later created_at; the
    -- event ordering (effective_at, created_at, id) then deterministically resolves to paused.
    INSERT INTO affiliate_status_events (affiliate_id, from_status, to_status, effective_at, reason, actor_email, created_at)
    VALUES (v_aff, 'active', 'paused', v_now, 'onboarding: awaiting activation', p_actor, clock_timestamp());
    UPDATE affiliates SET status = 'paused', updated_at = NOW() WHERE id = v_aff;
  END IF;

  v_link := create_affiliate_link(v_aff, v_slug, '/', p_actor);
  v_link_id := (v_link->>'link_id')::uuid;
  IF NOT v_activate THEN UPDATE affiliate_links SET active = FALSE WHERE id = v_link_id; END IF;

  UPDATE affiliate_acceptances SET affiliate_id = v_aff WHERE application_id = a.id AND affiliate_id IS NULL;

  UPDATE affiliate_profiles SET
    display_name = v_name, application_id = a.id, country = a.country, state_region = a.state_region,
    social_links = a.social_links, website = a.website,
    program_status = CASE WHEN v_activate THEN 'active' ELSE 'onboarding' END,
    activated_at = CASE WHEN v_activate THEN NOW() END,
    payout_threshold_cents = (c->>'payoutThresholdCents')::int,
    payout_schedule = NULLIF(c->>'payoutSchedule',''),
    paid_ads_policy = COALESCE(NULLIF(c->>'paidAdsPolicy',''), 'not_permitted'),
    program_start_at = v_start, program_end_at = v_end,
    accepted_program_terms_version = v_prog_terms, accepted_disclosure_version = v_prog_disc,
    requires_reacceptance = (v_prog_terms IS DISTINCT FROM v_terms.version OR v_prog_disc IS DISTINCT FROM v_disc.version),
    code_disabled_at = CASE WHEN v_activate THEN NULL ELSE NOW() END,
    disabled_discount_active = (v_disc_id IS NOT NULL),
    disabled_link_ids = CASE WHEN v_activate THEN '{}'::uuid[] ELSE ARRAY[v_link_id] END
  WHERE affiliate_id = v_aff;

  UPDATE affiliate_applications SET status = 'approved_onboarding', affiliate_id = v_aff, reviewed_by = p_actor, reviewed_at = NOW(),
         decision_message = NULLIF(btrim(coalesce(c->>'approvalMessage','')),'') WHERE id = a.id;
  IF NULLIF(btrim(coalesce(c->>'internalNote','')),'') IS NOT NULL THEN
    INSERT INTO affiliate_notes (application_id, affiliate_id, author, body) VALUES (a.id, v_aff, p_actor, btrim(c->>'internalNote'));
  END IF;
  PERFORM affiliate_enqueue_email('application_approved', a.email,
    jsonb_build_object('displayName', v_name, 'message', NULLIF(btrim(coalesce(c->>'approvalMessage','')),''), 'activated', v_activate),
    'app_approved:' || a.id, v_aff, a.id);
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.approve', 'affiliate_applications', a.id::text,
          jsonb_build_object('affiliate_id', v_aff, 'code', v_code, 'activate_now', v_activate, 'terms_version', v_prog_terms,
                             'commission_type', v_type, 'rate_bps', (c->>'commissionRateBps')::int,
                             'discount_type', v_disc_type));
  RETURN jsonb_build_object('outcome','approved','affiliate_id',v_aff,'code',v_code,
                            'program_status', CASE WHEN v_activate THEN 'active' ELSE 'onboarding' END);
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 6 — program status, profile settings, code, reacceptance, program dates
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- Switch the customer discount + referral links off/on with the program status. Remembers what to restore.
CREATE OR REPLACE FUNCTION affiliate_disable_code(p_affiliate_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE p affiliate_profiles; a affiliates; v_links UUID[]; v_disc_active BOOLEAN := FALSE;
BEGIN
  SELECT * INTO p FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  SELECT * INTO a FROM affiliates WHERE id = p_affiliate_id;
  IF p.code_disabled_at IS NOT NULL THEN RETURN; END IF;   -- already disabled; keep the remembered state
  v_links := ARRAY(SELECT id FROM affiliate_links WHERE affiliate_id = p_affiliate_id AND active);
  UPDATE affiliate_links SET active = FALSE WHERE affiliate_id = p_affiliate_id AND active;
  IF a.discount_id IS NOT NULL THEN
    SELECT active INTO v_disc_active FROM discounts WHERE id = a.discount_id;
    UPDATE discounts SET active = FALSE WHERE id = a.discount_id;
  END IF;
  UPDATE affiliate_profiles SET code_disabled_at = NOW(), disabled_discount_active = COALESCE(v_disc_active, FALSE),
         disabled_link_ids = v_links WHERE affiliate_id = p_affiliate_id;
END $$;

CREATE OR REPLACE FUNCTION affiliate_enable_code(p_affiliate_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE p affiliate_profiles; a affiliates;
BEGIN
  SELECT * INTO p FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  SELECT * INTO a FROM affiliates WHERE id = p_affiliate_id;
  IF p.code_disabled_at IS NULL THEN RETURN; END IF;
  IF array_length(p.disabled_link_ids,1) IS NOT NULL THEN
    UPDATE affiliate_links SET active = TRUE WHERE affiliate_id = p_affiliate_id AND id = ANY (p.disabled_link_ids);
  END IF;
  IF a.discount_id IS NOT NULL AND p.disabled_discount_active THEN
    UPDATE discounts SET active = TRUE WHERE id = a.discount_id;
  END IF;
  UPDATE affiliate_profiles SET code_disabled_at = NULL, disabled_discount_active = FALSE, disabled_link_ids = '{}' WHERE affiliate_id = p_affiliate_id;
END $$;

CREATE OR REPLACE FUNCTION set_affiliate_program_status(
  p_affiliate_id UUID, p_target TEXT, p_actor TEXT, p_reason TEXT DEFAULT NULL, p_message TEXT DEFAULT NULL,
  p_notify BOOLEAN DEFAULT TRUE, p_revoke_portal BOOLEAN DEFAULT FALSE, p_effective_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  p affiliate_profiles; a affiliates; v_from TEXT; v_fin TEXT; v_terms affiliate_documents; v_disc affiliate_documents;
  v_action TEXT; v_ctx TEXT := p_actor;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  IF p_target NOT IN ('active','suspended','terminated') THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|target'; END IF;
  SELECT * INTO p FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  SELECT * INTO a FROM affiliates WHERE id = p_affiliate_id FOR UPDATE;
  v_from := p.program_status;
  IF v_from = p_target THEN RETURN jsonb_build_object('outcome','no_change','program_status',v_from); END IF;
  IF p_target = 'active' AND v_from = 'terminated' AND coalesce(btrim(p_reason),'') = '' THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|REASON_REQUIRED|a reason is required to reinstate a terminated affiliate';
  END IF;
  -- Terminated is left only through a deliberate reinstatement (with a reason), never by "suspending" around it.
  IF p_target = 'suspended' AND v_from = 'terminated' THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_STATE|a terminated affiliate can only be reinstated';
  END IF;

  IF p_target = 'active' THEN
    IF p.program_end_at IS NOT NULL AND p.program_end_at <= now() THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTIVATION_NOT_ALLOWED|the program end date has passed'; END IF;
    -- The first activation of an approved applicant is gated whichever route led here (onboarding, or a
    -- suspend/terminate detour before ever being active). Legacy affiliates (no application) are not gated.
    IF v_from = 'onboarding' OR (p.activated_at IS NULL AND p.application_id IS NOT NULL) THEN
      IF p.program_start_at IS NOT NULL AND p.program_start_at > now() THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTIVATION_NOT_ALLOWED|the start date has not been reached'; END IF;
      v_terms := affiliate_current_document('program_terms'); v_disc := affiliate_current_document('disclosure_policy');
      IF p.accepted_program_terms_version IS DISTINCT FROM v_terms.version OR p.accepted_disclosure_version IS DISTINCT FROM v_disc.version
         OR p.requires_reacceptance THEN
        RAISE EXCEPTION 'KVRN_AFFPROG|ACTIVATION_NOT_ALLOWED|the current terms and disclosure policy have not been accepted';
      END IF;
    END IF;
    v_fin := 'active'; v_action := CASE WHEN v_from = 'onboarding' OR (p.activated_at IS NULL AND p.application_id IS NOT NULL) THEN 'activate' ELSE 'reinstate' END;
  ELSIF p_target = 'suspended' THEN v_fin := 'paused'; v_action := 'suspend';
  ELSE v_fin := 'terminated'; v_action := 'terminate';
  END IF;

  IF a.status IS DISTINCT FROM v_fin THEN
    PERFORM set_affiliate_status(p_affiliate_id, v_fin, p_effective_at, COALESCE(NULLIF(btrim(p_reason),''), v_action), p_actor);
  END IF;

  IF p_target = 'active' THEN PERFORM affiliate_enable_code(p_affiliate_id);
  ELSE PERFORM affiliate_disable_code(p_affiliate_id);
  END IF;

  UPDATE affiliate_profiles SET
    program_status = p_target,
    activated_at = CASE WHEN p_target = 'active' THEN COALESCE(activated_at, NOW()) ELSE activated_at END,
    suspended_at = CASE WHEN p_target = 'suspended' THEN NOW() WHEN p_target = 'active' THEN NULL ELSE suspended_at END,
    terminated_at = CASE WHEN p_target = 'terminated' THEN NOW() WHEN p_target = 'active' THEN NULL ELSE terminated_at END,
    portal_access = CASE WHEN p_target = 'active' THEN 'enabled'
                         WHEN p_revoke_portal THEN 'revoked' ELSE 'read_only' END
  WHERE affiliate_id = p_affiliate_id;

  IF p_revoke_portal AND p_target <> 'active'
     AND to_regprocedure('revoke_affiliate_sessions(uuid,text,text)') IS NOT NULL THEN
    EXECUTE 'SELECT revoke_affiliate_sessions($1,$2,$3)' USING p_affiliate_id, 'program_status:' || v_action, p_actor;
  END IF;

  IF p_notify AND p_target IN ('suspended','terminated') THEN
    PERFORM affiliate_enqueue_email(CASE p_target WHEN 'suspended' THEN 'affiliate_suspended' ELSE 'affiliate_terminated' END,
      a.email, jsonb_build_object('displayName', p.display_name, 'message', NULLIF(btrim(coalesce(p_message,'')),'')),
      v_action || ':' || p_affiliate_id || ':' || extract(epoch from clock_timestamp())::text, p_affiliate_id, NULL);
  ELSIF p_notify AND p_target = 'active' THEN
    PERFORM affiliate_enqueue_email('affiliate_activated', a.email,
      jsonb_build_object('displayName', p.display_name, 'reinstated', v_action = 'reinstate'),
      v_action || ':' || p_affiliate_id || ':' || extract(epoch from clock_timestamp())::text, p_affiliate_id, NULL);
  END IF;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.' || v_action, 'affiliates', p_affiliate_id::text,
          jsonb_build_object('from', v_from, 'to', p_target, 'revoke_portal', p_revoke_portal, 'notify', p_notify));
  RETURN jsonb_build_object('outcome','updated','from',v_from,'program_status',p_target,'action',v_action);
END $$;

CREATE OR REPLACE FUNCTION update_affiliate_profile_settings(p_affiliate_id UUID, p JSONB, p_actor TEXT) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE pr affiliate_profiles; v_changed TEXT[] := '{}'; v_country TEXT;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  SELECT * INTO pr FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  IF p ? 'country' THEN
    v_country := upper(btrim(coalesce(p->>'country','')));
    IF NOT (v_country = ANY (affiliate_program_allowed_countries())) THEN RAISE EXCEPTION 'KVRN_AFFPROG|COUNTRY_NOT_ALLOWED'; END IF;
    UPDATE affiliate_profiles SET country = v_country WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'country');
  END IF;
  IF p ? 'displayName' THEN UPDATE affiliate_profiles SET display_name = NULLIF(btrim(p->>'displayName'),'') WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'displayName'); END IF;
  IF p ? 'stateRegion' THEN UPDATE affiliate_profiles SET state_region = NULLIF(btrim(p->>'stateRegion'),'') WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'stateRegion'); END IF;
  IF p ? 'website' THEN UPDATE affiliate_profiles SET website = NULLIF(btrim(p->>'website'),'') WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'website'); END IF;
  IF p ? 'socialLinks' THEN UPDATE affiliate_profiles SET social_links = COALESCE(p->'socialLinks','[]'::jsonb) WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'socialLinks'); END IF;
  IF p ? 'payoutThresholdCents' THEN UPDATE affiliate_profiles SET payout_threshold_cents = (p->>'payoutThresholdCents')::int WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'payoutThresholdCents'); END IF;
  IF p ? 'payoutSchedule' THEN UPDATE affiliate_profiles SET payout_schedule = NULLIF(p->>'payoutSchedule','') WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'payoutSchedule'); END IF;
  IF p ? 'paidAdsPolicy' THEN UPDATE affiliate_profiles SET paid_ads_policy = p->>'paidAdsPolicy' WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'paidAdsPolicy'); END IF;
  IF p ? 'programStartAt' THEN UPDATE affiliate_profiles SET program_start_at = (p->>'programStartAt')::timestamptz WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'programStartAt'); END IF;
  IF p ? 'programEndAt' THEN UPDATE affiliate_profiles SET program_end_at = (p->>'programEndAt')::timestamptz WHERE affiliate_id = p_affiliate_id; v_changed := array_append(v_changed, 'programEndAt'); END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.settings.update', 'affiliates', p_affiliate_id::text,
          jsonb_build_object('fields', to_jsonb(v_changed),
            'payout_threshold_cents', CASE WHEN p ? 'payoutThresholdCents' THEN p->'payoutThresholdCents' END,
            'payout_schedule', CASE WHEN p ? 'payoutSchedule' THEN p->'payoutSchedule' END,
            'paid_ads_policy', CASE WHEN p ? 'paidAdsPolicy' THEN p->'paidAdsPolicy' END));
  RETURN jsonb_build_object('outcome','updated','fields',to_jsonb(v_changed));
END $$;

CREATE OR REPLACE FUNCTION set_affiliate_email(p_affiliate_id UUID, p_email TEXT, p_actor TEXT) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_norm TEXT := lower(btrim(coalesce(p_email,'')));
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  IF v_norm !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|email'; END IF;
  IF EXISTS (SELECT 1 FROM affiliate_profiles WHERE email_normalized = v_norm AND affiliate_id <> p_affiliate_id) THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|EMAIL_ALREADY_AFFILIATE';
  END IF;
  UPDATE affiliates SET email = btrim(p_email), updated_at = NOW() WHERE id = p_affiliate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  UPDATE affiliate_profiles SET email_normalized = v_norm WHERE affiliate_id = p_affiliate_id;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.email.update', 'affiliates', p_affiliate_id::text, '{}'::jsonb);
  RETURN jsonb_build_object('outcome','updated');
END $$;

-- A code can change only while it has never been used on an order (attribution is by code text).
CREATE OR REPLACE FUNCTION change_affiliate_code(p_affiliate_id UUID, p_new_code TEXT, p_actor TEXT) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE a affiliates; v_new TEXT := upper(btrim(coalesce(p_new_code,'')));
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  IF v_new !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' THEN RAISE EXCEPTION 'KVRN_AFFPROG|INVALID_INPUT|code'; END IF;
  SELECT * INTO a FROM affiliates WHERE id = p_affiliate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPROG|NOT_FOUND'; END IF;
  IF a.code = v_new THEN RETURN jsonb_build_object('outcome','no_change'); END IF;
  IF EXISTS (SELECT 1 FROM order_affiliate_attributions WHERE affiliate_id = p_affiliate_id)
     OR EXISTS (SELECT 1 FROM affiliate_commissions WHERE affiliate_id = p_affiliate_id)
     OR EXISTS (SELECT 1 FROM orders WHERE upper(discount_code) = upper(a.code))
     OR (a.discount_id IS NOT NULL AND (SELECT redemption_count FROM discounts WHERE id = a.discount_id) > 0) THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|CODE_LOCKED|the code has been used on orders and can no longer change';
  END IF;
  IF EXISTS (SELECT 1 FROM affiliates WHERE code = v_new) OR EXISTS (SELECT 1 FROM discounts WHERE code = v_new AND id IS DISTINCT FROM a.discount_id) THEN
    RAISE EXCEPTION 'KVRN_AFFPROG|CODE_TAKEN';
  END IF;
  UPDATE affiliates SET code = v_new, updated_at = NOW() WHERE id = p_affiliate_id;
  IF a.discount_id IS NOT NULL THEN UPDATE discounts SET code = v_new, name = 'Affiliate ' || v_new WHERE id = a.discount_id; END IF;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.code.change', 'affiliates', p_affiliate_id::text, jsonb_build_object('from', a.code, 'to', v_new));
  RETURN jsonb_build_object('outcome','updated','code',v_new);
END $$;

-- Who still needs to accept the current documents.
CREATE OR REPLACE FUNCTION affiliate_reacceptance_list() RETURNS TABLE (
  affiliate_id UUID, code TEXT, display_name TEXT, email TEXT, program_status TEXT,
  accepted_program_terms_version TEXT, accepted_disclosure_version TEXT,
  current_program_terms_version TEXT, current_disclosure_version TEXT,
  requires_reacceptance BOOLEAN, reason TEXT)
LANGUAGE sql STABLE AS $$
  WITH cur AS (
    SELECT (SELECT version FROM affiliate_current_document('program_terms')) AS t,
           (SELECT version FROM affiliate_current_document('disclosure_policy')) AS d)
  SELECT p.affiliate_id, a.code, p.display_name, a.email, p.program_status,
         p.accepted_program_terms_version, p.accepted_disclosure_version, cur.t, cur.d, p.requires_reacceptance,
         CASE WHEN p.accepted_program_terms_version IS NULL OR p.accepted_disclosure_version IS NULL THEN 'not_accepted'
              ELSE 'outdated' END
    FROM affiliate_profiles p JOIN affiliates a ON a.id = p.affiliate_id CROSS JOIN cur
   WHERE p.program_status IN ('onboarding','active','suspended')
     AND (p.accepted_program_terms_version IS DISTINCT FROM cur.t OR p.accepted_disclosure_version IS DISTINCT FROM cur.d
          OR p.requires_reacceptance)
   ORDER BY a.code
$$;

CREATE OR REPLACE FUNCTION request_affiliate_reacceptance(p_affiliate_ids UUID[], p_actor TEXT) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_n INTEGER := 0; v_t TEXT; v_d TEXT;
BEGIN
  IF coalesce(p_actor,'') = '' THEN RAISE EXCEPTION 'KVRN_AFFPROG|ACTOR_REQUIRED'; END IF;
  SELECT version INTO v_t FROM affiliate_current_document('program_terms');
  SELECT version INTO v_d FROM affiliate_current_document('disclosure_policy');
  FOR r IN SELECT p.affiliate_id, a.email, p.display_name FROM affiliate_profiles p JOIN affiliates a ON a.id = p.affiliate_id
            WHERE p.affiliate_id = ANY (p_affiliate_ids) AND p.program_status IN ('onboarding','active','suspended')
              AND (p.accepted_program_terms_version IS DISTINCT FROM v_t OR p.accepted_disclosure_version IS DISTINCT FROM v_d) LOOP
    UPDATE affiliate_profiles SET requires_reacceptance = TRUE WHERE affiliate_id = r.affiliate_id;
    PERFORM affiliate_enqueue_email('terms_update', r.email, jsonb_build_object('displayName', r.display_name, 'docType', 'program_terms', 'version', v_t),
      'terms_update:' || r.affiliate_id || ':program_terms:' || v_t || ':' || coalesce(v_d,''), r.affiliate_id, NULL);
    v_n := v_n + 1;
  END LOOP;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.reacceptance.request', 'affiliates', NULL, jsonb_build_object('count', v_n));
  RETURN jsonb_build_object('flagged', v_n);
END $$;

-- Program end dates: an affiliate whose end date has passed is terminated (history untouched).
CREATE OR REPLACE FUNCTION apply_due_affiliate_program_dates(p_actor TEXT DEFAULT 'system:affiliate-program') RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_n INTEGER := 0;
BEGIN
  FOR r IN SELECT affiliate_id FROM affiliate_profiles
            WHERE program_end_at IS NOT NULL AND program_end_at <= now() AND program_status <> 'terminated' LOOP
    PERFORM set_affiliate_program_status(r.affiliate_id, 'terminated', p_actor, 'program end date reached', NULL, TRUE, FALSE, NULL);
    v_n := v_n + 1;
  END LOOP;
  UPDATE affiliate_invites SET status = 'expired' WHERE status = 'open' AND expires_at <= now();
  RETURN jsonb_build_object('terminated', v_n);
END $$;

COMMIT;
