-- KVRN 039 — atomic pre-dispatch marketing budget reservations, schema ONLY.
-- NOT APPLIED. Requires owner-approved staging/prod migration, priced provider integration,
-- consent proof and send approval before any use. No network sends and no historical changes.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_budget_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES marketing_campaign_drafts(id),
 request_key text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 120),
 channel text NOT NULL CHECK (channel IN ('sms','email')),
 ai_initiated boolean NOT NULL DEFAULT false,
 budget_utc_day date NOT NULL,
 budget_utc_month date NOT NULL,
 reserved_micros bigint NOT NULL CHECK(reserved_micros>0),
 actual_micros bigint CHECK(actual_micros IS NULL OR actual_micros>=0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released')),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 closed_at timestamptz,
 CONSTRAINT mbr_settle_amount CHECK (state<>'settled' OR (actual_micros IS NOT NULL AND actual_micros<=reserved_micros)),
 CONSTRAINT mbr_no_actual_before_settle CHECK (state='settled' OR actual_micros IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_mbr_budget ON marketing_budget_reservations(channel,budget_utc_month,budget_utc_day,state);
-- One lock serializes KVRN marketing budget decisions across all competing senders.
-- This guards atomicity even if the database is Neon HTTP and calls cannot share a session.
CREATE OR REPLACE FUNCTION kvrn_marketing_reserve(
 p_campaign uuid,p_key text,p_channel text,p_ai boolean,p_worst_micros bigint,
 p_day_cap bigint,p_month_cap bigint,p_ai_month_cap bigint
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_state text; v_total bigint; v_ai_total bigint; v_day date;v_month date;
BEGIN
 IF length(p_key)<8 OR length(p_key)>120 OR p_worst_micros<=0 OR p_day_cap<=0 OR p_month_cap<=0 OR p_ai_month_cap<=0
   THEN RAISE EXCEPTION 'INVALID_BUDGET_ARGUMENT'; END IF;
 IF p_channel NOT IN ('sms','email') THEN RAISE EXCEPTION 'INVALID_CHANNEL'; END IF;
 -- Fail closed on campaign: editorial review is NOT send approval. This function
 -- is intentionally blocked until a separately approved dispatch gating migration.
 RAISE EXCEPTION 'MARKETING_DISPATCH_DISABLED';
 -- No reservation is created while dispatch is disabled.
END; $$;
-- Releasing stale/failed unused reservations is safe only with a future send worker
-- that proves no dispatch occurred. Intentionally not exposed via application API.
COMMIT;
