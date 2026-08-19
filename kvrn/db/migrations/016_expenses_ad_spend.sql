-- KVRN Migration 016 — Operating cost model + advertising spend
--
-- ── THREE DISTINCT COST STATES, NEVER COLLAPSED ──────────────────────────────
--
--   expense_definitions      = what KVRN EXPECTS to owe   (recurring obligations)
--   expense_transactions     = what KVRN ACTUALLY PAID    (billed fact)
--   provider_usage_snapshots = what usage SUGGESTS so far (estimate / projection)
--
-- Only expense_transactions is a real expense. A $19/month subscription definition
-- is NOT an expense until an invoice exists — otherwise realised profit would be
-- reduced by money that was never actually spent. Likewise a usage estimate from a
-- provider dashboard is a forecast, not a bill, and must never be summed into
-- realised operating profit.
--
-- An annual $40 renewal is ONE transaction. The UI may show a $3.33 monthly
-- equivalent for planning, but that is a presentation-layer division only — it never
-- creates twelve fabricated billed rows.
--
-- Advertising is a separate table because it is a marketing investment measured
-- against attributed revenue, not fixed overhead.
--
-- None of these are COGS. COGS is per-unit landed product cost on order_items.
--
-- Run after 001-015.

BEGIN;

-- Shared category vocabulary. 'development' is deliberately distinct from
-- 'infrastructure': GitHub/Codespaces is build tooling, not production runtime cost,
-- and the P&L reports operating profit before and after it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kvrn_expense_category') THEN
    CREATE TYPE kvrn_expense_category AS ENUM (
      'infrastructure',    -- Neon, Cloudflare — production runtime
      'development',       -- GitHub, Codespaces — build tooling (reported separately)
      'communications',    -- Twilio, Resend
      'payments',          -- fixed platform fees (NOT per-transaction Stripe fees)
      'shipping_platform', -- Shippo platform fees (NOT label costs)
      'domain',            -- registrar
      'software',          -- design/image tooling, subscriptions
      'contractor',        -- freelance/agency
      'packaging',         -- boxes, mailers, tissue
      'other'
    );
  END IF;
END $$;

-- ── A. expense_definitions — EXPECTED recurring obligations ──────────────────
-- Reference data for planning and for the infrastructure dashboard.
-- NEVER counted as a realised expense on its own.
CREATE TABLE IF NOT EXISTS expense_definitions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              TEXT        NOT NULL,
  category              kvrn_expense_category NOT NULL,
  name                  TEXT        NOT NULL,

  cadence               TEXT        NOT NULL
    CHECK (cadence IN ('monthly','annual','one_time','usage_based')),

  -- NULL for usage_based plans where the amount is not known in advance.
  expected_amount_cents INTEGER
    CHECK (expected_amount_cents IS NULL OR expected_amount_cents >= 0),
  currency              TEXT        NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),

  renewal_date          DATE,
  active                BOOLEAN     NOT NULL DEFAULT TRUE,
  notes                 TEXT,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A fixed-cadence obligation must state what it is expected to cost.
  CONSTRAINT ed_amount_required CHECK (
    cadence = 'usage_based' OR expected_amount_cents IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_ed_provider ON expense_definitions(provider);
CREATE INDEX IF NOT EXISTS idx_ed_active   ON expense_definitions(active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_ed_category ON expense_definitions(category);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_ed_updated_at') THEN
    CREATE TRIGGER set_ed_updated_at BEFORE UPDATE ON expense_definitions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── B. expense_transactions — ACTUAL billed expenses ─────────────────────────
-- The ONLY table that reduces realised operating profit.
CREATE TABLE IF NOT EXISTS expense_transactions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional link back to the obligation this invoice settles.
  expense_definition_id UUID        REFERENCES expense_definitions(id) ON DELETE SET NULL,

  provider              TEXT        NOT NULL,
  category              kvrn_expense_category NOT NULL,
  name                  TEXT        NOT NULL,

  amount_cents          INTEGER     NOT NULL CHECK (amount_cents >= 0),
  currency              TEXT        NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),

  -- Service period the charge covers. An annual renewal spans a year and is
  -- pro-rated across reporting windows rather than duplicated.
  period_start          DATE,
  period_end            DATE,

  -- The date the money actually left. NULL = incurred but not yet settled.
  paid_at               DATE,

  invoice_id            TEXT,
  source                TEXT        NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','provider_api','imported')),

  notes                 TEXT,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT et_period_valid CHECK (
    period_start IS NULL OR period_end IS NULL OR period_end >= period_start
  )
);

