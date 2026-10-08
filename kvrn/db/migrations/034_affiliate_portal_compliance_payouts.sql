-- KVRN Migration 034 — Affiliate portal auth, payout readiness, compliance, UGC rights
--
-- Additive only. Nothing in 001-033 is altered, dropped or replaced. Re-applying this file is a no-op
-- (IF NOT EXISTS everywhere, CREATE OR REPLACE only of functions created HERE, guarded triggers).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--   * Affiliate-only passwordless login:  affiliate_login_tokens, affiliate_sessions, affiliate_auth_rate_events,
--     affiliate_security_events. Only HASHES of tokens are stored. No raw email is stored in the auth tables.
--   * Payout readiness:  affiliate_payout_accounts (provider reference + MASKED metadata only), append-only
--     affiliate_readiness_events, affiliate_payout_attempts (failed payout + retry), statement function.
--   * Compliance center:  affiliate_compliance_items / _warnings / _reviews / _item_events, affiliate_fraud_flags.
--   * UGC rights:  affiliate_ugc_licenses — separate from affiliate status; nothing creates a license implicitly.
--   * affiliate_public_refs — non-reversible, per-affiliate reference ids for sales/payouts shown in the portal
--     (the affiliate NEVER sees an order number or order UUID).
--   * affiliate_portal_notifications — a small idempotent outbox (transactional_emails is order-scoped).
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
--   * No raw bank / tax / ID / DOB columns anywhere. Provider hosted onboarding only; masked metadata is
--     constrained by CHECK (affiliate_masked_metadata_ok).
--   * No change to commission math, attribution, payout functions or the ledger (020-026 untouched). Payout
--     "failed"/"retry" is an append-only ATTEMPT record beside the existing draft/paid/void payout row.
--   * No hard dependency on migration 033 (affiliate_profiles etc.). Functions that touch those tables are
--     plpgsql and guard with to_regclass(); they raise a coded error when the table is absent.
--
-- Run after 001-027 (and 033 when present).

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Generic append-only guard (own function)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION affiliate_portal_forbid_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KVRN_AFFPORTAL|APPEND_ONLY|% on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- AUTH — magic-link tokens, sessions, rate-limit events, security events
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_login_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hex of the random token. The token itself is never stored or logged.
  token_hash    TEXT        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- NULL is allowed by design (a request that matched nobody could be recorded), but the application only
  -- ever inserts a row when an eligible affiliate matched, so no token exists for an unknown email.
  affiliate_id  UUID        REFERENCES affiliates(id) ON DELETE RESTRICT,
  -- Keyed hash of the normalised email, used only for rate limiting. No raw address is stored here.
  email_hash    TEXT        NOT NULL,
  ip_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  CONSTRAINT alt_token_uq UNIQUE (token_hash),
  CONSTRAINT alt_expiry_after_create CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_alt_expires   ON affiliate_login_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_alt_affiliate ON affiliate_login_tokens(affiliate_id) WHERE affiliate_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS affiliate_sessions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash         TEXT        NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  -- Hash of the per-session CSRF token (double-submit: cookie + header must match, and match this hash).
  csrf_hash            TEXT        NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  affiliate_id         UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Sliding expiry (idle timeout) and a hard absolute ceiling.
  expires_at           TIMESTAMPTZ NOT NULL,
  absolute_expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ,
  revoked_reason       TEXT,
  user_agent_hash      TEXT,
  CONSTRAINT afs_session_uq UNIQUE (session_hash),
  CONSTRAINT afs_absolute_after_create CHECK (absolute_expires_at >= created_at)
);
CREATE INDEX IF NOT EXISTS idx_afs_affiliate ON affiliate_sessions(affiliate_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_afs_expires   ON affiliate_sessions(expires_at);

CREATE TABLE IF NOT EXISTS affiliate_auth_rate_events (
  id          BIGSERIAL   PRIMARY KEY,
  bucket      TEXT        NOT NULL,
  key_hash    TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aare_lookup ON affiliate_auth_rate_events(bucket, key_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS affiliate_security_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  UUID        REFERENCES affiliates(id) ON DELETE RESTRICT,
  event_type    TEXT        NOT NULL CHECK (event_type IN (
    'login_link_requested','login_succeeded','login_failed','logout','sessions_revoked',
    'access_changed','profile_updated','terms_accepted','statement_downloaded','payout_setup_started')),
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (length(detail::text) < 2000),
  ip_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ase2_affiliate ON affiliate_security_events(affiliate_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_security_events_append_only') THEN
    CREATE TRIGGER affiliate_security_events_append_only BEFORE UPDATE OR DELETE ON affiliate_security_events
      FOR EACH ROW EXECUTE FUNCTION affiliate_portal_forbid_mutation();
  END IF;
END $$;

-- DB-backed sliding-window limiter. Only ALLOWED attempts are recorded, so an attacker hammering a victim's
-- address cannot extend the victim's lockout beyond one window. The key is a hash that the application
-- derives from the email / IP regardless of whether an account exists, so being limited reveals nothing.
CREATE OR REPLACE FUNCTION affiliate_auth_rate_allow(
  p_bucket TEXT, p_key_hash TEXT, p_limit INTEGER, p_window_seconds INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  IF p_bucket IS NULL OR p_key_hash IS NULL OR p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_RATE_ARGS';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_bucket || ':' || p_key_hash, 0));
  SELECT COUNT(*) INTO v_count FROM affiliate_auth_rate_events
   WHERE bucket = p_bucket AND key_hash = p_key_hash
     AND created_at > NOW() - make_interval(secs => p_window_seconds);
  IF v_count >= p_limit THEN RETURN FALSE; END IF;
  INSERT INTO affiliate_auth_rate_events (bucket, key_hash) VALUES (p_bucket, p_key_hash);
  RETURN TRUE;
END;
$$;

-- Atomically consume a magic-link token. Returns the affiliate id, or NULL for EVERY failure cause
-- (unknown, expired, already used, access revoked, no profile) so the caller cannot tell them apart.
CREATE OR REPLACE FUNCTION affiliate_consume_login_token(p_token_hash TEXT) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_aff UUID; v_ok BOOLEAN := FALSE;
BEGIN
  UPDATE affiliate_login_tokens
     SET consumed_at = NOW()
   WHERE token_hash = p_token_hash
     AND consumed_at IS NULL
     AND expires_at > NOW()
     AND affiliate_id IS NOT NULL
  RETURNING affiliate_id INTO v_aff;
  IF v_aff IS NULL THEN RETURN NULL; END IF;

  IF to_regclass('public.affiliate_profiles') IS NULL THEN RETURN NULL; END IF;
  SELECT TRUE INTO v_ok FROM affiliate_profiles
   WHERE affiliate_id = v_aff AND portal_access <> 'revoked';
  IF v_ok IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN v_aff;
END;
$$;

-- Revoke every live session (and unused login link) of an affiliate. Used by Admin actions and maintenance.
CREATE OR REPLACE FUNCTION revoke_affiliate_sessions(
  p_affiliate_id UUID, p_reason TEXT, p_actor TEXT
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|ACTOR_REQUIRED'; END IF;
  -- Every not-yet-revoked row is closed; the count reports only the sessions that were actually still live.
  WITH u AS (
    UPDATE affiliate_sessions
       SET revoked_at = NOW(), revoked_reason = LEFT(COALESCE(NULLIF(BTRIM(p_reason),''), 'revoked'), 120)
     WHERE affiliate_id = p_affiliate_id AND revoked_at IS NULL
     RETURNING expires_at, absolute_expires_at)
  SELECT COUNT(*) FILTER (WHERE expires_at > NOW() AND absolute_expires_at > NOW())::INTEGER INTO v_n FROM u;
  UPDATE affiliate_login_tokens SET consumed_at = NOW()
   WHERE affiliate_id = p_affiliate_id AND consumed_at IS NULL;
  INSERT INTO affiliate_security_events (affiliate_id, event_type, detail)
  VALUES (p_affiliate_id, 'sessions_revoked',
          jsonb_build_object('count', v_n, 'reason', LEFT(COALESCE(p_reason,''), 120)));
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.sessions_revoke', 'affiliates', p_affiliate_id::text,
          jsonb_build_object('count', v_n, 'reason', LEFT(COALESCE(p_reason,''), 120)));
  RETURN v_n;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- AFFILIATE-FACING REFERENCE IDS (non-reversible)
-- ═══════════════════════════════════════════════════════════════════════════
-- A random id, stored. It is NOT derived from the order number/UUID, so possessing it reveals nothing and it
-- cannot be reversed. Admin maps it back through this table.
CREATE TABLE IF NOT EXISTS affiliate_public_refs (
  kind          TEXT        NOT NULL CHECK (kind IN ('sale','payout')),
  source_id     UUID        NOT NULL,
  affiliate_id  UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  ref           TEXT        NOT NULL CHECK (ref ~ '^[SP]-[0-9A-F]{10}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, source_id),
  CONSTRAINT apr_ref_uq UNIQUE (ref)
);
CREATE INDEX IF NOT EXISTS idx_apr_affiliate ON affiliate_public_refs(affiliate_id, kind);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_public_refs_immutable') THEN
    CREATE TRIGGER affiliate_public_refs_immutable BEFORE UPDATE OR DELETE ON affiliate_public_refs
      FOR EACH ROW EXECUTE FUNCTION affiliate_portal_forbid_mutation();
  END IF;
END $$;

-- Returns the reference for a commission ('sale') or payout, creating it on first use. Returns NULL when the
-- source does not belong to that affiliate — the portal can therefore never mint a reference for someone else's row.
CREATE OR REPLACE FUNCTION affiliate_public_ref(p_kind TEXT, p_source_id UUID, p_affiliate_id UUID)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_ref TEXT; v_try INTEGER := 0; v_prefix TEXT;
BEGIN
  IF p_kind NOT IN ('sale','payout') THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_REF_KIND'; END IF;
  SELECT ref INTO v_ref FROM affiliate_public_refs
   WHERE kind = p_kind AND source_id = p_source_id AND affiliate_id = p_affiliate_id;
  IF v_ref IS NOT NULL THEN RETURN v_ref; END IF;

  IF p_kind = 'sale' THEN
    PERFORM 1 FROM affiliate_commissions WHERE id = p_source_id AND affiliate_id = p_affiliate_id;
  ELSE
    PERFORM 1 FROM affiliate_payouts WHERE id = p_source_id AND affiliate_id = p_affiliate_id;
  END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_prefix := CASE WHEN p_kind = 'sale' THEN 'S' ELSE 'P' END;
  LOOP
    v_try := v_try + 1;
    v_ref := v_prefix || '-' || UPPER(SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 10));
    BEGIN
      INSERT INTO affiliate_public_refs (kind, source_id, affiliate_id, ref)
      VALUES (p_kind, p_source_id, p_affiliate_id, v_ref);
      RETURN v_ref;
    EXCEPTION WHEN unique_violation THEN
      SELECT ref INTO v_ref FROM affiliate_public_refs WHERE kind = p_kind AND source_id = p_source_id;
      IF v_ref IS NOT NULL THEN RETURN v_ref; END IF;
      IF v_try > 5 THEN RAISE; END IF;
    END;
  END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PAYOUT READINESS — provider references and status mirrors. NO raw bank/tax/ID data.
-- ═══════════════════════════════════════════════════════════════════════════
-- masked_metadata may only hold a handful of short display strings (e.g. brand "visa"/"bank", last4).
CREATE OR REPLACE FUNCTION affiliate_masked_metadata_ok(p JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL
     AND jsonb_typeof(p) = 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p) e
        WHERE e.key NOT IN ('brand','last4','country','currency','method_label','bank_name','account_label')
           OR jsonb_typeof(e.value) <> 'string'
           OR LENGTH(e.value #>> '{}') > 40)
     AND (NOT (p ? 'last4') OR (p ->> 'last4') ~ '^[0-9]{0,4}$')
$$;

CREATE TABLE IF NOT EXISTS affiliate_payout_accounts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id          UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  provider              TEXT        NOT NULL CHECK (provider IN ('manual','stripe_connect')),
  -- The PROVIDER'S opaque account id (e.g. an acct_ reference). Never a bank number.
  provider_account_ref  TEXT        CHECK (provider_account_ref IS NULL OR provider_account_ref ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  provider_status       TEXT        CHECK (provider_status IS NULL OR LENGTH(provider_status) <= 40),
  kyc_status            TEXT        NOT NULL DEFAULT 'not_started' CHECK (kyc_status IN ('not_started','pending','verified','problem')),
  tax_status            TEXT        NOT NULL DEFAULT 'not_started' CHECK (tax_status IN ('not_started','pending','complete','problem')),
  payout_method_status  TEXT        NOT NULL DEFAULT 'not_started' CHECK (payout_method_status IN ('not_started','pending','ready','failed')),
  masked_metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (affiliate_masked_metadata_ok(masked_metadata)),
  last_synced_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apa_affiliate_provider_uq UNIQUE (affiliate_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_apa_affiliate ON affiliate_payout_accounts(affiliate_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_apa_updated_at') THEN
    CREATE TRIGGER set_apa_updated_at BEFORE UPDATE ON affiliate_payout_accounts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Every KYC / tax / payout-method transition, with who or what caused it. Append-only.
CREATE TABLE IF NOT EXISTS affiliate_readiness_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  domain        TEXT        NOT NULL CHECK (domain IN ('kyc','tax','payout_method')),
  from_status   TEXT,
  to_status     TEXT        NOT NULL,
  source        TEXT        NOT NULL CHECK (source IN ('admin','provider','system')),
  actor_email   TEXT,
  note          TEXT        CHECK (note IS NULL OR LENGTH(note) <= 300),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_are_affiliate ON affiliate_readiness_events(affiliate_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_readiness_events_append_only') THEN
    CREATE TRIGGER affiliate_readiness_events_append_only BEFORE UPDATE OR DELETE ON affiliate_readiness_events
      FOR EACH ROW EXECUTE FUNCTION affiliate_portal_forbid_mutation();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Notification outbox (idempotent). transactional_emails is order-scoped, so affiliate mail has its own queue.
-- No recipient address is stored: it is resolved from the profile at send time.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_portal_notifications (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id     UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  kind             TEXT        NOT NULL CHECK (kind IN (
    'setup_required','activated','payout_sent','payout_failed','compliance_warning','reacceptance_required')),
  dedupe_key       TEXT        NOT NULL CHECK (LENGTH(dedupe_key) BETWEEN 3 AND 160),
  payload          JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (LENGTH(payload::text) < 4000),
  status           TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','skipped')),
  attempts         INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error       TEXT,
  provider_message_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at          TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apn_dedupe_uq UNIQUE (dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_apn_due ON affiliate_portal_notifications(next_attempt_at)
  WHERE status IN ('queued','failed','sending');

-- ═══════════════════════════════════════════════════════════════════════════
-- PAYOUT ATTEMPTS — failed payout + retry without changing the existing payout lifecycle
-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_payouts stays draft/paid/void (020). A "failed" payout is a draft whose latest attempt failed; the
-- draft keeps RESERVING the money (so it cannot be paid twice), and Admin either retries or voids it.
CREATE TABLE IF NOT EXISTS affiliate_payout_attempts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id           UUID        NOT NULL REFERENCES affiliate_payouts(id) ON DELETE RESTRICT,
  affiliate_id        UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  attempt_no          INTEGER     NOT NULL CHECK (attempt_no > 0),
  provider            TEXT        NOT NULL CHECK (provider IN ('manual','stripe_connect')),
  status              TEXT        NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','succeeded','failed')),
  idempotency_key     TEXT        NOT NULL CHECK (LENGTH(idempotency_key) BETWEEN 8 AND 120),
  provider_reference  TEXT        CHECK (provider_reference IS NULL OR LENGTH(provider_reference) <= 120),
  failure_code        TEXT        CHECK (failure_code IS NULL OR LENGTH(failure_code) <= 60),
  failure_note        TEXT        CHECK (failure_note IS NULL OR LENGTH(failure_note) <= 300),
  created_by          TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  CONSTRAINT apat_attempt_uq UNIQUE (payout_id, attempt_no),
  CONSTRAINT apat_idem_uq    UNIQUE (payout_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_apat_payout ON affiliate_payout_attempts(payout_id, attempt_no DESC);

CREATE OR REPLACE FUNCTION affiliate_payout_attempt_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|APPEND_ONLY|DELETE on affiliate_payout_attempts is not allowed';
  END IF;
  IF OLD.status <> 'initiated' THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|ATTEMPT_FINAL|a completed attempt cannot change';
  END IF;
  IF NEW.payout_id <> OLD.payout_id OR NEW.affiliate_id <> OLD.affiliate_id OR NEW.attempt_no <> OLD.attempt_no
     OR NEW.provider <> OLD.provider OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|ATTEMPT_IMMUTABLE|identity columns cannot change';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_payout_attempt_guard_trg') THEN
    CREATE TRIGGER affiliate_payout_attempt_guard_trg BEFORE UPDATE OR DELETE ON affiliate_payout_attempts
      FOR EACH ROW EXECUTE FUNCTION affiliate_payout_attempt_guard();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- COMPLIANCE CENTER
-- ═══════════════════════════════════════════════════════════════════════════
-- Saved promotional-post URLs reviewed by hand. No scraping.
CREATE TABLE IF NOT EXISTS affiliate_compliance_items (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id   UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  url            TEXT        NOT NULL CHECK (url ~ '^https://' AND LENGTH(url) <= 500),
  platform       TEXT        CHECK (platform IS NULL OR LENGTH(platform) <= 40),
  title          TEXT        CHECK (title IS NULL OR LENGTH(title) <= 160),
  status         TEXT        NOT NULL DEFAULT 'needs_review'
                  CHECK (status IN ('compliant','needs_review','violation','resolved')),
  internal_note  TEXT        CHECK (internal_note IS NULL OR LENGTH(internal_note) <= 1000),
  reviewed_at    TIMESTAMPTZ,
  reviewed_by    TEXT,
  created_by     TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aci_affiliate ON affiliate_compliance_items(affiliate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aci_status    ON affiliate_compliance_items(status) WHERE status IN ('needs_review','violation');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_aci_updated_at') THEN
    CREATE TRIGGER set_aci_updated_at BEFORE UPDATE ON affiliate_compliance_items
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_compliance_items_no_delete') THEN
    CREATE TRIGGER affiliate_compliance_items_no_delete BEFORE DELETE ON affiliate_compliance_items
      FOR EACH ROW EXECUTE FUNCTION affiliate_portal_forbid_mutation();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS affiliate_compliance_item_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       UUID        NOT NULL REFERENCES affiliate_compliance_items(id) ON DELETE RESTRICT,
  affiliate_id  UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  from_status   TEXT,
  to_status     TEXT        NOT NULL,
  note          TEXT        CHECK (note IS NULL OR LENGTH(note) <= 1000),
  actor_email   TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_acie_item ON affiliate_compliance_item_events(item_id, created_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_compliance_item_events_append_only') THEN
    CREATE TRIGGER affiliate_compliance_item_events_append_only BEFORE UPDATE OR DELETE ON affiliate_compliance_item_events
      FOR EACH ROW EXECUTE FUNCTION affiliate_portal_forbid_mutation();
  END IF;
END $$;

-- Warning history. `summary` is written FOR the affiliate (shown in the portal when notify_affiliate); the
-- internal_note is Admin-only and is never returned by any affiliate route.
CREATE TABLE IF NOT EXISTS affiliate_compliance_warnings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id      UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  item_id           UUID        REFERENCES affiliate_compliance_items(id) ON DELETE RESTRICT,
  severity          TEXT        NOT NULL CHECK (severity IN ('notice','warning','final')),
  category          TEXT        NOT NULL CHECK (category IN ('disclosure','brand','paid_ads','email_sms','claims','self_referral','other')),
  summary           TEXT        NOT NULL CHECK (LENGTH(summary) BETWEEN 3 AND 500),
  internal_note     TEXT        CHECK (internal_note IS NULL OR LENGTH(internal_note) <= 1000),
  notify_affiliate  BOOLEAN     NOT NULL DEFAULT TRUE,
  status            TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  issued_by         TEXT        NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT,
  resolution_note   TEXT        CHECK (resolution_note IS NULL OR LENGTH(resolution_note) <= 500),
  CONSTRAINT acw_resolved_consistent CHECK (
    (status = 'open' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_acw_affiliate ON affiliate_compliance_warnings(affiliate_id, issued_at DESC);

CREATE OR REPLACE FUNCTION affiliate_compliance_warning_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|APPEND_ONLY|DELETE on affiliate_compliance_warnings is not allowed';
  END IF;
  -- History is immutable: only open -> resolved (with who/when/note) may change.
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|WARNING_FINAL|a resolved warning cannot change';
  END IF;
  IF NEW.affiliate_id <> OLD.affiliate_id OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.severity <> OLD.severity OR NEW.category <> OLD.category OR NEW.summary <> OLD.summary
     OR NEW.internal_note IS DISTINCT FROM OLD.internal_note OR NEW.notify_affiliate <> OLD.notify_affiliate
     OR NEW.issued_by <> OLD.issued_by OR NEW.issued_at <> OLD.issued_at THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|WARNING_IMMUTABLE|only resolution fields can change';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_compliance_warning_guard_trg') THEN
    CREATE TRIGGER affiliate_compliance_warning_guard_trg BEFORE UPDATE OR DELETE ON affiliate_compliance_warnings
      FOR EACH ROW EXECUTE FUNCTION affiliate_compliance_warning_guard();
  END IF;
END $$;

-- "Last compliance review date" — an append-only log; the latest row is the current review.
CREATE TABLE IF NOT EXISTS affiliate_compliance_reviews (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  outcome       TEXT        NOT NULL CHECK (outcome IN ('no_issues','issues_found','follow_up')),
  note          TEXT        CHECK (note IS NULL OR LENGTH(note) <= 1000),
  reviewed_by   TEXT        NOT NULL,
  reviewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_acr_affiliate ON affiliate_compliance_reviews(affiliate_id, reviewed_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_compliance_reviews_append_only') THEN
    CREATE TRIGGER affiliate_compliance_reviews_append_only BEFORE UPDATE OR DELETE ON affiliate_compliance_reviews
      FOR EACH ROW EXECUTE FUNCTION affiliate_portal_forbid_mutation();
  END IF;
END $$;

-- Fraud / abuse flags. A flag is a QUESTION for a human, never an accusation: heuristics create `review`/`info`
-- flags that NEVER freeze anything (freeze_commissions is always inserted FALSE by the scan; only an Admin can set it). `freeze_commissions` is an explicit, auditable Admin decision that blocks PAYOUT (the payout gate);
-- no commission or ledger row is ever edited or deleted.
CREATE TABLE IF NOT EXISTS affiliate_fraud_flags (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id        UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  order_id            UUID        REFERENCES orders(id) ON DELETE RESTRICT,
  signal              TEXT        NOT NULL CHECK (signal IN (
    'customer_email_matches_affiliate','customer_email_similar_to_affiliate',
    'suspected_coupon_leakage','suspected_cookie_stuffing','suspected_duplicate_account','suspected_manipulated_attribution','other')),
  source              TEXT        NOT NULL CHECK (source IN ('heuristic','admin')),
  severity            TEXT        NOT NULL DEFAULT 'review' CHECK (severity IN ('info','review','high')),
  status              TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','dismissed')),
  freeze_commissions  BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Safe, non-PII facts only (e.g. {"match":"exact"}). Never an email, name or address.
  detail              JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (LENGTH(detail::text) < 1000),
  investigation_note  TEXT        CHECK (investigation_note IS NULL OR LENGTH(investigation_note) <= 1000),
  created_by          TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by         TEXT,
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT        CHECK (resolution_note IS NULL OR LENGTH(resolution_note) <= 500)
);
CREATE INDEX IF NOT EXISTS idx_aff_flags_affiliate ON affiliate_fraud_flags(affiliate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aff_flags_open ON affiliate_fraud_flags(affiliate_id) WHERE status IN ('open','investigating');
-- One heuristic flag per (affiliate, order, signal): the scan is idempotent and cannot pile up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_flags_heuristic
  ON affiliate_fraud_flags(affiliate_id, order_id, signal) WHERE source = 'heuristic' AND order_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_aff_flags_updated_at') THEN
    CREATE TRIGGER set_aff_flags_updated_at BEFORE UPDATE ON affiliate_fraud_flags
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_fraud_flags_no_delete') THEN
    CREATE TRIGGER affiliate_fraud_flags_no_delete BEFORE DELETE ON affiliate_fraud_flags
      FOR EACH ROW EXECUTE FUNCTION affiliate_portal_forbid_mutation();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS affiliate_fraud_flag_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id       UUID        NOT NULL REFERENCES affiliate_fraud_flags(id) ON DELETE RESTRICT,
  affiliate_id  UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  action        TEXT        NOT NULL CHECK (action IN ('opened','note','status_change','freeze','unfreeze')),
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT        CHECK (note IS NULL OR LENGTH(note) <= 1000),
  actor_email   TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_afe_flag ON affiliate_fraud_flag_events(flag_id, created_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_fraud_flag_events_append_only') THEN
    CREATE TRIGGER affiliate_fraud_flag_events_append_only BEFORE UPDATE OR DELETE ON affiliate_fraud_flag_events
      FOR EACH ROW EXECUTE FUNCTION affiliate_portal_forbid_mutation();
  END IF;
END $$;

-- Normalises an email for self-referral matching: lowercase, strip +tag, strip dots for gmail. Used ONLY to
-- raise a review flag, never to decide anything.
CREATE OR REPLACE FUNCTION affiliate_match_email(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL OR POSITION('@' IN p) = 0 THEN NULL
    ELSE (
      WITH parts AS (
        SELECT LOWER(BTRIM(SPLIT_PART(p, '@', 1))) AS l, LOWER(BTRIM(SPLIT_PART(p, '@', 2))) AS d
      )
      SELECT CASE WHEN d IN ('gmail.com','googlemail.com')
                  THEN REPLACE(SPLIT_PART(l, '+', 1), '.', '') || '@gmail.com'
                  ELSE SPLIT_PART(l, '+', 1) || '@' || d END
      FROM parts)
  END
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- UGC RIGHTS — separate from affiliate status. Nothing in the system creates a license implicitly.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION affiliate_ugc_rights_ok(p JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL
     AND jsonb_typeof(p) = 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p) e
        WHERE e.key NOT IN ('organic','website','email','paid_ads','whitelisting','editing','likeness')
           OR jsonb_typeof(e.value) <> 'boolean')
     AND EXISTS (SELECT 1 FROM jsonb_each(p) e WHERE e.value = 'true'::jsonb)
$$;

CREATE TABLE IF NOT EXISTS affiliate_ugc_licenses (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id       UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  license_version    TEXT        NOT NULL CHECK (LENGTH(license_version) BETWEEN 1 AND 40),
  rights             JSONB       NOT NULL CHECK (affiliate_ugc_rights_ok(rights)),
  channels           TEXT[]      NOT NULL DEFAULT '{}',
  territory          TEXT        NOT NULL CHECK (LENGTH(territory) BETWEEN 2 AND 80),
  duration_months    INTEGER     CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 600),
  starts_at          TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ,
  compensation_note  TEXT        CHECK (compensation_note IS NULL OR LENGTH(compensation_note) <= 500),
  -- Where the signed agreement lives (a reference, never the file).
  evidence_ref       TEXT        CHECK (evidence_ref IS NULL OR LENGTH(evidence_ref) <= 200),
  granted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by         TEXT        NOT NULL,
  revoked_at         TIMESTAMPTZ,
  revoked_by         TEXT,
  revoke_reason      TEXT        CHECK (revoke_reason IS NULL OR LENGTH(revoke_reason) <= 300),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aul_expiry_after_start CHECK (expires_at IS NULL OR expires_at > starts_at),
  CONSTRAINT aul_revoked_consistent CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_aul_affiliate ON affiliate_ugc_licenses(affiliate_id, granted_at DESC);

CREATE OR REPLACE FUNCTION affiliate_ugc_license_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|APPEND_ONLY|DELETE on affiliate_ugc_licenses is not allowed';
  END IF;
  -- The grant is immutable evidence of what was agreed. Only a one-time revocation may be recorded.
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|LICENSE_FINAL|a revoked license cannot change';
  END IF;
  IF NEW.affiliate_id <> OLD.affiliate_id OR NEW.license_version <> OLD.license_version OR NEW.rights <> OLD.rights
     OR NEW.channels <> OLD.channels OR NEW.territory <> OLD.territory
     OR NEW.duration_months IS DISTINCT FROM OLD.duration_months OR NEW.starts_at <> OLD.starts_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.compensation_note IS DISTINCT FROM OLD.compensation_note
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref OR NEW.granted_at <> OLD.granted_at
     OR NEW.granted_by <> OLD.granted_by THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|LICENSE_IMMUTABLE|a license can only be revoked, not edited';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_ugc_license_guard_trg') THEN
    CREATE TRIGGER affiliate_ugc_license_guard_trg BEFORE UPDATE OR DELETE ON affiliate_ugc_licenses
      FOR EACH ROW EXECUTE FUNCTION affiliate_ugc_license_guard();
  END IF;
END $$;

-- Is a specific right currently granted? FALSE when no license exists — being an affiliate (or receiving
-- product) never implies a right.
CREATE OR REPLACE FUNCTION affiliate_ugc_right_active(
  p_affiliate_id UUID, p_right TEXT, p_at TIMESTAMPTZ DEFAULT NOW()
) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM affiliate_ugc_licenses l
     WHERE l.affiliate_id = p_affiliate_id
       AND (l.rights ->> p_right) = 'true'
       AND l.starts_at <= p_at
       AND (l.expires_at IS NULL OR l.expires_at > p_at)
       AND (l.revoked_at IS NULL OR l.revoked_at > p_at))
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- READINESS / ACCESS / COMPLIANCE ACTIONS (atomic with their audit rows)
-- All access to affiliate_profiles (migration 033) is guarded; the contract limits the columns written.
-- ═══════════════════════════════════════════════════════════════════════════

-- Set one readiness domain. Positive states (verified / complete / ready) may only be set by an Admin WITH a
-- written attestation note, or by the provider integration — never silently, never by the affiliate.
CREATE OR REPLACE FUNCTION set_affiliate_readiness(
  p_affiliate_id UUID, p_domain TEXT, p_status TEXT, p_source TEXT,
  p_actor TEXT, p_note TEXT, p_provider TEXT DEFAULT 'manual'
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_from TEXT; v_positive BOOLEAN; v_note TEXT := NULLIF(BTRIM(COALESCE(p_note,'')), '');
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|ACTOR_REQUIRED'; END IF;
  IF p_source NOT IN ('admin','provider','system') THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_SOURCE'; END IF;
  IF p_domain = 'kyc'            AND p_status NOT IN ('not_started','pending','verified','problem') THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_STATUS'; END IF;
  IF p_domain = 'tax'            AND p_status NOT IN ('not_started','pending','complete','problem')  THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_STATUS'; END IF;
  IF p_domain = 'payout_method'  AND p_status NOT IN ('not_started','pending','ready','failed')      THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_STATUS'; END IF;
  IF p_domain NOT IN ('kyc','tax','payout_method') THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_DOMAIN'; END IF;
  IF v_note IS NOT NULL AND LENGTH(v_note) > 300 THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|NOTE_TOO_LONG'; END IF;

  v_positive := p_status IN ('verified','complete','ready');
  IF v_positive AND p_source = 'system' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|POSITIVE_REQUIRES_ADMIN_OR_PROVIDER'; END IF;
  IF v_positive AND p_source = 'admin' AND (v_note IS NULL OR LENGTH(v_note) < 8) THEN
    RAISE EXCEPTION 'KVRN_AFFPORTAL|ATTESTATION_NOTE_REQUIRED';
  END IF;

  IF to_regclass('public.affiliate_profiles') IS NULL THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|PROFILE_UNAVAILABLE'; END IF;

  IF p_domain = 'kyc' THEN
    SELECT kyc_status INTO v_from FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  ELSIF p_domain = 'tax' THEN
    SELECT tax_status INTO v_from FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  ELSE
    SELECT payout_method_status INTO v_from FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|PROFILE_NOT_FOUND'; END IF;
  IF v_from = p_status THEN
    RETURN jsonb_build_object('outcome','unchanged','domain',p_domain,'status',p_status);
  END IF;

  IF p_domain = 'kyc' THEN
    UPDATE affiliate_profiles SET kyc_status = p_status, updated_at = NOW() WHERE affiliate_id = p_affiliate_id;
    UPDATE affiliate_payout_accounts SET kyc_status = p_status, last_synced_at = NOW()
     WHERE affiliate_id = p_affiliate_id AND provider = p_provider;
  ELSIF p_domain = 'tax' THEN
    UPDATE affiliate_profiles SET tax_status = p_status, updated_at = NOW() WHERE affiliate_id = p_affiliate_id;
    UPDATE affiliate_payout_accounts SET tax_status = p_status, last_synced_at = NOW()
     WHERE affiliate_id = p_affiliate_id AND provider = p_provider;
  ELSE
    UPDATE affiliate_profiles SET payout_method_status = p_status, updated_at = NOW() WHERE affiliate_id = p_affiliate_id;
    UPDATE affiliate_payout_accounts SET payout_method_status = p_status, last_synced_at = NOW()
     WHERE affiliate_id = p_affiliate_id AND provider = p_provider;
  END IF;

  INSERT INTO affiliate_readiness_events (affiliate_id, domain, from_status, to_status, source, actor_email, note)
  VALUES (p_affiliate_id, p_domain, v_from, p_status, p_source, p_actor, v_note);

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.readiness_' || p_domain, 'affiliates', p_affiliate_id::text,
          jsonb_build_object('from', v_from, 'to', p_status, 'source', p_source));

  RETURN jsonb_build_object('outcome','updated','domain',p_domain,'from',v_from,'to',p_status);
END;
$$;

-- Register / update the provider account REFERENCE and masked display metadata (never raw details).
CREATE OR REPLACE FUNCTION set_affiliate_payout_account(
  p_affiliate_id UUID, p_provider TEXT, p_ref TEXT, p_masked JSONB, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|ACTOR_REQUIRED'; END IF;
  IF p_provider NOT IN ('manual','stripe_connect') THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_PROVIDER'; END IF;
  PERFORM 1 FROM affiliates WHERE id = p_affiliate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|AFFILIATE_NOT_FOUND'; END IF;

  INSERT INTO affiliate_payout_accounts (affiliate_id, provider, provider_account_ref, masked_metadata)
  VALUES (p_affiliate_id, p_provider, NULLIF(BTRIM(p_ref),''), COALESCE(p_masked,'{}'::jsonb))
  ON CONFLICT (affiliate_id, provider) DO UPDATE
     SET provider_account_ref = NULLIF(BTRIM(p_ref),''),
         masked_metadata = COALESCE(p_masked, affiliate_payout_accounts.masked_metadata),
         updated_at = NOW()
  RETURNING id INTO v_id;

  IF to_regclass('public.affiliate_profiles') IS NOT NULL THEN
    UPDATE affiliate_profiles
       SET payout_provider = p_provider, payout_provider_ref = NULLIF(BTRIM(p_ref),''), updated_at = NOW()
     WHERE affiliate_id = p_affiliate_id;
  END IF;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.payout_account_set', 'affiliates', p_affiliate_id::text,
          jsonb_build_object('provider', p_provider, 'has_ref', NULLIF(BTRIM(p_ref),'') IS NOT NULL));
  RETURN jsonb_build_object('outcome','saved','account_id',v_id);
END;
$$;

-- Portal access: enabled / read_only / revoked. Revoked ends every live session immediately.
CREATE OR REPLACE FUNCTION set_affiliate_portal_access(
  p_affiliate_id UUID, p_access TEXT, p_reason TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_from TEXT;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|ACTOR_REQUIRED'; END IF;
  IF p_access NOT IN ('enabled','read_only','revoked') THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_ACCESS'; END IF;
  IF to_regclass('public.affiliate_profiles') IS NULL THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|PROFILE_UNAVAILABLE'; END IF;
  SELECT portal_access INTO v_from FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|PROFILE_NOT_FOUND'; END IF;
  IF v_from = p_access THEN RETURN jsonb_build_object('outcome','unchanged','access',p_access); END IF;

  UPDATE affiliate_profiles SET portal_access = p_access, updated_at = NOW() WHERE affiliate_id = p_affiliate_id;
  INSERT INTO affiliate_security_events (affiliate_id, event_type, detail)
  VALUES (p_affiliate_id, 'access_changed', jsonb_build_object('from', v_from, 'to', p_access));
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.portal_access', 'affiliates', p_affiliate_id::text,
          jsonb_build_object('from', v_from, 'to', p_access, 'reason', LEFT(COALESCE(p_reason,''), 200)));
  IF p_access = 'revoked' THEN
    PERFORM revoke_affiliate_sessions(p_affiliate_id, 'portal_access_revoked', p_actor);
  END IF;
  RETURN jsonb_build_object('outcome','updated','from',v_from,'to',p_access);
END;
$$;

-- Paid-ad permission lives on the profile (contract) and is written ONLY through here.
CREATE OR REPLACE FUNCTION set_affiliate_paid_ads_policy(
  p_affiliate_id UUID, p_policy TEXT, p_note TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_from TEXT;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|ACTOR_REQUIRED'; END IF;
  IF p_policy NOT IN ('not_permitted','written_approval','approved') THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|BAD_POLICY'; END IF;
  IF to_regclass('public.affiliate_profiles') IS NULL THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|PROFILE_UNAVAILABLE'; END IF;
  SELECT paid_ads_policy INTO v_from FROM affiliate_profiles WHERE affiliate_id = p_affiliate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|PROFILE_NOT_FOUND'; END IF;
  IF v_from = p_policy THEN RETURN jsonb_build_object('outcome','unchanged','policy',p_policy); END IF;
  UPDATE affiliate_profiles SET paid_ads_policy = p_policy, updated_at = NOW() WHERE affiliate_id = p_affiliate_id;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.paid_ads_policy', 'affiliates', p_affiliate_id::text,
          jsonb_build_object('from', v_from, 'to', p_policy, 'note', LEFT(COALESCE(p_note,''), 200)));
  RETURN jsonb_build_object('outcome','updated','from',v_from,'to',p_policy);
END;
$$;

-- Compliance suspension: uses the EXISTING canonical set_affiliate_status() (code stops qualifying NEW activity
-- from now; history is untouched), mirrors program_status on the profile when 033 is present, and ends live
-- sessions. The portal then opens read-only; p_revoke_portal additionally blocks login (fraud / security).
CREATE OR REPLACE FUNCTION suspend_affiliate_for_compliance(
  p_affiliate_id UUID, p_reason TEXT, p_revoke_portal BOOLEAN, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_status TEXT; v_res JSONB;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|ACTOR_REQUIRED'; END IF;
  IF p_reason IS NULL OR LENGTH(BTRIM(p_reason)) < 5 THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|REASON_REQUIRED'; END IF;
  SELECT status INTO v_status FROM affiliates WHERE id = p_affiliate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|AFFILIATE_NOT_FOUND'; END IF;
  IF v_status = 'terminated' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|ALREADY_TERMINATED'; END IF;

  IF v_status <> 'paused' THEN
    v_res := set_affiliate_status(p_affiliate_id, 'paused', NULL, LEFT(p_reason, 200), p_actor);
    IF COALESCE(v_res ->> 'outcome','') <> 'updated' THEN RAISE EXCEPTION 'KVRN_AFFPORTAL|STATUS_NOT_UPDATED'; END IF;
  END IF;

  IF to_regclass('public.affiliate_profiles') IS NOT NULL THEN
    UPDATE affiliate_profiles
       SET program_status = 'suspended', suspended_at = COALESCE(suspended_at, NOW()), updated_at = NOW()
     WHERE affiliate_id = p_affiliate_id AND program_status <> 'terminated';
    IF p_revoke_portal THEN
      UPDATE affiliate_profiles SET portal_access = 'revoked', updated_at = NOW() WHERE affiliate_id = p_affiliate_id;
    END IF;
    -- A suspended affiliate's customer discount and referral links are switched off like on every other
    -- suspension path (migration 033 helper; remembers what to restore on reinstatement).
    IF to_regprocedure('affiliate_disable_code(uuid)') IS NOT NULL THEN
      EXECUTE 'SELECT affiliate_disable_code($1)' USING p_affiliate_id;
    END IF;
  END IF;

  PERFORM revoke_affiliate_sessions(p_affiliate_id, 'suspended', p_actor);
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.suspend', 'affiliates', p_affiliate_id::text,
          jsonb_build_object('revoke_portal', COALESCE(p_revoke_portal, FALSE), 'already_paused', v_status = 'paused'));
  RETURN jsonb_build_object('outcome', CASE WHEN v_status = 'paused' THEN 'already_suspended' ELSE 'suspended' END);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- BALANCES — one place for the affiliate-facing money buckets. NO new money math: every figure is a sum of
-- the existing append-only ledger, the existing payable function, or payout lines.
-- ═══════════════════════════════════════════════════════════════════════════
--   earned        initial accruals                         (positive)
--   reversed      refund / dispute reversals               (positive number = amount taken back)
--   restored      later positive corrections / dispute wins
--   pending       net ledger of commissions still inside their hold window and complete
--   unresolved    net ledger of commissions flagged incomplete (value NOT yet certain — never shown as zero)
--   available     SUM(affiliate_commission_payable) over approved/paid, complete commissions
--   in_payout     amounts reserved by DRAFT payouts
--   paid          amounts on PAID payouts
--   recovered     cash collected back after an overpayment
--   owed_back     overpayment still outstanding (cash paid minus ledger earned, less recovered)
-- Volatile: it first promotes anything past its hold window, exactly as the existing payable read path does.
CREATE OR REPLACE FUNCTION affiliate_portal_balances(p_affiliate_id UUID)
RETURNS TABLE (
  earned_cents BIGINT, reversed_cents BIGINT, restored_cents BIGINT,
  pending_cents BIGINT, unresolved_cents BIGINT, available_cents BIGINT,
  in_payout_cents BIGINT, paid_cents BIGINT, recovered_cents BIGINT, owed_back_cents BIGINT,
  incomplete_count INTEGER
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM promote_eligible_commissions_for_affiliate(p_affiliate_id);
  RETURN QUERY
  SELECT
    COALESCE((SELECT SUM(a.adjustment_cents) FROM affiliate_commission_adjustments a
               WHERE a.affiliate_id = p_affiliate_id AND a.reason = 'initial_accrual'),0)::bigint,
    COALESCE((SELECT -SUM(a.adjustment_cents) FROM affiliate_commission_adjustments a
               WHERE a.affiliate_id = p_affiliate_id AND a.adjustment_cents < 0),0)::bigint,
    COALESCE((SELECT SUM(a.adjustment_cents) FROM affiliate_commission_adjustments a
               WHERE a.affiliate_id = p_affiliate_id AND a.adjustment_cents > 0 AND a.reason <> 'initial_accrual'),0)::bigint,
    COALESCE((SELECT SUM(l.net) FROM (
                SELECT c.id, (SELECT COALESCE(SUM(a.adjustment_cents),0) FROM affiliate_commission_adjustments a WHERE a.commission_id = c.id) AS net
                  FROM affiliate_commissions c
                 WHERE c.affiliate_id = p_affiliate_id AND c.status = 'pending' AND NOT c.incomplete) l),0)::bigint,
    COALESCE((SELECT SUM(l.net) FROM (
                SELECT c.id, (SELECT COALESCE(SUM(a.adjustment_cents),0) FROM affiliate_commission_adjustments a WHERE a.commission_id = c.id) AS net
                  FROM affiliate_commissions c
                 WHERE c.affiliate_id = p_affiliate_id AND c.incomplete) l),0)::bigint,
    COALESCE((SELECT SUM(affiliate_commission_payable(c.id)) FROM affiliate_commissions c
               WHERE c.affiliate_id = p_affiliate_id AND c.status IN ('approved','paid') AND NOT c.incomplete),0)::bigint,
    COALESCE((SELECT SUM(pl.amount_cents) FROM affiliate_payout_lines pl JOIN affiliate_payouts p ON p.id = pl.payout_id
               WHERE p.affiliate_id = p_affiliate_id AND p.status = 'draft'),0)::bigint,
    COALESCE((SELECT SUM(pl.amount_cents) FROM affiliate_payout_lines pl JOIN affiliate_payouts p ON p.id = pl.payout_id
               WHERE p.affiliate_id = p_affiliate_id AND p.status = 'paid'),0)::bigint,
    COALESCE((SELECT SUM(a.recovered_cents) FROM affiliate_commission_adjustments a WHERE a.affiliate_id = p_affiliate_id),0)::bigint,
    COALESCE((SELECT SUM(affiliate_commission_overpaid(c.id)) FROM affiliate_commissions c WHERE c.affiliate_id = p_affiliate_id),0)::bigint,
    (SELECT COUNT(*)::int FROM affiliate_commissions c WHERE c.affiliate_id = p_affiliate_id AND c.incomplete);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PAYOUT STATEMENT — reproduces each line's amount from the ledger AS IT STOOD when the payout was created
-- ═══════════════════════════════════════════════════════════════════════════
--   line = earned + adjustments - previously_paid_on_other_payouts + recovered_cash
-- which is exactly affiliate_commission_payable() evaluated at the payout's creation instant. `reconciled` is
-- TRUE only when that reproduction equals the stored line amount; otherwise the statement is flagged (never
-- silently "fixed").
CREATE OR REPLACE FUNCTION affiliate_payout_statement(p_payout_id UUID)
RETURNS TABLE (
  commission_id UUID, line_amount_cents INTEGER,
  earned_cents INTEGER, adjustments_cents INTEGER, previously_paid_cents INTEGER, recovered_cents INTEGER,
  computed_net_cents INTEGER, reconciled BOOLEAN
)
LANGUAGE sql STABLE AS $$
  WITH p AS (SELECT id, created_at FROM affiliate_payouts WHERE id = p_payout_id),
  x AS (
    SELECT l.commission_id, l.amount_cents AS line_amount,
      COALESCE((SELECT SUM(a.adjustment_cents) FROM affiliate_commission_adjustments a, p
                 WHERE a.commission_id = l.commission_id AND a.reason = 'initial_accrual' AND a.created_at <= p.created_at),0)::int AS earned,
      COALESCE((SELECT SUM(a.adjustment_cents) FROM affiliate_commission_adjustments a, p
                 WHERE a.commission_id = l.commission_id AND a.reason <> 'initial_accrual' AND a.created_at <= p.created_at),0)::int AS adj,
      COALESCE((SELECT SUM(l2.amount_cents) FROM affiliate_payout_lines l2
                  JOIN affiliate_payouts p2 ON p2.id = l2.payout_id, p
                 WHERE l2.commission_id = l.commission_id AND p2.id <> p.id AND p2.created_at < p.created_at
                   AND (p2.status <> 'void' OR p2.updated_at > p.created_at)),0)::int AS prev,
      COALESCE((SELECT SUM(a.recovered_cents) FROM affiliate_commission_adjustments a, p
                 WHERE a.commission_id = l.commission_id AND a.created_at <= p.created_at),0)::int AS rec
    FROM affiliate_payout_lines l
    WHERE l.payout_id = p_payout_id
  )
  SELECT x.commission_id, x.line_amount, x.earned, x.adj, x.prev, x.rec,
         (x.earned + x.adj - x.prev + x.rec) AS net,
         (x.earned + x.adj - x.prev + x.rec) = x.line_amount
  FROM x ORDER BY x.commission_id;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PAYOUT ATTEMPTS — record / complete. The existing mark_affiliate_payout_paid() is CALLED, never modified.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION affiliate_record_payout_attempt(
  p_payout_id UUID, p_idempotency_key TEXT, p_provider TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_aff UUID; v_pstatus TEXT;
  v_dup_id UUID; v_dup_status TEXT; v_dup_no INTEGER;
  v_last_id UUID; v_last_status TEXT; v_last_no INTEGER;
  v_no INTEGER; v_id UUID;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_PAYOUT|ACTOR_REQUIRED'; END IF;
  SELECT affiliate_id, status INTO v_aff, v_pstatus FROM affiliate_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_PAYOUT|NOT_FOUND|%', p_payout_id; END IF;
  IF v_pstatus <> 'draft' THEN RAISE EXCEPTION 'KVRN_PAYOUT|NOT_DRAFT|%', v_pstatus; END IF;

  -- Scalars, not a RECORD: a field of an unassigned RECORD raises even on a branch that would not use it.
  SELECT id, status, attempt_no INTO v_dup_id, v_dup_status, v_dup_no FROM affiliate_payout_attempts
   WHERE payout_id = p_payout_id AND idempotency_key = p_idempotency_key;
  IF v_dup_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','already_recorded','attempt_id',v_dup_id,'status',v_dup_status,'attempt_no',v_dup_no);
  END IF;

  SELECT id, status, attempt_no INTO v_last_id, v_last_status, v_last_no FROM affiliate_payout_attempts
   WHERE payout_id = p_payout_id ORDER BY attempt_no DESC LIMIT 1;
  IF v_last_status = 'initiated' THEN
    RETURN jsonb_build_object('outcome','attempt_in_flight','attempt_id',v_last_id,'status',v_last_status,'attempt_no',v_last_no);
  END IF;
  IF v_last_status = 'succeeded' THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|ATTEMPT_ALREADY_SUCCEEDED';
  END IF;

  v_no := COALESCE(v_last_no, 0) + 1;
  INSERT INTO affiliate_payout_attempts (payout_id, affiliate_id, attempt_no, provider, idempotency_key, created_by)
  VALUES (p_payout_id, v_aff, v_no, p_provider, p_idempotency_key, p_actor)
  RETURNING id INTO v_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'affiliate.payout_attempt', 'affiliate_payouts', p_payout_id::text,
          jsonb_build_object('attempt_no', v_no, 'provider', p_provider));
  RETURN jsonb_build_object('outcome','recorded','attempt_id',v_id,'attempt_no',v_no,'status','initiated');
END;
$$;

CREATE OR REPLACE FUNCTION affiliate_complete_payout_attempt(
  p_attempt_id UUID, p_outcome TEXT, p_reference TEXT, p_failure_code TEXT, p_failure_note TEXT,
  p_paid_at TIMESTAMPTZ, p_method TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE a RECORD; v_ref TEXT; v_amount INTEGER;
BEGIN
  IF p_actor IS NULL OR BTRIM(p_actor) = '' THEN RAISE EXCEPTION 'KVRN_PAYOUT|ACTOR_REQUIRED'; END IF;
  IF p_outcome NOT IN ('succeeded','failed') THEN RAISE EXCEPTION 'KVRN_PAYOUT|BAD_OUTCOME'; END IF;
  SELECT * INTO a FROM affiliate_payout_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_PAYOUT|ATTEMPT_NOT_FOUND'; END IF;

  IF a.status <> 'initiated' THEN
    IF a.status = p_outcome THEN
      RETURN jsonb_build_object('outcome','already_completed','status',a.status,'attempt_id',a.id);
    END IF;
    RAISE EXCEPTION 'KVRN_PAYOUT|ATTEMPT_ALREADY_COMPLETED|%', a.status;
  END IF;

  SELECT amount_cents INTO v_amount FROM affiliate_payouts WHERE id = a.payout_id;

  IF p_outcome = 'failed' THEN
    UPDATE affiliate_payout_attempts
       SET status = 'failed', failure_code = LEFT(NULLIF(BTRIM(COALESCE(p_failure_code,'')),''), 60),
           failure_note = LEFT(NULLIF(BTRIM(COALESCE(p_failure_note,'')),''), 300), completed_at = NOW()
     WHERE id = a.id;
    INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
    VALUES (p_actor, 'affiliate.payout_failed', 'affiliate_payouts', a.payout_id::text,
            jsonb_build_object('attempt_no', a.attempt_no, 'failure_code', LEFT(COALESCE(p_failure_code,''), 60)));
    v_ref := affiliate_public_ref('payout', a.payout_id, a.affiliate_id);
    INSERT INTO affiliate_portal_notifications (affiliate_id, kind, dedupe_key, payload)
    VALUES (a.affiliate_id, 'payout_failed', 'payout_failed:' || a.id::text,
            jsonb_build_object('payout_ref', v_ref, 'amount_cents', v_amount))
    ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN jsonb_build_object('outcome','failed','attempt_id',a.id,'payout_id',a.payout_id);
  END IF;

  -- Succeeded: record the cash event through the EXISTING function (it audits and is idempotent).
  PERFORM mark_affiliate_payout_paid(a.payout_id, p_paid_at, p_method, p_reference, p_actor);
  UPDATE affiliate_payout_attempts
     SET status = 'succeeded', provider_reference = LEFT(NULLIF(BTRIM(COALESCE(p_reference,'')),''), 120), completed_at = NOW()
   WHERE id = a.id;
  v_ref := affiliate_public_ref('payout', a.payout_id, a.affiliate_id);
  INSERT INTO affiliate_portal_notifications (affiliate_id, kind, dedupe_key, payload)
  VALUES (a.affiliate_id, 'payout_sent', 'payout_sent:' || a.payout_id::text,
          jsonb_build_object('payout_ref', v_ref, 'amount_cents', v_amount))
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN jsonb_build_object('outcome','paid','attempt_id',a.id,'payout_id',a.payout_id);
END;
$$;

COMMIT;
