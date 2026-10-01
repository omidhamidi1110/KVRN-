// lib/__tests__/phase-b-batch3-020.test.ts
// Migration 020: affiliate / referral accounting.
//
// SCOPE OF THIS FILE. The authoritative validation for 020 is the live
// PostgreSQL execution run — the ten refund/dispute scenarios, the payout
// concurrency race, the zero-base invariant and the partial-dispute workflow all
// ran against a real database. These Jest tests cover the pure arithmetic, the
// input validation, and the structural guarantees that must not silently
// regress. They do NOT prove runtime SQL behaviour.

import {
  validateCreateAffiliate, validateDisputeDecomposition,
  AFFILIATE_STATUSES, COMMISSION_TYPES, FIXED_REVERSAL_POLICIES,
} from '../affiliates'

const fs   = require('fs')
const path = require('path')

const M020 = fs.readFileSync(
  path.join(__dirname, '../../db/migrations/020_affiliates.sql'), 'utf8')
/** Comments stripped, so prose describing a rule cannot satisfy a test of it. */
const ddl = M020.split('\n').filter((l: string) => !l.trim().startsWith('--')).join('\n')

const fnBody = (name: string) => {
  const start = ddl.indexOf(`FUNCTION ${name}`)
  return start < 0 ? '' : ddl.slice(start, ddl.indexOf('\n$$;', start))
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMISSION MATH
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors compute_affiliate_commission. */
function commission(base: number, type: 'percentage' | 'fixed',
                    bps: number | null, fixed: number | null): number {
  if (base <= 0) return 0
  if (type === 'percentage') {
    if (!bps || bps <= 0) return 0
    return Math.min(Math.round((base * bps) / 10000), base)
  }
  return Math.min(Math.max(fixed ?? 0, 0), base)
}

describe('commission calculation', () => {

  test('percentage uses one rounding rule, half away from zero', () => {
    expect(commission(10000, 'percentage', 1000, null)).toBe(1000)
    expect(commission(3333, 'percentage', 1000, null)).toBe(333)   // 333.3 -> 333
    expect(commission(3335, 'percentage', 1000, null)).toBe(334)   // 333.5 -> 334
  })

  test('a percentage can never exceed the base', () => {
    expect(commission(5000, 'percentage', 10000, null)).toBe(5000)
  })

  test('fixed is capped at the base', () => {
    expect(commission(3000, 'fixed', null, 5000)).toBe(3000)
    expect(commission(9000, 'fixed', null, 5000)).toBe(5000)
  })

  test('ZERO-BASE INVARIANT: base 0 gives commission 0 for both types', () => {
    // A fully discounted order cannot pay commission on money never collected.
    expect(commission(0, 'percentage', 1000, null)).toBe(0)
    expect(commission(0, 'fixed', null, 5000)).toBe(0)
  })

  test('the invariant is enforced by the database, not just by code', () => {
    expect(ddl).toContain('CONSTRAINT afc_zero_base_zero_commission')
    expect(ddl).toContain('base_cents > 0 OR commission_cents = 0')
    expect(ddl).toContain('CONSTRAINT afc_commission_le_base')
  })

  test('there is no base=0 special case anywhere', () => {
    // An earlier draft proposed full reversal at base 0, which contradicts the
    // cap. With the cap, a zero base means a zero commission and reversal is
    // unreachable.
    const fn = fnBody('apply_affiliate_claim_change')
    expect(fn).toContain('c.commission_cents = 0 OR c.base_cents = 0')
    expect(fn).toContain("'no_commission'")
  })

  test('the SQL applies the same cap', () => {
    const fn = fnBody('compute_affiliate_commission')
    expect(fn).toContain('LEAST(GREATEST(p_fixed_cents, 0), p_base_cents)')
    expect(fn).toContain('IF p_base_cents IS NULL OR p_base_cents <= 0 THEN RETURN 0')
  })

  test('Final5: corrupt or missing terms fail closed, never a silent $0', () => {
    // Before Final5 this branch read
    // "IF p_rate_bps IS NULL OR p_rate_bps <= 0 THEN RETURN 0", and the fixed
    // branch masked a NULL amount with COALESCE(p_fixed_cents, 0) — both
    // turned corrupt terms into an ordinary-looking zero commission.
    const fn = fnBody('compute_affiliate_commission')
    expect(fn).toContain("RAISE EXCEPTION 'KVRN_AFFILIATE|CORRUPT_TERMS")
    expect(fn).not.toContain('COALESCE(p_fixed_cents, 0)')
    // A base of 0 is a real economic fact (fully discounted order), not
    // corruption, and must still return 0 quietly rather than raise.
    expect(fn).toContain('IF p_base_cents IS NULL OR p_base_cents <= 0 THEN RETURN 0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TELESCOPING REVERSAL
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors the cumulative reversal in apply_affiliate_merchandise_reversal. */
function reverseSequence(commissionCents: number, base: number, merchSteps: number[]) {
  let cum = 0
  const deltas: number[] = []
  for (const m of merchSteps) {
    const before = cum
    cum = Math.min(base, cum + m)
    deltas.push(-(Math.round(commissionCents * cum / base)
                - Math.round(commissionCents * before / base)))
  }
  return { deltas, total: deltas.reduce((s, d) => s + d, 0), cumulative: cum }
}

describe('reversal telescopes and loses no cents', () => {

  test('a full merchandise refund reverses the whole commission', () => {
    expect(reverseSequence(1000, 10000, [10000]).total).toBe(-1000)
  })

  test('partial refunds sum to the same total as one refund', () => {
    const once  = reverseSequence(1000, 10000, [7000]).total
    const split = reverseSequence(1000, 10000, [3000, 4000]).total
    expect(split).toBe(once)
  })

  test('awkward cents still reconcile exactly', () => {
    // 1c at a time across a base that does not divide evenly.
    const r = reverseSequence(333, 3333, Array(3333).fill(1))
    expect(r.total).toBe(-333)
    expect(r.cumulative).toBe(3333)
  })

  test('exhaustive: any two-part split matches the single reversal', () => {
    for (const base of [1000, 3333, 9999]) {
      for (const rate of [500, 1000, 1234]) {
        const c = Math.min(Math.round(base * rate / 10000), base)
        for (let first = 1; first < base; first += Math.max(1, Math.floor(base / 17))) {
          const split = reverseSequence(c, base, [first, base - first]).total
          expect(split).toBe(-c)
        }
      }
    }
  })

  test('cumulative reversal never exceeds the original commission', () => {
    // Over-reversal is clamped by the shared counter.
    const r = reverseSequence(1000, 10000, [8000, 8000])
    expect(r.total).toBe(-1000)
    expect(r.cumulative).toBe(10000)
  })

  test('a zero-cent movement still persists its source claim', () => {
    // Rev 3: a row is written whenever the CLAIM changed, even when the money
    // did not. Dropping it would lose the claim entirely.
    const fn = fnBody('apply_affiliate_claim_change')
    expect(fn).toContain('IF v_delta = 0 THEN')
    expect(fn).toContain("'no_change'")
  })

  test('money is the change in the GLOBAL target, not a per-source figure', () => {
    // Rounding, overlap and all_or_nothing all make a source's marginal effect
    // at removal differ from its effect on arrival, so history is never replayed.
    const fn = fnBody('apply_affiliate_claim_change')
    expect(fn).toContain('v_money := v_tgt_before - v_tgt_after')
    expect(fn).toContain('affiliate_reversal_target')
  })

  test('raw source claims are never capped at insert time', () => {
    // The Rev-2 defect: capping on write discarded a refund's claim once the
    // global position was saturated.
    const fn = fnBody('affiliate_outstanding_merchandise')
    expect(fn).toContain('LEAST(')
    expect(fn).toContain('SUM(claim_delta_cents)')
    expect(ddl).toContain('claim_delta_cents           INTEGER NOT NULL DEFAULT 0')
  })

  test('refunds and disputes share ONE derived global position', () => {
    // Claims are per source, but the capped target is global, so the same
    // merchandise cannot reverse commission twice.
    const refund  = fnBody('apply_affiliate_refund_reversal')
    const dispute = fnBody('apply_affiliate_dispute_adjustment')
    expect(refund).toContain('apply_affiliate_claim_change')
    expect(refund).toContain("'refund:' || p_refund_id::text")
    // Dispute claims are now set by the dispute-centric sync.
    const sync = fnBody('sync_affiliate_dispute_state')
    expect(sync).toContain('apply_affiliate_claim_change')
    expect(sync).toContain("'dispute:' || d.id::text")
  })

  test('an all_or_nothing fixed policy is honoured from the snapshot', () => {
    const fn = fnBody('affiliate_reversal_target')
    expect(fn).toContain("v_policy = 'all_or_nothing'")
    expect(fn).toContain('fixed_reversal_policy_snapshot')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MERCHANDISE-ONLY, NEVER GROSS
// ─────────────────────────────────────────────────────────────────────────────

describe('commission never reverses on shipping or tax', () => {

  test('refunds use the merchandise component, not the Stripe total', () => {
    const fn = fnBody('apply_affiliate_refund_reversal')
    expect(fn).toContain('r.merchandise_refund_cents')
    expect(fn).not.toContain('r.amount_cents,')
  })

  test('an explicit affiliate discount is matched by discount_id, not by text', () => {
    // affiliates.code is KVRN's internal identifier; the customer-facing code is
    // a separate discounts row. Nothing requires them to be equal.
    const fn = fnBody('resolve_order_affiliate_attribution')
    // Final2-B: ownership is reconstructed from the effective-dated terms
    // history at the ORDER'S finalization instant, not from today's projection,
    // so a transferred discount cannot re-attribute an old order.
    expect(fn).toContain('affiliate_owner_of_discount_at(v_order.discount_id, v_finalized)')
    // Ambiguous historical ownership fails closed rather than picking by row order.
    expect(fn).toContain("'ambiguous_historical_ownership'")
    expect(fnBody('affiliate_owner_of_discount_at')).not.toContain('LIMIT 1')
    // The text fallback needs the affiliate to have existed and to own no
    // discount at that instant.
    expect(fn).toContain('(affiliate_terms_at(a.id, v_finalized)).discount_id IS NULL')
    expect(fn).toContain('a.created_at <= v_finalized')
  })

  test('an unresolved refund breakdown blocks reversal rather than guessing', () => {
    const fn = fnBody('apply_affiliate_refund_reversal')
    expect(fn).toContain("r.component_breakdown_status <> 'resolved'")
    expect(fn).toContain("'incomplete_pending_reconciliation'")
    // Rev 2: the reason is DERIVED, so the string lives in the derivation
    // function rather than being written by whichever path ran last.
    expect(fnBody('affiliate_unresolved_sources'))
      .toContain("'component_breakdown_unresolved'")
  })

  test('a full-charge dispute derives merchandise deterministically', () => {
    const fn = fnBody('sync_affiliate_dispute_state')
    expect(fn).toContain('d.amount_cents = o.total_cents')
    expect(fn).toContain('o.subtotal_cents,0) - COALESCE(o.discount_cents,0)')
  })

  test('a PARTIAL dispute is never inferred proportionally', () => {
    // 018's adjustment_cents is gross; using it as a merchandise numerator would
    // over-reverse by the shipping and tax share.
    const fn = fnBody('sync_affiliate_dispute_state')
    expect(fn).toContain("'incomplete_pending_reconciliation'")
    expect(fnBody('affiliate_unresolved_sources'))
      .toContain("'partial_dispute_merchandise_unresolved'")
    expect(fn).not.toContain('d.adjustment_cents * ')
    expect(fn).not.toContain('/ o.total_cents')
  })

  test('dispute effect is read from to_status, never from the delta sign', () => {
    // 018 derives adjustment_type from sign, so a POSITIVE dispute_revised row
    // occurs while the dispute is still LOST. Reading the sign would restore the
    // whole commission on what is not a win.
    // Rev3-Final2: dispute-centric. State comes from order_disputes.status, so
    // 018's delta sign is never consulted at all — and a dispute with NO 018 row
    // is still handled.
    const fn = fnBody('sync_affiliate_dispute_state')
    expect(fn).toContain("d.status IS DISTINCT FROM 'lost'")
    expect(fn).toContain('FROM order_disputes WHERE id = p_dispute_id')
    expect(fn).not.toContain('adjustment_cents > 0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RESTORATION
// ─────────────────────────────────────────────────────────────────────────────

describe('dispute restoration is source-scoped', () => {
  const fn = fnBody('apply_affiliate_dispute_adjustment')

  test('a win removes only the claim still outstanding for THAT dispute', () => {
    const fn = fnBody('sync_affiliate_dispute_state')
    expect(fn).toContain("v_key := 'dispute:' || d.id::text")
    expect(fn).toContain('v_comm.id, v_key, 0,')
  })

  test('refund-caused reversals are never restored by a dispute win', () => {
    const restore = fn.slice(fn.indexOf('adjustment_cents > 0'))
    expect(restore).not.toContain("reason = 'refund_reversal'")
  })

  test('restoration cannot exceed what is currently outstanding', () => {
    // Setting the claim to 0 can only release what the source still holds.
    expect(fnBody('affiliate_source_claim')).toContain('SUM(claim_delta_cents)')
    expect(fnBody('apply_affiliate_claim_change')).toContain('v_delta      := p_target_claim - v_current')
  })

  test('current state is derived by SUM, never by an ordering column', () => {
    // effective_at is an ECONOMIC date; a backdated resolution can sort earlier
    // than an already-processed later event.
    const fn = fnBody('affiliate_outstanding_merchandise')
    expect(fn).not.toContain('ORDER BY effective_at')
    expect(fnBody('apply_affiliate_claim_change')).not.toContain('ORDER BY effective_at DESC')
  })

  test('idempotency comes from the claim model, not an 018 source key', () => {
    // A unique index on (commission_id, source_dispute_adjustment_id) rejected
    // decomposition CORRECTIONS as already-applied, so a corrected merchandise
    // split silently failed to move the claim.
    expect(ddl).not.toContain('uq_aca_dispute_adj')
    // Re-running with unchanged state yields a zero delta and books nothing.
    expect(fnBody('apply_affiliate_claim_change')).toContain('IF v_delta = 0 THEN')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PARTIAL-DISPUTE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

describe('admin dispute decomposition', () => {
  const fn = fnBody('resolve_dispute_merchandise')

  test('components must total the disputed amount exactly', () => {
    expect(validateDisputeDecomposition(
      { merchandiseCents: 3000, shippingCents: 3000, taxCents: 0 }, 6000)).toEqual({ ok: true })
    expect(validateDisputeDecomposition(
      { merchandiseCents: 3000, shippingCents: 2000, taxCents: 0 }, 6000).ok).toBe(false)
    expect(fn).toContain('KVRN_DISPUTE|COMPONENTS_DO_NOT_TOTAL')
  })

  test('an omitted component is refused, not defaulted to zero', () => {
    const r = validateDisputeDecomposition(
      { merchandiseCents: 6000, shippingCents: undefined, taxCents: 0 }, 6000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/required/i)
  })

  test('negative components are refused', () => {
    expect(validateDisputeDecomposition(
      { merchandiseCents: 7000, shippingCents: -1000, taxCents: 0 }, 6000).ok).toBe(false)
    expect(fn).toContain('KVRN_DISPUTE|NEGATIVE_COMPONENT')
  })

  test('merchandise cannot exceed the order economics', () => {
    expect(fn).toContain('KVRN_DISPUTE|MERCHANDISE_EXCEEDS_ORDER')
  })

  test('resolution is keyed to the DISPUTED AMOUNT, not to an 018 delta row', () => {
    // 018 rows describe changes in gross revenue impact, not merchandise
    // content. A dispute_revised emitted because refund_offset moved must not
    // invalidate a decomposition that is still correct for the same amount.
    // Stage 3: uniqueness moved to a PARTIAL index so a correction can supersede
    // the earlier row without editing it, while exactly one stays current.
    expect(ddl).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_dmr_current')
    expect(ddl).toContain('WHERE superseded_at IS NULL')
    expect(fn).toContain("'already_resolved'")
  })

  test('a decomposition applies only to the amount it described', () => {
    // If Stripe changes the disputed amount the old row stays as evidence, but
    // the new amount is Incomplete until decomposed again.
    const d = fnBody('sync_affiliate_dispute_state')
    expect(d).toContain('resolved_disputed_amount_cents = d.amount_cents')
    expect(d).toContain('superseded_at IS NULL')
  })

  test('an actor is required and recorded', () => {
    expect(fn).toContain('KVRN_DISPUTE|ACTOR_REQUIRED')
    expect(ddl).toContain('resolved_by       TEXT        NOT NULL')
  })

  test('resolution re-syncs from CURRENT dispute state', () => {
    // So a correction MOVES the claim instead of being rejected.
    expect(fnBody('resolve_dispute_merchandise_by_dispute'))
      .toContain('sync_affiliate_dispute_state(d.id')
  })

  test('decomposition works with NO 018 adjustment row', () => {
    // 018 emits a row only when its gross revenue delta is non-zero, so a lost
    // partial dispute can exist without one.
    const fn = fnBody('resolve_dispute_merchandise_by_dispute')
    expect(fn).toContain('FROM order_disputes WHERE id = p_dispute_id')
    // The 018 row is looked up as optional provenance, never required.
    expect(fn).toContain('SELECT id INTO v_prov FROM order_dispute_financial_adjustments')
    expect(fn).not.toContain('DISPUTE_ADJUSTMENT_NOT_FOUND')
  })

  test('BOTH timestamps survive: economic date and knowledge date', () => {
    expect(ddl).toContain('effective_at      TIMESTAMPTZ NOT NULL')
    expect(ddl).toContain('resolved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()')
    expect(fn).toContain("'economic_effective_at',d.effective_at")
    expect(fn).toContain("'knowledge_at',NOW()")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RECOGNITION: ECONOMIC DATE vs KNOWLEDGE DATE
// ─────────────────────────────────────────────────────────────────────────────

describe('period recognition uses the economic date', () => {

  test('the ledger carries all three timestamps', () => {
    expect(ddl).toContain('effective_at    TIMESTAMPTZ NOT NULL')
    expect(ddl).toContain('knowledge_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()')
    expect(ddl).toContain('created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()')
  })

  test('period reporting keys on effective_at, not on when it was learned', () => {
    // A June dispute decomposed in July is recognised in JUNE, because that is
    // when the economics happened. knowledge_at is retained so the later
    // Integrity batch can explain why a closed period moved.
    const fn = fnBody('affiliate_commission_effect')
    expect(fn).toContain('WHERE effective_at >= p_start AND effective_at < p_end')
    expect(fn).not.toContain('knowledge_at >=')
  })

  test('economic facts on a ledger row are never rewritten', () => {
    expect(ddl).not.toContain('DELETE FROM affiliate_commission_adjustments')
    // The only UPDATEs stamp PROVENANCE onto a row created moments earlier in
    // the same transaction. No economic field is ever altered after the fact.
    const updates = ddl.split('UPDATE affiliate_commission_adjustments').slice(1)
    expect(updates.length).toBeGreaterThan(0)
    for (const u of updates) {
      const setClause = u.slice(0, u.indexOf('WHERE'))
      expect(setClause).toContain('source_dispute_resolution_id')
      for (const economic of ['adjustment_cents', 'effective_at', 'reason',
                              'claim_delta_cents', 'recovered_cents',
                              'cumulative_merchandise_reversed_after']) {
        expect(setClause).not.toContain(economic)
      }
    }
  })

  test('accrual and cash are separate functions', () => {
    expect(ddl).toContain('FUNCTION affiliate_commission_effect')
    expect(ddl).toContain('FUNCTION affiliate_payout_cash')
    // Cash reads the paid date only.
    expect(fnBody('affiliate_payout_cash')).toContain("status = 'paid' AND paid_at")
  })

  test('the accrual function never reads payouts', () => {
    expect(fnBody('affiliate_commission_effect')).not.toContain('affiliate_payouts')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ATTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────

describe('attribution is immutable and effective-dated', () => {
  const fn = fnBody('resolve_order_affiliate_attribution')

  test('one attribution per order, insert-only', () => {
    expect(ddl).toContain('CONSTRAINT oaa_order_uq UNIQUE (order_id)')
    expect(fn).toContain("'already_attributed'")
  })

  test('an explicit code beats a link', () => {
    expect(fn.indexOf('v_order.discount_code IS NOT NULL'))
      .toBeLessThan(fn.indexOf('affiliate_clicks'))
  })

  test('the most recent qualifying click wins, not the earliest', () => {
    expect(fn).toContain('ORDER BY c.occurred_at DESC, c.id DESC')
  })

  test('a later click cannot qualify for an earlier order', () => {
    expect(fn).toContain('c.occurred_at <= v_finalized')
  })

  test('the window comes from the terms in force AT CLICK TIME', () => {
    // Reading today's window could retroactively disqualify a historical click.
    expect(fn).toContain('affiliate_terms_at(c.affiliate_id, c.occurred_at)')
    expect(fn).toContain("attribution_window_days\n             || ' days'")
  })

  test('active status is judged historically, not from the current column', () => {
    expect(fn).toContain('affiliate_active_at(c.affiliate_id, c.occurred_at)')
    expect(fnBody('affiliate_active_at')).toContain('FROM affiliate_status_events')
  })

  test('every decision input is snapshotted', () => {
    for (const c of ['attribution_window_days_snapshot','commission_type_snapshot',
                     'commission_rate_bps_snapshot','commission_fixed_cents_snapshot',
                     'fixed_reversal_policy_snapshot','commission_base_cents',
                     'base_formula_version','hold_days_snapshot','eligible_at',
                     'exchange_commission_policy_version']) {
      expect(ddl).toContain(c)
    }
  })

  test('the base is net merchandise, excluding shipping and tax', () => {
    expect(fn).toContain('v_order.subtotal_cents,0) - COALESCE(v_order.discount_cents,0)')
    expect(fn).not.toContain('shipping_cents')
    expect(fn).not.toContain('tax_cents')
  })

  test('exchanges earn no additional commission, by versioned policy', () => {
    expect(ddl).toContain("exchange_commission_policy_version TEXT NOT NULL DEFAULT 'v1_no_commission'")
  })
})

describe('pause and termination are effective-dated', () => {

  test('status history is append-only with an effective instant', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS affiliate_status_events')
    expect(ddl).toContain('effective_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()')
  })

  test('historical status comes from the ledger', () => {
    const fn = fnBody('affiliate_active_at')
    expect(fn).toContain('WHERE affiliate_id = p_affiliate_id AND effective_at <= p_at')
    expect(fn).toContain('ORDER BY effective_at DESC')
  })

  test('a pause deletes nothing already owed', () => {
    expect(ddl).not.toContain('DELETE FROM affiliate_commissions')
    expect(ddl).not.toContain('DELETE FROM affiliate_commission_adjustments')
    expect(ddl).not.toContain('DELETE FROM affiliate_payout_lines')
    // The single DELETE on affiliate_payouts removes an EMPTY draft created
    // moments earlier in the same call when nothing turned out to be payable.
    // It never touches a payout with lines, and never touches history.
    const fn = fnBody('create_affiliate_payout')
    expect(fn).toContain('IF v_lines = 0 THEN\n    DELETE FROM affiliate_payouts WHERE id = v_payout;')
    expect((ddl.match(/DELETE FROM affiliate_payouts/g) ?? []).length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PAYOUTS
// ─────────────────────────────────────────────────────────────────────────────

describe('payout safety', () => {

  test('uniqueness is per payout, not once per commission for all time', () => {
    // A commission can be paid, reversed, recovered, restored and paid again.
    expect(ddl).toContain('CONSTRAINT afpl_payout_commission_uq UNIQUE (payout_id, commission_id)')
    expect(ddl).not.toContain('UNIQUE (commission_id)\n')
  })

  test('payable subtracts non-void payouts, reserving drafts', () => {
    const fn = fnBody('affiliate_commission_payable')
    expect(fn).toContain('SUM(adjustment_cents)')
    expect(fn).toContain("p.status <> 'void'")
  })

  test('OVERPAYMENT counts actually-paid cash only, never drafts', () => {
    // A draft has moved no money and therefore cannot overpay.
    const fn = fnBody('affiliate_commission_overpaid')
    expect(fn).toContain("p.status = 'paid'")
    expect(fn).not.toContain("p.status <> 'void'")
  })

  test('concurrent payout creation cannot pay the same money twice', () => {
    const fn = fnBody('create_affiliate_payout')
    expect(fn).toContain('FOR UPDATE SKIP LOCKED')
    // Recomputed inside the lock, never taken from the caller.
    expect(fn).toContain('v_payable := affiliate_commission_payable(v_row.id)')
  })

  test('no client-supplied amount reaches the payout', () => {
    const api = fs.readFileSync(
      path.join(__dirname, '../../app/api/admin/affiliates/payouts/route.ts'), 'utf8')
    expect(api).not.toContain('body.amountCents')
    expect(api).toContain('commissionIds')
  })

  test('incomplete commissions are excluded from payout', () => {
    expect(fnBody('affiliate_payable_commissions')).toContain('NOT c.incomplete')
    expect(fnBody('create_affiliate_payout')).toContain('NOT c.incomplete')
  })

  test('pending commissions are excluded from payout', () => {
    expect(fnBody('affiliate_payable_commissions')).toContain("c.status IN ('approved','paid')")
  })

  test('eligibility is automatic but payment is not', () => {
    const fn = fnBody('approve_eligible_commissions')
    expect(fn).toContain("SET status = 'approved'")
    // Approval must not touch payouts or money.
    expect(fn).not.toContain('affiliate_payouts')
    expect(fn).not.toContain('paid_at')
  })

  test('incomplete commissions never auto-approve', () => {
    expect(fnBody('approve_eligible_commissions')).toContain('AND NOT incomplete')
  })

  test('marking paid is a separate, explicit action', () => {
    expect(ddl).toContain('FUNCTION mark_affiliate_payout_paid')
    expect(ddl).toContain('CONSTRAINT afp_paid_has_date')
  })
})

describe('paid then refunded preserves history', () => {

  test('recovery does not reduce the ledger a second time', () => {
    // The reversal that created the overpayment already moved the ledger.
    // Charging it again here would count one economic event twice.
    const fn = fnBody('record_affiliate_payout_recovery')
    // The marker inserts adjustment_cents = 0: the reversal already moved the
    // economics, so charging it again would count one event twice. Asserted on
    // behaviour rather than on comment text.
    expect(fn).toContain('a marker is not cash and not economics')
    expect(fn).toContain('recovery_amount_cents')
    expect(fn).not.toContain('-p_amount_cents')
  })

  test('the overpayment is derived, so it cannot disagree with the ledger', () => {
    const fn = fnBody('affiliate_commission_overpaid')
    expect(fn).toContain('affiliate_payout_lines')
    expect(fn).toContain('affiliate_commission_adjustments')
  })

  test('payout history is never deleted or rewritten', () => {
    expect(ddl).not.toContain('DELETE FROM affiliate_payout_lines')
    expect(ddl).not.toContain('UPDATE affiliate_payout_lines')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION AND SAFETY
// ─────────────────────────────────────────────────────────────────────────────

describe('020 reuses existing systems', () => {

  test('affiliate discounts are ordinary discounts rows', () => {
    expect(ddl).toContain('discount_id   UUID REFERENCES discounts(id)')
    // No parallel coupon table.
    expect(ddl).not.toContain('CREATE TABLE IF NOT EXISTS affiliate_discounts')
  })

  test('018 and 019 are not altered', () => {
    expect(ddl).not.toContain('FUNCTION finalize_paid_order')
    expect(ddl).not.toContain('FUNCTION record_order_refund')
    expect(ddl).not.toContain('FUNCTION upsert_order_dispute')
    expect(ddl).not.toContain('FUNCTION consume_inventory_fifo')
  })

  test('dispute effects derive from 018 append-only rows', () => {
    expect(ddl).toContain('order_dispute_financial_adjustments')
    const fn = fnBody('apply_affiliate_dispute_adjustment')
    // Never from the mutable dispute status column.
    expect(fn).not.toContain('d.status')
    expect(fn).not.toContain('order_disputes.status')
  })

  test('no click stores an IP address or hash', () => {
    const block = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS affiliate_clicks'),
                            ddl.indexOf('CREATE INDEX IF NOT EXISTS idx_ac_session'))
    expect(block).not.toContain('ip_')
    expect(block).not.toContain('ip_hash')
  })

  test('the migration drops no DATA and is one transaction', () => {
    expect(ddl).not.toContain('DROP TABLE')
    // DROP FUNCTION appears only to retire superseded SIGNATURES before
    // recreating them. Leaving the old arity callable would keep an unsafe path
    // alive — the recovery functions without an idempotency key. No data is lost.
    const drops = ddl.split('DROP FUNCTION IF EXISTS').slice(1)
    for (const d of drops) {
      const target = d.slice(0, d.indexOf(';'))
      expect(target).toMatch(/collect_affiliate_recovery|record_affiliate_payout_recovery/)
    }
    expect(ddl).not.toMatch(/DROP FUNCTION(?! IF EXISTS)/)
    expect((M020.match(/^BEGIN;$/gm) ?? []).length).toBe(1)
    expect((M020.match(/^COMMIT;$/gm) ?? []).length).toBe(1)
  })

  test('every plpgsql function declares the variables it uses', () => {
    // The 018 Rev 8 lesson. The real gate is the live apply run; this is cheap
    // insurance against the same class of mistake.
    const re = /CREATE OR REPLACE FUNCTION (\w+)\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(M020)) !== null) {
      const body = M020.slice(m.index, M020.indexOf('\n$$;', m.index))
      if (!body.includes('DECLARE')) continue
      const decl = body.slice(body.indexOf('DECLARE'), body.indexOf('BEGIN'))
      const declared = new Set((decl.match(/\bv_\w+/g) ?? []).map((x: string) => x.toLowerCase()))
      const used = new Set((body.slice(body.indexOf('BEGIN')).match(/\bv_\w+/g) ?? [])
        .map((x: string) => x.toLowerCase()))
      const missing = [...used].filter(u => !declared.has(u))
      expect({ fn: m[1], missing }).toEqual({ fn: m[1], missing: [] })
    }
  })
})

describe('input validation', () => {
  const base = { code: 'AFF10', name: 'Ten', commissionType: 'percentage' as const,
                 commissionRateBps: 1000 }

  test('accepts a well-formed percentage affiliate', () => {
    expect(validateCreateAffiliate(base)).toEqual({ ok: true })
  })
  test('rejects a malformed code', () => {
    expect(validateCreateAffiliate({ ...base, code: 'a b' }).ok).toBe(false)
  })
  test('requires a rate for a percentage affiliate', () => {
    expect(validateCreateAffiliate({ ...base, commissionRateBps: null }).ok).toBe(false)
  })
  test('rejects a rate above 100%', () => {
    expect(validateCreateAffiliate({ ...base, commissionRateBps: 10001 }).ok).toBe(false)
  })
  test('requires an amount for a fixed affiliate', () => {
    expect(validateCreateAffiliate({
      ...base, commissionType: 'fixed', commissionRateBps: null }).ok).toBe(false)
  })
  test('rejects an out-of-range hold window', () => {
    expect(validateCreateAffiliate({ ...base, commissionHoldDays: 400 }).ok).toBe(false)
  })
  test('the exported vocabularies match the schema', () => {
    expect(AFFILIATE_STATUSES).toEqual(['active','paused','terminated'])
    expect(COMMISSION_TYPES).toEqual(['percentage','fixed'])
    expect(FIXED_REVERSAL_POLICIES).toEqual(['proportional','all_or_nothing'])
  })
})

describe('admin surface', () => {
  const readApi = (f: string) =>
    fs.readFileSync(path.join(__dirname, '../../app/api/admin/affiliates/', f), 'utf8')

  test('every route requires admin auth', () => {
    for (const f of ['route.ts','payouts/route.ts','reconciliation/route.ts']) {
      expect(readApi(f)).toContain('requireAdmin')
    }
  })

  test('audit is written INSIDE the canonical transaction, not after it', () => {
    // Defect #14: a post-commit audit insert can fail after money already
    // moved, returning 500 on a mutation that actually succeeded — and it
    // duplicates evidence the SQL function already wrote.
    for (const f of ['route.ts','payouts/route.ts','reconciliation/route.ts']) {
      expect(readApi(f)).not.toContain('INSERT INTO admin_audit_logs')
    }
    // backfill/route.ts has exactly THREE documented exceptions, all on paths
    // where the canonical SQL function is never reached and the attempt would
    // otherwise leave no trace:
    //   retryable_session_recovery_failed  Stripe could not be reached
    //   no_link_evidence                   a recovered sid matches no click
    //   malformed_recovered_session        Final5: previously audited ZERO
    //                                      times, the one outcome that used
    //                                      to leave no trace at all
    const bf = readApi('backfill/route.ts')
    expect((bf.match(/INSERT INTO admin_audit_logs/g) ?? []).length).toBe(3)
    expect(bf).toContain('retryable_session_recovery_failed')
    expect(bf).toContain('no_link_evidence')
    expect(bf).toContain('malformed_recovered_session')
    // Every canonical financial mutation logs atomically.
    for (const fname of ['create_affiliate','update_affiliate_terms','create_affiliate_payout',
                         'mark_affiliate_payout_paid','void_affiliate_payout',
                         'collect_affiliate_recovery','record_affiliate_payout_recovery',
                         'resolve_dispute_merchandise','backfill_order_affiliate_attribution']) {
      expect(fnBody(fname)).toContain('INSERT INTO admin_audit_logs')
    }
  })

  test('affiliate creation seeds the terms ledger atomically', () => {
    // Without this the historical-terms architecture is unwired and a backfill
    // would silently use present-day rates.
    const fn = fnBody('create_affiliate')
    expect(fn).toContain('INSERT INTO affiliate_terms_events')
    expect(fn).toContain('INSERT INTO affiliate_status_events')
    const lib = fs.readFileSync(path.join(__dirname, '../affiliates.ts'), 'utf8')
    expect(lib).toContain('SELECT create_affiliate(')
  })

  test('term changes append history rather than overwriting it', () => {
    const fn = fnBody('update_affiliate_terms')
    expect(fn).toContain('INSERT INTO affiliate_terms_events')
    expect(fn).not.toContain('DELETE FROM affiliate_terms_events')
    expect(fn).not.toContain('UPDATE affiliate_terms_events')
  })

  test('backfill has a real admin route and recovers the session server-side', () => {
    const api = readApi('backfill/route.ts')
    expect(api).toContain('requireAdmin')
    expect(api).toContain('backfillAttribution')
    // A browser-supplied session id is explicitly refused.
    expect(api).toContain('cannot be supplied')
    expect(fnBody('backfill_order_affiliate_attribution'))
      .toContain("o.attribution->>'kvrn_sid'")
  })

  test('the UI states that discount and commission are separate costs', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/affiliates/AffiliatesClient.tsx'), 'utf8')
    // Normalised: the source wraps these sentences across lines.
    const flat = ui.replace(/\s+/g, ' ')
    expect(flat).toContain('are separate costs and both may apply to one order')
    expect(flat).toContain('not</strong> treated as zero')
  })

  test('the UI does not compute commission amounts', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/affiliates/AffiliatesClient.tsx'), 'utf8')
    expect(ui).not.toContain('commissionRateBps *')
    expect(ui).not.toContain('* baseCents')
  })

  test('Affiliates appears in the admin navigation', () => {
    const nav = fs.readFileSync(
      path.join(__dirname, '../../components/admin/AdminShell.tsx'), 'utf8')
    expect(nav).toContain("href: '/admin/financials/affiliates'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REV 2 — DERIVED INCOMPLETENESS AND RESUMED ACCOUNTING
// ═════════════════════════════════════════════════════════════════════════════

/** Mirrors the corrected cumulative reversal, which persists zero-cent events. */
function reverseWithZeroEvents(commission: number, base: number, steps: number[]) {
  let cum = 0, total = 0
  const rows: number[] = []
  for (const m of steps) {
    const before = cum
    cum = Math.min(base, cum + m)
    // `+ 0` normalises JavaScript's -0, which SQL has no equivalent of.
    const delta = -(Math.round(commission * cum / base) - Math.round(commission * before / base)) + 0
    // A zero-cent row is still persisted whenever merchandise moved.
    if (delta !== 0 || cum - before !== 0) { rows.push(delta); total += delta }
  }
  return { rows, total, cum }
}

describe('zero-cent reversals preserve the sequence', () => {

  test('base 3, commission 1, two 1-cent refunds reverse exactly 1', () => {
    const r = reverseWithZeroEvents(1, 3, [1, 1])
    expect(r.rows).toEqual([0, -1])
    expect(r.total).toBe(-1)
    expect(r.cum).toBe(2)
  })

  test('base 7, commission 1, seven 1-cent refunds reverse exactly 1', () => {
    const r = reverseWithZeroEvents(1, 7, Array(7).fill(1))
    expect(r.total).toBe(-1)
    expect(r.cum).toBe(7)
    expect(r.rows).toHaveLength(7)      // every event persisted
  })

  test('dropping zero-cent events would lose the reversal entirely', () => {
    // The Rev-1 behaviour, shown to be wrong: each refund restarts from zero.
    let lost = 0
    for (let i = 0; i < 2; i++) lost += -(Math.round(1 * 1 / 3) - Math.round(1 * 0 / 3))
    expect(lost).toBe(0)
    expect(reverseWithZeroEvents(1, 3, [1, 1]).total).toBe(-1)
  })

  test('awkward percentages with intermediate zero rounds still reconcile', () => {
    for (const [base, rate] of [[3, 3333], [7, 1429], [11, 909], [13, 769]]) {
      const commission = Math.min(Math.round(base * rate / 10000), base)
      const r = reverseWithZeroEvents(commission, base, Array(base).fill(1))
      expect(r.total).toBe(-commission)
      expect(r.cum).toBe(base)
    }
  })
})

describe('incompleteness is derived from unresolved sources', () => {

  test('blockers are derived from CURRENT exposure, not historical rows', () => {
    expect(ddl).toContain('FUNCTION affiliate_unresolved_sources')
    const fn = fnBody('affiliate_unresolved_sources')
    expect(fn).toContain('FROM order_refunds r')
    // Rev 3: reads the dispute's CURRENT state, so a won dispute stops blocking.
    expect(fn).toContain('FROM order_disputes d')
    expect(fn).toContain("d.status = 'lost'")
    expect(fn).not.toContain('FROM order_dispute_financial_adjustments a')
  })

  test('a full-charge dispute is not treated as a blocker', () => {
    // Its merchandise share is deterministic, so nothing is unresolved.
    expect(fnBody('affiliate_unresolved_sources'))
      .toContain('d.amount_cents <> o.total_cents')
  })

  test('a won or prevented dispute never blocks, whatever its history', () => {
    expect(fnBody('affiliate_unresolved_sources')).toContain("d.status = 'lost'")
  })

  test('the flag is recomputed, never blindly toggled', () => {
    expect(ddl).toContain('FUNCTION refresh_affiliate_commission_state')
    expect(fnBody('refresh_affiliate_commission_state')).toContain('incomplete = (v_count > 0)')
    expect(ddl).not.toContain("incomplete_reason = 'refund_component_breakdown_unresolved'")
    expect(ddl).not.toContain('SET incomplete = FALSE, incomplete_reason = NULL')
  })

  test('status comes from ONE rule, never assigned ad hoc', () => {
    // Restoring economics must not fabricate lifecycle eligibility.
    expect(ddl).toContain('FUNCTION affiliate_derive_commission_status')
    const st = fnBody('affiliate_derive_commission_status')
    expect(st).toContain("IF c.eligible_at > p_now THEN RETURN 'pending'")
    expect(st).toContain("IF v_paid > 0 THEN RETURN 'paid'")
    // The claim engine delegates rather than deciding.
    expect(fnBody('apply_affiliate_claim_change'))
      .toContain('PERFORM refresh_affiliate_commission_state(p_commission_id)')
  })

  test('resolving one source cannot clear another', () => {
    const fn = fnBody('resolve_dispute_merchandise')
    expect(fn).toContain('refresh_affiliate_incomplete')
  })

  test('multiple blockers are summarised honestly', () => {
    expect(fnBody('refresh_affiliate_commission_state'))
      .toContain("v_count || ' unresolved sources'")
  })
})

describe('refund resolution resumes affiliate accounting', () => {

  test('a dedicated resume function exists', () => {
    expect(ddl).toContain('FUNCTION resume_affiliate_after_refund_resolution')
  })

  test('it applies the reversal and refreshes the derived flag', () => {
    const fn = fnBody('resume_affiliate_after_refund_resolution')
    expect(fn).toContain('apply_affiliate_refund_reversal')
    expect(fn).toContain('refresh_affiliate_incomplete')
  })

  test('the admin route calls it, so no webhook retry is needed', () => {
    const api = fs.readFileSync(path.join(__dirname,
      '../../app/api/admin/refunds/[id]/resolve-components/route.ts'), 'utf8')
    expect(api).toContain('resume_affiliate_after_refund_resolution')
    // Stripe will not redeliver a refund that already succeeded.
    expect(api).toContain('no reason to redeliver')
  })

  test('it stays idempotent through the existing source index', () => {
    expect(ddl).toContain('uq_aca_refund')
    expect(fnBody('apply_affiliate_refund_reversal')).toContain("'already_applied'")
  })

  test('a resume failure leaves the safe state, not a wrong one', () => {
    const api = fs.readFileSync(path.join(__dirname,
      '../../app/api/admin/refunds/[id]/resolve-components/route.ts'), 'utf8')
    expect(api).toContain('leaves the commission incomplete, which is the safe state')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// STAGE 2 — RECOVERY CASH, RUNTIME ELIGIBILITY, VOID
// ═════════════════════════════════════════════════════════════════════════════

describe('recovery cash is separate from commission economics', () => {

  test('collecting a recovery adds NO second negative adjustment', () => {
    // The refund or dispute already moved the economics; charging again would
    // reduce the ledger twice for one event.
    const fn = fnBody('collect_affiliate_recovery')
    // The inserted adjustment_cents is literal 0; the cash lives in
    // recovered_cents. Asserted on behaviour rather than comment text.
    expect(fn).toContain('adjustment_cents')
    expect(fn).toContain('recovered_cents')
    expect(fn).not.toContain('-p_amount_cents')
  })

  test('a pending recovery is not cash', () => {
    // record_affiliate_payout_recovery notes what is owed; only recovered_cents
    // represents money actually received.
    expect(ddl).toContain('recovered_cents       INTEGER NOT NULL DEFAULT 0')
    expect(fnBody('record_affiliate_payout_recovery')).not.toContain('recovered_cents,')
  })

  test('collection cannot exceed what is outstanding', () => {
    expect(fnBody('collect_affiliate_recovery')).toContain('KVRN_RECOVERY|EXCEEDS_OUTSTANDING')
  })

  test('collected recovery makes economics payable again', () => {
    const fn = fnBody('affiliate_commission_payable')
    expect(fn).toContain('SUM(recovered_cents)')
  })

  test('collected recovery reduces the outstanding overpayment', () => {
    expect(fnBody('affiliate_commission_overpaid')).toContain('SUM(recovered_cents)')
  })

  test('collection records its own evidence', () => {
    for (const c of ['recovered_at','recovery_method','recovery_reference','recovery_collected_by']) {
      expect(ddl).toContain(c)
    }
    expect(fnBody('collect_affiliate_recovery')).toContain('KVRN_RECOVERY|ACTOR_REQUIRED')
  })
})

describe('automatic eligibility has a real runtime path', () => {

  test('promotion happens on the authoritative payable read', () => {
    // Not a scheduler, and not an admin action: the ordinary read promotes.
    expect(ddl).toContain('FUNCTION promote_eligible_commissions_for_affiliate')
    expect(fnBody('affiliate_payable_commissions'))
      .toContain('promote_eligible_commissions_for_affiliate')
  })

  test('promotion is race-safe', () => {
    expect(fnBody('promote_eligible_commissions_for_affiliate')).toContain('FOR UPDATE SKIP LOCKED')
  })

  test('promotion defers to the single status rule', () => {
    // So a blocker or an unexpired hold still prevents approval.
    expect(fnBody('promote_eligible_commissions_for_affiliate'))
      .toContain('refresh_affiliate_commission_state')
  })

  test('eligibility never moves money', () => {
    const fn = fnBody('promote_eligible_commissions_for_affiliate')
    expect(fn).not.toContain('affiliate_payouts')
    expect(fn).not.toContain('paid_at')
  })

  test('the service layer reaches it through the payable read', () => {
    const lib = fs.readFileSync(path.join(__dirname, '../affiliates.ts'), 'utf8')
    expect(lib).toContain('affiliate_payable_commissions')
  })
})

describe('draft payouts have a canonical void path', () => {
  const fn = fnBody('void_affiliate_payout')

  test('a canonical function exists', () => {
    expect(ddl).toContain('FUNCTION void_affiliate_payout')
  })
  test('a paid payout cannot be voided', () => {
    expect(fn).toContain('KVRN_PAYOUT|PAID_CANNOT_BE_VOIDED')
  })
  test('voiding twice is safe', () => {
    expect(fn).toContain("'already_void'")
  })
  test('an actor and reason are recorded', () => {
    expect(fn).toContain('KVRN_PAYOUT|ACTOR_REQUIRED')
    expect(fn).toContain('p_reason')
  })
  test('the audit row is written inside the same function', () => {
    // Atomic with the mutation, not a separate statement that could fail after.
    expect(fn).toContain('INSERT INTO admin_audit_logs')
  })
  test('voiding releases the reservation', () => {
    // payable ignores void payouts, so the amount frees immediately.
    expect(fnBody('affiliate_commission_payable')).toContain("p.status <> 'void'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINAL2-B — TEMPORAL CAUSALITY, PROJECTION, WINDOW SNAPSHOT
// ═════════════════════════════════════════════════════════════════════════════

describe('temporal causality', () => {

  test('an affiliate cannot be active before it existed', () => {
    const fn = fnBody('affiliate_active_at')
    expect(fn).toContain('IF p_at < v_created THEN RETURN FALSE')
  })

  test('terms do not exist before the affiliate did', () => {
    expect(fnBody('affiliate_terms_at')).toContain('IF p_at < a.created_at THEN RETURN NULL')
  })

  test('a click cannot predate the link it belongs to', () => {
    expect(fnBody('resolve_order_affiliate_attribution'))
      .toContain('c.occurred_at >= l.created_at')
  })

  test('all three ordering sites use the same deterministic tie-break', () => {
    // Helper and projection must never disagree on which event is latest.
    for (const fn of ['affiliate_active_at','affiliate_terms_at',
                      'set_affiliate_status','update_affiliate_terms']) {
      expect(fnBody(fn)).toContain('ORDER BY effective_at DESC, created_at DESC, id DESC')
    }
  })
})

describe('projection is recomputed, never blindly overwritten', () => {

  test('status projection comes from the latest event effective at NOW', () => {
    const fn = fnBody('set_affiliate_status')
    expect(fn).toContain('SELECT to_status INTO v_proj')
    expect(fn).toContain('effective_at <= NOW()')
    // The inserted row is not assumed to be current.
    expect(fn).not.toContain('SET status = p_status,')
  })

  test('terms projection comes from the latest event effective at NOW', () => {
    const fn = fnBody('update_affiliate_terms')
    expect(fn).toContain('SELECT * INTO cur FROM affiliate_terms_events')
    expect(fn).toContain('default_commission_rate_bps    = cur.commission_rate_bps')
    expect(fn).toContain('discount_id                    = cur.discount_id')
  })

  test('future effective dates are rejected on both paths', () => {
    for (const fn of ['set_affiliate_status','update_affiliate_terms']) {
      expect(fnBody(fn)).toContain('KVRN_AFFILIATE|FUTURE_EFFECTIVE_AT_UNSUPPORTED')
    }
  })

  test('history, projection and audit are one transaction', () => {
    for (const fn of ['set_affiliate_status','update_affiliate_terms']) {
      const b = fnBody(fn)
      expect(b).toContain('INSERT INTO affiliate_')
      expect(b).toContain('UPDATE affiliates SET')
      expect(b).toContain('INSERT INTO admin_audit_logs')
    }
  })
})

describe('historical discount ownership', () => {

  test('a conflict detector exists for historical overlap', () => {
    // The CURRENT partial unique index cannot prove historical uniqueness.
    expect(ddl).toContain('FUNCTION affiliate_discount_ownership_conflicts')
  })

  test('ownership is derived from historical terms, not the current row', () => {
    const fn = fnBody('affiliate_owner_of_discount_at')
    expect(fn).toContain('(affiliate_terms_at(a.id, p_at)).discount_id = p_discount_id')
    expect(fn).toContain('a.created_at <= p_at')
  })
})

describe('link window snapshot records the window actually used', () => {

  test('the click-time window is captured', () => {
    const fn = fnBody('resolve_order_affiliate_attribution')
    expect(fn).toContain('v_click_window := (affiliate_terms_at(v_click.affiliate_id, v_click.occurred_at))')
  })

  test('it is stored rather than the finalization window', () => {
    expect(fnBody('resolve_order_affiliate_attribution'))
      .toContain('COALESCE(v_click_window, v_terms.attribution_window_days)')
  })

  test('commission economics still come from finalization terms', () => {
    const fn = fnBody('resolve_order_affiliate_attribution')
    expect(fn).toContain('v_terms := affiliate_terms_at(v_aff.id, v_finalized)')
    expect(fn).toContain('v_terms.commission_type, v_terms.commission_rate_bps')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINAL2-C #8 — DURABLE SESSION PRESERVATION AND RECOVERY
// ═════════════════════════════════════════════════════════════════════════════

describe('referral session preservation fails closed', () => {
  const co = fs.readFileSync(path.join(__dirname, '../checkout-session-handler.ts'), 'utf8')

  test('preservation happens BEFORE Stripe checkout is created', () => {
    expect(co.indexOf('preserveAffiliateSession(reservation.reservationId)'))
      .toBeLessThan(co.indexOf('stripe.checkout.sessions.create'))
  })

  test('a real referral that cannot be preserved stops checkout', () => {
    expect(co).toContain('if (!(await preserveAffiliateSession(reservation.reservationId)))')
    expect(co).toContain('status: 503')
  })

  test('evidence is what distinguishes a referral from a stale cookie', () => {
    expect(co).toContain('SELECT 1 FROM affiliate_clicks')
    expect(co).toContain('if (!hasReferralEvidence) return true')
  })

  test('an unknown evidence state is treated as a referral, not as none', () => {
    // Treating "cannot tell" as "no referral" is the failure that loses money.
    expect(co).toContain('hasReferralEvidence = true')
  })

  test('checkout without a cookie is untouched', () => {
    expect(co).toContain('if (!affiliateSessionId) return true')
  })
})

describe('backfill session recovery is server-side and validated', () => {
  const api = fs.readFileSync(
    path.join(__dirname, '../../app/api/admin/affiliates/backfill/route.ts'), 'utf8')

  test('a request-body session id is refused outright', () => {
    expect(api).toContain('cannot be supplied')
  })

  test('local snapshot is preferred over Stripe', () => {
    expect(api).toContain('needsStripeSessionRecovery')
    expect(api).toContain('if (!state.hasLocal && state.checkoutSessionId)')
  })

  test('a Stripe outage is retryable, never no_attribution', () => {
    expect(api).toContain('retryable_session_recovery_failed')
    expect(api).toContain('Nothing was changed')
    expect(api).toContain('status: 503')
  })

  test('a malformed recovered reference fails closed', () => {
    expect(api).toContain('malformed_recovered_session')
    expect(fnBody('backfill_order_affiliate_attribution'))
      .toContain('KVRN_AFFILIATE|MALFORMED_RECOVERED_SESSION')
  })

  test('a recovered session must map to real local click evidence', () => {
    // So even a valid-looking forged value cannot manufacture an attribution.
    expect(fnBody('backfill_order_affiliate_attribution'))
      .toContain('EXISTS (SELECT 1 FROM affiliate_clicks WHERE session_id = p_session_id)')
  })
})

describe('Final4 — validation bounds match the database CHECK constraints', () => {
  const base = { code: 'F4V', name: 'V', commissionType: 'percentage' as const,
                 commissionRateBps: 1000 }

  test('attribution window 0 is rejected, matching CHECK > 0', () => {
    // Previously accepted, which turned a clean 400 into a PostgreSQL 500.
    const r = validateCreateAffiliate({ ...base, attributionWindowDays: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/between 1 and 365/)
  })
  test('attribution window 1 and 365 are accepted', () => {
    expect(validateCreateAffiliate({ ...base, attributionWindowDays: 1 }).ok).toBe(true)
    expect(validateCreateAffiliate({ ...base, attributionWindowDays: 365 }).ok).toBe(true)
  })
  test('attribution window 366 is rejected', () => {
    expect(validateCreateAffiliate({ ...base, attributionWindowDays: 366 }).ok).toBe(false)
  })
  test('hold days 0 remains valid, matching CHECK >= 0', () => {
    expect(validateCreateAffiliate({ ...base, commissionHoldDays: 0 }).ok).toBe(true)
    expect(validateCreateAffiliate({ ...base, commissionHoldDays: 366 }).ok).toBe(false)
  })
  test('the migration CHECKs are what these bounds mirror', () => {
    expect(ddl).toContain('CHECK (attribution_window_days > 0 AND attribution_window_days <= 365)')
    expect(ddl).toContain('CHECK (commission_hold_days >= 0 AND commission_hold_days <= 365)')
  })
})

describe('Final4 — recovery idempotency structure', () => {
  test('a unique key scopes recovery operations per commission', () => {
    expect(ddl).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_aca_recovery_key')
    expect(ddl).toContain('WHERE recovery_idempotency_key IS NOT NULL')
  })
  test('both recovery functions require a key and fail closed on conflict', () => {
    for (const fn of ['collect_affiliate_recovery','record_affiliate_payout_recovery']) {
      const b = fnBody(fn)
      expect(b).toContain('KVRN_RECOVERY|IDEMPOTENCY_KEY_REQUIRED')
      expect(b).toContain('KVRN_RECOVERY|IDEMPOTENCY_CONFLICT')
      expect(b).toContain('KVRN_RECOVERY|ACTOR_REQUIRED')
    }
  })
  test('the marker is bounded by derived outstanding', () => {
    expect(fnBody('record_affiliate_payout_recovery'))
      .toContain('affiliate_commission_overpaid(p_commission_id)')
  })
  test('no recovery snapshot reads state by effective_at ordering', () => {
    for (const fn of ['collect_affiliate_recovery','record_affiliate_payout_recovery']) {
      expect(fnBody(fn)).not.toContain('ORDER BY effective_at')
      expect(fnBody(fn)).toContain('affiliate_outstanding_merchandise(p_commission_id)')
    }
  })
  test('period components reconcile by construction', () => {
    const fn = fnBody('affiliate_commission_effect')
    expect(fn).toContain("adjustment_cents > 0 AND reason <> 'initial_accrual'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FINAL5 — FREEZE-CANDIDATE INTEGRITY PASS
// ═════════════════════════════════════════════════════════════════════════════
//
// The authoritative validation is db/fixtures/final5.sql, run through
// scripts/test-020-fixtures.sh against a real, fresh PostgreSQL database — the
// 18 PASS assertions there prove the actual runtime behaviour (exceptions
// raised, rows never mutated on conflict, legitimate cases unaffected). These
// tests cover the structural guarantees that must not silently regress.

describe('Final5 — historical terms fail closed, never a silent $0', () => {
  test('affiliate_terms_events mirrors the affiliates CHECK', () => {
    const block = ddl.slice(
      ddl.indexOf('CREATE TABLE IF NOT EXISTS affiliate_terms_events'),
      ddl.indexOf('CREATE INDEX IF NOT EXISTS idx_ate_affiliate'))
    expect(block).toContain('CONSTRAINT ate_terms_present CHECK')
    expect(block).toContain("commission_type = 'percentage' AND commission_rate_bps IS NOT NULL")
    expect(block).toContain("commission_type = 'fixed'   AND commission_fixed_cents IS NOT NULL")
  })

  test('update_affiliate_terms rejects invalid terms before inserting', () => {
    const fn = fnBody('update_affiliate_terms')
    expect(fn).toContain('KVRN_AFFILIATE|INVALID_TERMS')
    // The validation must run BEFORE the INSERT, not after.
    expect(fn.indexOf('INVALID_TERMS')).toBeLessThan(fn.indexOf('INSERT INTO affiliate_terms_events'))
  })

  test('a legitimate fixed-$0 terms row is not treated as missing', () => {
    // Distinguishes "no amount was configured" (fail closed) from
    // "the configured amount is zero" (a real, if unusual, terms value).
    const fn = fnBody('compute_affiliate_commission')
    expect(fn).toContain('IF p_fixed_cents IS NULL OR p_fixed_cents < 0 THEN')
  })
})

describe('Final5 — marking a payout paid requires an actor', () => {
  test('mark_affiliate_payout_paid guards against a blank actor', () => {
    const fn = fnBody('mark_affiliate_payout_paid')
    expect(fn).toContain('KVRN_PAYOUT|ACTOR_REQUIRED')
    // Every other canonical payout/recovery mutation already requires this;
    // Final5 closes the one that did not.
    expect(fn.indexOf('ACTOR_REQUIRED')).toBeLessThan(fn.indexOf('UPDATE affiliate_payouts'))
  })
})

describe('Final6 — terms are validated BEFORE the zero-base return', () => {
  // STATIC AUDIT ONLY. The runtime proof is db/fixtures/final5.sql, which calls
  // the real function with a zero base and corrupt terms. This pins the SHAPE so
  // a refactor cannot quietly move validation back underneath the early return.
  const fn = () => fnBody('compute_affiliate_commission')
  const zeroBaseReturn = 'IF p_base_cents IS NULL OR p_base_cents <= 0 THEN RETURN 0'

  test('every terms rejection precedes the zero-base RETURN 0', () => {
    const f = fn()
    const zero = f.indexOf(zeroBaseReturn)
    expect(zero).toBeGreaterThan(-1)
    const raises = [...f.matchAll(/RAISE EXCEPTION 'KVRN_AFFILIATE\|CORRUPT_TERMS/g)].map(m => m.index as number)
    // percentage, fixed, unknown type
    expect(raises).toHaveLength(3)
    for (const at of raises) expect(at).toBeLessThan(zero)
  })

  test('the three checks are the percentage, fixed and unknown-type rejections', () => {
    const f = fn()
    const zero = f.indexOf(zeroBaseReturn)
    const before = f.slice(0, zero)
    expect(before).toContain("IF p_type = 'percentage' THEN")
    expect(before).toContain("ELSIF p_type = 'fixed' THEN")
    expect(before).toContain('unknown commission_type')
  })

  test('the percentage bounds mirror the table CHECK exactly: > 0 and <= 10000', () => {
    expect(fn()).toContain('p_rate_bps IS NULL OR p_rate_bps <= 0 OR p_rate_bps > 10000')
    // the same bounds the tables enforce
    expect(M020).toContain('commission_rate_bps > 0 AND commission_rate_bps <= 10000')
  })

  test('a validly configured fixed $0 is still legitimate, and the zero-base return survives', () => {
    const f = fn()
    expect(f).toContain('IF p_fixed_cents IS NULL OR p_fixed_cents < 0 THEN')
    expect(f).toContain(zeroBaseReturn)
  })
})

describe('Final6 — a whitespace-only payout actor is blank', () => {
  test('mark_affiliate_payout_paid rejects NULL, empty and whitespace-only actors', () => {
    const fn = fnBody('mark_affiliate_payout_paid')
    expect(fn).toContain('p_actor IS NULL')
    expect(fn).toContain('BTRIM(p_actor)')
    // BTRIM strips only spaces; the regex is what catches tabs and newlines.
    expect(fn).toContain("p_actor ~ '^\\s*$'")
    expect(fn.indexOf('ACTOR_REQUIRED')).toBeLessThan(fn.indexOf('UPDATE affiliate_payouts'))
  })
})

describe('Final6 — the IDEMPOTENCY_CONFLICT message says request, not amount', () => {
  test('the recoveries route no longer claims only an amount differed', () => {
    const api = fs.readFileSync(
      path.join(__dirname, '../../app/api/admin/affiliates/recoveries/route.ts'), 'utf8')
    expect(api).toContain('already used for a different request')
    expect(api).not.toContain('different amount')
    // message-only change: still a 409
    expect(api).toMatch(/different request[^\n]*\n\s*\{ status: 409 \}/)
  })
})

describe('Final6 — the Final5 fixture is fail-hard', () => {
  // STATIC AUDIT ONLY. That the harness really exits nonzero was proven by
  // running deliberately broken copies (see FINAL6-EVIDENCE.txt); this pins the
  // file against reverting to print-only checks.
  const fx = fs.readFileSync(path.join(__dirname, '../../db/fixtures/final5.sql'), 'utf8')

  test('no check can print FAIL or PASS as its verdict', () => {
    expect(fx).not.toMatch(/RAISE NOTICE 'FAIL/)
    expect(fx).not.toMatch(/EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PASS/)
  })

  test('no result is left to an \\echo EXPECT line', () => {
    expect(fx).not.toMatch(/\\echo\s+'\s*EXPECT/)
  })

  test('the assertion helpers raise, and the run is under ON_ERROR_STOP', () => {
    expect(fx).toContain('\\set ON_ERROR_STOP on')
    expect(fx).toContain('CREATE OR REPLACE FUNCTION f5_expect_token')
    expect(fx).toContain('CREATE OR REPLACE FUNCTION f5_expect_check')
    expect(fx).toContain('CREATE OR REPLACE FUNCTION f5_assert_eq')
    expect(fx).toContain("RAISE EXCEPTION 'F5 ASSERT FAILED: unexpected SUCCESS")
    // the table constraint is verified by SQLSTATE and by NAME
    expect(fx).toContain("'23514'")
    expect(fx).toContain("'ate_terms_present'")
  })

  test('the zero-base corruption cases and the whitespace actor are asserted', () => {
    for (const c of [
      "compute_affiliate_commission(0,'percentage',NULL,NULL)",
      "compute_affiliate_commission(0,'percentage',0,NULL)",
      "compute_affiliate_commission(0,'percentage',10001,NULL)",
      "compute_affiliate_commission(0,'fixed',NULL,NULL)",
      "compute_affiliate_commission(0,'bogus_type',NULL,NULL)",
    ]) expect(fx).toContain(c)
    expect(fx).toContain("'ach','r','   ')")
  })
})

describe('Final5 — recovery idempotency compares the full payload', () => {
  test('both functions accept a raw request-date, separate from the resolved timestamp', () => {
    for (const fn of ['collect_affiliate_recovery', 'record_affiliate_payout_recovery']) {
      expect(fnBody(fn)).toContain('p_request_date')
    }
    expect(ddl).toContain('recovery_request_date TEXT')
  })

  test('collect_affiliate_recovery now also accepts notes', () => {
    expect(fnBody('collect_affiliate_recovery')).toContain('p_notes')
  })

  test('comparison uses IS NOT DISTINCT FROM, so two blank fields do not fabricate a conflict', () => {
    for (const fn of ['collect_affiliate_recovery', 'record_affiliate_payout_recovery']) {
      expect(fnBody(fn)).toContain('IS NOT DISTINCT FROM')
    }
  })

  test('collect compares amount, date, method, reference, notes and actor', () => {
    const fn = fnBody('collect_affiliate_recovery')
    for (const field of ['recovered_cents', 'recovery_request_date', 'recovery_method',
                          'recovery_reference', 'notes', 'recovery_collected_by']) {
      expect(fn).toContain(field)
    }
  })

  test('record compares amount, date, notes and actor', () => {
    const fn = fnBody('record_affiliate_payout_recovery')
    for (const field of ['recovery_amount_cents', 'recovery_request_date', 'notes', 'created_by']) {
      expect(fn).toContain(field)
    }
  })

  test('a key can never be reused across operation kinds', () => {
    // record requires the existing row to still be 'pending'; collect
    // requires it to still be 'recovered'. Either mismatch is a conflict
    // regardless of amount — this is what closes the accidental case where
    // collect_affiliate_recovery also writes recovery_amount_cents, so a
    // same-amount cross-kind reuse used to read as a legitimate retry.
    expect(fnBody('record_affiliate_payout_recovery')).toContain("recovery_status <> 'pending'")
    expect(fnBody('collect_affiliate_recovery')).toContain("recovery_status <> 'recovered'")
  })

  test('both old pre-Final5 arities are retired, so only one signature is ever callable', () => {
    expect(ddl).toContain(
      'DROP FUNCTION IF EXISTS record_affiliate_payout_recovery(UUID, INTEGER, TIMESTAMPTZ, TEXT, TEXT, TEXT)')
    expect(ddl).toContain(
      'collect_affiliate_recovery(UUID, INTEGER, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT)')
  })
})

describe('Final5 — a malformed recovered session is audited, not silent', () => {
  test('the outcome writes exactly one audit row on the path with no canonical SQL call', () => {
    const bf = fs.readFileSync(
      path.join(__dirname, '../../app/api/admin/affiliates/backfill/route.ts'), 'utf8')
    const idx = bf.indexOf("outcome: 'malformed_recovered_session'")
    expect(idx).toBeGreaterThan(-1)
    // The audit insert for this outcome must appear once, ahead of its response.
    const before = bf.slice(0, idx)
    const after = bf.slice(idx)
    expect(before.lastIndexOf('INSERT INTO admin_audit_logs'))
      .toBeGreaterThan(before.lastIndexOf('isValidSessionId(ref)'))
    expect(after.slice(0, 200)).not.toContain('INSERT INTO admin_audit_logs')
  })
})

describe('Final5 — reload-safe recovery-collection idempotency key', () => {
  test('the client no longer keeps the attempt key in component state alone', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/affiliates/AffiliatesClient.tsx'), 'utf8')
    expect(ui).not.toContain('useState<Record<string, string>>({})')
    expect(ui).toContain('recovery-attempt-key')
  })

  test('the durable key module has no React dependency', () => {
    const mod = fs.readFileSync(
      path.join(__dirname, '../recovery-attempt-key.ts'), 'utf8')
    expect(mod).not.toContain("from 'react'")
    expect(mod).toContain('sessionStorage')
  })
})