CREATE INDEX IF NOT EXISTS idx_et_paid_at    ON expense_transactions(paid_at DESC)
  WHERE paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_et_provider   ON expense_transactions(provider, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_et_category   ON expense_transactions(category, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_et_definition ON expense_transactions(expense_definition_id)
  WHERE expense_definition_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_et_updated_at') THEN
    CREATE TRIGGER set_et_updated_at BEFORE UPDATE ON expense_transactions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── C. provider_usage_snapshots — ESTIMATES AND PROJECTIONS ONLY ─────────────
-- Point-in-time readings of consumption against an allowance.
-- estimated_accrued_cents and projected_month_end_cents are FORECASTS.
-- They are surfaced in the infrastructure dashboard and are structurally excluded
-- from every realised-profit figure.
CREATE TABLE IF NOT EXISTS provider_usage_snapshots (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                  TEXT        NOT NULL,

  metric_name               TEXT        NOT NULL,
  -- Units make the reading unambiguous: 42 CU-hours is not 42 GB.
  metric_unit               TEXT        NOT NULL,

  usage_value               NUMERIC,
  included_allowance        NUMERIC,

  -- Forecasts. NEVER an actual billed amount.
  estimated_accrued_cents   INTEGER
    CHECK (estimated_accrued_cents IS NULL OR estimated_accrued_cents >= 0),
  projected_month_end_cents INTEGER
    CHECK (projected_month_end_cents IS NULL OR projected_month_end_cents >= 0),

  threshold_status          TEXT
    CHECK (threshold_status IS NULL OR threshold_status IN ('ok','warning','critical')),

  billing_period_start      DATE,
  billing_period_end        DATE,

  source                    TEXT        NOT NULL DEFAULT 'manual'
    CHECK (source IN ('provider_api','manual','estimated')),

  notes                     TEXT,
  created_by                TEXT,
  captured_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pus_provider
  ON provider_usage_snapshots(provider, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_pus_period
  ON provider_usage_snapshots(billing_period_start, billing_period_end);

-- ── D. ad_spend ──────────────────────────────────────────────────────────────
-- Creative production (photography, video) is advertising investment, not the
-- generic 'content' operating-expense bucket, so it belongs here alongside media
-- spend. Email infrastructure is NOT advertising — Resend fees are a
-- 'communications' expense unless a send is deliberately classified as a campaign.
CREATE TABLE IF NOT EXISTS ad_spend (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  platform        TEXT        NOT NULL
    CHECK (platform IN (
      'meta','instagram','tiktok','google','influencer',
      'photographer','videographer','creative_production','other'
    )),
  campaign_name   TEXT,
  campaign_id     TEXT,

  spend_cents     INTEGER     NOT NULL CHECK (spend_cents >= 0),
  currency        TEXT        NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),

  period_start    DATE        NOT NULL,
  period_end      DATE        NOT NULL,

  -- The PLATFORM'S OWN attribution claim. Stored for comparison only; never summed
  -- into KVRN revenue or profit. KVRN first-party attribution is computed from
  -- orders.attribution instead.
  provider_reported_revenue_cents INTEGER
    CHECK (provider_reported_revenue_cents IS NULL OR provider_reported_revenue_cents >= 0),
  provider_reported_orders        INTEGER
    CHECK (provider_reported_orders IS NULL OR provider_reported_orders >= 0),
  provider_source TEXT
    CHECK (provider_source IS NULL OR provider_source IN ('manual','api','imported')),

  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ad_period_valid CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_ad_period   ON ad_spend(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_ad_platform ON ad_spend(platform, period_start DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_ad_spend_updated_at') THEN
    CREATE TRIGGER set_ad_spend_updated_at BEFORE UPDATE ON ad_spend
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;

SELECT 'expense_definitions'      AS tbl, COUNT(*) FROM expense_definitions
UNION ALL SELECT 'expense_transactions',     COUNT(*) FROM expense_transactions
UNION ALL SELECT 'provider_usage_snapshots', COUNT(*) FROM provider_usage_snapshots
UNION ALL SELECT 'ad_spend',                 COUNT(*) FROM ad_spend;
