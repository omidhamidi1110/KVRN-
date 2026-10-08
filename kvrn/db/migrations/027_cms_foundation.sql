-- KVRN Migration 027 — CMS foundation (shared tables)
--
-- Additive only. Nothing in 001–026 is altered, dropped or replaced.
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, guarded constraints. Safe to re-run.
-- Run after 001–026. NOT applied to production by the implementation batch.
--
-- WHAT THIS IS
-- ------------
-- The small set of generic tables that every Admin-managed public-content feature
-- shares, so Product Editor, policies, size guides, FAQ, pages, navigation, footer,
-- announcement bar, collections, SEO and the Media Library do not each invent a
-- private draft/version/translation/media/redirect mechanism:
--
--   media_assets / media_usages     R2-backed Media Library (Neon stores metadata ONLY)
--   content_entities                one head row per editable thing: status + revision
--   content_versions                immutable snapshots for draft / publish / rollback
--   content_translations            per-field translations with a completeness status
--   site_settings                   small keyed JSON settings (global SEO, locales, ...)
--   content_redirects               published-slug redirects (old path -> new path)
--   cache_invalidations             visible, retryable post-commit cache invalidation log
--   collections / collection_products   basic collections and their ordered products
--
-- WHAT THIS IS NOT
-- ----------------
-- It does NOT hold commerce truth. SKU, inventory, price, weight/dimensions and COGS
-- stay in products / product_variants / inventory_* exactly as before. CMS rows only
-- ever REFERENCE canonical commerce rows; they never copy or override them.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- MEDIA LIBRARY
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per distinct binary. sha256 is UNIQUE so re-uploading the same file reuses
-- the existing asset instead of duplicating the object ("do not duplicate the binary
-- simply because it is reused"). The object itself lives in R2 under storage_key.
CREATE TABLE IF NOT EXISTS media_assets (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key  TEXT        NOT NULL,
  sha256       TEXT        NOT NULL,
  mime_type    TEXT        NOT NULL,
  byte_size    INTEGER     NOT NULL CHECK (byte_size > 0),
  width        INTEGER     CHECK (width  IS NULL OR width  > 0),
  height       INTEGER     CHECK (height IS NULL OR height > 0),
  -- Pre-generated responsive renditions: [{"width":480,"storage_key":"...","mime_type":"image/webp","byte_size":123}]
  variants     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  filename     TEXT        NOT NULL,
  alt_text     TEXT,
  title        TEXT,
  caption      TEXT,
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  status       TEXT        NOT NULL DEFAULT 'active',
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at  TIMESTAMPTZ,
  CONSTRAINT media_assets_storage_key_uq UNIQUE (storage_key),
  CONSTRAINT media_assets_sha256_uq      UNIQUE (sha256),
  CONSTRAINT media_assets_sha256_fmt     CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT media_assets_status_chk     CHECK (status IN ('active','archived')),
  -- Raster images only. SVG is deliberately excluded (script-bearing format).
  CONSTRAINT media_assets_mime_chk       CHECK (mime_type IN ('image/webp','image/jpeg','image/png','image/avif','image/gif'))
);
CREATE INDEX IF NOT EXISTS idx_media_assets_status  ON media_assets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_assets_tags    ON media_assets USING GIN (tags);

-- Where each asset is referenced, so destructive actions can show usage first and
-- archive/unlink is preferred over unsafe hard deletion. scope separates what a draft
-- references from what the published version references.
CREATE TABLE IF NOT EXISTS media_usages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID        NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  owner_type  TEXT        NOT NULL,
  owner_id    TEXT        NOT NULL,
  slot        TEXT        NOT NULL,
  scope       TEXT        NOT NULL DEFAULT 'published',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_usages_scope_chk CHECK (scope IN ('draft','published')),
  CONSTRAINT media_usages_uq UNIQUE (asset_id, owner_type, owner_id, slot, scope)
);
CREATE INDEX IF NOT EXISTS idx_media_usages_owner ON media_usages(owner_type, owner_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTENT ENTITIES + VERSIONS (draft / preview / publish / rollback)
-- ═══════════════════════════════════════════════════════════════════════════
-- content_entities is the HEAD: which version is the working draft, which one is live,
-- and a monotonically increasing `revision` used for stale-edit protection (a save must
-- present the revision it loaded; a mismatch is a conflict, never a silent overwrite).
CREATE TABLE IF NOT EXISTS content_entities (
  entity_type          TEXT        NOT NULL,
  entity_id            TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'draft',
  slug                 TEXT,
  draft_version_no     INTEGER,
  published_version_no INTEGER,
  revision             INTEGER     NOT NULL DEFAULT 0 CHECK (revision >= 0),
  publish_at           TIMESTAMPTZ,
  unpublish_at         TIMESTAMPTZ,
  published_at         TIMESTAMPTZ,
  archived_at          TIMESTAMPTZ,
  created_by           TEXT,
  updated_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_type, entity_id),
  CONSTRAINT content_entities_status_chk
    CHECK (status IN ('draft','published','scheduled','unpublished','archived'))
);
-- A live slug is unique within its entity type (case-insensitive). Drafts may reuse a
-- slug until they publish, so only published/scheduled heads are constrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_entities_live_slug
  ON content_entities (entity_type, lower(slug))
  WHERE slug IS NOT NULL AND status IN ('published','scheduled');
