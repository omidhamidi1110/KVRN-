-- KVRN Migration 018 — Returns, exchanges and payment disputes
--
-- Phase B Batch 3, part 1 of 3 (018 -> 019 -> 020).
--
-- Mostly additive: new tables, new functions, new columns on order_refunds and
-- order_return_items, and three missing indexes. Nothing is dropped.
--
-- ONE EXISTING FUNCTION IS REPLACED: record_order_refund() from migration 015.
-- Its 9-argument signature is preserved exactly, so no caller changes; the only
-- behavioural change is that it now persists stripe_payment_intent_id, which this
-- migration adds and which the dispute refund-offset scoping depends on. Without
-- that replacement every NEW refund would leave the column NULL and fall through
-- to the legacy attribution branch. See the function body for the full diff note.
--
-- finalize_paid_order is NOT touched by this migration.
--
-- ── THE CENTRAL ACCOUNTING RULE ─────────────────────────────────────────────
--
-- REVENUE IS REDUCED ONLY BY order_refunds AND BY A LOST DISPUTE.
--
-- A return does NOT reduce revenue. It records the physical and inventory
-- consequences of goods coming back; the money is handled by whichever refund it
-- is allocated to. Modelling both as revenue reducers would count the same dollar
-- twice, which is the likeliest error in this batch.
--
-- A dispute and a refund can also cover the SAME money (merchant refunds, then the
-- dispute is withdrawn). order_disputes.refund_offset_cents excludes the
-- already-refunded portion, so only net_revenue_impact_cents reduces revenue.
--
-- ── DISPUTE STATE ───────────────────────────────────────────────────────────
--
-- Stripe can legitimately move a dispute late, including lost -> won. There is
-- deliberately NO monotonic status-rank guard. Staleness is prevented by comparing
-- Stripe's own event timestamp against last_applied_event_at, which rejects
-- genuinely out-of-order delivery while permitting any valid later outcome.
--
-- Dispute cash effects are never inferred from status. Where Stripe reports a
-- balance transaction it is stored verbatim and is authoritative for fees and cash.
--
-- Run after 001-017.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS return_number_seq   START 1000 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS exchange_number_seq START 1000 INCREMENT 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- REFUND COMPONENT BREAKDOWN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Stripe reports a refund TOTAL. It does not decompose that total into
-- merchandise, shipping and tax, so migration 015 left those columns nullable.
-- NULL there genuinely means "not known" — it does not mean zero.
--
-- Two tempting readings are both wrong:
--   * NULL as permissive (cap each component at the refund total) would let three
--     components each absorb the whole refund, permitting allocations summing to
--     three times the money actually returned.
--   * NULL as zero would block every allocation and silently understate
--     merchandise refunds.
--
-- The breakdown is therefore an explicit STATE. While it is 'unknown' the refund
-- still reduces customer cash and the total refunded amount, returns may still be
-- created, and physical receipt/restock may still happen — but component-level
-- allocation is refused until the split is genuinely known.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_refunds' AND column_name = 'component_breakdown_status'
  ) THEN
    ALTER TABLE order_refunds ADD COLUMN component_breakdown_status TEXT NOT NULL
      DEFAULT 'unknown'
      CHECK (component_breakdown_status IN ('unknown','resolved'));

    -- Provenance: derived deterministically from the order, or entered by an admin.
    ALTER TABLE order_refunds ADD COLUMN component_breakdown_source TEXT
      CHECK (component_breakdown_source IS NULL
             OR component_breakdown_source IN ('derived_full_refund','admin'));
    ALTER TABLE order_refunds ADD COLUMN component_breakdown_resolved_at TIMESTAMPTZ;
    ALTER TABLE order_refunds ADD COLUMN component_breakdown_resolved_by TEXT;

    -- Needed to scope a dispute's refund offset to the money actually disputed.
    -- migration 015 stored only the charge id; an order may carry more than one
    -- payment intent once exchange price differences exist.
    ALTER TABLE order_refunds ADD COLUMN stripe_payment_intent_id TEXT;

    -- Backfill: a row already carrying all three components is resolved.
    -- Everything else stays 'unknown' rather than having a split invented for it.
    UPDATE order_refunds
    SET component_breakdown_status  = 'resolved',
        component_breakdown_source  = 'admin',
        component_breakdown_resolved_at = NOW()
    WHERE merchandise_refund_cents IS NOT NULL
      AND shipping_refund_cents    IS NOT NULL
      AND tax_refund_cents         IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_or_charge
  ON order_refunds(stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_or_payment_intent
  ON order_refunds(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_or_breakdown_pending
  ON order_refunds(created_at DESC)
  WHERE component_breakdown_status = 'unknown';

-- ═══════════════════════════════════════════════════════════════════════════
-- RETURNS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_returns (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  return_number   TEXT        NOT NULL,

  status          TEXT        NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','in_transit','received','completed','cancelled')),

  -- ── Return shipping: three genuinely different concepts ──────────────────
  -- Neutral default on purpose. Nothing is assumed about who pays; the admin must
  -- choose explicitly when return shipping actually applies.
  return_shipping_paid_by TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (return_shipping_paid_by IN ('kvrn','customer','not_applicable')),

  -- KVRN's ACTUAL carrier cost, only when KVRN bought the label.
  -- NULL means not recorded — never treat as 0, and never create a carrier
  -- expense before an authoritative cost exists.
  return_label_cost_cents INTEGER
    CHECK (return_label_cost_cents IS NULL OR return_label_cost_cents >= 0),
  return_label_shipment_id UUID REFERENCES shipments(id) ON DELETE SET NULL,

  -- Amount deducted from the customer's refund or billed back to them. A REVENUE
  -- matter, deliberately separate from KVRN's carrier cost above.
  return_shipping_charged_to_customer_cents INTEGER
    CHECK (return_shipping_charged_to_customer_cents IS NULL
        OR return_shipping_charged_to_customer_cents >= 0),

  reason          TEXT,
  notes           TEXT,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT order_returns_number_uq UNIQUE (return_number),
  CONSTRAINT ret_label_cost_requires_kvrn CHECK (
    return_label_cost_cents IS NULL OR return_shipping_paid_by = 'kvrn'
  )
);

CREATE INDEX IF NOT EXISTS idx_ret_order  ON order_returns(order_id);
CREATE INDEX IF NOT EXISTS idx_ret_status ON order_returns(status, requested_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_order_returns_updated_at') THEN
    CREATE TRIGGER set_order_returns_updated_at BEFORE UPDATE ON order_returns
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- COGS is credited back ONLY when a unit is both sellable AND restocked (the
-- restock event itself arrives in migration 019). Damaged, defective, lost and
-- disposed units keep their original COGS: the goods really were consumed, and
-- reversing the cost would overstate profit.
CREATE TABLE IF NOT EXISTS order_return_items (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id       UUID        NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  order_item_id   UUID        NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,

  quantity        INTEGER     NOT NULL CHECK (quantity > 0),

  disposition     TEXT        NOT NULL DEFAULT 'sellable'
    CHECK (disposition IN ('sellable','damaged','defective','lost','disposed')),

  restocked       BOOLEAN     NOT NULL DEFAULT FALSE,
  restocked_at    TIMESTAMPTZ,

  -- Frozen from order_items at return creation so a later cost-batch change can
  -- never alter the credit for goods already returned.
  unit_cogs_cents_snapshot INTEGER
    CHECK (unit_cogs_cents_snapshot IS NULL OR unit_cogs_cents_snapshot >= 0),
  cogs_credit_cents        INTEGER
    CHECK (cogs_credit_cents IS NULL OR cogs_credit_cents >= 0),

  -- Sale price snapshot (GROSS, before any order discount).
  unit_price_cents_snapshot INTEGER
    CHECK (unit_price_cents_snapshot IS NULL OR unit_price_cents_snapshot >= 0),

  -- ── Post-discount merchandise economics, frozen at return creation ───────
  -- Gross value alone would let a discounted unit claim more merchandise refund
  -- than the customer ever paid for it. A $100 item bought under a $20 allocated
  -- discount is worth $80 of merchandise refund, not $100.
  --
  -- net_merchandise_basis_cents is the AUTHORITATIVE cap for merchandise
  -- allocation against this returned line. Snapshotted so later discount or price
  -- changes cannot alter the economics of goods already returned.
  line_gross_cents_snapshot        INTEGER
    CHECK (line_gross_cents_snapshot IS NULL OR line_gross_cents_snapshot >= 0),
  allocated_discount_cents_snapshot INTEGER
    CHECK (allocated_discount_cents_snapshot IS NULL OR allocated_discount_cents_snapshot >= 0),
  net_merchandise_basis_cents      INTEGER
    CHECK (net_merchandise_basis_cents IS NULL OR net_merchandise_basis_cents >= 0),

  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT rit_restock_requires_sellable CHECK (
    restocked = FALSE OR disposition = 'sellable'
  ),
  CONSTRAINT rit_credit_requires_restock CHECK (
    cogs_credit_cents IS NULL OR restocked = TRUE
  )
);

CREATE INDEX IF NOT EXISTS idx_rit_return     ON order_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_rit_order_item ON order_return_items(order_item_id);

-- Many-to-many on purpose: one return may be settled by several partial refunds,
-- a refund may arrive before or after physical receipt, and a refund may exist
-- with no return at all (simply no allocation row).
--
-- Allocation NEVER moves money. It records which refund settled which return so
-- the two systems reconcile. Revenue is still reduced only by order_refunds.
CREATE TABLE IF NOT EXISTS return_refund_allocations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id          UUID        NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  refund_id          UUID        NOT NULL REFERENCES order_refunds(id) ON DELETE RESTRICT,

  merchandise_cents  INTEGER     NOT NULL DEFAULT 0 CHECK (merchandise_cents >= 0),
  shipping_cents     INTEGER     NOT NULL DEFAULT 0 CHECK (shipping_cents    >= 0),
  tax_cents          INTEGER     NOT NULL DEFAULT 0 CHECK (tax_cents         >= 0),

  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT rra_return_refund_uq UNIQUE (return_id, refund_id)
);

CREATE INDEX IF NOT EXISTS idx_rra_return ON return_refund_allocations(return_id);
CREATE INDEX IF NOT EXISTS idx_rra_refund ON return_refund_allocations(refund_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- EXCHANGES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An exchange is NOT a new sale. It creates replacement COGS and shipping cost but
-- no merchandise revenue. Only a price difference touches money, and only once it
-- is authoritatively settled.
CREATE TABLE IF NOT EXISTS order_exchanges (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  return_id        UUID        REFERENCES order_returns(id) ON DELETE SET NULL,
  exchange_number  TEXT        NOT NULL,

  status           TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','shipped','completed','cancelled')),

  replacement_shipping_cost_cents INTEGER
    CHECK (replacement_shipping_cost_cents IS NULL OR replacement_shipping_cost_cents >= 0),
  replacement_shipment_id UUID REFERENCES shipments(id) ON DELETE SET NULL,

  -- Signed: positive = customer owes KVRN, negative = KVRN owes customer.
  -- An admin typing a number produces status='pending' and has NO financial
  -- effect. It becomes revenue/cash only at 'succeeded' with real Stripe evidence.
  price_difference_cents INTEGER NOT NULL DEFAULT 0,
  price_difference_status TEXT   NOT NULL DEFAULT 'none'
    CHECK (price_difference_status IN ('none','pending','succeeded','failed')),
  price_difference_payment_intent_id      TEXT,
  price_difference_balance_transaction_id TEXT,
  price_difference_refund_id UUID REFERENCES order_refunds(id) ON DELETE SET NULL,
  price_difference_tax_cents INTEGER NOT NULL DEFAULT 0
    CHECK (price_difference_tax_cents >= 0),

  reason           TEXT,
  notes            TEXT,
  shipped_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT order_exchanges_number_uq UNIQUE (exchange_number),
  CONSTRAINT exch_positive_needs_evidence CHECK (
    price_difference_status <> 'succeeded'
    OR price_difference_cents <= 0
    OR price_difference_payment_intent_id IS NOT NULL
    OR price_difference_balance_transaction_id IS NOT NULL
  ),
  CONSTRAINT exch_negative_needs_refund CHECK (
    price_difference_status <> 'succeeded'
    OR price_difference_cents >= 0
    OR price_difference_refund_id IS NOT NULL
  ),
  CONSTRAINT exch_none_means_zero CHECK (
    price_difference_status <> 'none' OR price_difference_cents = 0
  )
);

CREATE INDEX IF NOT EXISTS idx_exch_order  ON order_exchanges(order_id);
CREATE INDEX IF NOT EXISTS idx_exch_return ON order_exchanges(return_id)
  WHERE return_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exch_status ON order_exchanges(status, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_order_exchanges_updated_at') THEN
    CREATE TRIGGER set_order_exchanges_updated_at BEFORE UPDATE ON order_exchanges
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_exchange_items (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id      UUID        NOT NULL REFERENCES order_exchanges(id) ON DELETE CASCADE,
  variant_id       UUID        NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  sku              TEXT        NOT NULL,
  quantity         INTEGER     NOT NULL CHECK (quantity > 0),

  unit_cogs_cents_snapshot INTEGER
    CHECK (unit_cogs_cents_snapshot IS NULL OR unit_cogs_cents_snapshot >= 0),
  line_cogs_cents          INTEGER
    CHECK (line_cogs_cents IS NULL OR line_cogs_cents >= 0),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exi_exchange ON order_exchange_items(exchange_id);
CREATE INDEX IF NOT EXISTS idx_exi_variant  ON order_exchange_items(variant_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- DISPUTES / CHARGEBACKS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_disputes (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

  stripe_dispute_id  TEXT        NOT NULL,
  stripe_charge_id   TEXT,
  stripe_payment_intent_id TEXT,

  amount_cents       INTEGER     NOT NULL CHECK (amount_cents > 0),
  currency           TEXT        NOT NULL DEFAULT 'usd',

  -- Stripe's own status verbatim, so a new Stripe status can never be silently
  -- coerced into the wrong accounting bucket.
  stripe_status      TEXT        NOT NULL,
  -- 'prevented' is a TERMINAL Stripe outcome (API 2025-08-27.basil): the dispute
  -- was blocked or auto-resolved before becoming a formal chargeback. It is NOT
  -- an unresolved dispute awaiting review, and it does NOT reduce revenue —
  -- where Stripe auto-resolves by refunding, that money already leaves through
  -- order_refunds, so counting it here too would double-count the same dollar.
  status             TEXT        NOT NULL
    CHECK (status IN ('open','under_review','won','lost','withdrawn','prevented')),

  refund_offset_cents INTEGER    NOT NULL DEFAULT 0 CHECK (refund_offset_cents >= 0),
  -- Frozen at a terminal state. Only this reduces revenue.
  net_revenue_impact_cents INTEGER NOT NULL DEFAULT 0
    CHECK (net_revenue_impact_cents >= 0),

  -- Staleness guard. Deliberately NOT a monotonic status rank: a late
  -- lost -> won transition is legitimate and must be allowed through.
  --
  -- Stripe event timestamps do NOT form a unique total order — two distinct,
  -- legitimate events can share one event.created value. Only a STRICTLY older
  -- event is stale; an equal timestamp is applied, because the UNIQUE event id
  -- has already ruled out a duplicate. last_applied_event_id records which event
  -- won so the decision is auditable.
  last_applied_event_at TIMESTAMPTZ,
  last_applied_event_id TEXT,

  opened_at          TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT order_disputes_stripe_uq UNIQUE (stripe_dispute_id),
  CONSTRAINT dispute_offset_le_amount CHECK (refund_offset_cents <= amount_cents)
);

-- Safe to re-run: if an earlier application of 018 created the table without
-- 'prevented', refresh the constraint rather than silently keeping the old one.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_disputes_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%prevented%'
  ) THEN
    ALTER TABLE order_disputes DROP CONSTRAINT order_disputes_status_check;
    ALTER TABLE order_disputes ADD CONSTRAINT order_disputes_status_check
      CHECK (status IN ('open','under_review','won','lost','withdrawn','prevented'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_disp_order  ON order_disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disp_status ON order_disputes(status, opened_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_order_disputes_updated_at') THEN
    CREATE TRIGGER set_order_disputes_updated_at BEFORE UPDATE ON order_disputes
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Append-only history. Never deleted, never rewritten. A late win appends a new
-- row; the prior lost row remains as evidence of what actually happened.
CREATE TABLE IF NOT EXISTS order_dispute_events (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id             UUID        NOT NULL REFERENCES order_disputes(id) ON DELETE CASCADE,

  stripe_event_id        TEXT        NOT NULL,
  stripe_event_type      TEXT        NOT NULL,
  -- Stripe's own event creation time. This, not arrival order, decides staleness.
  stripe_event_created_at TIMESTAMPTZ NOT NULL,

  from_status            TEXT,
  to_status              TEXT        NOT NULL,
  stripe_status          TEXT,
  -- TRUE only when THIS event's own to_status is what ended up applied. After a
  -- same-timestamp reconciliation the authoritative Stripe object may resolve to
  -- a different status, in which case this stays FALSE and reconciled_to_status
  -- records what actually took effect — so the trail never claims the incoming
  -- webhook state was applied when it was not.
  applied                BOOLEAN     NOT NULL DEFAULT FALSE,
  skipped_reason         TEXT,
  -- The authoritative status applied instead of to_status, when they differ.
  reconciled_to_status   TEXT,
  reconciliation_source  TEXT
    CHECK (reconciliation_source IS NULL OR reconciliation_source IN ('stripe_dispute_object')),
  payload                JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ode_event_uq UNIQUE (stripe_event_id)
);

CREATE INDEX IF NOT EXISTS idx_ode_dispute
  ON order_dispute_events(dispute_id, stripe_event_created_at DESC);

-- Authoritative Stripe money movement for a dispute: the debit, the fee, any
-- counter, and any RETURNED fee when a dispute is won.
--
-- Cash flow and profitability both read this table. The UNIQUE balance
-- transaction id guarantees each real Stripe movement is consumed exactly once no
-- matter how often a webhook is redelivered. Nothing here is inferred from status,
-- so regional and contract differences in fee handling are captured as they are.
CREATE TABLE IF NOT EXISTS dispute_balance_transactions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id            UUID        NOT NULL REFERENCES order_disputes(id) ON DELETE CASCADE,

  stripe_balance_transaction_id TEXT NOT NULL,

  -- Signed. Negative = money out of KVRN, positive = money in (e.g. a reversal).
  amount_cents          INTEGER     NOT NULL,
  fee_cents             INTEGER     NOT NULL DEFAULT 0,
  net_cents             INTEGER     NOT NULL,
  currency              TEXT        NOT NULL DEFAULT 'usd',

  reporting_category    TEXT,
  stripe_created_at     TIMESTAMPTZ,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT dbt_stripe_uq UNIQUE (stripe_balance_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_dbt_dispute ON dispute_balance_transactions(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dbt_created ON dispute_balance_transactions(stripe_created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- resolve_refund_components() — establish an authoritative breakdown
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two routes, both exact. Neither guesses.
--
--   'derived_full_refund' — the refund equals the order total, so the split is
--       deterministic from the order's own snapshot. Used only when the derived
--       components reconcile to the refund total exactly.
--
--   'admin' — an operator supplies the split. Accepted only when the three
--       components sum EXACTLY to the refund total. No component silently
--       defaults to zero or to the whole refund.
CREATE OR REPLACE FUNCTION resolve_refund_components(
  p_refund_id         UUID,
  p_merchandise_cents INTEGER DEFAULT NULL,
  p_shipping_cents    INTEGER DEFAULT NULL,
  p_tax_cents         INTEGER DEFAULT NULL,
  p_actor             TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_ref     RECORD;
  v_ord     RECORD;
  v_merch   INTEGER;
  v_ship    INTEGER;
  v_tax     INTEGER;
  v_source  TEXT;
BEGIN
  SELECT id, order_id, amount_cents, component_breakdown_status
  INTO v_ref
  FROM order_refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_REFUND|NOT_FOUND|%', p_refund_id;
  END IF;

  IF v_ref.component_breakdown_status = 'resolved' THEN
    RETURN jsonb_build_object('outcome','already_resolved','refund_id',p_refund_id);
  END IF;

  IF p_merchandise_cents IS NOT NULL
     OR p_shipping_cents IS NOT NULL
     OR p_tax_cents IS NOT NULL THEN
    -- Admin decomposition. All three must be supplied; a missing value is not
    -- silently treated as zero.
    IF p_merchandise_cents IS NULL OR p_shipping_cents IS NULL OR p_tax_cents IS NULL THEN
      RAISE EXCEPTION 'KVRN_REFUND|INCOMPLETE_DECOMPOSITION|all three components required';
    END IF;
    IF p_merchandise_cents < 0 OR p_shipping_cents < 0 OR p_tax_cents < 0 THEN
      RAISE EXCEPTION 'KVRN_REFUND|NEGATIVE_COMPONENT';
    END IF;
    IF (p_merchandise_cents + p_shipping_cents + p_tax_cents) <> v_ref.amount_cents THEN
      RAISE EXCEPTION 'KVRN_REFUND|DECOMPOSITION_MISMATCH|sum:% refund:%',
        p_merchandise_cents + p_shipping_cents + p_tax_cents, v_ref.amount_cents;
    END IF;
    v_merch := p_merchandise_cents;
    v_ship  := p_shipping_cents;
    v_tax   := p_tax_cents;
    v_source := 'admin';
  ELSE
    -- Deterministic derivation, permitted only for a genuine full refund.
    SELECT subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents
    INTO v_ord FROM orders WHERE id = v_ref.order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_REFUND|ORDER_NOT_FOUND|%', v_ref.order_id;
    END IF;
    IF v_ref.amount_cents <> v_ord.total_cents THEN
      RAISE EXCEPTION 'KVRN_REFUND|NOT_FULL_REFUND|refund:% order_total:%|admin decomposition required',
        v_ref.amount_cents, v_ord.total_cents;
    END IF;
    v_merch := GREATEST(0, v_ord.subtotal_cents - v_ord.discount_cents);
    v_ship  := v_ord.shipping_cents;
    v_tax   := v_ord.tax_cents;
    -- Only accept the derivation if it reconciles exactly to the refund.
    IF (v_merch + v_ship + v_tax) <> v_ref.amount_cents THEN
      RAISE EXCEPTION 'KVRN_REFUND|DERIVATION_DOES_NOT_RECONCILE|derived:% refund:%',
        v_merch + v_ship + v_tax, v_ref.amount_cents;
    END IF;
    v_source := 'derived_full_refund';
  END IF;

  UPDATE order_refunds
  SET merchandise_refund_cents = v_merch,
      shipping_refund_cents    = v_ship,
      tax_refund_cents         = v_tax,
      component_breakdown_status = 'resolved',
      component_breakdown_source = v_source,
      component_breakdown_resolved_at = NOW(),
      component_breakdown_resolved_by = p_actor,
      updated_at = NOW()
  WHERE id = p_refund_id;

  RETURN jsonb_build_object(
    'outcome','resolved','refund_id',p_refund_id,'source',v_source,
    'merchandise_cents',v_merch,'shipping_cents',v_ship,'tax_cents',v_tax
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- allocate_return_refund() — transactional allocation with integrity checks
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cross-row totals cannot be CHECK constraints, so allocation is validated here
-- under row locks on both the refund and the return.
--
-- Enforced:
--   0. the refund's component breakdown is RESOLVED (never fabricated from NULL)
--   1. the return and the refund belong to the SAME order
--   2. cumulative merchandise allocation <= merchandise_refund_cents
--   3. cumulative shipping    allocation <= shipping_refund_cents
--   4. cumulative tax         allocation <= tax_refund_cents
--   5. merchandise allocation <= economically applicable returned value
CREATE OR REPLACE FUNCTION allocate_return_refund(
  p_return_id         UUID,
  p_refund_id         UUID,
  p_merchandise_cents INTEGER,
  p_shipping_cents    INTEGER,
  p_tax_cents         INTEGER,
  p_actor             TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_ret            RECORD;
  v_ref            RECORD;
  v_existing_merch INTEGER;
  v_existing_ship  INTEGER;
  v_existing_tax   INTEGER;
  v_returned_value INTEGER;
  v_ret_existing   INTEGER;
  v_id             UUID;
BEGIN
  IF COALESCE(p_merchandise_cents,0) < 0
     OR COALESCE(p_shipping_cents,0) < 0
     OR COALESCE(p_tax_cents,0) < 0 THEN
    RAISE EXCEPTION 'KVRN_RETURN|NEGATIVE_ALLOCATION';
  END IF;

  SELECT id, order_id INTO v_ret
  FROM order_returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_RETURN|RETURN_NOT_FOUND|%', p_return_id;
  END IF;

  SELECT id, order_id, amount_cents, component_breakdown_status,
         merchandise_refund_cents, shipping_refund_cents, tax_refund_cents
  INTO v_ref
  FROM order_refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_RETURN|REFUND_NOT_FOUND|%', p_refund_id;
  END IF;

  -- 0. No allocation until the split is genuinely known. NULL components are not
  -- permissive caps and are not zero — they are unresolved.
  IF v_ref.component_breakdown_status <> 'resolved' THEN
    RAISE EXCEPTION 'KVRN_RETURN|BREAKDOWN_UNRESOLVED|refund:%|resolve components first',
      p_refund_id;
  END IF;
  IF v_ref.merchandise_refund_cents IS NULL
     OR v_ref.shipping_refund_cents IS NULL
     OR v_ref.tax_refund_cents IS NULL THEN
    RAISE EXCEPTION 'KVRN_RETURN|BREAKDOWN_INCOMPLETE|refund:%', p_refund_id;
  END IF;

  -- 1. Same order.
  IF v_ret.order_id <> v_ref.order_id THEN
    RAISE EXCEPTION 'KVRN_RETURN|ORDER_MISMATCH|return:% refund:%',
      v_ret.order_id, v_ref.order_id;
  END IF;

  SELECT COALESCE(SUM(merchandise_cents),0),
         COALESCE(SUM(shipping_cents),0),
         COALESCE(SUM(tax_cents),0)
  INTO v_existing_merch, v_existing_ship, v_existing_tax
  FROM return_refund_allocations
  WHERE refund_id = p_refund_id AND return_id <> p_return_id;

  -- 2-4. Component caps, from the RESOLVED values only.
  IF v_existing_merch + COALESCE(p_merchandise_cents,0) > v_ref.merchandise_refund_cents THEN
    RAISE EXCEPTION 'KVRN_RETURN|MERCHANDISE_OVER_ALLOCATED|cap:% attempted:%',
      v_ref.merchandise_refund_cents, v_existing_merch + COALESCE(p_merchandise_cents,0);
  END IF;
  IF v_existing_ship + COALESCE(p_shipping_cents,0) > v_ref.shipping_refund_cents THEN
    RAISE EXCEPTION 'KVRN_RETURN|SHIPPING_OVER_ALLOCATED|cap:% attempted:%',
      v_ref.shipping_refund_cents, v_existing_ship + COALESCE(p_shipping_cents,0);
  END IF;
  IF v_existing_tax + COALESCE(p_tax_cents,0) > v_ref.tax_refund_cents THEN
    RAISE EXCEPTION 'KVRN_RETURN|TAX_OVER_ALLOCATED|cap:% attempted:%',
      v_ref.tax_refund_cents, v_existing_tax + COALESCE(p_tax_cents,0);
  END IF;

  -- ── 5. RETURN-SIDE CAP: post-discount net merchandise value ──────────────
  --
  -- The basis is NET of the order discount, not gross. A $100 line bought under a
  -- $20 allocated discount permits $80 of merchandise refund, never $100.
  --
  -- The cap is CUMULATIVE across every refund allocated to this return, so the
  -- same returned merchandise cannot be allocated twice via two partial refunds.
  -- Together with the refund-side caps above, both directions reconcile:
  --   refund side: SUM(allocations against a refund) <= refund merchandise component
  --   return side: SUM(allocations against a return) <= returned net basis
  SELECT COALESCE(SUM(ri.net_merchandise_basis_cents), 0)
  INTO v_returned_value
  FROM order_return_items ri WHERE ri.return_id = p_return_id;

  -- Existing allocations for THIS return, excluding the pair being written so an
  -- update replaces rather than double-counts.
  SELECT COALESCE(SUM(a.merchandise_cents), 0)
  INTO v_ret_existing
  FROM return_refund_allocations a
  WHERE a.return_id = p_return_id AND a.refund_id <> p_refund_id;

  -- Enforced UNCONDITIONALLY. A line whose post-discount net basis is exactly 0
  -- (a fully discounted or free item) must permit exactly 0 merchandise refund,
  -- so guarding this with "> 0" would have let a free item claim real money.
  -- A return with no recorded basis also resolves to 0 here, which refuses
  -- allocation rather than permitting it — unknown is never treated as generous.
  IF (v_ret_existing + COALESCE(p_merchandise_cents,0)) > v_returned_value THEN
    RAISE EXCEPTION 'KVRN_RETURN|EXCEEDS_RETURNED_VALUE|net_basis:% already:% attempted:%',
      v_returned_value, v_ret_existing, p_merchandise_cents;
  END IF;

  INSERT INTO return_refund_allocations (
    return_id, refund_id, merchandise_cents, shipping_cents, tax_cents, created_by
  ) VALUES (
    p_return_id, p_refund_id,
    COALESCE(p_merchandise_cents,0), COALESCE(p_shipping_cents,0),
    COALESCE(p_tax_cents,0), p_actor
  )
  ON CONFLICT (return_id, refund_id) DO UPDATE
    SET merchandise_cents = EXCLUDED.merchandise_cents,
        shipping_cents    = EXCLUDED.shipping_cents,
        tax_cents         = EXCLUDED.tax_cents
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'outcome','allocated','allocation_id',v_id,
    'return_id',p_return_id,'refund_id',p_refund_id,
    'merchandise_cents',COALESCE(p_merchandise_cents,0),
    'shipping_cents',COALESCE(p_shipping_cents,0),
    'tax_cents',COALESCE(p_tax_cents,0)
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- order_dispute_financial_adjustments — APPEND-ONLY revenue recognition ledger
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS.
--
-- order_disputes.net_revenue_impact_cents is CURRENT state and is overwritten as
-- a dispute moves. That alone cannot reproduce a historical period:
--
--   June: dispute lost          -> current row says -$100
--   July: Stripe reverses to won -> current row says 0
--
-- Reporting June from the current row would then show no loss ever happened, and
-- July would show no restoration. The money moved twice and the books recorded
-- neither. This table records each CHANGE instead, so a period is computed from
-- what was recognised at the time:
--
--   period dispute revenue effect = SUM(adjustment_cents WHERE effective_at IN period)
--
-- SIGN CONVENTION: negative reduces recognised revenue, positive restores it.
--
-- Rows are INSERT-ONLY. A later outcome appends a compensating row; it never
-- edits or deletes an earlier one, so June stays -$100 and July becomes +$100.
CREATE TABLE IF NOT EXISTS order_dispute_financial_adjustments (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id            UUID        NOT NULL REFERENCES order_disputes(id) ON DELETE RESTRICT,
  order_id              UUID        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  stripe_dispute_id     TEXT        NOT NULL,

  -- Signed. Negative = revenue reduced, positive = revenue restored.
  adjustment_cents      INTEGER     NOT NULL,

  -- The Stripe event time this economic effect belongs to. Period reporting keys
  -- on THIS, not on when the row happened to be written.
  effective_at          TIMESTAMPTZ NOT NULL,

  -- Provenance sufficient to audit how the number was derived.
  from_status           TEXT,
  to_status             TEXT        NOT NULL,
  disputed_amount_cents INTEGER     NOT NULL,
  refund_offset_cents   INTEGER     NOT NULL DEFAULT 0,
  prior_impact_cents    INTEGER     NOT NULL DEFAULT 0,
  new_impact_cents      INTEGER     NOT NULL DEFAULT 0,

  adjustment_type       TEXT        NOT NULL
    CHECK (adjustment_type IN ('dispute_lost','dispute_restored','dispute_revised')),

  -- Which path produced it, and from which Stripe event.
  source                TEXT        NOT NULL
    CHECK (source IN ('webhook_event','reconciliation')),
  stripe_event_id       TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency: one adjustment per (event, path). A redelivered webhook cannot
  -- append a second identical economic effect.
  CONSTRAINT odfa_event_source_uq UNIQUE (stripe_event_id, source)
);

CREATE INDEX IF NOT EXISTS idx_odfa_effective ON order_dispute_financial_adjustments(effective_at);
CREATE INDEX IF NOT EXISTS idx_odfa_dispute   ON order_dispute_financial_adjustments(dispute_id);
CREATE INDEX IF NOT EXISTS idx_odfa_order     ON order_dispute_financial_adjustments(order_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- allocate_order_discount_to_items() — THE canonical per-line discount split
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Largest-remainder (Hamilton) apportionment, weighted by line gross value.
-- This is the SAME method as allocateDiscountToLines() in
-- lib/financial-calculator.ts, deliberately mirrored rather than re-invented:
--   1. exact share  = discount x line_gross / order_gross
--   2. each line takes floor(exact share)
--   3. leftover cents go to the largest fractional remainders
--   4. ties break by line_gross DESC then order_item_id ASC — fully deterministic
--
-- GUARANTEE, asserted in the test suite:
--   SUM(net_cents) = orders.subtotal_cents - orders.discount_cents, exactly.
--
-- That identity holds because finalize_paid_order sets
-- subtotal_cents = SUM(unit_price_cents * quantity) and
-- line_total_cents = unit_price_cents * quantity, so SUM(line_total) = subtotal.
CREATE OR REPLACE FUNCTION allocate_order_discount_to_items(p_order_id UUID)
RETURNS TABLE (
  order_item_id            UUID,
  gross_cents              INTEGER,
  allocated_discount_cents INTEGER,
  net_cents                INTEGER
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_order_gross INTEGER;
  v_discount    INTEGER;
  v_leftover    INTEGER;
BEGIN
  SELECT COALESCE(SUM(oi.line_total_cents), 0) INTO v_order_gross
  FROM order_items oi WHERE oi.order_id = p_order_id;

  SELECT COALESCE(o.discount_cents, 0) INTO v_discount
  FROM orders o WHERE o.id = p_order_id;

  -- Never allocate more discount than there is merchandise to discount.
  v_discount := LEAST(GREATEST(v_discount, 0), GREATEST(v_order_gross, 0));

  IF v_order_gross <= 0 THEN
    RETURN QUERY
      SELECT oi.id, oi.line_total_cents, 0, oi.line_total_cents
      FROM order_items oi WHERE oi.order_id = p_order_id;
    RETURN;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT oi.id,
           oi.line_total_cents AS gross,
           (v_discount::numeric * oi.line_total_cents) / v_order_gross AS exact
    FROM order_items oi WHERE oi.order_id = p_order_id
  ),
  floored AS (
    SELECT id, gross, FLOOR(exact)::int AS base_alloc, exact - FLOOR(exact) AS remainder
    FROM base
  ),
  ranked AS (
    SELECT id, gross, base_alloc,
           ROW_NUMBER() OVER (ORDER BY remainder DESC, gross DESC, id ASC) AS rn
    FROM floored
  ),
  totals AS (
    SELECT v_discount - COALESCE(SUM(base_alloc), 0) AS leftover FROM floored
  )
  SELECT r.id,
         r.gross,
         (r.base_alloc + CASE WHEN r.rn <= (SELECT leftover FROM totals) THEN 1 ELSE 0 END)::int,
         (r.gross - (r.base_alloc + CASE WHEN r.rn <= (SELECT leftover FROM totals) THEN 1 ELSE 0 END))::int
  FROM ranked r;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- create_order_return() — atomic return creation with quantity guard
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cumulative returned quantity per order line can never exceed the quantity
-- actually ordered. That is a cross-row rule, so it is enforced here with the
-- order row locked rather than as a CHECK constraint.
--
-- Unit COGS and unit price are snapshotted from order_items at creation, so a
-- later cost-batch change cannot retroactively alter the economics of goods that
-- have already come back.
CREATE OR REPLACE FUNCTION create_order_return(
  p_order_id        UUID,
  p_items           JSONB,
  p_shipping_payer  TEXT,
  p_reason          TEXT,
  p_notes           TEXT,
  p_actor           TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_return_id  UUID;
  v_number     TEXT;
  v_item       JSONB;
  v_oi         RECORD;
  v_already    INTEGER;
  v_qty        INTEGER;
  v_count      INTEGER := 0;
  v_alloc      RECORD;
  v_net_line   INTEGER;
  v_disc_line  INTEGER;
  v_net_basis  INTEGER;
  v_disc_part  INTEGER;
  v_gross_part INTEGER;
BEGIN
  PERFORM 1 FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_RETURN|ORDER_NOT_FOUND|%', p_order_id;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'KVRN_RETURN|NO_ITEMS';
  END IF;

  v_number := 'RET-' || LPAD(nextval('return_number_seq')::TEXT, 6, '0');

  INSERT INTO order_returns (
    order_id, return_number, status, return_shipping_paid_by, reason, notes, created_by
  ) VALUES (
    p_order_id, v_number, 'requested',
    COALESCE(NULLIF(p_shipping_payer,''), 'not_applicable'),
    NULLIF(p_reason,''), NULLIF(p_notes,''), p_actor
  ) RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'quantity')::INTEGER;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'KVRN_RETURN|INVALID_QUANTITY';
    END IF;

    SELECT id, order_id, quantity, unit_price_cents, unit_cogs_cents
    INTO v_oi
    FROM order_items WHERE id = (v_item->>'orderItemId')::UUID;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_RETURN|ORDER_ITEM_NOT_FOUND|%', v_item->>'orderItemId';
    END IF;
    IF v_oi.order_id <> p_order_id THEN
      RAISE EXCEPTION 'KVRN_RETURN|ITEM_ORDER_MISMATCH|%', v_oi.id;
    END IF;

    -- Cumulative guard across every prior return for this line.
    SELECT COALESCE(SUM(ri.quantity), 0) INTO v_already
    FROM order_return_items ri
    JOIN order_returns r ON r.id = ri.return_id
    WHERE ri.order_item_id = v_oi.id AND r.status <> 'cancelled';

    IF v_already + v_qty > v_oi.quantity THEN
      RAISE EXCEPTION 'KVRN_RETURN|QUANTITY_EXCEEDS_ORDERED|line:% ordered:% already:% requested:%',
        v_oi.id, v_oi.quantity, v_already, v_qty;
    END IF;

    -- ── Post-discount merchandise basis ─────────────────────────────────────
    -- The canonical allocator gives this line's NET value after its share of the
    -- order discount. Gross value would let a discounted unit claim more
    -- merchandise refund than the customer ever paid for it.
    SELECT a.gross_cents, a.allocated_discount_cents, a.net_cents
    INTO v_alloc
    FROM allocate_order_discount_to_items(p_order_id) a
    WHERE a.order_item_id = v_oi.id;

    v_net_line  := COALESCE(v_alloc.net_cents, v_oi.unit_price_cents * v_oi.quantity);
    v_disc_line := COALESCE(v_alloc.allocated_discount_cents, 0);

    -- ── Snapshot the RETURNED PORTION, not the whole line ───────────────────
    --
    -- Every snapshot on this row describes the quantity actually being returned,
    -- so the three fields stay internally consistent for partial returns:
    --
    --     returned_gross - returned_discount = returned_net   (exactly)
    --
    -- Cumulative apportionment, so repeated partial returns of one line telescope
    -- to the original line economics with no rounding drift:
    --     part(X) = round(X x (already+q)/Q) - round(X x already/Q)
    -- Summed over the whole ordered quantity this collapses to round(X) - 0 = X.
    --
    -- NET and DISCOUNT are apportioned independently and GROSS is derived as
    -- their sum. Deriving the other way round (gross - discount) can produce a
    -- negative net on some cent boundaries; deriving gross cannot, because both
    -- inputs are segments of a monotonic rounded ramp and are therefore >= 0.
    -- This also leaves the net basis arithmetic byte-identical to Rev 3, so the
    -- authoritative merchandise cap is unchanged.
    v_net_basis  := ROUND(v_net_line::numeric  * (v_already + v_qty) / v_oi.quantity)::int
                  - ROUND(v_net_line::numeric  * v_already          / v_oi.quantity)::int;
    v_disc_part  := ROUND(v_disc_line::numeric * (v_already + v_qty) / v_oi.quantity)::int
                  - ROUND(v_disc_line::numeric * v_already          / v_oi.quantity)::int;
    v_gross_part := v_net_basis + v_disc_part;

    INSERT INTO order_return_items (
      return_id, order_item_id, quantity, disposition,
      unit_cogs_cents_snapshot, unit_price_cents_snapshot,
      line_gross_cents_snapshot, allocated_discount_cents_snapshot,
      net_merchandise_basis_cents, notes
    ) VALUES (
      v_return_id, v_oi.id, v_qty,
      COALESCE(NULLIF(v_item->>'disposition',''), 'sellable'),
      v_oi.unit_cogs_cents,          -- NULL stays NULL: cost unknown, never 0
      v_oi.unit_price_cents,
      v_gross_part, v_disc_part,
      v_net_basis,
      NULLIF(v_item->>'notes','')
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'outcome','created','return_id',v_return_id,
    'return_number',v_number,'item_count',v_count
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- create_order_exchange() — replacement units, no revenue
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An exchange creates replacement COGS and shipping cost but NO merchandise
-- revenue. A price difference is recorded as 'pending' and has no financial
-- effect until it is settled with authoritative Stripe evidence.
--
-- Replacement COGS is snapshotted at creation via the existing resolve_cost_batch,
-- exactly as a sale would be, so replacement cost is real and immutable.
CREATE OR REPLACE FUNCTION create_order_exchange(
  p_order_id     UUID,
  p_return_id    UUID,
  p_items        JSONB,
  p_price_diff   INTEGER,
  p_reason       TEXT,
  p_actor        TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_exchange_id UUID;
  v_number      TEXT;
  v_item        JSONB;
  v_variant     RECORD;
  v_batch       product_cost_batches;
  v_qty         INTEGER;
  v_count       INTEGER := 0;
  v_today       DATE := (NOW() AT TIME ZONE 'UTC')::DATE;
BEGIN
  PERFORM 1 FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_EXCHANGE|ORDER_NOT_FOUND|%', p_order_id;
  END IF;

  IF p_return_id IS NOT NULL THEN
    PERFORM 1 FROM order_returns WHERE id = p_return_id AND order_id = p_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'KVRN_EXCHANGE|RETURN_ORDER_MISMATCH|%', p_return_id;
    END IF;
  END IF;

  v_number := 'EXC-' || LPAD(nextval('exchange_number_seq')::TEXT, 6, '0');

  INSERT INTO order_exchanges (
    order_id, return_id, exchange_number, status,
    price_difference_cents, price_difference_status, reason, created_by
  ) VALUES (
    p_order_id, p_return_id, v_number, 'pending',
    COALESCE(p_price_diff, 0),
    -- Zero difference needs no settlement; anything else starts unsettled.
    CASE WHEN COALESCE(p_price_diff,0) = 0 THEN 'none' ELSE 'pending' END,
    NULLIF(p_reason,''), p_actor
  ) RETURNING id INTO v_exchange_id;

  IF p_items IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_qty := (v_item->>'quantity')::INTEGER;
      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'KVRN_EXCHANGE|INVALID_QUANTITY';
      END IF;

      SELECT id, sku INTO v_variant
      FROM product_variants WHERE id = (v_item->>'variantId')::UUID;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'KVRN_EXCHANGE|VARIANT_NOT_FOUND|%', v_item->>'variantId';
      END IF;

      -- Cost failure must never block the exchange: NULL means unknown, not 0.
      v_batch := resolve_cost_batch(v_variant.id, v_today);

      INSERT INTO order_exchange_items (
        exchange_id, variant_id, sku, quantity,
        unit_cogs_cents_snapshot, line_cogs_cents
      ) VALUES (
        v_exchange_id, v_variant.id, v_variant.sku, v_qty,
        v_batch.unit_cogs_cents,
        CASE WHEN v_batch.unit_cogs_cents IS NULL THEN NULL
             ELSE v_batch.unit_cogs_cents * v_qty END
      );
      v_count := v_count + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'outcome','created','exchange_id',v_exchange_id,
    'exchange_number',v_number,'item_count',v_count
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- upsert_order_dispute() — idempotent, staleness-guarded dispute state
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Idempotency: order_dispute_events.stripe_event_id is UNIQUE, so a redelivered
-- webhook records nothing new and applies nothing.
--
-- Staleness: an event is applied only when its Stripe timestamp is NEWER than
-- last_applied_event_at. This is deliberately not a status-rank check, so a late
-- lost -> won transition is accepted while genuinely out-of-order delivery is not.
--
-- Revenue impact is frozen only at a terminal state, and only for the portion NOT
-- already refunded, so a dispute and a refund can never reduce revenue twice for
-- the same money.
CREATE OR REPLACE FUNCTION upsert_order_dispute(
  p_stripe_dispute_id  TEXT,
  p_stripe_charge_id   TEXT,
  p_payment_intent_id  TEXT,
  p_amount_cents       INTEGER,
  p_currency           TEXT,
  p_stripe_status      TEXT,
  p_mapped_status      TEXT,
  p_stripe_event_id    TEXT,
  p_stripe_event_type  TEXT,
  p_event_created_at   TIMESTAMPTZ,
  p_opened_at          TIMESTAMPTZ,
  p_payload            JSONB
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id   UUID;
  v_dispute    RECORD;
  v_refunded   INTEGER;
  v_offset     INTEGER;
  v_impact     INTEGER;
  v_from       TEXT;
  -- Prior recognised impact, used to append the DELTA to the ledger.
  v_prior_impact INTEGER := 0;
  v_delta        INTEGER := 0;
  -- Non-null when THIS call created the dispute row, so the audit trail can show
  -- "no prior state" rather than echoing the incoming status back as from_status.
  v_created_id   UUID;
BEGIN
  -- Resolve the order from the payment intent, falling back to the charge id.
  SELECT id INTO v_order_id FROM orders
  WHERE stripe_payment_intent_id = p_payment_intent_id
     OR (p_stripe_charge_id IS NOT NULL AND stripe_charge_id = p_stripe_charge_id)
  LIMIT 1;

  IF v_order_id IS NULL THEN
    -- Unknown order: acknowledge without inventing a dispute record.
    RETURN jsonb_build_object('outcome','no_order','stripe_dispute_id',p_stripe_dispute_id);
  END IF;

  -- Create on first sight; lock thereafter.
  INSERT INTO order_disputes (
    order_id, stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id,
    amount_cents, currency, stripe_status, status, opened_at
  ) VALUES (
    v_order_id, p_stripe_dispute_id, NULLIF(p_stripe_charge_id,''),
    NULLIF(p_payment_intent_id,''), p_amount_cents,
    COALESCE(NULLIF(p_currency,''),'usd'), p_stripe_status, p_mapped_status,
    COALESCE(p_opened_at, NOW())
  )
  ON CONFLICT (stripe_dispute_id) DO NOTHING
  RETURNING id INTO v_created_id;

  SELECT id, status, stripe_status, amount_cents, last_applied_event_at,
         net_revenue_impact_cents
  INTO v_dispute
  FROM order_disputes WHERE stripe_dispute_id = p_stripe_dispute_id FOR UPDATE;
  v_prior_impact := COALESCE(v_dispute.net_revenue_impact_cents, 0);

  -- A dispute seen for the first time has no prior state. Without this the row
  -- was just inserted with the incoming status, so from_status would echo it back.
  v_from := CASE WHEN v_created_id IS NOT NULL THEN NULL ELSE v_dispute.status END;

  -- Duplicate delivery: the UNIQUE key absorbs it.
  INSERT INTO order_dispute_events (
    dispute_id, stripe_event_id, stripe_event_type, stripe_event_created_at,
    from_status, to_status, stripe_status, applied, payload
  ) VALUES (
    v_dispute.id, p_stripe_event_id, p_stripe_event_type, p_event_created_at,
    v_from, p_mapped_status, p_stripe_status, FALSE, p_payload
  )
  ON CONFLICT (stripe_event_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'outcome','duplicate_event','dispute_id',v_dispute.id,
      'stripe_event_id',p_stripe_event_id
    );
  END IF;

  -- ── Staleness: STRICTLY older only ──────────────────────────────────────
  --
  -- Stripe event.created is not a unique total order. Two distinct legitimate
  -- events (for example charge.dispute.closed and charge.dispute.funds_reinstated
  -- fired at the same instant) can share a timestamp, and discarding one of them
  -- would lose real accounting information.
  --
  -- An exact duplicate is impossible here: the UNIQUE stripe_event_id check above
  -- has already returned. So an equal timestamp always means a DISTINCT event.
  --
  -- Equal-timestamp events are NOT resolved by delivery order. See the conflict
  -- branch below: webhook delivery sequence is not an authoritative chronological
  -- tie-break, and letting it decide would mean the same Stripe history produced
  -- different financial state depending on which packet arrived first.
  IF v_dispute.last_applied_event_at IS NOT NULL
     AND p_event_created_at < v_dispute.last_applied_event_at THEN
    UPDATE order_dispute_events
    SET applied = FALSE, skipped_reason = 'stale_event'
    WHERE stripe_event_id = p_stripe_event_id;
    RETURN jsonb_build_object(
      'outcome','stale_event','dispute_id',v_dispute.id,
      'last_applied_at',v_dispute.last_applied_event_at
    );
  END IF;

  -- ── Equal timestamp with a CONFLICTING outcome ──────────────────────────
  --
  -- Two distinct events share event.created and imply different dispute states.
  -- Applying whichever arrived last would make the final financial state depend
  -- on webhook delivery order, so A->B and B->A would disagree. Stripe does not
  -- guarantee delivery order, and event ids are not chronological, so neither can
  -- break the tie.
  --
  -- Instead the caller must reconcile against the CURRENT authoritative Stripe
  -- Dispute object and apply that via reconcile_order_dispute(). The event is
  -- still recorded here for audit history, marked awaiting_reconciliation.
  --
  -- Non-conflicting equal-timestamp events (same resulting status) fall through
  -- and are applied normally: they add idempotent information only.
  IF v_dispute.last_applied_event_at IS NOT NULL
     AND p_event_created_at = v_dispute.last_applied_event_at
     AND v_dispute.status IS DISTINCT FROM p_mapped_status THEN
    UPDATE order_dispute_events
    SET applied = FALSE, skipped_reason = 'awaiting_reconciliation'
    WHERE stripe_event_id = p_stripe_event_id;
    RETURN jsonb_build_object(
      'outcome','needs_reconciliation','dispute_id',v_dispute.id,
      'stripe_dispute_id',p_stripe_dispute_id,
      'current_status',v_dispute.status,'incoming_status',p_mapped_status,
      'event_created_at',p_event_created_at
    );
  END IF;

  -- ── Refund offset, SCOPED TO THE DISPUTED MONEY ─────────────────────────
  --
  -- Summing every succeeded refund on the order would be wrong: once exchange
  -- price differences exist, one order can carry several payment intents, and a
  -- dispute against payment A must not be offset by a refund belonging to
  -- payment B.
  --
  -- Attribution, strongest first:
  --   1. refund.stripe_charge_id         = the disputed charge
  --   2. refund.stripe_payment_intent_id = the disputed payment intent
  --   3. LEGACY ONLY: refunds predating those identifiers (both NULL) are
  --      attributed only when the order is unambiguous — that is, it has no
  --      exchange price-difference payment intent that could own them. Where
  --      ambiguity exists the refund is excluded rather than guessed, because a
  --      wrong offset silently misstates revenue.
  SELECT COALESCE(SUM(r.amount_cents),0) INTO v_refunded
  FROM order_refunds r
  WHERE r.order_id = v_order_id
    AND r.status = 'succeeded'
    AND (
      (p_stripe_charge_id IS NOT NULL AND r.stripe_charge_id = p_stripe_charge_id)
      OR (p_payment_intent_id IS NOT NULL
          AND r.stripe_payment_intent_id = p_payment_intent_id)
      OR (
        r.stripe_charge_id IS NULL
        AND r.stripe_payment_intent_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM order_exchanges e
          WHERE e.order_id = v_order_id
            AND e.price_difference_payment_intent_id IS NOT NULL
        )
      )
    );

  v_offset := LEAST(COALESCE(v_refunded,0), p_amount_cents);

  -- Only a lost dispute reduces revenue, and only net of refunds.
  v_impact := CASE WHEN p_mapped_status = 'lost'
                   THEN GREATEST(0, p_amount_cents - v_offset)
                   ELSE 0 END;

  UPDATE order_disputes
  SET stripe_status            = p_stripe_status,
      status                   = p_mapped_status,
      amount_cents             = p_amount_cents,
      stripe_charge_id         = COALESCE(NULLIF(p_stripe_charge_id,''), stripe_charge_id),
      stripe_payment_intent_id = COALESCE(NULLIF(p_payment_intent_id,''), stripe_payment_intent_id),
      refund_offset_cents      = v_offset,
      net_revenue_impact_cents = v_impact,
      last_applied_event_at    = p_event_created_at,
      last_applied_event_id    = p_stripe_event_id,
      resolved_at = CASE WHEN p_mapped_status IN ('won','lost','withdrawn','prevented')
                         THEN COALESCE(resolved_at, NOW()) ELSE resolved_at END,
      updated_at = NOW()
  WHERE id = v_dispute.id;

  UPDATE order_dispute_events
  SET applied = TRUE WHERE stripe_event_id = p_stripe_event_id;

  -- ── Append-only economic effect ─────────────────────────────────────────
  -- Record the CHANGE in recognised impact, not the new absolute value, so a
  -- historical period keeps what was recognised at the time. A re-assertion of
  -- the same status yields a zero delta and appends nothing.
  v_delta := -(v_impact - COALESCE(v_prior_impact, 0));
  IF v_delta <> 0 THEN
    INSERT INTO order_dispute_financial_adjustments (
      dispute_id, order_id, stripe_dispute_id, adjustment_cents, effective_at,
      from_status, to_status, disputed_amount_cents, refund_offset_cents,
      prior_impact_cents, new_impact_cents, adjustment_type, source, stripe_event_id
    ) VALUES (
      v_dispute.id, v_order_id, p_stripe_dispute_id, v_delta, p_event_created_at,
      v_from, p_mapped_status, p_amount_cents, v_offset,
      COALESCE(v_prior_impact,0), v_impact,
      CASE WHEN v_delta < 0 AND COALESCE(v_prior_impact,0) = 0 THEN 'dispute_lost'
           WHEN v_delta > 0 AND v_impact = 0                   THEN 'dispute_restored'
           ELSE 'dispute_revised' END,
      'webhook_event', p_stripe_event_id
    )
    ON CONFLICT (stripe_event_id, source) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'outcome','applied','dispute_id',v_dispute.id,
    'revenue_adjustment_cents', v_delta,
    'from_status',v_from,'to_status',p_mapped_status,
    'same_timestamp', (v_dispute.last_applied_event_at = p_event_created_at),
    'refund_offset_cents',v_offset,'net_revenue_impact_cents',v_impact
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- reconcile_order_dispute() — authoritative state from the live Stripe object
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Called when two distinct events share an event.created timestamp and imply
-- CONFLICTING dispute states. Rather than letting webhook delivery order decide,
-- the caller fetches the current Stripe Dispute object and passes it here.
--
-- WHY THIS IS ORDER-INDEPENDENT: whichever of the tied events arrives second
-- triggers reconciliation, and reconciliation reads the same live Stripe object
-- regardless of arrival sequence. A->B and B->A therefore converge on identical
-- final state. Re-running it is idempotent for the same reason.
--
-- last_applied_event_at is deliberately NOT advanced to "now". Advancing it would
-- make genuinely newer future events look stale and silently drop them. It stays
-- pinned to the tied events' timestamp, so a later real transition (including a
-- late lost -> won) still applies normally.
CREATE OR REPLACE FUNCTION reconcile_order_dispute(
  p_stripe_dispute_id  TEXT,
  p_stripe_status      TEXT,
  p_mapped_status      TEXT,
  p_amount_cents       INTEGER,
  p_stripe_charge_id   TEXT,
  p_payment_intent_id  TEXT,
  p_event_created_at   TIMESTAMPTZ,
  p_trigger_event_id   TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_dispute      RECORD;
  v_order_id     UUID;
  v_refunded     INTEGER;
  v_offset       INTEGER;
  v_impact       INTEGER;
  v_from         TEXT;
  v_delta        INTEGER := 0;
  -- Prior recognised impact, used to append the DELTA to the ledger.
  v_prior_impact INTEGER := 0;
  -- The incoming event's own to_status, compared against the authoritative
  -- outcome so the audit trail never claims it was applied when it wasn't.
  v_incoming     TEXT;
BEGIN
  SELECT id, order_id, status, amount_cents, last_applied_event_at,
         net_revenue_impact_cents
  INTO v_dispute
  FROM order_disputes WHERE stripe_dispute_id = p_stripe_dispute_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome','no_dispute','stripe_dispute_id',p_stripe_dispute_id);
  END IF;

  v_from     := v_dispute.status;
  v_order_id := v_dispute.order_id;
  v_prior_impact := COALESCE(v_dispute.net_revenue_impact_cents, 0);

  -- Same scoping rule as upsert_order_dispute: only refunds attributable to the
  -- disputed money offset it. See that function for the full rationale.
  SELECT COALESCE(SUM(r.amount_cents),0) INTO v_refunded
  FROM order_refunds r
  WHERE r.order_id = v_order_id
    AND r.status = 'succeeded'
    AND (
      (p_stripe_charge_id IS NOT NULL AND r.stripe_charge_id = p_stripe_charge_id)
      OR (p_payment_intent_id IS NOT NULL
          AND r.stripe_payment_intent_id = p_payment_intent_id)
      OR (
        r.stripe_charge_id IS NULL
        AND r.stripe_payment_intent_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM order_exchanges e
          WHERE e.order_id = v_order_id
            AND e.price_difference_payment_intent_id IS NOT NULL
        )
      )
    );

  v_offset := LEAST(COALESCE(v_refunded,0), p_amount_cents);
  v_impact := CASE WHEN p_mapped_status = 'lost'
                   THEN GREATEST(0, p_amount_cents - v_offset)
                   ELSE 0 END;

  UPDATE order_disputes
  SET stripe_status            = p_stripe_status,
      status                   = p_mapped_status,
      amount_cents             = p_amount_cents,
      stripe_charge_id         = COALESCE(NULLIF(p_stripe_charge_id,''), stripe_charge_id),
      stripe_payment_intent_id = COALESCE(NULLIF(p_payment_intent_id,''), stripe_payment_intent_id),
      refund_offset_cents      = v_offset,
      net_revenue_impact_cents = v_impact,
      -- Pinned to the tied timestamp, never advanced to NOW().
      last_applied_event_at    = COALESCE(p_event_created_at, last_applied_event_at),
      last_applied_event_id    = COALESCE(p_trigger_event_id, last_applied_event_id),
      resolved_at = CASE WHEN p_mapped_status IN ('won','lost','withdrawn','prevented')
                         THEN COALESCE(resolved_at, NOW()) ELSE resolved_at END,
      updated_at = NOW()
  WHERE id = v_dispute.id;

  -- ── Honest audit marking ────────────────────────────────────────────────
  -- applied is TRUE only when the incoming event's own to_status is what actually
  -- took effect. When the authoritative Stripe object resolved to something else,
  -- the event stays NOT applied and reconciled_to_status records what did — so
  -- the trail never claims an incoming webhook state was applied when it wasn't.
  IF p_trigger_event_id IS NOT NULL THEN
    SELECT to_status INTO v_incoming
    FROM order_dispute_events WHERE stripe_event_id = p_trigger_event_id;

    UPDATE order_dispute_events
    SET applied = (v_incoming IS NOT DISTINCT FROM p_mapped_status),
        skipped_reason = CASE
          WHEN v_incoming IS NOT DISTINCT FROM p_mapped_status
            THEN 'confirmed_by_reconciliation'
          ELSE 'superseded_by_reconciliation' END,
        reconciled_to_status  = p_mapped_status,
        reconciliation_source = 'stripe_dispute_object'
    WHERE stripe_event_id = p_trigger_event_id;
  END IF;

  -- Append-only economic effect from the AUTHORITATIVE outcome. Because the tied
  -- event that triggered reconciliation was never applied, exactly one adjustment
  -- results from a same-timestamp conflict, never two contradictory ones.
  v_delta := -(v_impact - v_prior_impact);
  IF v_delta <> 0 THEN
    INSERT INTO order_dispute_financial_adjustments (
      dispute_id, order_id, stripe_dispute_id, adjustment_cents, effective_at,
      from_status, to_status, disputed_amount_cents, refund_offset_cents,
      prior_impact_cents, new_impact_cents, adjustment_type, source, stripe_event_id
    ) VALUES (
      v_dispute.id, v_order_id, p_stripe_dispute_id, v_delta,
      COALESCE(p_event_created_at, NOW()),
      v_from, p_mapped_status, p_amount_cents, v_offset,
      v_prior_impact, v_impact,
      CASE WHEN v_delta < 0 AND v_prior_impact = 0 THEN 'dispute_lost'
           WHEN v_delta > 0 AND v_impact = 0  THEN 'dispute_restored'
           ELSE 'dispute_revised' END,
      'reconciliation', p_trigger_event_id
    )
    ON CONFLICT (stripe_event_id, source) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'outcome','reconciled','dispute_id',v_dispute.id,
    'revenue_adjustment_cents', v_delta,
    'from_status',v_from,'to_status',p_mapped_status,
    'refund_offset_cents',v_offset,'net_revenue_impact_cents',v_impact
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- record_order_refund() — replaced to persist the payment intent
-- ═══════════════════════════════════════════════════════════════════════════
--
-- IDENTICAL 9-argument signature to migration 015. The ONLY change is that the
-- INSERT now stores stripe_payment_intent_id, which this migration added.
--
-- Without this, every refund recorded from now on would leave that column NULL
-- and fall through to the LEGACY branch of the dispute offset scoping above —
-- silently undermining the very correction the column exists for.
--
-- Everything else is preserved byte-for-byte from 015: the amount guard, the
-- order lookup with FOR UPDATE, ON CONFLICT idempotency by stripe_refund_id, the
-- replay/lifecycle UPDATE path, the succeeded-only refunded total, and the
-- payment_status transition that marks an order refunded only once cumulative
-- succeeded refunds reach the amount actually paid.
CREATE OR REPLACE FUNCTION record_order_refund(
  p_stripe_refund_id  TEXT,
  p_payment_intent_id TEXT,
  p_charge_id         TEXT,
  p_amount_cents      INTEGER,
  p_currency          TEXT,
  p_status            TEXT,
  p_reason            TEXT,
  p_fee_refunded      INTEGER,
  p_refunded_at       TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id       UUID;
  v_order_total    INTEGER;
  v_existing_id    UUID;
  v_refunded_total INTEGER;
  v_outcome        TEXT;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('outcome','ignored_zero_amount');
  END IF;

  SELECT id, total_cents INTO v_order_id, v_order_total
  FROM orders
  WHERE stripe_payment_intent_id = p_payment_intent_id
  FOR UPDATE;

  IF v_order_id IS NULL THEN
    RETURN jsonb_build_object('outcome','no_order');
  END IF;

  SELECT id INTO v_existing_id
  FROM order_refunds WHERE stripe_refund_id = p_stripe_refund_id;

  IF v_existing_id IS NULL THEN
    INSERT INTO order_refunds (
      order_id, stripe_refund_id, stripe_charge_id, stripe_payment_intent_id,
      amount_cents, currency, fee_refunded_cents, status, reason, refunded_at
    ) VALUES (
      v_order_id, p_stripe_refund_id, NULLIF(p_charge_id,''),
      NULLIF(p_payment_intent_id,''),                 -- NEW: scoping identifier
      p_amount_cents,
      COALESCE(NULLIF(p_currency,''),'usd'), p_fee_refunded,
      COALESCE(NULLIF(p_status,''),'pending'), NULLIF(p_reason,''),
      COALESCE(p_refunded_at, NOW())
    )
    ON CONFLICT (stripe_refund_id) DO NOTHING;
    v_outcome := 'recorded';
  ELSE
    UPDATE order_refunds
    SET status             = COALESCE(NULLIF(p_status,''), status),
        amount_cents       = p_amount_cents,
        fee_refunded_cents = COALESCE(p_fee_refunded, fee_refunded_cents),
        refunded_at        = COALESCE(p_refunded_at, refunded_at),
        -- Backfill the identifier on replay if it was previously unknown.
        stripe_charge_id   = COALESCE(stripe_charge_id, NULLIF(p_charge_id,'')),
        stripe_payment_intent_id =
          COALESCE(stripe_payment_intent_id, NULLIF(p_payment_intent_id,'')),
        updated_at         = NOW()
    WHERE id = v_existing_id;
    v_outcome := 'updated';
  END IF;

  SELECT COALESCE(SUM(amount_cents),0) INTO v_refunded_total
  FROM order_refunds
  WHERE order_id = v_order_id AND status = 'succeeded';

  UPDATE orders
  SET payment_status = CASE
        WHEN v_refunded_total >= v_order_total THEN 'refunded'
        ELSE payment_status
      END,
      updated_at = NOW()
  WHERE id = v_order_id;

  RETURN jsonb_build_object(
    'outcome',        v_outcome,
    'order_id',       v_order_id,
    'refunded_total', v_refunded_total,
    'fully_refunded', v_refunded_total >= v_order_total
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- backfill_refund_payment_intents() — populate the new scoping identifier
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Existing refunds predate order_refunds.stripe_payment_intent_id. Where the
-- order carries exactly one payment intent and no exchange price-difference
-- payment intent exists, attribution is unambiguous and can be backfilled safely.
-- Ambiguous rows are deliberately left NULL and fall to the legacy branch above.
UPDATE order_refunds r
SET stripe_payment_intent_id = o.stripe_payment_intent_id
FROM orders o
WHERE r.order_id = o.id
  AND r.stripe_payment_intent_id IS NULL
  AND o.stripe_payment_intent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM order_exchanges e
    WHERE e.order_id = o.id AND e.price_difference_payment_intent_id IS NOT NULL
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- admin_audit_logs indexes
-- ═══════════════════════════════════════════════════════════════════════════
-- The table exists from migration 001 and is already written to by Batch 1/2
-- admin routes, but has no indexes at all. Batch 3 adds substantially more audit
-- traffic, so the common lookups are indexed here.
CREATE INDEX IF NOT EXISTS idx_aal_resource ON admin_audit_logs(resource, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_actor    ON admin_audit_logs(actor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_created  ON admin_audit_logs(created_at DESC);

COMMIT;

SELECT 'order_returns'                AS tbl, COUNT(*) FROM order_returns
UNION ALL SELECT 'order_return_items',          COUNT(*) FROM order_return_items
UNION ALL SELECT 'return_refund_allocations',   COUNT(*) FROM return_refund_allocations
UNION ALL SELECT 'order_exchanges',             COUNT(*) FROM order_exchanges
UNION ALL SELECT 'order_exchange_items',        COUNT(*) FROM order_exchange_items
UNION ALL SELECT 'order_disputes',              COUNT(*) FROM order_disputes
UNION ALL SELECT 'order_dispute_events',        COUNT(*) FROM order_dispute_events
UNION ALL SELECT 'dispute_balance_transactions',COUNT(*) FROM dispute_balance_transactions
UNION ALL SELECT 'refunds_awaiting_breakdown',  COUNT(*) FROM order_refunds
  WHERE component_breakdown_status = 'unknown';
