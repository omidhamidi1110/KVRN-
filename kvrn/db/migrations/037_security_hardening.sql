-- 037_security_hardening.sql
-- Additive public-endpoint abuse controls discovered during the post-merge Stage 2 security audit.
-- No existing commerce/accounting formula is changed.

CREATE TABLE IF NOT EXISTS public_api_rate_events (
  id          BIGSERIAL   PRIMARY KEY,
  bucket      TEXT        NOT NULL CHECK (length(bucket) BETWEEN 1 AND 80),
  key_hash    TEXT        NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_api_rate_lookup
  ON public_api_rate_events(bucket, key_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_api_rate_created
  ON public_api_rate_events(created_at);

-- DB-backed sliding-window limiter so the limit survives Worker isolate churn.
-- Only accepted attempts are recorded; denied attempts do not extend the lockout window.
CREATE OR REPLACE FUNCTION public_api_rate_allow(
  p_bucket TEXT,
  p_key_hash TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_bucket IS NULL OR length(p_bucket) < 1 OR length(p_bucket) > 80
     OR p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$'
     OR p_limit < 1 OR p_limit > 10000
     OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'KVRN_PUBLIC_RATE|BAD_ARGS';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pubrl:' || p_bucket || ':' || p_key_hash, 0));

  SELECT COUNT(*) INTO v_count
    FROM public_api_rate_events
   WHERE bucket = p_bucket
     AND key_hash = p_key_hash
     AND created_at > clock_timestamp() - make_interval(secs => p_window_seconds);

  IF v_count >= p_limit THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public_api_rate_events(bucket, key_hash, created_at)
  VALUES (p_bucket, p_key_hash, clock_timestamp());

  -- The table contains only abuse-control metadata. Keep it short-lived even if a scheduled cleanup is missed.
  DELETE FROM public_api_rate_events
   WHERE created_at < clock_timestamp() - interval '2 days';

  RETURN TRUE;
END;
$$;

-- Defense in depth for CMS-generated redirects. Current writers already construct internal paths from
-- validated slugs, but direct SQL or a future writer must not be able to persist control characters,
-- whitespace, backslashes or protocol-relative destinations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_redirects_safe_paths_chk'
  ) THEN
    ALTER TABLE content_redirects
      ADD CONSTRAINT content_redirects_safe_paths_chk CHECK (
        from_path ~ '^/[^/]' AND to_path ~ '^/[^/]'
        AND from_path !~ '[[:cntrl:][:space:]]' AND to_path !~ '[[:cntrl:][:space:]]'
        AND position(E'\\' in from_path) = 0 AND position(E'\\' in to_path) = 0
      ) NOT VALID;
    ALTER TABLE content_redirects VALIDATE CONSTRAINT content_redirects_safe_paths_chk;
  END IF;
END $$;
