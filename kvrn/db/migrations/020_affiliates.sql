-- KVRN Migration 020 — Affiliate / referral accounting
--
-- Phase B Batch 3, part 3 of 3 (018 -> 019 -> 020). Additive only: new tables and
-- new functions. Nothing in 018 or 019 is altered, dropped or replaced.
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
--
-- Not a second discount engine. Affiliate customer discounts are ordinary rows in
-- `discounts` (system_managed = TRUE), so claim, redemption, stacking and the
-- NO_CLAIM_FOR_LIMITED_CODE invariant in finalize_paid_order all keep working
-- untouched. A customer discount and an affiliate commission are DIFFERENT
-- economic effects and both may legitimately apply to one order: the discount
-- reduces what the customer paid, and it therefore also reduces the commission
-- base, so it is accounted exactly once.
--
-- Not a second revenue or refund system. Revenue still moves only through
-- order_refunds and lost disputes, exactly as 018 defines.
--
-- ── THE COMMISSION BASE ─────────────────────────────────────────────────────
--
--   commission_base_cents = orders.subtotal_cents - orders.discount_cents
--
-- Net merchandise only. Shipping is cost recovery, not margin. Sales tax is never
-- KVRN revenue. The base and a formula version are SNAPSHOTTED at accrual so a
-- later policy change cannot reinterpret a historical order.
--
-- ── THE CENTRAL DOUBLE-COUNT DEFENCE ────────────────────────────────────────
--
-- Refunds and disputes can cover the SAME merchandise. Both paths therefore
-- advance ONE shared counter, cumulative_merchandise_reversed_after, and each
-- reversal is the difference between the cumulative target after it and before:
--
--   reversal = round(commission x cum_after / base) - round(commission x cum_before / base)
--
-- Telescoping like this is the same technique 018 uses for partial return
-- allocation and 019 uses for partial batch receipts. It loses no cents across
-- any sequence of partial refunds, and because both paths share the counter the
-- same merchandise can never reverse commission twice.
--
-- ── UNKNOWN IS NEVER ZERO ───────────────────────────────────────────────────
--
-- A refund whose component breakdown is unresolved, or a PARTIAL dispute with no
-- deterministic merchandise decomposition, produces NO adjustment. The commission
-- is flagged incomplete and is excluded from payout until an admin supplies the
-- verified decomposition. Nothing is guessed and nothing is treated as zero.
--
-- Run after 001-019.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS affiliate_payout_number_seq START 1000 INCREMENT 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- AFFILIATES
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliates (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  email         TEXT,

  -- Current status is a SUMMARY. Historical validity is reproduced from
  -- affiliate_status_events, never from this column.
  status        TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','terminated')),

  default_commission_type TEXT NOT NULL DEFAULT 'percentage'
    CHECK (default_commission_type IN ('percentage','fixed')),
  default_commission_rate_bps    INTEGER
    CHECK (default_commission_rate_bps IS NULL
           OR (default_commission_rate_bps > 0 AND default_commission_rate_bps <= 10000)),
  default_commission_fixed_cents INTEGER
    CHECK (default_commission_fixed_cents IS NULL OR default_commission_fixed_cents >= 0),

  -- How a fixed commission reverses on a partial refund. Snapshotted per order.
  default_fixed_reversal_policy TEXT NOT NULL DEFAULT 'proportional'
    CHECK (default_fixed_reversal_policy IN ('proportional','all_or_nothing')),

  attribution_window_days INTEGER NOT NULL DEFAULT 30
    CHECK (attribution_window_days > 0 AND attribution_window_days <= 365),

  -- Hold before a commission becomes automatically eligible. Snapshotted per
  -- order so a later change cannot move a historical eligibility date.
  commission_hold_days    INTEGER NOT NULL DEFAULT 30
    CHECK (commission_hold_days >= 0 AND commission_hold_days <= 365),

  -- The customer-facing discount, if any. An ORDINARY discounts row.
  discount_id   UUID REFERENCES discounts(id) ON DELETE SET NULL,

  notes         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT affiliates_code_uq UNIQUE (code),
  -- Terms must be usable for the configured type.
  CONSTRAINT aff_terms_present CHECK (
    (default_commission_type = 'percentage' AND default_commission_rate_bps IS NOT NULL)
    OR (default_commission_type = 'fixed'   AND default_commission_fixed_cents IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_aff_status ON affiliates(status);
-- ONE affiliate may own a given discount. Two affiliates claiming the same
-- discount would make attribution ambiguous and commission non-deterministic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_discount
  ON affiliates(discount_id) WHERE discount_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_affiliates_updated_at') THEN
    CREATE TRIGGER set_affiliates_updated_at BEFORE UPDATE ON affiliates
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── affiliate_status_events — append-only, effective-dated ──────────────────
--
-- A pause must stop NEW qualifying activity after its effective instant, while
-- activity that validly occurred BEFORE the pause still qualifies. The mutable
-- status column cannot answer "was this affiliate active last Tuesday", so
-- attribution asks this ledger instead.
--
-- Nothing already accrued, adjusted, recovered or owed ever disappears because
-- an affiliate was later paused or terminated.
CREATE TABLE IF NOT EXISTS affiliate_status_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  from_status   TEXT,
  to_status     TEXT        NOT NULL
    CHECK (to_status IN ('active','paused','terminated')),
  -- When the change takes economic effect. Not necessarily when it was recorded.
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason        TEXT,
  actor_email   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ase_affiliate
  ON affiliate_status_events(affiliate_id, effective_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_terms_events — effective-dated financial configuration
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS IS REQUIRED. The affiliates row holds CURRENT terms and is mutable.
-- Late attribution (backfill) would otherwise read whatever rate happens to be
-- configured on the day an admin retries, so an order finalised on June 1 at 10%
-- would silently accrue 20% if the affiliate changed on June 5.
--
-- Terms are therefore appended, never overwritten in place. Attribution — at
-- payment time or backfilled months later — reads the row in force at the
-- ORDER'S finalization instant, so the economics are identical either way.
--
-- Attribution window is included deliberately: changing it later could otherwise
-- change whether a historical click still qualified.
CREATE TABLE IF NOT EXISTS affiliate_terms_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id   UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,

  commission_type TEXT       NOT NULL CHECK (commission_type IN ('percentage','fixed')),
  commission_rate_bps    INTEGER
    CHECK (commission_rate_bps IS NULL
           OR (commission_rate_bps > 0 AND commission_rate_bps <= 10000)),
  commission_fixed_cents INTEGER
    CHECK (commission_fixed_cents IS NULL OR commission_fixed_cents >= 0),
  fixed_reversal_policy  TEXT NOT NULL
    CHECK (fixed_reversal_policy IN ('proportional','all_or_nothing')),
  attribution_window_days INTEGER NOT NULL
    CHECK (attribution_window_days > 0 AND attribution_window_days <= 365),
  commission_hold_days    INTEGER NOT NULL
    CHECK (commission_hold_days >= 0 AND commission_hold_days <= 365),
  discount_id    UUID REFERENCES discounts(id) ON DELETE SET NULL,

  -- When these terms take economic effect. Not necessarily when recorded.
  effective_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason         TEXT,
  actor_email    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Final5. Mirrors affiliates.aff_terms_present. Without this, a historical
  -- terms row with a NULL rate or NULL fixed amount could reach
  -- compute_affiliate_commission, which previously treated that corruption as
  -- an ordinary $0 commission instead of failing closed. A row column-copied,
  -- bulk-loaded or hand-corrected outside update_affiliate_terms() is caught
  -- here regardless of what wrote it.
  CONSTRAINT ate_terms_present CHECK (
    (commission_type = 'percentage' AND commission_rate_bps IS NOT NULL)
    OR (commission_type = 'fixed'   AND commission_fixed_cents IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ate_affiliate
  ON affiliate_terms_events(affiliate_id, effective_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- LINKS AND CLICKS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_links (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id     UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  slug             TEXT        NOT NULL,
  destination_path TEXT        NOT NULL DEFAULT '/',
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT affiliate_links_slug_uq UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_al_affiliate ON affiliate_links(affiliate_id);

-- Clicks reuse the existing analytics session id. NO IP ADDRESS AND NO IP HASH:
-- session id and link id are sufficient for click-to-conversion reporting, so
-- collecting a visitor network identifier would be unnecessary personal data.
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id      UUID        NOT NULL REFERENCES affiliate_links(id) ON DELETE CASCADE,
  affiliate_id UUID        NOT NULL REFERENCES affiliates(id)      ON DELETE RESTRICT,
  session_id   TEXT,
  referrer     TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ac_session ON affiliate_clicks(session_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ac_affiliate ON affiliate_clicks(affiliate_id, occurred_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- IMMUTABLE ORDER ATTRIBUTION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One affiliate per order, resolved ONCE at finalization. order_id is UNIQUE and
-- rows are insert-only, so a later click can never rewrite a completed order.
--
-- Every input to the decision is snapshotted, so the outcome stays reproducible
-- after the affiliate's configuration changes.
CREATE TABLE IF NOT EXISTS order_affiliate_attributions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID        NOT NULL REFERENCES orders(id)     ON DELETE RESTRICT,
  affiliate_id   UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  link_id        UUID REFERENCES affiliate_links(id) ON DELETE SET NULL,
  click_id       UUID REFERENCES affiliate_clicks(id) ON DELETE SET NULL,
  code_used      TEXT,

  attribution_method TEXT    NOT NULL CHECK (attribution_method IN ('code','link')),
  attributed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Frozen decision inputs ──────────────────────────────────────────────
  attribution_window_days_snapshot INTEGER NOT NULL,
  commission_type_snapshot         TEXT    NOT NULL
    CHECK (commission_type_snapshot IN ('percentage','fixed')),
  commission_rate_bps_snapshot     INTEGER,
  commission_fixed_cents_snapshot  INTEGER,
  fixed_reversal_policy_snapshot   TEXT    NOT NULL
    CHECK (fixed_reversal_policy_snapshot IN ('proportional','all_or_nothing')),

  commission_base_cents            INTEGER NOT NULL CHECK (commission_base_cents >= 0),
  base_formula_version             TEXT    NOT NULL DEFAULT 'v1_net_merchandise',

  -- Hold policy frozen here so future configuration cannot move eligibility.
  hold_days_snapshot               INTEGER NOT NULL,
  eligible_at                      TIMESTAMPTZ NOT NULL,

  -- Versioned so the "exchanges earn no commission" rule can change knowingly.
  exchange_commission_policy_version TEXT NOT NULL DEFAULT 'v1_no_commission',

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT oaa_order_uq UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS idx_oaa_affiliate ON order_affiliate_attributions(affiliate_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- COMMISSIONS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- status SUMMARISES the lifecycle. The authoritative economics live in the
-- append-only adjustment ledger below; period reporting must read that, never
-- this row.
CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  affiliate_id    UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  attribution_id  UUID        NOT NULL REFERENCES order_affiliate_attributions(id) ON DELETE RESTRICT,

  base_cents       INTEGER    NOT NULL CHECK (base_cents >= 0),
  commission_cents INTEGER    NOT NULL CHECK (commission_cents >= 0),

  status          TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','paid','reversed')),
  eligible_at     TIMESTAMPTZ NOT NULL,
  approved_at     TIMESTAMPTZ,
  approved_by     TEXT,

  -- Set when a refund or dispute cannot be quantified yet. Excluded from payout
  -- while true. Unknown is never treated as zero.
  incomplete      BOOLEAN     NOT NULL DEFAULT FALSE,
  incomplete_reason TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT afc_order_uq UNIQUE (order_id),
  -- THE ZERO-BASE INVARIANT. A fixed commission is capped at the base, so a
  -- fully discounted order cannot pay commission on money never collected.
  CONSTRAINT afc_zero_base_zero_commission CHECK (
    base_cents > 0 OR commission_cents = 0
  ),
  CONSTRAINT afc_commission_le_base CHECK (commission_cents <= base_cents)
);

CREATE INDEX IF NOT EXISTS idx_afc_affiliate ON affiliate_commissions(affiliate_id, status);
CREATE INDEX IF NOT EXISTS idx_afc_eligible  ON affiliate_commissions(eligible_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_afc_incomplete ON affiliate_commissions(created_at DESC)
  WHERE incomplete;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_afc_updated_at') THEN
    CREATE TRIGGER set_afc_updated_at BEFORE UPDATE ON affiliate_commissions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── The append-only economic ledger ────────────────────────────────────────
--
-- THREE DIFFERENT TIMESTAMPS, all preserved:
--
--   effective_at   when the ECONOMIC EVENT occurred (the refund, the dispute).
--                  Period reporting keys on this.
--   knowledge_at   when KVRN learned enough to QUANTIFY it. For a June dispute
--                  decomposed in July this is July.
--   created_at     when the row was written.
--
-- A June dispute resolved in July is recognised in JUNE, because that is when the
-- economics happened. knowledge_at is retained so the later Financial Integrity
-- batch can also produce a "known as of" view and explain why a closed period
-- moved. Historical rows are never rewritten.
CREATE TABLE IF NOT EXISTS affiliate_commission_adjustments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id   UUID        NOT NULL REFERENCES affiliate_commissions(id) ON DELETE RESTRICT,
  order_id        UUID        NOT NULL REFERENCES orders(id)     ON DELETE RESTRICT,
  affiliate_id    UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,

  -- Signed. Positive accrues or restores; negative reverses or recovers.
  adjustment_cents INTEGER    NOT NULL,

  effective_at    TIMESTAMPTZ NOT NULL,
  knowledge_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  reason          TEXT        NOT NULL
    CHECK (reason IN ('initial_accrual','refund_reversal','dispute_reversal',
                      'dispute_won_restore','manual_correction','payout_recovery')),

  -- Provenance.
  source_refund_id            UUID REFERENCES order_refunds(id) ON DELETE SET NULL,
  source_dispute_id           UUID REFERENCES order_disputes(id) ON DELETE SET NULL,
  source_dispute_adjustment_id UUID
    REFERENCES order_dispute_financial_adjustments(id) ON DELETE SET NULL,
  -- A decomposition CORRECTION is its own event. One 018 adjustment id cannot
  -- uniquely identify every later correction of the same dispute, which is why
  -- keying idempotency on it silently dropped corrections.
  -- FK added after dispute_merchandise_resolutions is created, below.
  source_dispute_resolution_id UUID,
  source_payout_id            UUID,

  -- THE SHARED COUNTER. Refund and dispute reversals both advance it, which is
  -- what makes double reversal of the same merchandise impossible.
  -- ── RAW SOURCE CLAIMS ───────────────────────────────────────────────────
  --
  -- claim_source_key identifies WHICH source owns a merchandise claim
  -- ('refund:<uuid>' or 'dispute:<uuid>'), and claim_delta_cents is that
  -- source's RAW signed change — never capped.
  --
  -- Capping at insert time was the Rev-2 defect: once cumulative merchandise
  -- reached the base, a later legitimate refund advanced the counter by 0 and
  -- its claim vanished. A subsequent dispute win then released merchandise the
  -- refund still owned, restoring commission that was genuinely gone.
  --
  -- Raw claims may overlap and may exceed the base. The GLOBAL position is
  -- capped only when it is derived:
  --   outstanding = LEAST(base, GREATEST(0, SUM(claim_delta_cents)))
  claim_source_key            TEXT,
  claim_delta_cents           INTEGER NOT NULL DEFAULT 0,

  merchandise_reversed_this   INTEGER NOT NULL DEFAULT 0,
  cumulative_merchandise_reversed_after INTEGER NOT NULL DEFAULT 0
    CHECK (cumulative_merchandise_reversed_after >= 0),

  recovery_status TEXT        NOT NULL DEFAULT 'not_required'
    CHECK (recovery_status IN ('not_required','pending','recovered','written_off')),
  -- Money the affiliate owes back because a PAID commission was later reversed.
  -- This is a COLLECTION concern, not a second economic reduction: the reversal
  -- that created the overpayment already moved the ledger. Recovery rows
  -- therefore carry adjustment_cents = 0 and record the amount owed here.
  recovery_amount_cents INTEGER
    CHECK (recovery_amount_cents IS NULL OR recovery_amount_cents >= 0),
  -- Cash ACTUALLY collected back from the affiliate, with its own evidence.
  -- A pending recovery is an amount owed, not cash: only recovered_cents counts.
  recovered_cents       INTEGER NOT NULL DEFAULT 0 CHECK (recovered_cents >= 0),
  recovered_at          TIMESTAMPTZ,
  recovery_method       TEXT,
  recovery_reference    TEXT,
  recovery_collected_by TEXT,
  -- Idempotency for RECOVERY WORKFLOW operations (markers and cash collection).
  -- Amount alone is not a key: several partial recoveries of the same value are
  -- legitimate. A provider reference is not a key either, because manual/cash
  -- recovery may have none.
  recovery_idempotency_key TEXT,
  -- Final5. The client's RAW, literal request date (the "YYYY-MM-DD" string as
  -- typed, or NULL if the field was left blank), preserved for idempotency
  -- comparison. effective_at/recovered_at cannot serve this role: both are
  -- resolved with COALESCE(..., NOW()) at insert time, so a blank date already
  -- becomes a concrete timestamp that a retry could never reproduce.
  recovery_request_date TEXT,

  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One recovery operation per key, per commission. Partial so ordinary economic
-- rows (which carry no key) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aca_recovery_key
  ON affiliate_commission_adjustments(commission_id, recovery_idempotency_key)
  WHERE recovery_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aca_commission ON affiliate_commission_adjustments(commission_id, effective_at);
CREATE INDEX IF NOT EXISTS idx_aca_effective  ON affiliate_commission_adjustments(effective_at);
CREATE INDEX IF NOT EXISTS idx_aca_affiliate  ON affiliate_commission_adjustments(affiliate_id, effective_at);

-- Idempotency: one reversal per source event. A redelivered webhook or a repeated
-- admin action cannot append a second identical economic effect.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aca_refund
  ON affiliate_commission_adjustments(commission_id, source_refund_id)
  WHERE source_refund_id IS NOT NULL AND reason = 'refund_reversal';
-- NOTE: there is deliberately NO unique index on
-- (commission_id, source_dispute_adjustment_id).
--
-- A dispute legitimately produces SEVERAL affiliate movements over its life:
-- an initial loss, a decomposition, a correction of that decomposition, and a
-- later win. Keying uniqueness on the 018 adjustment id rejected all but the
-- first as 'already applied', so a corrected merchandise split silently failed
-- to move the claim and the commission stayed wrong.
--
-- Idempotency instead comes from the claim model itself: claims are TARGETS, so
-- re-running with unchanged state yields a zero delta and books nothing. The
-- 018 adjustment id is provenance only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aca_accrual
  ON affiliate_commission_adjustments(commission_id)
  WHERE reason = 'initial_accrual';

-- ═══════════════════════════════════════════════════════════════════════════
-- PARTIAL-DISPUTE MERCHANDISE RESOLUTION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS. 018 computes a dispute's revenue impact from Stripe's
-- dispute.amount, which is the GROSS charge including shipping and tax, offset by
-- GROSS refund totals. order_dispute_financial_adjustments.adjustment_cents is
-- therefore a gross figure and is NOT a merchandise-only number.
--
-- Affiliate commission is merchandise-only. When a dispute covers the WHOLE
-- charge the merchandise share is deterministic (subtotal - discount) and needs
-- no resolution. When a dispute is PARTIAL, no decomposition exists anywhere, and
-- inferring one proportionally would be a guess. Such disputes stay Incomplete
-- until an admin supplies the verified split here.
--
-- Append-only: a resolution is recorded once, with who and when.
CREATE TABLE IF NOT EXISTS dispute_merchandise_resolutions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id        UUID        NOT NULL REFERENCES order_disputes(id) ON DELETE RESTRICT,
  -- Retained as provenance: which 018 row prompted the decomposition. It is NOT
  -- the validity key.
  dispute_adjustment_id UUID
    REFERENCES order_dispute_financial_adjustments(id) ON DELETE SET NULL,
  -- THE VALIDITY KEY: the gross disputed amount this decomposition describes.
  -- If Stripe later changes the disputed amount, this row no longer applies and
  -- the dispute becomes Incomplete until a new decomposition is supplied.
  resolved_disputed_amount_cents INTEGER NOT NULL CHECK (resolved_disputed_amount_cents > 0),
  order_id          UUID        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

  -- The verified split of the disputed amount. Must total it exactly.
  merchandise_cents INTEGER     NOT NULL CHECK (merchandise_cents >= 0),
  shipping_cents    INTEGER     NOT NULL CHECK (shipping_cents    >= 0),
  tax_cents         INTEGER     NOT NULL CHECK (tax_cents         >= 0),
  disputed_amount_cents INTEGER NOT NULL CHECK (disputed_amount_cents > 0),

  -- Economic date of the dispute event, preserved separately from when the
  -- decomposition became known.
  effective_at      TIMESTAMPTZ NOT NULL,
  resolved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by       TEXT        NOT NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── APPEND-ONLY WITH SUPERSESSION ───────────────────────────────────────
  --
  -- Uniqueness on (dispute_id, amount) was too strict: an admin who later
  -- obtains better evidence must be able to CORRECT a decomposition for the same
  -- gross amount without the original being edited or deleted.
  --
  -- Instead every resolution is immutable and carries a version. A correction
  -- inserts a NEW row citing supersedes_resolution_id; the earlier row survives
  -- as evidence and is simply no longer current.
  --
  -- Keyed to the disputed AMOUNT, not to an 018 row: 018 rows describe changes
  -- in gross revenue impact and are not synonymous with merchandise content, so
  -- a dispute_revised emitted because refund_offset moved must not invalidate a
  -- decomposition still correct for the same amount.
  supersedes_resolution_id UUID REFERENCES dispute_merchandise_resolutions(id) ON DELETE RESTRICT,
  version        INTEGER  NOT NULL DEFAULT 1 CHECK (version > 0),
  superseded_at  TIMESTAMPTZ,
  correction_reason TEXT,

  -- Exactly ONE current resolution per (dispute, amount). Two conflicting
  -- corrections cannot race into existence: the second loses on this index.
  CONSTRAINT dmr_version_uq UNIQUE (dispute_id, resolved_disputed_amount_cents, version),
  CONSTRAINT dmr_components_total CHECK (
    merchandise_cents + shipping_cents + tax_cents = resolved_disputed_amount_cents
  )
);

CREATE INDEX IF NOT EXISTS idx_dmr_dispute ON dispute_merchandise_resolutions(dispute_id);
-- Only one CURRENT row per dispute+amount; superseded rows are exempt.
-- Late FK now that dispute_merchandise_resolutions exists.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aca_resolution_fk') THEN
    ALTER TABLE affiliate_commission_adjustments
      ADD CONSTRAINT aca_resolution_fk FOREIGN KEY (source_dispute_resolution_id)
      REFERENCES dispute_merchandise_resolutions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dmr_current
  ON dispute_merchandise_resolutions(dispute_id, resolved_disputed_amount_cents)
  WHERE superseded_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- PAYOUTS — manual money movement only
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  UUID        NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
  payout_number TEXT        NOT NULL,
  amount_cents  INTEGER     NOT NULL CHECK (amount_cents >= 0),
  status        TEXT        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','paid','void')),
  -- Cash flow reads THIS, never the accrual ledger.
  paid_at       TIMESTAMPTZ,
  method        TEXT,
  reference     TEXT,
  notes         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT afp_number_uq UNIQUE (payout_number),
  CONSTRAINT afp_paid_has_date CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_afp_affiliate ON affiliate_payouts(affiliate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_afp_paid      ON affiliate_payouts(paid_at) WHERE paid_at IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_afp_updated_at') THEN
    CREATE TRIGGER set_afp_updated_at BEFORE UPDATE ON affiliate_payouts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── Payout lines — a PAYABLE ledger, not one line per commission forever ────
--
-- UNIQUE(commission_id) would have been wrong. A commission can legitimately be
-- paid, partly reversed by a refund, recovered, restored by a later dispute win,
-- and become payable again. Uniqueness is therefore per PAYOUT, and safety comes
-- from a server-side payable computation taken under lock.
CREATE TABLE IF NOT EXISTS affiliate_payout_lines (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id     UUID        NOT NULL REFERENCES affiliate_payouts(id) ON DELETE CASCADE,
  commission_id UUID        NOT NULL REFERENCES affiliate_commissions(id) ON DELETE RESTRICT,
  amount_cents  INTEGER     NOT NULL CHECK (amount_cents > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT afpl_payout_commission_uq UNIQUE (payout_id, commission_id)
);

CREATE INDEX IF NOT EXISTS idx_afpl_commission ON affiliate_payout_lines(commission_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_active_at() — historical status, not the mutable column
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Answers "was this affiliate active at instant X" from the effective-dated
-- event ledger. A pause stops NEW qualifying activity from its effective_at;
-- activity before it still qualifies.
CREATE OR REPLACE FUNCTION affiliate_active_at(p_affiliate_id UUID, p_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE v_status TEXT; v_created TIMESTAMPTZ;
BEGIN
  SELECT created_at INTO v_created FROM affiliates WHERE id = p_affiliate_id;
  IF v_created IS NULL THEN RETURN FALSE; END IF;

  -- TEMPORAL CAUSALITY. An affiliate cannot have been active before it existed.
  -- Falling back to the mutable current row for an earlier instant would let a
  -- newly created affiliate appear historically active, so an old order could be
  -- backfilled to an affiliate that did not exist when the order happened.
  IF p_at < v_created THEN RETURN FALSE; END IF;

  SELECT to_status INTO v_status
  FROM affiliate_status_events
  WHERE affiliate_id = p_affiliate_id AND effective_at <= p_at
  -- Deterministic tie-break, identical to affiliate_terms_at and the projection
  -- recomputation, so all three always agree.
  ORDER BY effective_at DESC, created_at DESC, id DESC
  LIMIT 1;

  IF v_status IS NULL THEN
    -- At or after creation but with no event yet: only legitimate for affiliates
    -- predating the status ledger, where the current row is the best evidence.
    SELECT status INTO v_status FROM affiliates WHERE id = p_affiliate_id;
  END IF;

  RETURN COALESCE(v_status, 'terminated') = 'active';
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- compute_affiliate_commission() — the ONE rounding rule
-- ═══════════════════════════════════════════════════════════════════════════
--
--   percentage: round_half_up(base x rate_bps / 10000)
--   fixed:      LEAST(configured, base)
--
-- INVARIANT: base = 0 => commission = 0, for both types. A fully discounted
-- order cannot pay commission on money that was never collected. The database
-- also enforces this with afc_zero_base_zero_commission.
CREATE OR REPLACE FUNCTION compute_affiliate_commission(
  p_base_cents  INTEGER,
  p_type        TEXT,
  p_rate_bps    INTEGER,
  p_fixed_cents INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  -- Final6. TERMS ARE VALIDATED FIRST, independent of the base amount.
  -- Corrupt or missing terms must fail closed, never be quietly treated as a
  -- $0 commission -- and that must hold even when the order base happens to be
  -- zero. Previously the zero-base return sat above this check, so
  -- compute_affiliate_commission(0,'percentage',NULL,NULL) returned 0 and hid
  -- the corruption behind a legitimately-zero order. The bounds mirror the
  -- table CHECKs on affiliates and affiliate_terms_events exactly: percentage
  -- rate > 0 and <= 10000 bps; fixed amount >= 0 (0 is a real configured value).
  IF p_type = 'percentage' THEN
    IF p_rate_bps IS NULL OR p_rate_bps <= 0 OR p_rate_bps > 10000 THEN
      RAISE EXCEPTION 'KVRN_AFFILIATE|CORRUPT_TERMS|percentage rate missing or invalid: %', p_rate_bps;
    END IF;
  ELSIF p_type = 'fixed' THEN
    IF p_fixed_cents IS NULL OR p_fixed_cents < 0 THEN
      RAISE EXCEPTION 'KVRN_AFFILIATE|CORRUPT_TERMS|fixed amount missing or invalid: %', p_fixed_cents;
    END IF;
  ELSE
    RAISE EXCEPTION 'KVRN_AFFILIATE|CORRUPT_TERMS|unknown commission_type: %', p_type;
  END IF;

  -- Terms are now known to be valid. Only NOW may a zero or negative base
  -- return 0: that is a real economic fact (a fully discounted order), never a
  -- data problem, once corruption has been ruled out above.
  IF p_base_cents IS NULL OR p_base_cents <= 0 THEN RETURN 0; END IF;

  IF p_type = 'percentage' THEN
    -- ROUND on numeric is half away from zero; base is positive here.
    RETURN LEAST(
      ROUND(p_base_cents::NUMERIC * p_rate_bps / 10000)::INTEGER,
      p_base_cents);
  END IF;

  -- p_type = 'fixed'. A genuine, validly-configured $0 flat commission still
  -- returns 0 here -- that is a real terms value, not a missing one.
  RETURN LEAST(GREATEST(p_fixed_cents, 0), p_base_cents);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- create_affiliate() — canonical creation: row + status + terms + audit
-- ═══════════════════════════════════════════════════════════════════════════
--
-- All four writes in ONE transaction. Previously the service issued them
-- separately, and the terms event was never written at all — so the historical
-- terms ledger existed but production creation did not seed it, leaving
-- affiliate_terms_at() to fall back to the mutable current row.
CREATE OR REPLACE FUNCTION create_affiliate(
  p_code TEXT, p_name TEXT, p_email TEXT,
  p_commission_type TEXT, p_rate_bps INTEGER, p_fixed_cents INTEGER,
  p_fixed_reversal_policy TEXT, p_attribution_window_days INTEGER,
  p_commission_hold_days INTEGER, p_discount_id UUID,
  p_notes TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|ACTOR_REQUIRED';
  END IF;

  INSERT INTO affiliates (
    code, name, email, default_commission_type,
    default_commission_rate_bps, default_commission_fixed_cents,
    default_fixed_reversal_policy, attribution_window_days,
    commission_hold_days, discount_id, notes, created_by
  ) VALUES (
    UPPER(p_code), p_name, p_email, p_commission_type,
    CASE WHEN p_commission_type = 'percentage' THEN p_rate_bps END,
    CASE WHEN p_commission_type = 'fixed' THEN p_fixed_cents END,
    COALESCE(p_fixed_reversal_policy,'proportional'),
    COALESCE(p_attribution_window_days,30),
    COALESCE(p_commission_hold_days,30),
    p_discount_id, p_notes, p_actor
  ) RETURNING id INTO v_id;

  INSERT INTO affiliate_status_events (affiliate_id, to_status, effective_at, actor_email)
  VALUES (v_id, 'active', v_now, p_actor);

  -- The initial terms snapshot. Without this, a later backfill would read
  -- whatever the affiliates row happens to say on the day it runs.
  INSERT INTO affiliate_terms_events (
    affiliate_id, commission_type, commission_rate_bps, commission_fixed_cents,
    fixed_reversal_policy, attribution_window_days, commission_hold_days,
    discount_id, effective_at, reason, actor_email
  ) VALUES (
    v_id, p_commission_type,
    CASE WHEN p_commission_type = 'percentage' THEN p_rate_bps END,
    CASE WHEN p_commission_type = 'fixed' THEN p_fixed_cents END,
    COALESCE(p_fixed_reversal_policy,'proportional'),
    COALESCE(p_attribution_window_days,30),
    COALESCE(p_commission_hold_days,30),
    p_discount_id, v_now, 'initial', p_actor
  );

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'create', 'affiliates', v_id::text,
          jsonb_build_object('code', UPPER(p_code), 'commission_type', p_commission_type,
                             'rate_bps', p_rate_bps, 'fixed_cents', p_fixed_cents));

  RETURN jsonb_build_object('outcome','created','affiliate_id',v_id);
END;
$$;

-- Append new financial terms. History is never edited; the affiliates row is a
-- projection of the latest event and is updated in the same transaction.
CREATE OR REPLACE FUNCTION update_affiliate_terms(
  p_affiliate_id UUID, p_commission_type TEXT, p_rate_bps INTEGER,
  p_fixed_cents INTEGER, p_fixed_reversal_policy TEXT,
  p_attribution_window_days INTEGER, p_commission_hold_days INTEGER,
  p_discount_id UUID, p_effective_at TIMESTAMPTZ, p_reason TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID; v_eff TIMESTAMPTZ := COALESCE(p_effective_at, NOW());
  cur affiliate_terms_events;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|ACTOR_REQUIRED';
  END IF;
  IF v_eff > NOW() THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|FUTURE_EFFECTIVE_AT_UNSUPPORTED|%', v_eff;
  END IF;
  -- Final5. Fail closed BEFORE the insert, so the error is the clear
  -- KVRN_AFFILIATE|INVALID_TERMS rather than a bare constraint violation, and
  -- so a backdated correction can never append a historical row that
  -- compute_affiliate_commission would later have to silently zero out.
  IF p_commission_type NOT IN ('percentage','fixed') THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|INVALID_TERMS|unknown commission_type %', p_commission_type;
  END IF;
  IF p_commission_type = 'percentage'
     AND (p_rate_bps IS NULL OR p_rate_bps <= 0 OR p_rate_bps > 10000) THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|INVALID_TERMS|percentage terms require a valid rate';
  END IF;
  IF p_commission_type = 'fixed'
     AND (p_fixed_cents IS NULL OR p_fixed_cents < 0) THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|INVALID_TERMS|fixed terms require a valid amount';
  END IF;
  PERFORM 1 FROM affiliates WHERE id = p_affiliate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_AFFILIATE|NOT_FOUND'; END IF;

  INSERT INTO affiliate_terms_events (
    affiliate_id, commission_type, commission_rate_bps, commission_fixed_cents,
    fixed_reversal_policy, attribution_window_days, commission_hold_days,
    discount_id, effective_at, reason, actor_email
  ) VALUES (
    p_affiliate_id, p_commission_type,
    CASE WHEN p_commission_type = 'percentage' THEN p_rate_bps END,
    CASE WHEN p_commission_type = 'fixed' THEN p_fixed_cents END,
    p_fixed_reversal_policy, p_attribution_window_days, p_commission_hold_days,
    p_discount_id, v_eff, p_reason, p_actor
  ) RETURNING id INTO v_id;

  -- Project from the LATEST event effective at NOW(), not from the row just
  -- inserted. A backdated correction therefore changes history without
  -- resurrecting old terms as current — including old discount ownership, which
  -- would otherwise trip the current uniqueness invariant.
  SELECT * INTO cur FROM affiliate_terms_events
  WHERE affiliate_id = p_affiliate_id AND effective_at <= NOW()
  ORDER BY effective_at DESC, created_at DESC, id DESC
  LIMIT 1;

  UPDATE affiliates SET
    default_commission_type        = cur.commission_type,
    default_commission_rate_bps    = cur.commission_rate_bps,
    default_commission_fixed_cents = cur.commission_fixed_cents,
    default_fixed_reversal_policy  = cur.fixed_reversal_policy,
    attribution_window_days        = cur.attribution_window_days,
    commission_hold_days           = cur.commission_hold_days,
    discount_id                    = cur.discount_id,
    updated_at = NOW()
  WHERE id = p_affiliate_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'update_terms', 'affiliates', p_affiliate_id::text,
          jsonb_build_object('terms_event_id', v_id, 'effective_at', v_eff,
                             'commission_type', p_commission_type, 'rate_bps', p_rate_bps,
                             'projected_rate_bps', cur.commission_rate_bps));

  RETURN jsonb_build_object('outcome','terms_appended','terms_event_id',v_id,
    'effective_at',v_eff,'current_projection_rate_bps',cur.commission_rate_bps);
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- persist_checkout_affiliate_session() — local session recovery for backfill
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Stores the opaque kvrn_sid on the reservation's attribution JSONB at checkout.
-- finalize_paid_order (017) already copies reservations.attribution to
-- orders.attribution, so the identity survives into the order WITHOUT touching
-- the frozen function.
--
-- This is what makes admin backfill possible from order identity alone: no admin
-- ever types a session id, and no Stripe round-trip is required.
CREATE OR REPLACE FUNCTION persist_checkout_affiliate_session(
  p_reservation_id UUID, p_session_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  IF p_session_id IS NULL OR p_session_id = '' THEN RETURN FALSE; END IF;
  UPDATE reservations
  SET attribution = COALESCE(attribution, '{}'::jsonb)
                    || jsonb_build_object('kvrn_sid', p_session_id)
  WHERE id = p_reservation_id;
  RETURN FOUND;
END;
$$;

-- Status change and link creation, each atomic with its audit row. Status is
-- financially significant: it decides whether new activity can qualify.
CREATE OR REPLACE FUNCTION set_affiliate_status(
  p_affiliate_id UUID, p_status TEXT, p_effective_at TIMESTAMPTZ,
  p_reason TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_from TEXT; v_eff TIMESTAMPTZ := COALESCE(p_effective_at, NOW()); v_proj TEXT;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|ACTOR_REQUIRED';
  END IF;

  -- FUTURE EVENTS ARE REJECTED. There is no scheduler or effective-dated read
  -- path that would activate them, so a future row would sit inert while the
  -- projection claimed it had taken effect. Backdated corrections are allowed.
  IF v_eff > NOW() THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|FUTURE_EFFECTIVE_AT_UNSUPPORTED|%', v_eff;
  END IF;

  SELECT status INTO v_from FROM affiliates WHERE id = p_affiliate_id FOR UPDATE;
  IF v_from IS NULL THEN RETURN jsonb_build_object('outcome','not_found'); END IF;

  INSERT INTO affiliate_status_events
    (affiliate_id, from_status, to_status, effective_at, reason, actor_email)
  VALUES (p_affiliate_id, v_from, p_status, v_eff, p_reason, p_actor);

  -- RECOMPUTE, never blindly overwrite. A BACKDATED correction must not become
  -- the current status when a later event already supersedes it. Ordering is
  -- identical to affiliate_active_at, so helper and projection always agree.
  SELECT to_status INTO v_proj
  FROM affiliate_status_events
  WHERE affiliate_id = p_affiliate_id AND effective_at <= NOW()
  ORDER BY effective_at DESC, created_at DESC, id DESC
  LIMIT 1;

  UPDATE affiliates SET status = COALESCE(v_proj, v_from), updated_at = NOW()
  WHERE id = p_affiliate_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'status_change', 'affiliates', p_affiliate_id::text,
          jsonb_build_object('from', v_from, 'to', p_status, 'effective_at', v_eff,
                             'current_projection', COALESCE(v_proj, v_from)));

  RETURN jsonb_build_object('outcome','updated','from',v_from,'to',p_status,
    'effective_at',v_eff,'current_projection',COALESCE(v_proj, v_from));
END;
$$;


CREATE OR REPLACE FUNCTION create_affiliate_link(
  p_affiliate_id UUID, p_slug TEXT, p_destination TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|ACTOR_REQUIRED';
  END IF;
  INSERT INTO affiliate_links (affiliate_id, slug, destination_path, created_by)
  VALUES (p_affiliate_id, p_slug, COALESCE(NULLIF(p_destination,''),'/'), p_actor)
  RETURNING id INTO v_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'create', 'affiliate_links', v_id::text,
          jsonb_build_object('slug', p_slug, 'affiliate_id', p_affiliate_id));

  RETURN jsonb_build_object('outcome','created','link_id',v_id);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_terms_at() — the terms in force at a given instant
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Falls back to the current affiliates row only when no event precedes the
-- instant, which happens solely for affiliates created before the terms ledger
-- existed. Every affiliate created through the admin path seeds an event.
CREATE OR REPLACE FUNCTION affiliate_terms_at(p_affiliate_id UUID, p_at TIMESTAMPTZ)
RETURNS affiliate_terms_events
LANGUAGE plpgsql STABLE AS $$
DECLARE t affiliate_terms_events; a affiliates;
BEGIN
  SELECT * INTO a FROM affiliates WHERE id = p_affiliate_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- TEMPORAL CAUSALITY: no terms exist before the affiliate did.
  IF p_at < a.created_at THEN RETURN NULL; END IF;

  SELECT * INTO t FROM affiliate_terms_events
  WHERE affiliate_id = p_affiliate_id AND effective_at <= p_at
  ORDER BY effective_at DESC, created_at DESC, id DESC
  LIMIT 1;
  IF FOUND THEN RETURN t; END IF;

  -- At or after creation with no terms event: affiliates predating the ledger.
  t.affiliate_id            := a.id;
  t.commission_type         := a.default_commission_type;
  t.commission_rate_bps     := a.default_commission_rate_bps;
  t.commission_fixed_cents  := a.default_commission_fixed_cents;
  t.fixed_reversal_policy   := a.default_fixed_reversal_policy;
  t.attribution_window_days := a.attribution_window_days;
  t.commission_hold_days    := a.commission_hold_days;
  t.discount_id             := a.discount_id;
  t.effective_at            := a.created_at;
  RETURN t;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_owner_of_discount_at() — HISTORICAL ownership, fail-closed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Attribution previously selected the affiliate by TODAY'S affiliates.discount_id
-- and only then loaded historical terms, so a discount transferred from A to B
-- would retroactively re-attribute A's old orders to B.
--
-- Ownership is therefore reconstructed from each affiliate's terms snapshot in
-- force at p_at, restricted to affiliates that existed then.
--
-- Returns one row per historical owner. Callers MUST fail closed on more than
-- one: LIMIT 1 would silently pick by row order, which is not a decision anyone
-- authorised.
CREATE OR REPLACE FUNCTION affiliate_owner_of_discount_at(
  p_discount_id UUID, p_at TIMESTAMPTZ
) RETURNS TABLE (affiliate_id UUID)
LANGUAGE sql STABLE AS $$
  SELECT a.id
  FROM affiliates a
  WHERE p_discount_id IS NOT NULL
    AND a.created_at <= p_at                       -- existed at that instant
    AND (affiliate_terms_at(a.id, p_at)).discount_id = p_discount_id;
$$;

-- Detects overlapping historical ownership of one discount. The CURRENT partial
-- unique index cannot prove this: history can contain two affiliates owning the
-- same discount at the same past instant even when today's projection is clean.
CREATE OR REPLACE FUNCTION affiliate_discount_ownership_conflicts()
RETURNS TABLE (discount_id UUID, at_instant TIMESTAMPTZ, owner_count INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT t.discount_id, t.effective_at,
         (SELECT COUNT(*)::int FROM affiliate_owner_of_discount_at(t.discount_id, t.effective_at))
  FROM affiliate_terms_events t
  WHERE t.discount_id IS NOT NULL
    AND (SELECT COUNT(*) FROM affiliate_owner_of_discount_at(t.discount_id, t.effective_at)) > 1;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- resolve_order_affiliate_attribution() — immutable, resolved once
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Priority:
--   1. a valid affiliate code explicitly used on the order wins outright;
--   2. otherwise the MOST RECENT qualifying click at or before finalization and
--      within the affiliate's window as configured at that instant;
--   3. otherwise no attribution.
--
-- The affiliate must have been ACTIVE at the qualifying instant, judged from the
-- effective-dated status ledger rather than the current column.
--
-- order_id is UNIQUE and rows are insert-only, so a later click can never
-- rewrite a completed order. Every decision input is snapshotted.
CREATE OR REPLACE FUNCTION resolve_order_affiliate_attribution(
  p_order_id    UUID,
  p_session_id  TEXT DEFAULT NULL,
  p_actor       TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_order      RECORD;
  v_aff        affiliates;
  v_click      RECORD;
  -- Scalars, not fields of v_click: a CASE referencing an unassigned RECORD
  -- still fails at runtime even on the branch that would not use it.
  v_click_id   UUID;
  v_link_id    UUID;
  v_method     TEXT;
  v_terms      affiliate_terms_events;
  v_owner_count INTEGER := 0;
  v_owner_id   UUID;
  v_click_window INTEGER;
  v_base       INTEGER;
  v_commission INTEGER;
  v_attr_id    UUID;
  v_comm_id    UUID;
  v_finalized  TIMESTAMPTZ;
  v_eligible   TIMESTAMPTZ;
  v_existing   UUID;
BEGIN
  SELECT id, subtotal_cents, discount_cents, discount_code, discount_id,
         paid_at, created_at
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|ORDER_NOT_FOUND|%', p_order_id;
  END IF;

  -- Immutable: never re-resolve.
  SELECT id INTO v_existing FROM order_affiliate_attributions WHERE order_id = p_order_id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','already_attributed','attribution_id',v_existing);
  END IF;

  v_finalized := COALESCE(v_order.paid_at, v_order.created_at, NOW());

  -- ── 1. Explicit affiliate discount wins ─────────────────────────────────
  --
  -- Ownership is resolved from the effective-dated terms history AT THE ORDER'S
  -- FINALIZATION INSTANT, not from today's affiliates projection. A discount
  -- transferred from A to B must never retroactively re-attribute A's old
  -- orders to B.
  IF v_order.discount_id IS NOT NULL THEN
    -- No MIN(uuid) aggregate exists in PostgreSQL; count and select separately.
    SELECT COUNT(*) INTO v_owner_count
    FROM affiliate_owner_of_discount_at(v_order.discount_id, v_finalized);
    IF v_owner_count = 1 THEN
      SELECT affiliate_id INTO v_owner_id
      FROM affiliate_owner_of_discount_at(v_order.discount_id, v_finalized);
    END IF;

    IF v_owner_count > 1 THEN
      -- FAIL CLOSED. Overlapping historical ownership is corrupt data, and
      -- picking one by row order is a decision nobody authorised. No commission
      -- is created and the ambiguity is reported for reconciliation.
      RETURN jsonb_build_object(
        'outcome','ambiguous_historical_ownership',
        'order_id',p_order_id,'discount_id',v_order.discount_id,
        'owner_count',v_owner_count,'at',v_finalized);
    END IF;

    IF v_owner_count = 1 THEN
      SELECT * INTO v_aff FROM affiliates WHERE id = v_owner_id;
      IF affiliate_active_at(v_aff.id, v_finalized) THEN
        v_method := 'code';
      ELSE
        v_aff := NULL;
      END IF;
    END IF;
  END IF;

  -- FALLBACK, deliberately narrow and only when the order has NO authoritative
  -- discount id. Historical existence and status still apply, so an affiliate
  -- created after the order can never be matched by text either.
  IF v_aff.id IS NULL
     AND v_order.discount_id IS NULL
     AND v_order.discount_code IS NOT NULL THEN
    SELECT a.* INTO v_aff FROM affiliates a
    WHERE a.created_at <= v_finalized
      AND (affiliate_terms_at(a.id, v_finalized)).discount_id IS NULL
      AND UPPER(a.code) = UPPER(v_order.discount_code)
    LIMIT 1;
    IF FOUND AND affiliate_active_at(v_aff.id, v_finalized) THEN
      v_method := 'code';
    ELSE
      v_aff := NULL;
    END IF;
  END IF;

  -- 2. Otherwise the most recent qualifying click inside the window.
  IF v_aff.id IS NULL AND p_session_id IS NOT NULL THEN
    SELECT c.id AS click_id, c.link_id, c.affiliate_id, c.occurred_at
    INTO v_click
    FROM affiliate_clicks c
    JOIN affiliates a ON a.id = c.affiliate_id
    JOIN affiliate_links l ON l.id = c.link_id
    WHERE c.session_id = p_session_id
      AND c.occurred_at <= v_finalized
      -- TEMPORAL CAUSALITY: the link must have existed when the click was
      -- supposedly made. Without this, a corrupted or synthetic click timestamp
      -- predating the link would still qualify.
      AND c.occurred_at >= l.created_at
      -- Window from the terms in force when the CLICK happened, so a later
      -- configuration change cannot retroactively disqualify it.
      AND c.occurred_at >= v_finalized
          - ((affiliate_terms_at(c.affiliate_id, c.occurred_at)).attribution_window_days
             || ' days')::INTERVAL
      -- The affiliate must have been active WHEN THE CLICK HAPPENED. A pause
      -- stops NEW qualifying activity from its effective instant; it does not
      -- retroactively void a click that was valid when it occurred, so that
      -- click may still convert inside its window.
      AND affiliate_active_at(c.affiliate_id, c.occurred_at)
    ORDER BY c.occurred_at DESC, c.id DESC
    LIMIT 1;

    IF FOUND THEN
      SELECT * INTO v_aff FROM affiliates WHERE id = v_click.affiliate_id;
      v_click_id := v_click.click_id;
      v_link_id  := v_click.link_id;
      v_method   := 'link';
      -- THE WINDOW ACTUALLY USED to qualify this click. Storing the
      -- finalization-time window instead would make the audit trail describe a
      -- rule that was never applied.
      v_click_window := (affiliate_terms_at(v_click.affiliate_id, v_click.occurred_at))
                        .attribution_window_days;
    END IF;
  END IF;

  IF v_aff.id IS NULL THEN
    RETURN jsonb_build_object('outcome','no_attribution','order_id',p_order_id);
  END IF;

  -- ── HISTORICAL TERMS ────────────────────────────────────────────────────
  -- Read the terms in force at the ORDER'S finalization instant, never today's.
  -- A backfill months later therefore produces identical economics to what would
  -- have been accrued at payment time.
  v_terms := affiliate_terms_at(v_aff.id, v_finalized);

  v_base := GREATEST(0, COALESCE(v_order.subtotal_cents,0) - COALESCE(v_order.discount_cents,0));
  v_commission := compute_affiliate_commission(
    v_base, v_terms.commission_type,
    v_terms.commission_rate_bps, v_terms.commission_fixed_cents);

  v_eligible := v_finalized + (v_terms.commission_hold_days || ' days')::INTERVAL;

  INSERT INTO order_affiliate_attributions (
    order_id, affiliate_id, link_id, click_id, code_used, attribution_method,
    attributed_at, attribution_window_days_snapshot,
    commission_type_snapshot, commission_rate_bps_snapshot, commission_fixed_cents_snapshot,
    fixed_reversal_policy_snapshot, commission_base_cents, hold_days_snapshot, eligible_at
  ) VALUES (
    p_order_id, v_aff.id,
    v_link_id, v_click_id,
    CASE WHEN v_method = 'code' THEN v_order.discount_code ELSE NULL END,
    v_method, v_finalized,
    -- Link: the click-time window that decided qualification.
    -- Code: the finalization-time policy, which is what governed that decision.
    COALESCE(v_click_window, v_terms.attribution_window_days),
    v_terms.commission_type, v_terms.commission_rate_bps,
    v_terms.commission_fixed_cents, v_terms.fixed_reversal_policy,
    v_base, v_terms.commission_hold_days, v_eligible
  ) RETURNING id INTO v_attr_id;

  INSERT INTO affiliate_commissions (
    order_id, affiliate_id, attribution_id, base_cents, commission_cents,
    status, eligible_at
  ) VALUES (
    p_order_id, v_aff.id, v_attr_id, v_base, v_commission, 'pending', v_eligible
  ) RETURNING id INTO v_comm_id;

  -- Immutable initial accrual, effective when the order was finalised.
  IF v_commission > 0 THEN
    INSERT INTO affiliate_commission_adjustments (
      commission_id, order_id, affiliate_id, adjustment_cents,
      effective_at, knowledge_at, reason, cumulative_merchandise_reversed_after, created_by
    ) VALUES (
      v_comm_id, p_order_id, v_aff.id, v_commission,
      v_finalized, NOW(), 'initial_accrual', 0, p_actor
    );
  END IF;

  RETURN jsonb_build_object(
    'outcome','attributed','attribution_id',v_attr_id,'commission_id',v_comm_id,
    'affiliate_id',v_aff.id,'method',v_method,
    'base_cents',v_base,'commission_cents',v_commission,'eligible_at',v_eligible
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- THE CLAIM ENGINE — outstanding merchandise derived from raw source claims
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Each source (a refund, a dispute) owns a RAW signed merchandise claim. The
-- global reversal position is derived from the sum of those claims and capped
-- only at derivation time:
--
--   outstanding = LEAST(base, GREATEST(0, SUM(claim_delta_cents)))
--
-- The money moved by ANY claim change is the change in the GLOBAL target:
--
--   adjustment = target(outstanding_before) - target(outstanding_after)
--
-- This is what makes overlap correct. Two sources may both claim merchandise the
-- other already covers; the global target is capped so the customer's money is
-- only reversed once, yet each source keeps its own claim, so removing one later
-- releases exactly its share and no more.
--
-- It also makes restoration correct WITHOUT replaying history: the monetary
-- effect of removing a claim is computed from the position at removal time, not
-- from whatever that source happened to move when it arrived. Rounding, overlap
-- and all-or-nothing policy can all make those two numbers differ.

/** Current raw claim held by ONE source. Signed; never capped. */
CREATE OR REPLACE FUNCTION affiliate_source_claim(
  p_commission_id UUID, p_source_key TEXT
) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(claim_delta_cents), 0)::INTEGER
  FROM affiliate_commission_adjustments
  WHERE commission_id = p_commission_id AND claim_source_key = p_source_key;
$$;

/**
 * Current outstanding merchandise for a commission.
 *
 * Derived by SUMMING claims, so it never depends on row ordering. That closes
 * the Rev-2 defect where the "latest" cumulative snapshot was read with
 * ORDER BY effective_at — an economic date, which a backdated resolution can
 * make earlier than an already-processed later event.
 */
CREATE OR REPLACE FUNCTION affiliate_outstanding_merchandise(p_commission_id UUID)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT LEAST(
    (SELECT base_cents FROM affiliate_commissions WHERE id = p_commission_id),
    GREATEST(0, COALESCE((SELECT SUM(claim_delta_cents)
                          FROM affiliate_commission_adjustments
                          WHERE commission_id = p_commission_id), 0))
  )::INTEGER;
$$;

/**
 * Commission reversed when `p_outstanding` merchandise is claimed.
 *
 * Proportional by default. A fixed commission whose snapshotted policy is
 * all_or_nothing reverses in full the moment any merchandise is claimed.
 */
CREATE OR REPLACE FUNCTION affiliate_reversal_target(
  p_commission_id UUID, p_outstanding INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE c affiliate_commissions; v_policy TEXT; v_type TEXT;
BEGIN
  SELECT * INTO c FROM affiliate_commissions WHERE id = p_commission_id;
  IF NOT FOUND OR c.base_cents = 0 OR c.commission_cents = 0 THEN RETURN 0; END IF;
  IF p_outstanding <= 0 THEN RETURN 0; END IF;

  SELECT commission_type_snapshot, fixed_reversal_policy_snapshot
  INTO v_type, v_policy
  FROM order_affiliate_attributions WHERE id = c.attribution_id;

  IF v_type = 'fixed' AND v_policy = 'all_or_nothing' THEN
    RETURN c.commission_cents;
  END IF;

  RETURN LEAST(c.commission_cents,
    ROUND(c.commission_cents::NUMERIC * LEAST(p_outstanding, c.base_cents) / c.base_cents)::INTEGER);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- apply_affiliate_claim_change() — THE single economic primitive
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Sets a source's claim to p_target_claim and books the resulting global money
-- change. Every refund, dispute loss, dispute win and revision goes through here.
--
-- A row is written whenever the claim OR the money changed, so a zero-cent
-- movement still records its claim and the sequence stays reconstructable.
CREATE OR REPLACE FUNCTION apply_affiliate_claim_change(
  p_commission_id  UUID,
  p_source_key     TEXT,
  p_target_claim   INTEGER,
  p_reason         TEXT,
  p_effective_at   TIMESTAMPTZ,
  p_source_refund_id UUID DEFAULT NULL,
  p_source_dispute_id UUID DEFAULT NULL,
  p_source_dispute_adjustment_id UUID DEFAULT NULL,
  p_actor          TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  c            affiliate_commissions;
  v_current    INTEGER;
  v_delta      INTEGER;
  v_out_before INTEGER;
  v_out_after  INTEGER;
  v_tgt_before INTEGER;
  v_tgt_after  INTEGER;
  v_money      INTEGER;
  v_id         UUID;
BEGIN
  SELECT * INTO c FROM affiliate_commissions WHERE id = p_commission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|COMMISSION_NOT_FOUND|%', p_commission_id;
  END IF;
  IF c.commission_cents = 0 OR c.base_cents = 0 THEN
    RETURN jsonb_build_object('outcome','no_commission','adjustment_cents',0);
  END IF;
  IF p_target_claim IS NULL OR p_target_claim < 0 THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|INVALID_CLAIM';
  END IF;

  v_current    := affiliate_source_claim(p_commission_id, p_source_key);
  v_delta      := p_target_claim - v_current;
  v_out_before := affiliate_outstanding_merchandise(p_commission_id);
  v_tgt_before := affiliate_reversal_target(p_commission_id, v_out_before);

  IF v_delta = 0 THEN
    RETURN jsonb_build_object('outcome','no_change','adjustment_cents',0,
      'source_claim',v_current,'outstanding_merchandise',v_out_before);
  END IF;

  -- Position AFTER this claim change, capped only here.
  v_out_after := LEAST(c.base_cents, GREATEST(0, v_out_before
                 + (v_delta - (LEAST(c.base_cents, GREATEST(0,
                     (SELECT COALESCE(SUM(claim_delta_cents),0)
                      FROM affiliate_commission_adjustments
                      WHERE commission_id = p_commission_id))) - v_out_before))));
  -- Simpler and exact: recompute from the raw sum including this delta.
  v_out_after := LEAST(c.base_cents, GREATEST(0,
    COALESCE((SELECT SUM(claim_delta_cents) FROM affiliate_commission_adjustments
              WHERE commission_id = p_commission_id), 0) + v_delta));

  v_tgt_after := affiliate_reversal_target(p_commission_id, v_out_after);
  -- Negative reverses, positive restores.
  v_money := v_tgt_before - v_tgt_after;

  INSERT INTO affiliate_commission_adjustments (
    commission_id, order_id, affiliate_id, adjustment_cents,
    effective_at, knowledge_at, reason,
    source_refund_id, source_dispute_id, source_dispute_adjustment_id,
    claim_source_key, claim_delta_cents,
    merchandise_reversed_this, cumulative_merchandise_reversed_after, created_by
  ) VALUES (
    p_commission_id, c.order_id, c.affiliate_id, v_money,
    p_effective_at, NOW(), p_reason,
    p_source_refund_id, p_source_dispute_id, p_source_dispute_adjustment_id,
    p_source_key, v_delta,
    v_out_after - v_out_before, v_out_after, p_actor
  ) RETURNING id INTO v_id;

  -- Status comes from the ONE authoritative rule. Restoring economics must never
  -- fabricate lifecycle eligibility, so a commission still inside its hold window
  -- returns to pending rather than jumping to approved.
  PERFORM refresh_affiliate_commission_state(p_commission_id);

  RETURN jsonb_build_object(
    'outcome','applied','adjustment_id',v_id,'adjustment_cents',v_money,
    'source_claim',p_target_claim,'claim_delta',v_delta,
    'outstanding_before',v_out_before,'outstanding_after',v_out_after,
    'target_before',v_tgt_before,'target_after',v_tgt_after
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- apply_affiliate_refund_reversal() — merchandise-only, resolved-only
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Uses order_refunds.merchandise_refund_cents, which 018 populates only once the
-- component breakdown is RESOLVED. Shipping refunds and tax refunds never reverse
-- commission, and the raw Stripe total is never used as a substitute.
--
-- While the breakdown is unresolved the commission is flagged INCOMPLETE and no
-- adjustment is written. Unknown is not zero and is not guessed.
CREATE OR REPLACE FUNCTION apply_affiliate_refund_reversal(
  p_refund_id UUID,
  p_actor     TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  r        RECORD;
  v_comm   affiliate_commissions;
  v_exists UUID;
BEGIN
  SELECT id, order_id, status, amount_cents, merchandise_refund_cents,
         component_breakdown_status, refunded_at, created_at
  INTO r FROM order_refunds WHERE id = p_refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|REFUND_NOT_FOUND|%', p_refund_id;
  END IF;

  SELECT * INTO v_comm FROM affiliate_commissions WHERE order_id = r.order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome','no_affiliate_order','refund_id',p_refund_id);
  END IF;

  -- Idempotent: one reversal per refund.
  SELECT id INTO v_exists FROM affiliate_commission_adjustments
  WHERE commission_id = v_comm.id AND source_refund_id = p_refund_id
    AND reason = 'refund_reversal';
  IF v_exists IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','already_applied','adjustment_id',v_exists);
  END IF;

  IF r.status <> 'succeeded' THEN
    RETURN jsonb_build_object('outcome','refund_not_succeeded','status',r.status);
  END IF;

  -- Unknown decomposition: flag, do not guess, do not zero.
  IF r.component_breakdown_status <> 'resolved'
     OR r.merchandise_refund_cents IS NULL THEN
    -- Derived from the authoritative sources, never blindly toggled.
    PERFORM refresh_affiliate_incomplete(v_comm.id);
    RETURN jsonb_build_object('outcome','incomplete_pending_reconciliation',
      'commission_id',v_comm.id,'refund_id',p_refund_id);
  END IF;

  -- The refund's claim is its OWN merchandise amount, held independently of any
  -- dispute claim. It survives even when the global position is already
  -- saturated, so a later dispute win releases only the dispute's share.
  RETURN apply_affiliate_claim_change(
    v_comm.id, 'refund:' || p_refund_id::text, r.merchandise_refund_cents,
    'refund_reversal', COALESCE(r.refunded_at, r.created_at),
    p_refund_id, NULL, NULL, p_actor);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- sync_affiliate_dispute_state() — DISPUTE-centric, not 018-adjustment-centric
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 018 writes order_dispute_financial_adjustments ONLY when its gross revenue
-- delta is non-zero. A dispute can nonetheless change the merchandise a
-- commission is exposed to while that delta is zero — for example when an
-- earlier gross refund (all shipping, zero merchandise) already offsets the
-- disputed amount. Driving affiliate accounting from those rows therefore missed
-- real exposure entirely.
--
-- This reads the CURRENT order_disputes row and sets the source claim
-- 'dispute:<id>' to the CURRENT target:
--
--   lost, full charge          -> deterministic merchandise (subtotal - discount)
--   lost, partial + resolved   -> the current decomposition's merchandise
--   lost, partial + unresolved -> no target is guessed; commission Incomplete
--   won/withdrawn/prevented/open/under_review -> 0
--
-- IDEMPOTENCY COMES FROM THE MODEL, NOT FROM A SOURCE KEY. Because the claim is
-- a TARGET, re-running with unchanged state produces a zero delta and books
-- nothing. That also fixes decomposition corrections, which the old
-- source_dispute_adjustment_id key rejected as 'already_applied'.
CREATE OR REPLACE FUNCTION sync_affiliate_dispute_state(
  p_dispute_id    UUID,
  p_effective_at  TIMESTAMPTZ DEFAULT NULL,
  p_actor         TEXT DEFAULT NULL,
  p_adjustment_id UUID DEFAULT NULL,   -- optional provenance
  p_resolution_id UUID DEFAULT NULL    -- optional provenance
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  d        RECORD;
  o        RECORD;
  v_comm   affiliate_commissions;
  v_target INTEGER;
  v_merch  INTEGER;
  v_key    TEXT;
  v_eff    TIMESTAMPTZ;
  v_res    JSONB;
BEGIN
  SELECT id, order_id, status, amount_cents, opened_at, resolved_at
  INTO d FROM order_disputes WHERE id = p_dispute_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|DISPUTE_NOT_FOUND|%', p_dispute_id;
  END IF;

  SELECT * INTO v_comm FROM affiliate_commissions WHERE order_id = d.order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome','no_affiliate_order','order_id',d.order_id);
  END IF;

  v_key := 'dispute:' || d.id::text;
  v_eff := COALESCE(p_effective_at, d.resolved_at, d.opened_at, NOW());

  IF d.status IS DISTINCT FROM 'lost' THEN
    -- No current exposure. Releases any claim this dispute still holds.
    v_res := apply_affiliate_claim_change(
      v_comm.id, v_key, 0,
      CASE WHEN affiliate_source_claim(v_comm.id, v_key) > 0
           THEN 'dispute_won_restore' ELSE 'dispute_reversal' END,
      v_eff, NULL, d.id, p_adjustment_id, p_actor);
    -- A status-driven win has no merchandise-resolution cause, so none is
    -- invented; the link is stamped only when one was actually supplied.
    IF p_resolution_id IS NOT NULL AND (v_res->>'adjustment_id') IS NOT NULL THEN
      UPDATE affiliate_commission_adjustments
      SET source_dispute_resolution_id = p_resolution_id
      WHERE id = (v_res->>'adjustment_id')::uuid;
    END IF;
    PERFORM refresh_affiliate_commission_state(v_comm.id);
    RETURN v_res || jsonb_build_object('dispute_status', d.status);
  END IF;

  -- CURRENT decomposition for the dispute's CURRENT amount.
  SELECT merchandise_cents INTO v_merch
  FROM dispute_merchandise_resolutions
  WHERE dispute_id = d.id
    AND resolved_disputed_amount_cents = d.amount_cents
    AND superseded_at IS NULL
  LIMIT 1;

  IF v_merch IS NOT NULL THEN
    v_target := v_merch;
  ELSE
    SELECT subtotal_cents, discount_cents, total_cents INTO o
    FROM orders WHERE id = d.order_id;
    IF d.amount_cents = o.total_cents THEN
      v_target := GREATEST(0, COALESCE(o.subtotal_cents,0) - COALESCE(o.discount_cents,0));
    ELSE
      -- Partial and undecomposed: never guessed. Flagged from CURRENT state, so
      -- this works even when 018 booked no revenue delta at all.
      PERFORM refresh_affiliate_commission_state(v_comm.id);
      RETURN jsonb_build_object(
        'outcome','incomplete_pending_reconciliation',
        'commission_id',v_comm.id,'dispute_id',d.id,
        'disputed_amount_cents',d.amount_cents,'order_total_cents',o.total_cents);
    END IF;
  END IF;

  v_res := apply_affiliate_claim_change(
    v_comm.id, v_key, v_target, 'dispute_reversal',
    v_eff, NULL, d.id, p_adjustment_id, p_actor);

  -- ── PROVENANCE: link the movement to the resolution that CAUSED it ───────
  --
  -- Stamped here rather than passed into apply_affiliate_claim_change, because
  -- adding a parameter to that function would create a second signature and a
  -- new overload on reapply. This runs in the same transaction, so the financial
  -- adjustment and its provenance commit atomically.
  --
  -- A duplicate retry books no row (the claim delta is zero), so there is
  -- nothing to stamp and nothing is invented.
  IF p_resolution_id IS NOT NULL AND (v_res->>'adjustment_id') IS NOT NULL THEN
    UPDATE affiliate_commission_adjustments
    SET source_dispute_resolution_id = p_resolution_id
    WHERE id = (v_res->>'adjustment_id')::uuid;
  END IF;

  PERFORM refresh_affiliate_commission_state(v_comm.id);
  RETURN v_res || jsonb_build_object('dispute_status', d.status,
    'merchandise_target', v_target,
    'source_dispute_resolution_id', p_resolution_id);
END;
$$;

/**
 * Thin compatibility wrapper: an 018 ledger row simply identifies which dispute
 * to re-sync. The row itself is provenance, never the driver.
 */
CREATE OR REPLACE FUNCTION apply_affiliate_dispute_adjustment(
  p_dispute_adjustment_id UUID,
  p_actor                 TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE a RECORD;
BEGIN
  SELECT dispute_id, effective_at INTO a
  FROM order_dispute_financial_adjustments WHERE id = p_dispute_adjustment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|DISPUTE_ADJUSTMENT_NOT_FOUND|%', p_dispute_adjustment_id;
  END IF;
  RETURN sync_affiliate_dispute_state(a.dispute_id, a.effective_at, p_actor,
                                      p_dispute_adjustment_id, NULL);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- resolve_dispute_merchandise() — admin decomposition of a partial dispute
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The dispute analogue of resolve_refund_components, designed for disputes
-- rather than copied from refunds.
--
-- The three components must total the DISPUTED amount exactly, and the
-- merchandise portion cannot exceed the merchandise economics actually available
-- on the order (subtotal - discount). Negative and impossible values are refused.
--
-- Duplicate resolution is prevented structurally by dmr_adjustment_uq. On
-- success the affiliate adjustment fires EXACTLY ONCE through the shared
-- cumulative primitive, so refund and dispute still cannot double-reverse.
--
-- BOTH TIMESTAMPS SURVIVE: effective_at is the economic date of the dispute
-- event, resolved_at is when KVRN learned the split. A June dispute decomposed in
-- July is recognised in June and carries knowledge_at = July.
CREATE OR REPLACE FUNCTION resolve_dispute_merchandise(
  p_dispute_adjustment_id UUID,
  p_merchandise_cents     INTEGER,
  p_shipping_cents        INTEGER,
  p_tax_cents             INTEGER,
  p_actor                 TEXT,
  p_notes                 TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  d            RECORD;
  o            RECORD;
  v_avail      INTEGER;
  v_exists     UUID;
  v_cur        RECORD;
  v_supersedes UUID;
  v_version    INTEGER := 1;
  v_res_id     UUID;
  v_apply      JSONB;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|ACTOR_REQUIRED';
  END IF;
  IF COALESCE(p_merchandise_cents,-1) < 0
     OR COALESCE(p_shipping_cents,-1) < 0
     OR COALESCE(p_tax_cents,-1) < 0 THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|NEGATIVE_COMPONENT';
  END IF;

  SELECT a.id, a.dispute_id, a.order_id, a.adjustment_cents, a.effective_at,
         a.disputed_amount_cents
  INTO d FROM order_dispute_financial_adjustments a WHERE a.id = p_dispute_adjustment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|ADJUSTMENT_NOT_FOUND|%', p_dispute_adjustment_id;
  END IF;

  -- Current decomposition for THIS disputed amount, if any.
  SELECT id, merchandise_cents, shipping_cents, tax_cents, version
  INTO v_cur FROM dispute_merchandise_resolutions
  WHERE dispute_id = d.dispute_id
    AND resolved_disputed_amount_cents = d.disputed_amount_cents
    AND superseded_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    -- Identical retry: idempotent no-op, so a double submit cannot apply twice.
    IF v_cur.merchandise_cents = p_merchandise_cents
       AND v_cur.shipping_cents = p_shipping_cents
       AND v_cur.tax_cents = p_tax_cents THEN
      RETURN jsonb_build_object('outcome','already_resolved','resolution_id',v_cur.id,
        'version',v_cur.version);
    END IF;
    -- Genuine CORRECTION: a correction reason is required, and the previous row
    -- is marked superseded rather than edited.
    IF p_notes IS NULL OR p_notes = '' THEN
      RAISE EXCEPTION 'KVRN_DISPUTE|CORRECTION_REASON_REQUIRED|superseding version %',
        v_cur.version;
    END IF;
    UPDATE dispute_merchandise_resolutions
    SET superseded_at = NOW() WHERE id = v_cur.id;
    v_supersedes := v_cur.id;
    v_version    := v_cur.version + 1;
  END IF;

  -- Components must total the CURRENT GROSS DISPUTED AMOUNT, never an 018
  -- revenue-delta, which is a change in impact rather than merchandise content.
  IF (p_merchandise_cents + p_shipping_cents + p_tax_cents) <> d.disputed_amount_cents THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|COMPONENTS_DO_NOT_TOTAL|sum:% disputed:%',
      p_merchandise_cents + p_shipping_cents + p_tax_cents, d.disputed_amount_cents;
  END IF;

  -- Merchandise cannot exceed the merchandise economics that exist on the order.
  SELECT subtotal_cents, discount_cents, total_cents INTO o
  FROM orders WHERE id = d.order_id;
  v_avail := GREATEST(0, COALESCE(o.subtotal_cents,0) - COALESCE(o.discount_cents,0));
  IF p_merchandise_cents > v_avail THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|MERCHANDISE_EXCEEDS_ORDER|available:% supplied:%',
      v_avail, p_merchandise_cents;
  END IF;

  INSERT INTO dispute_merchandise_resolutions (
    dispute_id, dispute_adjustment_id, order_id,
    merchandise_cents, shipping_cents, tax_cents, disputed_amount_cents,
    resolved_disputed_amount_cents, effective_at, resolved_by, notes,
    supersedes_resolution_id, version, correction_reason
  ) VALUES (
    d.dispute_id, p_dispute_adjustment_id, d.order_id,
    p_merchandise_cents, p_shipping_cents, p_tax_cents, d.disputed_amount_cents,
    d.disputed_amount_cents, d.effective_at, p_actor, p_notes,
    v_supersedes, v_version, CASE WHEN v_supersedes IS NOT NULL THEN p_notes END
  ) RETURNING id INTO v_res_id;

  -- Atomic audit: the mutation and its evidence share one transaction.
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor,
          CASE WHEN v_supersedes IS NOT NULL THEN 'resolve_merchandise_correction'
               ELSE 'resolve_merchandise' END,
          'order_disputes', d.dispute_id::text,
          jsonb_build_object('resolution_id',v_res_id,'version',v_version,
            'supersedes',v_supersedes,'merchandise_cents',p_merchandise_cents,
            'disputed_amount_cents',d.disputed_amount_cents));

  -- Re-sync from CURRENT dispute state. A correction therefore MOVES the claim
  -- rather than being rejected as already applied: the claim is a target, and the
  -- new resolution is now the current one.
  v_apply := sync_affiliate_dispute_state(
    d.dispute_id, d.effective_at, p_actor, p_dispute_adjustment_id, v_res_id);

  -- Recompute rather than clear: another dispute or an unresolved refund may
  -- still be blocking this commission.
  PERFORM refresh_affiliate_incomplete(c2.id)
  FROM affiliate_commissions c2 WHERE c2.order_id = d.order_id;

  RETURN jsonb_build_object(
    'outcome','resolved','resolution_id',v_res_id,
    'merchandise_cents',p_merchandise_cents,
    'economic_effective_at',d.effective_at,'knowledge_at',NOW(),
    'affiliate_effect',v_apply);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- resolve_dispute_merchandise_by_dispute() — decompose WITHOUT an 018 row
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The canonical admin entry point. A lost partial dispute can exist with NO
-- order_dispute_financial_adjustments row at all, because 018 emits one only
-- when its gross revenue delta is non-zero. Requiring such a row made exactly
-- those disputes impossible to reconcile.
--
-- Components must total the dispute's CURRENT gross amount. An 018 row is
-- attached as provenance when one happens to exist, but is never required.
CREATE OR REPLACE FUNCTION resolve_dispute_merchandise_by_dispute(
  p_dispute_id        UUID,
  p_merchandise_cents INTEGER,
  p_shipping_cents    INTEGER,
  p_tax_cents         INTEGER,
  p_actor             TEXT,
  p_notes             TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  d            RECORD;
  o            RECORD;
  v_avail      INTEGER;
  v_cur        RECORD;
  v_supersedes UUID;
  v_version    INTEGER := 1;
  v_res_id     UUID;
  v_prov       UUID;
  v_apply      JSONB;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|ACTOR_REQUIRED';
  END IF;
  IF COALESCE(p_merchandise_cents,-1) < 0 OR COALESCE(p_shipping_cents,-1) < 0
     OR COALESCE(p_tax_cents,-1) < 0 THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|NEGATIVE_COMPONENT';
  END IF;

  SELECT id, order_id, amount_cents, status, opened_at, resolved_at
  INTO d FROM order_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|NOT_FOUND|%', p_dispute_id;
  END IF;

  IF (p_merchandise_cents + p_shipping_cents + p_tax_cents) <> d.amount_cents THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|COMPONENTS_DO_NOT_TOTAL|sum:% disputed:%',
      p_merchandise_cents + p_shipping_cents + p_tax_cents, d.amount_cents;
  END IF;

  SELECT subtotal_cents, discount_cents INTO o FROM orders WHERE id = d.order_id;
  v_avail := GREATEST(0, COALESCE(o.subtotal_cents,0) - COALESCE(o.discount_cents,0));
  IF p_merchandise_cents > v_avail THEN
    RAISE EXCEPTION 'KVRN_DISPUTE|MERCHANDISE_EXCEEDS_ORDER|available:% supplied:%',
      v_avail, p_merchandise_cents;
  END IF;

  -- Current decomposition for this amount, if any.
  SELECT id, merchandise_cents, shipping_cents, tax_cents, version
  INTO v_cur FROM dispute_merchandise_resolutions
  WHERE dispute_id = d.id AND resolved_disputed_amount_cents = d.amount_cents
    AND superseded_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF v_cur.merchandise_cents = p_merchandise_cents
       AND v_cur.shipping_cents = p_shipping_cents
       AND v_cur.tax_cents = p_tax_cents THEN
      RETURN jsonb_build_object('outcome','already_resolved',
        'resolution_id',v_cur.id,'version',v_cur.version);
    END IF;
    IF p_notes IS NULL OR p_notes = '' THEN
      RAISE EXCEPTION 'KVRN_DISPUTE|CORRECTION_REASON_REQUIRED|superseding version %',
        v_cur.version;
    END IF;
    UPDATE dispute_merchandise_resolutions SET superseded_at = NOW() WHERE id = v_cur.id;
    v_supersedes := v_cur.id;
    v_version    := v_cur.version + 1;
  END IF;

  -- Optional provenance only.
  SELECT id INTO v_prov FROM order_dispute_financial_adjustments
  WHERE dispute_id = d.id ORDER BY created_at DESC LIMIT 1;

  INSERT INTO dispute_merchandise_resolutions (
    dispute_id, dispute_adjustment_id, order_id,
    merchandise_cents, shipping_cents, tax_cents, disputed_amount_cents,
    resolved_disputed_amount_cents, effective_at, resolved_by, notes,
    supersedes_resolution_id, version, correction_reason
  ) VALUES (
    d.id, v_prov, d.order_id,
    p_merchandise_cents, p_shipping_cents, p_tax_cents, d.amount_cents,
    d.amount_cents, COALESCE(d.resolved_at, d.opened_at, NOW()), p_actor, p_notes,
    v_supersedes, v_version, CASE WHEN v_supersedes IS NOT NULL THEN p_notes END
  ) RETURNING id INTO v_res_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor,
          CASE WHEN v_supersedes IS NOT NULL THEN 'resolve_merchandise_correction'
               ELSE 'resolve_merchandise' END,
          'order_disputes', d.id::text,
          jsonb_build_object('resolution_id',v_res_id,'version',v_version,
            'supersedes',v_supersedes,'merchandise_cents',p_merchandise_cents,
            'disputed_amount_cents',d.amount_cents));

  -- Re-sync from CURRENT state, so a correction MOVES the claim.
  v_apply := sync_affiliate_dispute_state(d.id, NULL, p_actor, v_prov, v_res_id);

  RETURN jsonb_build_object('outcome','resolved','resolution_id',v_res_id,
    'version',v_version,'merchandise_cents',p_merchandise_cents,
    'affiliate_effect',v_apply);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- backfill_order_affiliate_attribution() — late attribution that catches up
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Attribution at payment time is deliberately non-fatal, so a transient failure
-- must not permanently lose an affiliate obligation. This retries it.
--
-- THE HARD PART IS NOT CREATING THE ATTRIBUTION, IT IS CATCHING UP. Refunds and
-- disputes may already have happened. The resulting state must be IDENTICAL to
-- what would exist had attribution succeeded at payment time, so every
-- authoritative economic event on the order is replayed into CURRENT source
-- claims:
--
--   resolved refund          -> claim its merchandise
--   unresolved refund        -> no claim; commission goes Incomplete
--   dispute currently lost, full charge   -> deterministic merchandise claim
--   dispute currently lost, partial+resolved -> the resolved merchandise
--   dispute currently lost, partial+unresolved -> Incomplete
--   dispute won / prevented  -> no claim at all
--
-- Because claims are TARGETS derived from current state, a dispute that cycled
-- lost -> won -> lost is applied once at its current position. There is no replay
-- and no double counting.
--
-- Historical terms are used throughout: resolve_order_affiliate_attribution
-- reads affiliate_terms_at(order finalization), so a rate changed after the
-- order cannot alter its economics.
--
-- Idempotent: an order that already has an attribution is returned untouched,
-- and a finalized attribution is never rewritten.
CREATE OR REPLACE FUNCTION backfill_order_affiliate_attribution(
  p_order_id   UUID,
  p_session_id TEXT DEFAULT NULL,
  p_actor      TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_session TEXT;
  v_attr    JSONB;
  v_comm    UUID;
  r         RECORD;
  v_applied INTEGER := 0;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_AFFILIATE|ACTOR_REQUIRED';
  END IF;

  -- ── RECOVER THE SESSION IDENTITY FROM PERSISTED ORDER DATA ──────────────
  -- An admin must never know or type an opaque kvrn_sid. The checkout path
  -- persisted it onto the reservation and finalize_paid_order copied it to
  -- orders.attribution, so it is recoverable from order identity alone.
  --
  -- p_session_id is NOT an admin input. It carries a value the SERVER recovered
  -- from Stripe's client_reference_id when local data is missing, and it is only
  -- honoured when it maps to real local click evidence — so a forged value
  -- cannot manufacture an attribution.
  -- The LOCAL snapshot is only authoritative when it is actually usable. A
  -- corrupt or truncated kvrn_sid is non-empty, so trusting it would suppress
  -- the caller's Stripe fallback and then resolve to nothing — turning CORRUPT
  -- EVIDENCE into a confident negative, which is the single outcome this
  -- recovery path exists to prevent.
  SELECT o.attribution->>'kvrn_sid' INTO v_session FROM orders o WHERE o.id = p_order_id;

  IF v_session IS NOT NULL
     AND (v_session !~ '^[A-Za-z0-9_-]{32,128}$'
          OR NOT EXISTS (SELECT 1 FROM affiliate_clicks WHERE session_id = v_session))
  THEN
    v_session := NULL;   -- unusable: fall through exactly as if nothing was stored
  END IF;

  IF v_session IS NULL AND p_session_id IS NOT NULL THEN
    IF p_session_id !~ '^[A-Za-z0-9_-]{32,128}$' THEN
      RAISE EXCEPTION 'KVRN_AFFILIATE|MALFORMED_RECOVERED_SESSION';
    END IF;
    -- Must correspond to actual stored referral evidence.
    IF EXISTS (SELECT 1 FROM affiliate_clicks WHERE session_id = p_session_id) THEN
      v_session := p_session_id;
    END IF;
  END IF;

  -- Never rewrite a finalized attribution.
  v_attr := resolve_order_affiliate_attribution(p_order_id, v_session, p_actor);

  IF v_attr->>'outcome' <> 'attributed' THEN
    -- The ADMIN INVOCATION is auditable even when nothing changed. A retry
    -- mechanism whose no-op outcomes leave no trace cannot be reviewed.
    INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
    VALUES (p_actor, 'backfill_attempt', 'orders', p_order_id::text,
            jsonb_build_object('outcome', v_attr->>'outcome',
                               'session_recovered', v_session IS NOT NULL));
    RETURN jsonb_build_object('outcome', v_attr->>'outcome', 'attribution', v_attr);
  END IF;

  SELECT id INTO v_comm FROM affiliate_commissions WHERE order_id = p_order_id;

  -- ── Catch up on refunds ─────────────────────────────────────────────────
  FOR r IN
    SELECT id FROM order_refunds
    WHERE order_id = p_order_id AND status = 'succeeded'
    ORDER BY COALESCE(refunded_at, created_at)
  LOOP
    PERFORM apply_affiliate_refund_reversal(r.id, p_actor);
    v_applied := v_applied + 1;
  END LOOP;

  -- ── Catch up on disputes from CURRENT state ─────────────────────────────
  -- Iterates order_disputes directly. The previous version picked one 018 row
  -- per dispute using ORDER BY effective_at DESC, which reintroduced exactly the
  -- economic-date ordering Stage 1 removed: effective_at is a RECOGNITION date,
  -- and a backdated correction can sort earlier than an already-processed later
  -- event. It also missed disputes for which 018 emitted no row at all.
  FOR r IN
    SELECT d.id FROM order_disputes d WHERE d.order_id = p_order_id ORDER BY d.id
  LOOP
    PERFORM sync_affiliate_dispute_state(r.id, NULL, p_actor, NULL, NULL);
    v_applied := v_applied + 1;
  END LOOP;

  PERFORM refresh_affiliate_commission_state(v_comm);

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'backfill_attempt', 'orders', p_order_id::text,
          jsonb_build_object('outcome', 'backfilled',
                             'commission_id', v_comm,
                             'events_reconciled', v_applied,
                             'session_recovered', v_session IS NOT NULL));

  RETURN jsonb_build_object(
    'outcome','backfilled','commission_id',v_comm,
    'events_reconciled',v_applied,
    'net_commission_cents',
      (SELECT COALESCE(SUM(adjustment_cents),0)
       FROM affiliate_commission_adjustments WHERE commission_id = v_comm),
    'incomplete', (SELECT incomplete FROM affiliate_commissions WHERE id = v_comm),
    'session_recovered', v_session IS NOT NULL,
    'status', (SELECT status FROM affiliate_commissions WHERE id = v_comm));
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_unresolved_sources() — CURRENT exposure, not historical rows
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Rev 2 treated every historical negative partial 018 row without a
-- decomposition as a permanent blocker. A partial dispute that was lost, never
-- decomposed, and then WON stayed Incomplete forever: no merchandise was ever
-- reversed, there was nothing left to quantify, yet the old row kept blocking.
--
-- Blocking is therefore derived from CURRENT unquantified exposure:
--
--   refund   a succeeded refund whose component breakdown is still unknown
--   dispute  a dispute whose CURRENT status is lost, whose CURRENT disputed
--            amount is partial, and which has no decomposition FOR THAT AMOUNT
--
-- A won, withdrawn or prevented dispute has no outstanding merchandise claim, so
-- it never blocks regardless of its unresolved history. A full-charge dispute is
-- never a blocker: its merchandise share is deterministic.
CREATE OR REPLACE FUNCTION affiliate_unresolved_sources(p_commission_id UUID)
RETURNS TABLE (source_kind TEXT, source_id UUID, detail TEXT)
LANGUAGE sql STABLE AS $$
  WITH c AS (SELECT order_id FROM affiliate_commissions WHERE id = p_commission_id)
  SELECT 'refund'::text, r.id, 'component_breakdown_unresolved'::text
  FROM order_refunds r, c
  WHERE r.order_id = c.order_id
    AND r.status = 'succeeded'
    AND (r.component_breakdown_status <> 'resolved' OR r.merchandise_refund_cents IS NULL)
  UNION ALL
  -- CURRENT dispute state only.
  SELECT 'dispute'::text, d.id, 'partial_dispute_merchandise_unresolved'::text
  FROM order_disputes d
  JOIN orders o ON o.id = d.order_id, c
  WHERE d.order_id = c.order_id
    AND d.status = 'lost'                                  -- still an exposure
    AND d.amount_cents <> o.total_cents                    -- partial only
    AND NOT EXISTS (
      SELECT 1 FROM dispute_merchandise_resolutions m
      WHERE m.dispute_id = d.id
        AND m.resolved_disputed_amount_cents = d.amount_cents);  -- for THIS amount
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_derive_commission_status() — the ONE status rule
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Status was previously assigned ad hoc at several call sites, which let a
-- dispute win flip a commission straight from reversed to approved and bypass
-- the remainder of its hold window.
--
-- Restoring ECONOMICS must never fabricate LIFECYCLE eligibility. One rule:
--
--   fully reversed          -> reversed
--   unresolved blocker      -> pending  (and incomplete is set)
--   before eligible_at      -> pending
--   eligible, complete      -> approved
--   any cash already paid   -> paid     (payout history is authoritative)
CREATE OR REPLACE FUNCTION affiliate_derive_commission_status(
  p_commission_id UUID, p_now TIMESTAMPTZ DEFAULT NOW()
) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c          affiliate_commissions;
  v_target   INTEGER;
  v_blocked  INTEGER;
  v_paid     INTEGER;
BEGIN
  SELECT * INTO c FROM affiliate_commissions WHERE id = p_commission_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(l.amount_cents),0) INTO v_paid
  FROM affiliate_payout_lines l JOIN affiliate_payouts p ON p.id = l.payout_id
  WHERE l.commission_id = p_commission_id AND p.status = 'paid';

  -- Real cash has moved; the payout history is the authoritative record.
  IF v_paid > 0 THEN RETURN 'paid'; END IF;

  v_target := affiliate_reversal_target(p_commission_id,
                affiliate_outstanding_merchandise(p_commission_id));
  IF c.commission_cents > 0 AND v_target >= c.commission_cents THEN
    RETURN 'reversed';
  END IF;

  SELECT COUNT(*) INTO v_blocked FROM affiliate_unresolved_sources(p_commission_id);
  IF v_blocked > 0 THEN RETURN 'pending'; END IF;

  IF c.eligible_at > p_now THEN RETURN 'pending'; END IF;
  RETURN 'approved';
END;
$$;

/** Recompute BOTH the incomplete flag and the status from authoritative state. */
CREATE OR REPLACE FUNCTION refresh_affiliate_commission_state(
  p_commission_id UUID, p_now TIMESTAMPTZ DEFAULT NOW()
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER; v_reason TEXT; v_status TEXT;
BEGIN
  SELECT COUNT(*), MIN(detail) INTO v_count, v_reason
  FROM affiliate_unresolved_sources(p_commission_id);

  UPDATE affiliate_commissions
  SET incomplete = (v_count > 0),
      incomplete_reason = CASE
        WHEN v_count = 0 THEN NULL
        WHEN v_count = 1 THEN v_reason
        ELSE v_count || ' unresolved sources' END,
      updated_at = NOW()
  WHERE id = p_commission_id;

  v_status := affiliate_derive_commission_status(p_commission_id, p_now);
  UPDATE affiliate_commissions
  SET status = v_status, updated_at = NOW()
  WHERE id = p_commission_id AND status IS DISTINCT FROM v_status;

  RETURN jsonb_build_object('commission_id',p_commission_id,
    'unresolved_count',v_count,'incomplete',v_count > 0,'status',v_status);
END;
$$;

-- Backwards-compatible alias used by earlier call sites.
CREATE OR REPLACE FUNCTION refresh_affiliate_incomplete(p_commission_id UUID)
RETURNS JSONB
LANGUAGE sql AS $$
  SELECT refresh_affiliate_commission_state(p_commission_id);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- resume_affiliate_after_refund_resolution() — no webhook retry required
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When an admin supplies a refund's component breakdown, the affiliate reversal
-- that was blocked must be applied as part of THAT workflow. Waiting for another
-- Stripe webhook would mean the commission stayed wrong indefinitely, since
-- Stripe has no reason to redeliver a refund that already succeeded.
--
-- Idempotent through the existing (commission_id, source_refund_id) unique index,
-- so calling it twice is harmless. Also refreshes the derived incomplete flag, so
-- the commission stays blocked if another source is still unresolved.
CREATE OR REPLACE FUNCTION resume_affiliate_after_refund_resolution(
  p_refund_id UUID, p_actor TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_order  UUID;
  v_comm   UUID;
  v_apply  JSONB;
BEGIN
  SELECT order_id INTO v_order FROM order_refunds WHERE id = p_refund_id;
  IF v_order IS NULL THEN
    RETURN jsonb_build_object('outcome','refund_not_found');
  END IF;

  SELECT id INTO v_comm FROM affiliate_commissions WHERE order_id = v_order;
  IF v_comm IS NULL THEN
    RETURN jsonb_build_object('outcome','no_affiliate_order');
  END IF;

  v_apply := apply_affiliate_refund_reversal(p_refund_id, p_actor);

  RETURN jsonb_build_object(
    'outcome','resumed','commission_id',v_comm,
    'reversal',v_apply,
    'incomplete_state', refresh_affiliate_incomplete(v_comm));
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- approve_eligible_commissions() — automatic ELIGIBILITY, never automatic money
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Approval means "past the hold window and quantified". It authorises nothing
-- financial: money moves only when an admin creates and marks a payout paid.
--
-- eligible_at was frozen at accrual from the snapshotted hold days, so changing
-- an affiliate's configuration later cannot move a historical eligibility date.
/**
 * Promote eligible commissions for ONE affiliate, race-safely.
 *
 * Called lazily on every authoritative payable/list read, so eligibility happens
 * without any admin action and without a scheduler. SKIP LOCKED means two
 * concurrent readers cannot contend: whichever gets the row promotes it, the
 * other simply sees the result.
 *
 * Promotion is ELIGIBILITY ONLY. No money moves; a payout remains a separate,
 * explicit admin action.
 */
CREATE OR REPLACE FUNCTION promote_eligible_commissions_for_affiliate(
  p_affiliate_id UUID, p_now TIMESTAMPTZ DEFAULT NOW()
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT id FROM affiliate_commissions
    WHERE affiliate_id = p_affiliate_id
      AND status = 'pending'
      AND eligible_at <= p_now
      AND commission_cents > 0
    FOR UPDATE SKIP LOCKED
  LOOP
    -- The single authoritative rule decides; it re-checks blockers itself.
    PERFORM refresh_affiliate_commission_state(r.id, p_now);
    IF (SELECT status FROM affiliate_commissions WHERE id = r.id) = 'approved' THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION approve_eligible_commissions(p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  WITH upd AS (
    UPDATE affiliate_commissions
    SET status = 'approved', approved_at = p_now, approved_by = 'system:auto_hold',
        updated_at = NOW()
    WHERE status = 'pending'
      AND eligible_at <= p_now
      AND NOT incomplete            -- unquantified cases never auto-approve
      AND commission_cents > 0
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM upd;
  RETURN jsonb_build_object('outcome','approved','count',v_count);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_commission_payable() — authoritative, server-side
-- ═══════════════════════════════════════════════════════════════════════════
--
--   payable = SUM(all ledger adjustments) - SUM(amounts on non-void payouts)
--
-- Draft lines ARE subtracted here, deliberately: a draft reserves the amount so
-- a second payout cannot be built from the same money. Voiding the draft frees
-- it again. This is a RESERVATION, not a cash statement — see
-- affiliate_commission_overpaid for the cash view.
--
-- A commission may legitimately be paid, partly reversed, recovered, restored by
-- a later dispute win, and become payable again. That is why payout lines are
-- unique per PAYOUT rather than once per commission for all time.
--
-- Never accepts a client-supplied amount.
CREATE OR REPLACE FUNCTION affiliate_commission_payable(p_commission_id UUID)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(0,
    COALESCE((SELECT SUM(adjustment_cents) FROM affiliate_commission_adjustments
              WHERE commission_id = p_commission_id), 0)
  - COALESCE((SELECT SUM(l.amount_cents) FROM affiliate_payout_lines l
              JOIN affiliate_payouts p ON p.id = l.payout_id
              WHERE l.commission_id = p_commission_id AND p.status <> 'void'), 0)
  -- Cash the affiliate has already handed back makes the corresponding
  -- economics payable again; without this a restored commission stays stuck.
  + COALESCE((SELECT SUM(recovered_cents) FROM affiliate_commission_adjustments
              WHERE commission_id = p_commission_id), 0)
  )::INTEGER;
$$;

-- Commissions an admin may currently pay. Excludes pending, incomplete,
-- fully reversed and already-paid amounts by construction.
/**
 * Payable commissions for an affiliate.
 *
 * VOLATILE, not STABLE: it first promotes anything past its hold window, so an
 * eligible commission becomes payable through the ordinary read path with no
 * admin intervention and no scheduler.
 */
CREATE OR REPLACE FUNCTION affiliate_payable_commissions(p_affiliate_id UUID)
RETURNS TABLE (
  commission_id UUID, order_id UUID, order_number TEXT,
  commission_cents INTEGER, payable_cents INTEGER,
  status TEXT, eligible_at TIMESTAMPTZ
)
LANGUAGE sql VOLATILE AS $$
  SELECT promote_eligible_commissions_for_affiliate(p_affiliate_id);
  SELECT c.id, c.order_id, o.order_number, c.commission_cents,
         affiliate_commission_payable(c.id), c.status, c.eligible_at
  FROM affiliate_commissions c
  JOIN orders o ON o.id = c.order_id
  WHERE c.affiliate_id = p_affiliate_id
    AND c.status IN ('approved','paid')
    AND NOT c.incomplete
    AND affiliate_commission_payable(c.id) > 0;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- create_affiliate_payout() — amounts computed under lock, never supplied
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Concurrency: candidate commissions are taken with FOR UPDATE SKIP LOCKED and
-- the payable amount is recomputed INSIDE the lock, so two simultaneous admin
-- requests cannot pay the same money twice. The second finds either a locked row
-- it skips, or a payable of zero.
--
-- Manual only: this creates a DRAFT. Money is recorded as moved by a separate
-- explicit admin action.
CREATE OR REPLACE FUNCTION create_affiliate_payout(
  p_affiliate_id UUID,
  p_commission_ids UUID[],
  p_actor        TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_payout   UUID;
  v_number   TEXT;
  v_row      RECORD;
  v_payable  INTEGER;
  v_total    INTEGER := 0;
  v_lines    INTEGER := 0;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|ACTOR_REQUIRED';
  END IF;
  IF p_commission_ids IS NULL OR array_length(p_commission_ids,1) IS NULL THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|NO_COMMISSIONS';
  END IF;

  v_number := 'APO-' || LPAD(nextval('affiliate_payout_number_seq')::TEXT, 6, '0');

  INSERT INTO affiliate_payouts (affiliate_id, payout_number, amount_cents, status, created_by)
  VALUES (p_affiliate_id, v_number, 0, 'draft', p_actor)
  RETURNING id INTO v_payout;

  FOR v_row IN
    SELECT c.id
    FROM affiliate_commissions c
    WHERE c.id = ANY(p_commission_ids)
      AND c.affiliate_id = p_affiliate_id
      AND c.status IN ('approved','paid')
      AND NOT c.incomplete
    ORDER BY c.created_at
    FOR UPDATE SKIP LOCKED          -- concurrent requests cannot contend
  LOOP
    -- Authoritative, recomputed while holding the lock.
    v_payable := affiliate_commission_payable(v_row.id);
    IF v_payable > 0 THEN
      INSERT INTO affiliate_payout_lines (payout_id, commission_id, amount_cents)
      VALUES (v_payout, v_row.id, v_payable);
      v_total := v_total + v_payable;
      v_lines := v_lines + 1;
    END IF;
  END LOOP;

  IF v_lines = 0 THEN
    DELETE FROM affiliate_payouts WHERE id = v_payout;
    RETURN jsonb_build_object('outcome','nothing_payable','affiliate_id',p_affiliate_id);
  END IF;

  UPDATE affiliate_payouts SET amount_cents = v_total, updated_at = NOW()
  WHERE id = v_payout;

  -- Atomic audit: mutation and evidence share one transaction, so a failed
  -- audit write rolls the payout back rather than leaving it unrecorded.
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'create', 'affiliate_payouts', v_payout::text,
          jsonb_build_object('amount_cents', v_total, 'line_count', v_lines,
                             'affiliate_id', p_affiliate_id));

  RETURN jsonb_build_object('outcome','created','payout_id',v_payout,
    'payout_number',v_number,'amount_cents',v_total,'line_count',v_lines);
END;
$$;

-- Mark a draft payout as actually paid. THIS is the cash-flow event.
CREATE OR REPLACE FUNCTION mark_affiliate_payout_paid(
  p_payout_id UUID, p_paid_at TIMESTAMPTZ, p_method TEXT,
  p_reference TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE p RECORD;
BEGIN
  -- Final5. Every other canonical mutation in this migration (void, record,
  -- collect) already requires a nonblank actor; marking a payout paid moves
  -- real cash-out status and must be attributable too. Final6: whitespace-only
  -- text is blank as well, so '   ' is refused, not recorded as an actor.
  -- BTRIM alone strips only spaces; the regex also catches tabs and newlines.
  IF p_actor IS NULL OR BTRIM(p_actor) = '' OR p_actor ~ '^\s*$' THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|ACTOR_REQUIRED';
  END IF;
  SELECT id, status INTO p FROM affiliate_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_PAYOUT|NOT_FOUND|%', p_payout_id; END IF;
  IF p.status = 'paid' THEN
    RETURN jsonb_build_object('outcome','already_paid','payout_id',p_payout_id);
  END IF;
  IF p.status = 'void' THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|VOID_CANNOT_BE_PAID';
  END IF;

  UPDATE affiliate_payouts
  SET status='paid', paid_at=COALESCE(p_paid_at,NOW()), method=p_method,
      reference=p_reference, updated_at=NOW()
  WHERE id = p_payout_id;

  -- Summary only; payout history itself remains the authoritative cash record.
  UPDATE affiliate_commissions SET status='paid', updated_at=NOW()
  WHERE id IN (SELECT commission_id FROM affiliate_payout_lines WHERE payout_id = p_payout_id)
    AND status <> 'paid';

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'mark_paid', 'affiliate_payouts', p_payout_id::text,
          jsonb_build_object('paid_at', COALESCE(p_paid_at, NOW()),
                             'method', p_method, 'reference', p_reference));

  RETURN jsonb_build_object('outcome','paid','payout_id',p_payout_id);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- record_affiliate_payout_recovery() — paid, then refunded
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A commission already PAID that is later reversed keeps its paid status and its
-- payout history intact. The shortfall is recorded as an append-only row awaiting
-- collection. History is never rewritten.
--
-- CRITICAL: the recovery row carries adjustment_cents = 0. The reversal that
-- created the overpayment ALREADY reduced the ledger; charging the same money
-- again here would count one economic event twice. The amount owed lives in
-- recovery_amount_cents, and the overpayment itself is derivable as
-- paid - net_ledger.
-- Old 5-argument signature dropped: the version without an idempotency key is
-- the unbounded, repeatable path this replaces.
DROP FUNCTION IF EXISTS record_affiliate_payout_recovery(UUID, INTEGER, TIMESTAMPTZ, TEXT, TEXT);
-- Final5. The 6-argument signature (no raw request-date) is superseded too:
-- comparing amount alone let a changed date/note/actor silently ride the same
-- key as "already_recorded". Leaving both arities callable would keep that
-- unsafe path alive.
DROP FUNCTION IF EXISTS record_affiliate_payout_recovery(UUID, INTEGER, TIMESTAMPTZ, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION record_affiliate_payout_recovery(
  p_commission_id   UUID,
  p_amount_cents    INTEGER,
  p_effective_at    TIMESTAMPTZ,
  p_actor           TEXT,
  p_notes           TEXT,
  p_idempotency_key TEXT,
  -- Final5. Raw client-literal date string ("YYYY-MM-DD") or NULL, kept
  -- separately from effective_at so a blank-date retry is comparable: the
  -- resolved column bakes in NOW() and can never reproduce a blank input.
  p_request_date    TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  c          affiliate_commissions;
  v_owed     INTEGER;
  v_existing RECORD;
  v_id       UUID;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_RECOVERY|ACTOR_REQUIRED';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RAISE EXCEPTION 'KVRN_RECOVERY|IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'KVRN_RECOVERY|INVALID_RECOVERY_AMOUNT';
  END IF;

  SELECT * INTO c FROM affiliate_commissions WHERE id = p_commission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_RECOVERY|COMMISSION_NOT_FOUND'; END IF;

  SELECT id, recovery_status, recovery_amount_cents, recovery_request_date, notes, created_by
  INTO v_existing
  FROM affiliate_commission_adjustments
  WHERE commission_id = p_commission_id
    AND recovery_idempotency_key = p_idempotency_key;

  IF FOUND THEN
    -- Final5. This key was already used for the OTHER recovery operation kind
    -- (a cash collection, not a marker). That can never be a legitimate retry
    -- of this 'record' request, regardless of amount.
    IF v_existing.recovery_status <> 'pending' THEN
      RAISE EXCEPTION
        'KVRN_RECOVERY|IDEMPOTENCY_CONFLICT|key:% existing_operation:% requested_operation:record',
        p_idempotency_key, v_existing.recovery_status;
    END IF;
    -- Final5. Compare the FULL canonical payload, not amount alone. IS NOT
    -- DISTINCT FROM treats two NULLs (e.g. no date supplied either time) as
    -- equal, which plain `=` does not.
    IF v_existing.recovery_amount_cents IS NOT DISTINCT FROM p_amount_cents
       AND v_existing.recovery_request_date IS NOT DISTINCT FROM p_request_date
       AND v_existing.notes                IS NOT DISTINCT FROM p_notes
       AND v_existing.created_by           IS NOT DISTINCT FROM p_actor THEN
      RETURN jsonb_build_object('outcome','already_recorded',
        'adjustment_id',v_existing.id,'recovery_amount_cents',v_existing.recovery_amount_cents);
    END IF;
    RAISE EXCEPTION
      'KVRN_RECOVERY|IDEMPOTENCY_CONFLICT|key:% existing:% requested:%',
      p_idempotency_key, v_existing.recovery_amount_cents, p_amount_cents;
  END IF;

  -- BOUNDED by the derived outstanding overpayment. Recording a pursuit of more
  -- than is actually owed would put a figure in front of an operator that no
  -- economic fact supports.
  v_owed := affiliate_commission_overpaid(p_commission_id);
  IF p_amount_cents > v_owed THEN
    RAISE EXCEPTION 'KVRN_RECOVERY|EXCEEDS_OUTSTANDING|outstanding:% attempted:%',
      v_owed, p_amount_cents;
  END IF;

  INSERT INTO affiliate_commission_adjustments (
    commission_id, order_id, affiliate_id, adjustment_cents,
    effective_at, knowledge_at, reason,
    -- CURRENT derived position. Reading the latest row by effective_at would
    -- reintroduce the Stage-1 defect: an economic date is not processing order,
    -- so a backdated claim change can sort ahead of a later real one.
    cumulative_merchandise_reversed_after,
    recovery_status, recovery_amount_cents, recovery_idempotency_key,
    recovery_request_date, notes, created_by
  ) VALUES (
    p_commission_id, c.order_id, c.affiliate_id,
    0,                                   -- a marker is not cash and not economics
    COALESCE(p_effective_at, NOW()), NOW(), 'payout_recovery',
    affiliate_outstanding_merchandise(p_commission_id),
    'pending', p_amount_cents, p_idempotency_key,
    p_request_date, p_notes, p_actor
  ) RETURNING id INTO v_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'record_recovery', 'affiliate_commissions', p_commission_id::text,
          jsonb_build_object('recovery_amount_cents', p_amount_cents,
                             'idempotency_key', p_idempotency_key));

  RETURN jsonb_build_object('outcome','recovery_recorded','adjustment_id',v_id,
    'adjustment_cents',0,'recovery_amount_cents',p_amount_cents,
    'merchandise_snapshot', affiliate_outstanding_merchandise(p_commission_id));
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- collect_affiliate_recovery() — recovery CASH actually received
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Collecting a recovery moves CASH. It must NOT add another negative commission
-- adjustment: the refund or dispute that created the overpayment already changed
-- the economics, and charging it again would reduce the ledger twice.
--
-- Four things stay separate:
--   commission economics   the adjustment ledger
--   payouts paid           cash out to the affiliate
--   recovery owed          derived overpayment, not cash
--   recovery collected     cash back in, recorded here
--
-- Collection cannot exceed what is still outstanding, and repeated collection of
-- the same amount is refused rather than silently doubled.
-- Old 6-argument signature is dropped explicitly: adding a parameter would
-- otherwise leave two callable versions, and the one without an idempotency key
-- is exactly the unsafe path this replaces.
DROP FUNCTION IF EXISTS collect_affiliate_recovery(UUID, INTEGER, TIMESTAMPTZ, TEXT, TEXT, TEXT);
-- Final5. The 7-argument signature (no notes, no raw request-date) is
-- superseded too: comparing amount alone let a changed date/method/
-- reference/note/actor silently ride the same key as "already_collected".
DROP FUNCTION IF EXISTS
  collect_affiliate_recovery(UUID, INTEGER, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION collect_affiliate_recovery(
  p_commission_id   UUID,
  p_amount_cents    INTEGER,
  p_collected_at    TIMESTAMPTZ,
  p_method          TEXT,
  p_reference       TEXT,
  p_actor           TEXT,
  p_idempotency_key TEXT,
  p_notes           TEXT DEFAULT NULL,
  -- Final5. Raw client-literal date string or NULL — see the identical
  -- parameter on record_affiliate_payout_recovery for why this cannot be
  -- derived from the resolved effective/collected timestamp.
  p_request_date    TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  c            affiliate_commissions;
  v_owed       INTEGER;
  v_existing   RECORD;
  v_id         UUID;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_RECOVERY|ACTOR_REQUIRED';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RAISE EXCEPTION 'KVRN_RECOVERY|IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'KVRN_RECOVERY|INVALID_AMOUNT';
  END IF;

  SELECT * INTO c FROM affiliate_commissions WHERE id = p_commission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_RECOVERY|COMMISSION_NOT_FOUND'; END IF;

  -- ── IDEMPOTENCY, CHECKED BEFORE ANY BOUND ───────────────────────────────
  --
  -- A lost HTTP response is indistinguishable from a failure, so the retry must
  -- be a no-op rather than a second cash row. Amount alone cannot serve as the
  -- key: two genuine partial collections of 150 are legitimate.
  SELECT id, recovered_cents, recovery_status, recovery_method, recovery_reference,
         recovery_request_date, notes, recovery_collected_by
  INTO v_existing
  FROM affiliate_commission_adjustments
  WHERE commission_id = p_commission_id
    AND recovery_idempotency_key = p_idempotency_key;

  IF FOUND THEN
    -- Final5. This key was already used for the OTHER recovery operation kind
    -- (a marker, not a cash collection). That can never be a legitimate retry
    -- of this 'collect' request, regardless of amount.
    IF v_existing.recovery_status <> 'recovered' THEN
      RAISE EXCEPTION
        'KVRN_RECOVERY|IDEMPOTENCY_CONFLICT|key:% existing_operation:% requested_operation:collect',
        p_idempotency_key, v_existing.recovery_status;
    END IF;
    -- Final5. Same key, FULL same payload: a genuine retry. IS NOT DISTINCT
    -- FROM treats two NULLs (no method/reference/notes/date either time) as
    -- equal, which plain `=` does not — plain `=` would otherwise conflict a
    -- perfectly repeated cash-only retry against itself.
    IF v_existing.recovered_cents        IS NOT DISTINCT FROM p_amount_cents
       AND v_existing.recovery_request_date IS NOT DISTINCT FROM p_request_date
       AND v_existing.recovery_method       IS NOT DISTINCT FROM p_method
       AND v_existing.recovery_reference    IS NOT DISTINCT FROM p_reference
       AND v_existing.notes                 IS NOT DISTINCT FROM p_notes
       AND v_existing.recovery_collected_by IS NOT DISTINCT FROM p_actor THEN
      RETURN jsonb_build_object('outcome','already_collected',
        'adjustment_id',v_existing.id,'recovered_cents',v_existing.recovered_cents,
        'outstanding_after', affiliate_commission_overpaid(p_commission_id));
    END IF;
    -- Same key, different payload: fail closed. Nothing is mutated.
    RAISE EXCEPTION
      'KVRN_RECOVERY|IDEMPOTENCY_CONFLICT|key:% existing:% requested:%',
      p_idempotency_key, v_existing.recovered_cents, p_amount_cents;
  END IF;

  -- Outstanding is DERIVED: cash paid minus ledger earnings, less cash collected.
  v_owed := affiliate_commission_overpaid(p_commission_id);
  IF p_amount_cents > v_owed THEN
    RAISE EXCEPTION 'KVRN_RECOVERY|EXCEEDS_OUTSTANDING|outstanding:% attempted:%',
      v_owed, p_amount_cents;
  END IF;

  INSERT INTO affiliate_commission_adjustments (
    commission_id, order_id, affiliate_id,
    adjustment_cents,          -- ZERO: the reversal already moved the economics
    effective_at, knowledge_at, reason,
    cumulative_merchandise_reversed_after,
    recovery_status, recovery_amount_cents,
    recovered_cents, recovered_at, recovery_method, recovery_reference,
    recovery_collected_by, recovery_idempotency_key, recovery_request_date,
    notes, created_by
  ) VALUES (
    p_commission_id, c.order_id, c.affiliate_id,
    0,
    COALESCE(p_collected_at, NOW()), NOW(), 'payout_recovery',
    -- CURRENT derived position, never a max(effective_at) read.
    affiliate_outstanding_merchandise(p_commission_id),
    'recovered', p_amount_cents,
    p_amount_cents, COALESCE(p_collected_at, NOW()), p_method, p_reference,
    p_actor, p_idempotency_key, p_request_date,
    p_notes, p_actor
  ) RETURNING id INTO v_id;

  -- Audit exactly once per NEW collection operation.
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'collect_recovery', 'affiliate_commissions', p_commission_id::text,
          jsonb_build_object('recovered_cents', p_amount_cents, 'method', p_method,
                             'reference', p_reference,
                             'idempotency_key', p_idempotency_key));

  RETURN jsonb_build_object('outcome','collected','adjustment_id',v_id,
    'recovered_cents',p_amount_cents,
    'outstanding_after', affiliate_commission_overpaid(p_commission_id));
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- void_affiliate_payout() — canonical draft cancellation
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A draft reserves payable, so a mistaken draft would otherwise hold a
-- commission hostage with no in-app way to release it. Voiding frees the
-- reservation immediately because payable ignores void payouts.
CREATE OR REPLACE FUNCTION void_affiliate_payout(
  p_payout_id UUID, p_reason TEXT, p_actor TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE p RECORD;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|ACTOR_REQUIRED';
  END IF;

  SELECT id, status, amount_cents INTO p
  FROM affiliate_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KVRN_PAYOUT|NOT_FOUND|%', p_payout_id; END IF;

  -- Idempotent.
  IF p.status = 'void' THEN
    RETURN jsonb_build_object('outcome','already_void','payout_id',p_payout_id);
  END IF;
  -- Cash already moved; voiding would misstate the cash record.
  IF p.status = 'paid' THEN
    RAISE EXCEPTION 'KVRN_PAYOUT|PAID_CANNOT_BE_VOIDED|%', p_payout_id;
  END IF;

  UPDATE affiliate_payouts
  SET status = 'void', notes = COALESCE(p_reason, notes), updated_at = NOW()
  WHERE id = p_payout_id;

  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (p_actor, 'void', 'affiliate_payouts', p_payout_id::text,
          jsonb_build_object('amount_cents', p.amount_cents, 'reason', p_reason));

  RETURN jsonb_build_object('outcome','voided','payout_id',p_payout_id,
    'released_cents',p.amount_cents);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_commission_effect() — period reporting from the LEDGER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Keyed on effective_at, the ECONOMIC date, so a closed period reflects what
-- actually happened then. knowledge_at is carried separately so the later
-- Financial Integrity batch can also answer "what did we know as of date X" and
-- explain why a prior period changed. Historical rows are never rewritten.
--
-- Profitability reads THIS. Cash flow reads affiliate_payouts.paid_at instead.
CREATE OR REPLACE FUNCTION affiliate_commission_effect(
  p_start TIMESTAMPTZ, p_end TIMESTAMPTZ
) RETURNS TABLE (
  accrued_cents BIGINT, reversed_cents BIGINT, restored_cents BIGINT,
  net_commission_cents BIGINT, adjustment_count INTEGER,
  incomplete_commission_count INTEGER
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(SUM(adjustment_cents) FILTER (WHERE reason = 'initial_accrual'),0)::bigint,
    COALESCE(SUM(adjustment_cents) FILTER (WHERE adjustment_cents < 0),0)::bigint,
    -- POSITIVE CORRECTIONS AND RESTORATIONS, not only Stripe dispute wins.
    -- A merchandise-resolution correction while a dispute REMAINS lost is a real
    -- positive economic movement but keeps reason='dispute_reversal', so keying
    -- on the reason left the visible components unable to reconcile to net.
    COALESCE(SUM(adjustment_cents)
             FILTER (WHERE adjustment_cents > 0 AND reason <> 'initial_accrual'),0)::bigint,
    COALESCE(SUM(adjustment_cents),0)::bigint,
    COUNT(*)::int,
    -- PERIOD-SCOPED, matching the economics beside it. Counting every incomplete
    -- commission ever would let a two-year-old unresolved case appear inside a
    -- 30-day result. Scoped on the attribution's economic instant, which is the
    -- order's finalization time.
    (SELECT COUNT(*) FROM affiliate_commissions c
     JOIN order_affiliate_attributions a ON a.id = c.attribution_id
     WHERE c.incomplete
       AND a.attributed_at >= p_start AND a.attributed_at < p_end)::int
  FROM affiliate_commission_adjustments
  WHERE effective_at >= p_start AND effective_at < p_end;
$$;

-- Overpayment outstanding on a commission: CASH ACTUALLY PAID, minus what the
-- ledger says was earned. Derived, so it can never disagree with the ledger.
--
-- Deliberately different from affiliate_commission_payable, which also subtracts
-- DRAFT reservations. A draft has moved no money and therefore cannot overpay.
CREATE OR REPLACE FUNCTION affiliate_commission_overpaid(p_commission_id UUID)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(0,
    -- ACTUALLY PAID ONLY. A draft has moved no cash, so it cannot create an
    -- overpayment; only status='paid' counts here.
    COALESCE((SELECT SUM(l.amount_cents) FROM affiliate_payout_lines l
              JOIN affiliate_payouts p ON p.id = l.payout_id
              WHERE l.commission_id = p_commission_id AND p.status = 'paid'), 0)
  - COALESCE((SELECT SUM(adjustment_cents) FROM affiliate_commission_adjustments
              WHERE commission_id = p_commission_id), 0)
  -- Recovery already collected is no longer outstanding.
  - COALESCE((SELECT SUM(recovered_cents) FROM affiliate_commission_adjustments
              WHERE commission_id = p_commission_id), 0)
  )::INTEGER;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- affiliate_reconciliation_backlog() — CURRENT backlog, deliberately GLOBAL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every commission awaiting quantification, regardless of when it arose. This is
-- a current-state operational warning and is returned SEPARATELY from
-- affiliate_commission_effect so a backlog figure can never be mistaken for a
-- period economic result.
CREATE OR REPLACE FUNCTION affiliate_reconciliation_backlog()
RETURNS TABLE (incomplete_count INTEGER, oldest_attributed_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::int, MIN(a.attributed_at)
  FROM affiliate_commissions c
  JOIN order_affiliate_attributions a ON a.id = c.attribution_id
  WHERE c.incomplete;
$$;

-- Cash actually paid to affiliates in a period. Deliberately separate.
CREATE OR REPLACE FUNCTION affiliate_payout_cash(
  p_start TIMESTAMPTZ, p_end TIMESTAMPTZ
) RETURNS TABLE (paid_cents BIGINT, payout_count INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(amount_cents),0)::bigint, COUNT(*)::int
  FROM affiliate_payouts
  WHERE status = 'paid' AND paid_at >= p_start AND paid_at < p_end;
$$;

COMMIT;

SELECT 'affiliates' AS tbl, COUNT(*) FROM affiliates
UNION ALL SELECT 'commissions', COUNT(*) FROM affiliate_commissions
UNION ALL SELECT 'adjustments', COUNT(*) FROM affiliate_commission_adjustments
UNION ALL SELECT 'payouts', COUNT(*) FROM affiliate_payouts;