CREATE INDEX IF NOT EXISTS idx_content_entities_status ON content_entities(entity_type, status);
CREATE INDEX IF NOT EXISTS idx_content_entities_sched
  ON content_entities(publish_at, unpublish_at) WHERE status IN ('scheduled','published');

-- Immutable snapshots. A version is NEVER edited after it is published or superseded;
-- rollback copies an older snapshot into a NEW version and publishes that, so history
-- is append-only and the audit trail stays truthful.
CREATE TABLE IF NOT EXISTS content_versions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT        NOT NULL,
  entity_id     TEXT        NOT NULL,
  version_no    INTEGER     NOT NULL CHECK (version_no >= 1),
  state         TEXT        NOT NULL DEFAULT 'draft',
  snapshot      JSONB       NOT NULL,
  change_note   TEXT,
  rolled_back_from INTEGER,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by  TEXT,
  published_at  TIMESTAMPTZ,
  CONSTRAINT content_versions_uq    UNIQUE (entity_type, entity_id, version_no),
  CONSTRAINT content_versions_state_chk CHECK (state IN ('draft','published','superseded')),
  CONSTRAINT content_versions_entity_fk
    FOREIGN KEY (entity_type, entity_id) REFERENCES content_entities(entity_type, entity_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_content_versions_entity
  ON content_versions(entity_type, entity_id, version_no DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- TRANSLATIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per (entity, locale, field). Canonical commerce facts (SKU, inventory, price,
-- weight/dimensions, COGS) are never translated here. source_hash records the hash of
-- the source-language text the translation was written against so Admin can flag a
-- translation as STALE when the source later changes. Legal/policy translations are only
-- ever 'published' by a deliberate Admin action; machine_generated rows can never be
-- 'published' (enforced below).
CREATE TABLE IF NOT EXISTS content_translations (
  entity_type        TEXT        NOT NULL,
  entity_id          TEXT        NOT NULL,
  locale             TEXT        NOT NULL,
  field              TEXT        NOT NULL,
  value              TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'draft',
  source_hash        TEXT,
  machine_generated  BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_by         TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at       TIMESTAMPTZ,
  PRIMARY KEY (entity_type, entity_id, locale, field),
  CONSTRAINT content_translations_locale_chk CHECK (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  CONSTRAINT content_translations_status_chk CHECK (status IN ('draft','needs_review','published')),
  CONSTRAINT content_translations_no_machine_publish
    CHECK (NOT (machine_generated AND status = 'published'))
);
CREATE INDEX IF NOT EXISTS idx_content_translations_locale
  ON content_translations(locale, entity_type, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- SITE SETTINGS (small keyed JSON; global SEO, locale config, program settings ...)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS site_settings (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  revision    INTEGER     NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_settings_key_fmt CHECK (key ~ '^[a-z0-9_.-]{1,80}$')
);

-- ═══════════════════════════════════════════════════════════════════════════
-- REDIRECTS (published-slug changes)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_redirects (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_path    TEXT        NOT NULL,
  to_path      TEXT        NOT NULL,
  status_code  INTEGER     NOT NULL DEFAULT 301,
  entity_type  TEXT,
  entity_id    TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT content_redirects_from_uq UNIQUE (from_path),
  CONSTRAINT content_redirects_code_chk CHECK (status_code IN (301,302,307,308)),
  CONSTRAINT content_redirects_paths_chk
    CHECK (from_path LIKE '/%' AND to_path LIKE '/%' AND from_path <> to_path
           AND from_path NOT LIKE '//%' AND to_path NOT LIKE '//%')
);
CREATE INDEX IF NOT EXISTS idx_content_redirects_entity ON content_redirects(entity_type, entity_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- CACHE INVALIDATION LOG
-- ═══════════════════════════════════════════════════════════════════════════
-- Written AFTER the authoritative transaction commits. A failed invalidation stays
-- 'failed' (visible in Admin, retryable) — the site is never silently claimed current.
CREATE TABLE IF NOT EXISTS cache_invalidations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reason        TEXT        NOT NULL,
  paths         TEXT[]      NOT NULL DEFAULT '{}',
  tags          TEXT[]      NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'pending',
  attempts      INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    TEXT,
  requested_by  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  CONSTRAINT cache_invalidations_status_chk CHECK (status IN ('pending','done','failed'))
);
CREATE INDEX IF NOT EXISTS idx_cache_invalidations_open
  ON cache_invalidations(created_at) WHERE status <> 'done';

-- ═══════════════════════════════════════════════════════════════════════════
-- COLLECTIONS (basic). Content fields live here; translations via content_translations
-- (entity_type = 'collection'). Products are only REFERENCED, never copied.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS collections (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  description   TEXT,
  hero_media_id UUID        REFERENCES media_assets(id) ON DELETE SET NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  seo           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at   TIMESTAMPTZ,
  CONSTRAINT collections_slug_fmt CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT collections_slug_uq  UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS collection_products (
  collection_id UUID        NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  product_id    UUID        NOT NULL REFERENCES products(id)    ON DELETE CASCADE,
  position      INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_products_product ON collection_products(product_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_media_assets_updated_at') THEN
    CREATE TRIGGER set_media_assets_updated_at BEFORE UPDATE ON media_assets
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_content_entities_updated_at') THEN
    CREATE TRIGGER set_content_entities_updated_at BEFORE UPDATE ON content_entities
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_site_settings_updated_at') THEN
    CREATE TRIGGER set_site_settings_updated_at BEFORE UPDATE ON site_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_collections_updated_at') THEN
    CREATE TRIGGER set_collections_updated_at BEFORE UPDATE ON collections
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Published/superseded versions are immutable: the only permitted UPDATE of a
-- non-draft version is the draft→published / published→superseded state change.
CREATE OR REPLACE FUNCTION content_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'CONTENT_VERSION_IMMUTABLE|%|%', OLD.entity_type, OLD.entity_id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state <> 'draft'
     AND (NEW.snapshot IS DISTINCT FROM OLD.snapshot
          OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
          OR NEW.entity_id   IS DISTINCT FROM OLD.entity_id
          OR NEW.version_no  IS DISTINCT FROM OLD.version_no) THEN
    RAISE EXCEPTION 'CONTENT_VERSION_IMMUTABLE|%|%', OLD.entity_type, OLD.entity_id;
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_versions_immutable_trg') THEN
    CREATE TRIGGER content_versions_immutable_trg
      BEFORE UPDATE OR DELETE ON content_versions
      FOR EACH ROW EXECUTE FUNCTION content_versions_immutable();
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- CMS LIFECYCLE FUNCTIONS (atomic: one statement = one transaction on Neon HTTP)
-- ═══════════════════════════════════════════════════════════════════════════
-- Error vocabulary (RAISE EXCEPTION 'CODE|a|b'): CMS_INVALID, CMS_STALE_REVISION,
-- CMS_NOT_FOUND, CMS_NO_DRAFT, CMS_ARCHIVED, CMS_SLUG_TAKEN, CMS_BAD_SCHEDULE.
-- Draft saves are not audited (autosave would flood the log); every lifecycle change
-- (publish, unpublish, rollback, schedule, archive, restore) writes admin_audit_logs
-- in the SAME transaction as the change itself.

CREATE OR REPLACE FUNCTION cms_audit(p_actor TEXT, p_action TEXT, p_type TEXT, p_id TEXT, p_payload JSONB)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (COALESCE(NULLIF(p_actor,''),'system@kvrn.internal'), p_action, p_type, p_id, p_payload);
$$;

CREATE OR REPLACE FUNCTION cms_save_draft(
  p_type TEXT, p_id TEXT, p_snapshot JSONB, p_expected_revision INTEGER,
  p_actor TEXT, p_note TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_e   content_entities%ROWTYPE;
  v_ver INTEGER;
BEGIN
  IF p_type IS NULL OR p_type = '' OR p_id IS NULL OR p_id = '' THEN
    RAISE EXCEPTION 'CMS_INVALID|KEY';
  END IF;
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'CMS_INVALID|SNAPSHOT';
  END IF;

  SELECT * INTO v_e FROM content_entities
   WHERE entity_type = p_type AND entity_id = p_id FOR UPDATE;

  IF NOT FOUND THEN
    IF COALESCE(p_expected_revision, 0) <> 0 THEN
      RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;
    END IF;
    BEGIN
      INSERT INTO content_entities (entity_type, entity_id, status, draft_version_no, revision, created_by, updated_by)
      VALUES (p_type, p_id, 'draft', 1, 1, p_actor, p_actor);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;   -- lost a create race
    END;
    INSERT INTO content_versions (entity_type, entity_id, version_no, state, snapshot, change_note, created_by)
    VALUES (p_type, p_id, 1, 'draft', p_snapshot, p_note, p_actor);
    RETURN jsonb_build_object('version_no', 1, 'revision', 1, 'created', TRUE);
  END IF;

  IF v_e.status = 'archived' THEN RAISE EXCEPTION 'CMS_ARCHIVED|%|%', p_type, p_id; END IF;
  IF p_expected_revision IS DISTINCT FROM v_e.revision THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;
  END IF;

  IF v_e.draft_version_no IS NOT NULL THEN
    -- Autosave: the open draft is the only mutable version.
    UPDATE content_versions
       SET snapshot = p_snapshot, change_note = COALESCE(p_note, change_note)
     WHERE entity_type = p_type AND entity_id = p_id
       AND version_no = v_e.draft_version_no AND state = 'draft';
    v_ver := v_e.draft_version_no;
  ELSE
    SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_ver
      FROM content_versions WHERE entity_type = p_type AND entity_id = p_id;
    INSERT INTO content_versions (entity_type, entity_id, version_no, state, snapshot, change_note, created_by)
    VALUES (p_type, p_id, v_ver, 'draft', p_snapshot, p_note, p_actor);
  END IF;

  UPDATE content_entities
     SET draft_version_no = v_ver, revision = revision + 1, updated_by = p_actor
   WHERE entity_type = p_type AND entity_id = p_id;

  RETURN jsonb_build_object('version_no', v_ver, 'revision', v_e.revision + 1, 'created', FALSE);
END $$;

-- Internal: make version p_ver the live one. Caller holds the entity row lock.
CREATE OR REPLACE FUNCTION cms__go_live(
  p_e content_entities, p_ver INTEGER, p_actor TEXT, p_path_prefix TEXT, p_action TEXT, p_rolled_from INTEGER
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_snap     JSONB;
  v_new_slug TEXT;
  v_old_slug TEXT := CASE WHEN p_e.status IN ('published','scheduled','unpublished') THEN p_e.slug ELSE NULL END;
  v_redirect BOOLEAN := FALSE;
BEGIN
  SELECT snapshot INTO v_snap FROM content_versions
   WHERE entity_type = p_e.entity_type AND entity_id = p_e.entity_id AND version_no = p_ver;
  v_new_slug := NULLIF(lower(btrim(v_snap->>'slug')), '');

  IF p_path_prefix IS NOT NULL AND v_new_slug IS NULL THEN
    RAISE EXCEPTION 'CMS_INVALID|SLUG_REQUIRED';
  END IF;

  -- Supersede whatever is live now.
  UPDATE content_versions SET state = 'superseded'
   WHERE entity_type = p_e.entity_type AND entity_id = p_e.entity_id AND state = 'published';

  UPDATE content_versions
     SET state = 'published', published_by = p_actor, published_at = NOW()
   WHERE entity_type = p_e.entity_type AND entity_id = p_e.entity_id AND version_no = p_ver;

  BEGIN
    UPDATE content_entities
       SET status = 'published', slug = COALESCE(v_new_slug, slug),
           published_version_no = p_ver,
           draft_version_no = CASE WHEN draft_version_no = p_ver THEN NULL ELSE draft_version_no END,
           published_at = NOW(), publish_at = NULL, archived_at = NULL,
           revision = revision + 1, updated_by = p_actor
     WHERE entity_type = p_e.entity_type AND entity_id = p_e.entity_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'CMS_SLUG_TAKEN|%|%', p_e.entity_type, v_new_slug;
  END;

  IF p_path_prefix IS NOT NULL THEN
    -- The new live path must never itself be a redirect source.
    DELETE FROM content_redirects WHERE from_path = p_path_prefix || '/' || v_new_slug;
    IF v_old_slug IS NOT NULL AND v_old_slug IS DISTINCT FROM v_new_slug THEN
      INSERT INTO content_redirects (from_path, to_path, status_code, entity_type, entity_id, created_by)
      VALUES (p_path_prefix || '/' || v_old_slug, p_path_prefix || '/' || v_new_slug, 301,
              p_e.entity_type, p_e.entity_id, p_actor)
      ON CONFLICT (from_path) DO UPDATE
        SET to_path = EXCLUDED.to_path, entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id;
      v_redirect := TRUE;
    END IF;
    -- Flatten chains: every earlier slug of this entity points straight at the live path.
    UPDATE content_redirects
       SET to_path = p_path_prefix || '/' || v_new_slug
     WHERE entity_type = p_e.entity_type AND entity_id = p_e.entity_id
       AND from_path LIKE p_path_prefix || '/%'
       AND to_path <> p_path_prefix || '/' || v_new_slug;
  END IF;

  PERFORM cms_audit(p_actor, p_action, p_e.entity_type, p_e.entity_id,
    jsonb_build_object('version_no', p_ver, 'slug', v_new_slug, 'previous_slug', v_old_slug,
                       'rolled_back_from', p_rolled_from, 'redirect_created', v_redirect));

  RETURN jsonb_build_object('version_no', p_ver, 'slug', v_new_slug, 'previous_slug', v_old_slug,
                            'redirect_created', v_redirect);
END $$;

-- p_expected_revision NULL is reserved for the scheduler (cms_apply_due); the TS layer
-- always supplies a number.
CREATE OR REPLACE FUNCTION cms_publish(
  p_type TEXT, p_id TEXT, p_expected_revision INTEGER, p_actor TEXT, p_path_prefix TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_e content_entities%ROWTYPE; v_r JSONB;
BEGIN
  SELECT * INTO v_e FROM content_entities WHERE entity_type = p_type AND entity_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|%|%', p_type, p_id; END IF;
  IF v_e.status = 'archived' THEN RAISE EXCEPTION 'CMS_ARCHIVED|%|%', p_type, p_id; END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> v_e.revision THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;
  END IF;
  IF v_e.draft_version_no IS NULL THEN RAISE EXCEPTION 'CMS_NO_DRAFT|%|%', p_type, p_id; END IF;
  v_r := cms__go_live(v_e, v_e.draft_version_no, p_actor, p_path_prefix, 'cms.publish', NULL);
  RETURN v_r || jsonb_build_object('revision', v_e.revision + 1);
END $$;

CREATE OR REPLACE FUNCTION cms_rollback(
  p_type TEXT, p_id TEXT, p_to_version_no INTEGER, p_expected_revision INTEGER,
  p_actor TEXT, p_path_prefix TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_e content_entities%ROWTYPE; v_src content_versions%ROWTYPE; v_new INTEGER; v_r JSONB;
BEGIN
  SELECT * INTO v_e FROM content_entities WHERE entity_type = p_type AND entity_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|%|%', p_type, p_id; END IF;
  IF v_e.status = 'archived' THEN RAISE EXCEPTION 'CMS_ARCHIVED|%|%', p_type, p_id; END IF;
  IF p_expected_revision IS DISTINCT FROM v_e.revision THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;
  END IF;
  SELECT * INTO v_src FROM content_versions
   WHERE entity_type = p_type AND entity_id = p_id AND version_no = p_to_version_no;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|%|%', p_type, p_id; END IF;

  SELECT MAX(version_no) + 1 INTO v_new FROM content_versions WHERE entity_type = p_type AND entity_id = p_id;
  -- History is append-only: rollback is a NEW version carrying the old snapshot.
  INSERT INTO content_versions (entity_type, entity_id, version_no, state, snapshot, change_note,
                                rolled_back_from, created_by)
  VALUES (p_type, p_id, v_new, 'draft', v_src.snapshot, 'Rollback to v' || p_to_version_no,
          p_to_version_no, p_actor);
  v_r := cms__go_live(v_e, v_new, p_actor, p_path_prefix, 'cms.rollback', p_to_version_no);
  RETURN v_r || jsonb_build_object('revision', v_e.revision + 1);
END $$;

CREATE OR REPLACE FUNCTION cms_unpublish(
  p_type TEXT, p_id TEXT, p_expected_revision INTEGER, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_e content_entities%ROWTYPE;
BEGIN
  SELECT * INTO v_e FROM content_entities WHERE entity_type = p_type AND entity_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|%|%', p_type, p_id; END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> v_e.revision THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;
  END IF;
  IF v_e.status <> 'published' THEN RAISE EXCEPTION 'CMS_INVALID|NOT_PUBLISHED'; END IF;
  UPDATE content_versions SET state = 'superseded'
   WHERE entity_type = p_type AND entity_id = p_id AND state = 'published';
  UPDATE content_entities
     SET status = 'unpublished', published_version_no = NULL, unpublish_at = NULL,
         revision = revision + 1, updated_by = p_actor
   WHERE entity_type = p_type AND entity_id = p_id;
  PERFORM cms_audit(p_actor, 'cms.unpublish', p_type, p_id,
                    jsonb_build_object('previous_version_no', v_e.published_version_no));
  RETURN jsonb_build_object('revision', v_e.revision + 1);
END $$;

CREATE OR REPLACE FUNCTION cms_set_schedule(
  p_type TEXT, p_id TEXT, p_publish_at TIMESTAMPTZ, p_unpublish_at TIMESTAMPTZ,
  p_expected_revision INTEGER, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_e content_entities%ROWTYPE; v_slug TEXT;
BEGIN
  SELECT * INTO v_e FROM content_entities WHERE entity_type = p_type AND entity_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|%|%', p_type, p_id; END IF;
  IF v_e.status = 'archived' THEN RAISE EXCEPTION 'CMS_ARCHIVED|%|%', p_type, p_id; END IF;
  IF p_expected_revision IS DISTINCT FROM v_e.revision THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;
  END IF;
  IF p_publish_at IS NOT NULL AND p_publish_at <= NOW() THEN RAISE EXCEPTION 'CMS_BAD_SCHEDULE|PUBLISH_IN_PAST'; END IF;
  IF p_unpublish_at IS NOT NULL AND p_unpublish_at <= NOW() THEN RAISE EXCEPTION 'CMS_BAD_SCHEDULE|UNPUBLISH_IN_PAST'; END IF;
  IF p_publish_at IS NOT NULL AND p_unpublish_at IS NOT NULL AND p_unpublish_at <= p_publish_at THEN
    RAISE EXCEPTION 'CMS_BAD_SCHEDULE|ORDER';
  END IF;
  IF p_publish_at IS NOT NULL THEN
    IF v_e.draft_version_no IS NULL THEN RAISE EXCEPTION 'CMS_NO_DRAFT|%|%', p_type, p_id; END IF;
    SELECT NULLIF(lower(btrim(snapshot->>'slug')), '') INTO v_slug FROM content_versions
     WHERE entity_type = p_type AND entity_id = p_id AND version_no = v_e.draft_version_no;
    IF v_slug IS NOT NULL AND EXISTS (
         SELECT 1 FROM content_entities o
          WHERE o.entity_type = p_type AND o.entity_id <> p_id AND lower(o.slug) = v_slug
            AND o.status IN ('published','scheduled')) THEN
      RAISE EXCEPTION 'CMS_SLUG_TAKEN|%|%', p_type, v_slug;
    END IF;
  END IF;
  IF p_unpublish_at IS NOT NULL AND p_publish_at IS NULL AND v_e.status <> 'published' THEN
    RAISE EXCEPTION 'CMS_BAD_SCHEDULE|NOT_PUBLISHED';
  END IF;
  UPDATE content_entities
     SET publish_at = p_publish_at, unpublish_at = p_unpublish_at,
         status = CASE WHEN p_publish_at IS NOT NULL AND status <> 'published' THEN 'scheduled'
                       WHEN p_publish_at IS NULL AND status = 'scheduled' THEN
                            CASE WHEN published_version_no IS NULL THEN 'draft' ELSE 'published' END
                       ELSE status END,
         revision = revision + 1, updated_by = p_actor
   WHERE entity_type = p_type AND entity_id = p_id;
  PERFORM cms_audit(p_actor, 'cms.schedule', p_type, p_id,
    jsonb_build_object('publish_at', p_publish_at, 'unpublish_at', p_unpublish_at));
  RETURN jsonb_build_object('revision', v_e.revision + 1);
END $$;

CREATE OR REPLACE FUNCTION cms_archive(
  p_type TEXT, p_id TEXT, p_expected_revision INTEGER, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_e content_entities%ROWTYPE;
BEGIN
  SELECT * INTO v_e FROM content_entities WHERE entity_type = p_type AND entity_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|%|%', p_type, p_id; END IF;
  IF p_expected_revision IS DISTINCT FROM v_e.revision THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;
  END IF;
  IF v_e.status = 'archived' THEN RETURN jsonb_build_object('revision', v_e.revision, 'noop', TRUE); END IF;
  UPDATE content_versions SET state = 'superseded'
   WHERE entity_type = p_type AND entity_id = p_id AND state = 'published';
  UPDATE content_entities
     SET status = 'archived', archived_at = NOW(), published_version_no = NULL,
         publish_at = NULL, unpublish_at = NULL, revision = revision + 1, updated_by = p_actor
   WHERE entity_type = p_type AND entity_id = p_id;
  PERFORM cms_audit(p_actor, 'cms.archive', p_type, p_id,
                    jsonb_build_object('was_status', v_e.status));
  RETURN jsonb_build_object('revision', v_e.revision + 1);
END $$;

CREATE OR REPLACE FUNCTION cms_restore(
  p_type TEXT, p_id TEXT, p_expected_revision INTEGER, p_actor TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_e content_entities%ROWTYPE;
BEGIN
  SELECT * INTO v_e FROM content_entities WHERE entity_type = p_type AND entity_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_NOT_FOUND|%|%', p_type, p_id; END IF;
  IF p_expected_revision IS DISTINCT FROM v_e.revision THEN
    RAISE EXCEPTION 'CMS_STALE_REVISION|%|%', p_type, p_id;
  END IF;
  IF v_e.status <> 'archived' THEN RAISE EXCEPTION 'CMS_INVALID|NOT_ARCHIVED'; END IF;
  -- Restore NEVER auto-publishes. It returns to a non-live state for review.
  UPDATE content_entities
     SET status = CASE WHEN draft_version_no IS NULL THEN 'unpublished' ELSE 'draft' END,
         archived_at = NULL, revision = revision + 1, updated_by = p_actor
   WHERE entity_type = p_type AND entity_id = p_id;
  PERFORM cms_audit(p_actor, 'cms.restore', p_type, p_id, '{}'::jsonb);
  RETURN jsonb_build_object('revision', v_e.revision + 1);
END $$;

-- Public URL prefix per sluggable entity type, used for slug-change redirects when a
-- publish happens without a caller-supplied prefix (the scheduler). Later migrations may
-- CREATE OR REPLACE this to register more entity types.
CREATE OR REPLACE FUNCTION cms_path_prefix(p_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type WHEN 'product' THEN '/products' WHEN 'collection' THEN '/collections' ELSE NULL END
$$;

-- Scheduler entry point. Applies due publishes/unpublishes one entity at a time; a
-- failure on one entity (e.g. a slug that became taken) is reported and never blocks
-- the others. The caller invalidates caches for every {ok:true} item.
CREATE OR REPLACE FUNCTION cms_apply_due(p_now TIMESTAMPTZ DEFAULT NOW()) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE r RECORD; out JSONB := '[]'::jsonb; v_res JSONB;
BEGIN
  FOR r IN
    SELECT entity_type, entity_id FROM content_entities
     WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= p_now
     ORDER BY publish_at
  LOOP
    BEGIN
      v_res := cms_publish(r.entity_type, r.entity_id, NULL, 'system@kvrn.internal',
                           cms_path_prefix(r.entity_type));
      out := out || jsonb_build_array(jsonb_build_object('entity_type', r.entity_type,
               'entity_id', r.entity_id, 'action', 'publish', 'ok', TRUE));
    EXCEPTION WHEN OTHERS THEN
      out := out || jsonb_build_array(jsonb_build_object('entity_type', r.entity_type,
               'entity_id', r.entity_id, 'action', 'publish', 'ok', FALSE, 'error', SQLERRM));
    END;
  END LOOP;
  FOR r IN
    SELECT entity_type, entity_id FROM content_entities
     WHERE status = 'published' AND unpublish_at IS NOT NULL AND unpublish_at <= p_now
     ORDER BY unpublish_at
  LOOP
    BEGIN
      v_res := cms_unpublish(r.entity_type, r.entity_id, NULL, 'system@kvrn.internal');
      out := out || jsonb_build_array(jsonb_build_object('entity_type', r.entity_type,
               'entity_id', r.entity_id, 'action', 'unpublish', 'ok', TRUE));
    EXCEPTION WHEN OTHERS THEN
      out := out || jsonb_build_array(jsonb_build_object('entity_type', r.entity_type,
               'entity_id', r.entity_id, 'action', 'unpublish', 'ok', FALSE, 'error', SQLERRM));
    END;
  END LOOP;
  RETURN out;
END $$;

COMMIT;
