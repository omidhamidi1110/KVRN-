-- KVRN migration 046: atomic cost reservations and OWNER-LOCKED marketing controls.
-- STAGING DESIGN ONLY. NOT APPLIED. Requires 038 and 039; apply 038-045 first.
-- This migration contains no outbound send worker, no auto-enable, and no provider calls.
-- Marketing dispatch always stays disabled until separately approved configuration,
-- recipient proof, price verification, idempotent sending, provider integration and QA.
BEGIN;

CREATE TABLE IF NOT EXISTS marketing_budget_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  dispatch_enabled boolean NOT NULL DEFAULT false,
  sms_daily_cap_micros bigint NOT NULL DEFAULT 3000000 CHECK (sms_daily_cap_micros BETWEEN 1 AND 3000000),
  sms_monthly_cap_micros bigint NOT NULL DEFAULT 15000000 CHECK (sms_monthly_cap_micros BETWEEN 1 AND 15000000),
  email_daily_cap_micros bigint NOT NULL DEFAULT 2000000 CHECK (email_daily_cap_micros BETWEEN 1 AND 2000000),
  email_monthly_cap_micros bigint NOT NULL DEFAULT 10000000 CHECK (email_monthly_cap_micros BETWEEN 1 AND 10000000),
  ai_sms_monthly_cap_micros bigint NOT NULL DEFAULT 5000000 CHECK (ai_sms_monthly_cap_micros BETWEEN 1 AND 5000000),
  changed_at timestamptz NOT NULL DEFAULT NOW()
);
INSERT INTO marketing_budget_policy(id,dispatch_enabled)
VALUES(1,false) ON CONFLICT(id) DO NOTHING;

-- DB-level serialized budgets are defense in depth. The app is NEVER permitted
-- to treat a reservation as proof of consent or permission to call a provider.
-- The existing function arguments are retained for compatibility with 039,
-- but can only REDUCE the ceilings stored in the policy table, not raise them.
CREATE OR REPLACE FUNCTION kvrn_marketing_reserve(
 p_campaign uuid,p_key text,p_channel text,p_ai boolean,p_worst_micros bigint,
 p_day_cap bigint,p_month_cap bigint,p_ai_month_cap bigint
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_policy marketing_budget_policy%ROWTYPE;
  v_existing marketing_budget_reservations%ROWTYPE;
  v_campaign marketing_campaign_drafts%ROWTYPE;
  v_day date := (NOW() AT TIME ZONE 'UTC')::date;
  v_month date := date_trunc('month',NOW() AT TIME ZONE 'UTC')::date;
  v_day_cap bigint;
  v_month_cap bigint;
  v_ai_cap bigint;
  v_day_committed numeric;
  v_month_committed numeric;
  v_ai_month_committed numeric;
  v_new uuid;
BEGIN
  -- Arguments must be positive bounded integers; never accept unknown-priced sends.
  IF p_campaign IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 120
     OR p_key !~ '^[A-Za-z0-9:_-]+$'
     OR p_channel NOT IN ('sms','email') OR p_ai IS NULL
     OR p_worst_micros IS NULL OR p_worst_micros NOT BETWEEN 1 AND 2000000
     OR p_day_cap IS NULL OR p_day_cap <= 0
     OR p_month_cap IS NULL OR p_month_cap <= 0
     OR p_ai_month_cap IS NULL OR p_ai_month_cap <= 0
  THEN RAISE EXCEPTION 'INVALID_MARKETING_BUDGET_ARGUMENT'; END IF;

  -- SERIALIZE all provider reservations in the database (even across Neon HTTP
  -- transactions). Keep lock until commit; unrelated financial rows unaffected.
  PERFORM pg_advisory_xact_lock(48112026046::bigint);
  SELECT * INTO STRICT v_policy FROM marketing_budget_policy WHERE id=1 FOR UPDATE;
  IF NOT v_policy.dispatch_enabled THEN
    RAISE EXCEPTION 'MARKETING_DISPATCH_DISABLED';
  END IF;

  SELECT * INTO v_existing FROM marketing_budget_reservations WHERE request_key=p_key;
  IF FOUND THEN
    IF v_existing.campaign_id=p_campaign AND v_existing.channel=p_channel
       AND v_existing.ai_initiated=p_ai AND v_existing.reserved_micros=p_worst_micros
       AND v_existing.state='reserved'
       AND v_existing.budget_utc_day=v_day
       AND v_existing.budget_utc_month=v_month
    THEN RETURN v_existing.id;
    ELSE RAISE EXCEPTION 'MARKETING_IDEMPOTENCY_CONFLICT'; END IF;
  END IF;

  SELECT * INTO v_campaign FROM marketing_campaign_drafts WHERE id=p_campaign FOR SHARE;
  IF NOT FOUND OR v_campaign.channel<>p_channel OR v_campaign.state<>'reviewed' THEN
    RAISE EXCEPTION 'MARKETING_CAMPAIGN_NOT_REVIEWED';
  END IF;

  v_day_cap := LEAST(p_day_cap,CASE WHEN p_channel='sms' THEN v_policy.sms_daily_cap_micros ELSE v_policy.email_daily_cap_micros END);
  v_month_cap := LEAST(p_month_cap,CASE WHEN p_channel='sms' THEN v_policy.sms_monthly_cap_micros ELSE v_policy.email_monthly_cap_micros END);
  v_ai_cap := LEAST(p_ai_month_cap,v_policy.ai_sms_monthly_cap_micros);

  -- numeric aggregates prevent BIGINT overflow if history grows abnormally.
  -- Reserved rows consume their entire conservative worst-case amount;
  -- settled rows consume only actual, never fabricated zeros; releases consume 0.
  SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros::numeric
                           WHEN state='settled' THEN actual_micros::numeric ELSE 0 END),0)
    INTO v_day_committed FROM marketing_budget_reservations
   WHERE channel=p_channel AND budget_utc_day=v_day;
  SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros::numeric
                           WHEN state='settled' THEN actual_micros::numeric ELSE 0 END),0)
    INTO v_month_committed FROM marketing_budget_reservations
   WHERE channel=p_channel AND budget_utc_month=v_month;
  IF v_day_committed+p_worst_micros::numeric>v_day_cap OR
     v_month_committed+p_worst_micros::numeric>v_month_cap THEN
    RAISE EXCEPTION 'MARKETING_BUDGET_EXCEEDED';
  END IF;
  IF p_ai AND p_channel='sms' THEN
    SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros::numeric
                             WHEN state='settled' THEN actual_micros::numeric ELSE 0 END),0)
      INTO v_ai_month_committed FROM marketing_budget_reservations
     WHERE channel='sms' AND ai_initiated=true AND budget_utc_month=v_month;
    IF v_ai_month_committed+p_worst_micros::numeric>v_ai_cap THEN
      RAISE EXCEPTION 'MARKETING_AI_SUB_BUDGET_EXCEEDED';
    END IF;
  END IF;

  INSERT INTO marketing_budget_reservations(
    campaign_id,request_key,channel,ai_initiated,budget_utc_day,
    budget_utc_month,reserved_micros,state
  ) VALUES(p_campaign,p_key,p_channel,p_ai,v_day,v_month,p_worst_micros,'reserved')
  RETURNING id INTO v_new;
  RETURN v_new;
END; $$;

-- Immutable attribution & monetary facts after reservation: no arbitrary
-- UPDATE API here. A future reconciler must use atomic reviewed procedures.
COMMIT;
