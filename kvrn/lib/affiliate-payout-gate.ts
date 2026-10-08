// lib/affiliate-payout-gate.ts — "may KVRN create a payout for this affiliate right now?"
// Server-only.
//
// The gate DECIDES; it never computes money. Amounts still come exclusively from create_affiliate_payout()
// (020) under row locks. A blocked payout creates nothing; an allowed one is created by the unchanged SQL.
//
// BLOCKERS stop payout creation. WARNINGS are shown to the Admin but do not stop it.
// Fail closed: if the gate cannot be evaluated (e.g. the profile table is unavailable) it BLOCKS.
//
// KNOWN LIMIT: the gate is enforced by the Admin payout route and by createGatedPayout(). A caller that runs
// the SQL function create_affiliate_payout() directly bypasses it by design — the function is frozen (020) and
// the existing tests/ops call it directly. Treat direct SQL as a break-glass path.
import { getSetting } from '@/lib/site-settings'
import { getProfileByAffiliateId, type ProfileRow } from '@/lib/affiliate-portal-bridge'

type Sql = any

export interface GateIssue { code: string; message: string }
export interface GateResult {
  allowed: boolean
  blockers: GateIssue[]
  warnings: GateIssue[]
  snapshot: {
    programStatus: string | null
    financialStatus: string | null
    kyc: string | null
    tax: string | null
    payoutMethod: string | null
    payableCents: number
    thresholdCents: number | null
    taxRequired: boolean
  }
}

export interface GateInputs {
  profile: Pick<ProfileRow, 'programStatus' | 'kycStatus' | 'taxStatus' | 'payoutMethodStatus' | 'requiresReacceptance'
    | 'acceptedProgramTermsVersion' | 'acceptedDisclosureVersion' | 'payoutThresholdCents'> | null
  financialStatus: string | null            // affiliates.status: active | paused | terminated
  taxRequired: boolean
  payableCents: number                      // over the evaluated selection
  selectedMissingCount: number              // ids supplied that do not belong to this affiliate
  selectedIncompleteCount: number           // supplied commissions flagged incomplete (unresolved refund/dispute)
  frozenFlagCount: number                   // open fraud flags with freeze_commissions
  reviewFlagCount: number                   // open non-freezing flags (warning only)
  fraudHoldOrderCount: number               // payable orders with an ACTIVE fraud hold (orders contract)
  incompleteElsewhereCount: number          // incomplete commissions NOT in the selection (warning)
  owedBackCents: number                     // outstanding overpayment (warning)
}

export function evaluateGateInputs(i: GateInputs): GateResult {
  const blockers: GateIssue[] = []
  const warnings: GateIssue[] = []
  const b = (code: string, message: string) => blockers.push({ code, message })
  const w = (code: string, message: string) => warnings.push({ code, message })

  if (!i.profile) {
    b('no_profile', 'No affiliate profile on file. Identity, tax and payout status cannot be confirmed.')
  } else {
    const p = i.profile
    if (p.programStatus === 'suspended') b('program_suspended', 'Affiliate is suspended.')
    else if (p.programStatus === 'terminated') b('program_terminated', 'Affiliate is terminated.')
    else if (p.programStatus !== 'active') b('program_not_active', 'Affiliate is not active in the program yet.')
    if (p.kycStatus !== 'verified') b('kyc_not_verified', `Identity verification is ${label(p.kycStatus)}.`)
    if (i.taxRequired && p.taxStatus !== 'complete') b('tax_incomplete', `Tax onboarding is ${label(p.taxStatus)}.`)
    if (p.payoutMethodStatus !== 'ready') b('payout_method_not_ready', `Payout method is ${label(p.payoutMethodStatus)}.`)
    if (p.requiresReacceptance) b('reacceptance_required', 'Updated program terms have not been accepted.')
    if (!p.acceptedProgramTermsVersion || !p.acceptedDisclosureVersion) {
      b('terms_not_accepted', 'Program terms or disclosure policy have not been accepted.')
    }
    if (p.payoutThresholdCents !== null && p.payoutThresholdCents > 0 && i.payableCents < p.payoutThresholdCents) {
      b('below_threshold', 'Payable balance is below the payout threshold.')
    }
  }
  if (i.financialStatus === 'paused') b('program_suspended', 'Affiliate code is paused.')
  if (i.financialStatus === 'terminated') b('program_terminated', 'Affiliate is terminated.')

  if (i.selectedMissingCount > 0) b('commission_not_found', 'A selected commission does not belong to this affiliate.')
  if (i.selectedIncompleteCount > 0) b('commission_incomplete', 'A selected commission has an unresolved refund or dispute.')
  if (i.frozenFlagCount > 0) b('commissions_frozen', 'Commissions are frozen by an open fraud / abuse review.')
  if (i.fraudHoldOrderCount > 0) b('fraud_hold_active', 'An underlying order has an active fraud hold.')
  if (i.payableCents <= 0) b('nothing_payable', 'Nothing is payable yet.')

  if (i.reviewFlagCount > 0) w('review_flags_open', 'Open review flags exist for this affiliate.')
  if (i.incompleteElsewhereCount > 0) w('incomplete_commissions', 'Other commissions are unresolved and excluded from payout.')
  if (i.owedBackCents > 0) w('recovery_outstanding', 'An earlier overpayment has not been recovered.')

  // De-duplicate by code (paused + suspended can both fire).
  const seen = new Set<string>()
  const uniq = (xs: GateIssue[]) => xs.filter(x => (seen.has(x.code) ? false : (seen.add(x.code), true)))
  const ub = uniq(blockers)
  return {
    allowed: ub.length === 0, blockers: ub, warnings: uniq(warnings),
    snapshot: {
      programStatus: i.profile?.programStatus ?? null, financialStatus: i.financialStatus,
      kyc: i.profile?.kycStatus ?? null, tax: i.profile?.taxStatus ?? null, payoutMethod: i.profile?.payoutMethodStatus ?? null,
      payableCents: i.payableCents, thresholdCents: i.profile?.payoutThresholdCents ?? null, taxRequired: i.taxRequired,
    },
  }
}

function label(s: string | null | undefined) { return (s ?? 'unknown').replace(/_/g, ' ') }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Read the facts and evaluate. `commissionIds` narrows the evaluation to the commissions about to be paid. */
export async function canPayAffiliate(
  sql: Sql, affiliateId: string, opts: { commissionIds?: string[]; draftPayoutId?: string } = {},
): Promise<GateResult> {
  try {
    if (!UUID_RE.test(affiliateId)) throw new Error('bad id')
    // EXECUTING an existing draft: its money is already reserved (so "payable" is 0 by design). Evaluate that
    // payout's own lines and its stored amount instead — the amount is read, never recomputed.
    let draft: { amountCents: number; commissionIds: string[]; orderIds: string[] } | null = null
    if (opts.draftPayoutId !== undefined) {
      if (!UUID_RE.test(opts.draftPayoutId)) throw new Error('bad payout id')
      const ph = await sql`SELECT amount_cents FROM affiliate_payouts
                            WHERE id = ${opts.draftPayoutId}::uuid AND affiliate_id = ${affiliateId}::uuid AND status = 'draft'` as any[]
      if (!ph[0]) throw new Error('not a draft payout of this affiliate')
      const lines = await sql`SELECT l.commission_id, c.order_id FROM affiliate_payout_lines l
                                JOIN affiliate_commissions c ON c.id = l.commission_id WHERE l.payout_id = ${opts.draftPayoutId}::uuid` as any[]
      draft = { amountCents: Number(ph[0].amount_cents), commissionIds: lines.map(l => l.commission_id), orderIds: lines.map(l => l.order_id) }
    }
    const ids = draft ? draft.commissionIds : (opts.commissionIds ?? []).filter(x => UUID_RE.test(x))
    const profile = await getProfileByAffiliateId(sql, affiliateId)
    const aff = await sql`SELECT status FROM affiliates WHERE id = ${affiliateId}::uuid` as any[]
    const setting = await getSetting<{ tax_required?: boolean }>(sql, 'affiliate.payouts', { tax_required: true })
    const taxRequired = setting.value?.tax_required !== false

    // The SAME read path the Admin payable list uses (it also promotes anything past its hold window).
    const payable = await sql`SELECT commission_id, order_id, payable_cents FROM affiliate_payable_commissions(${affiliateId}::uuid)` as any[]
    const selected = draft
      ? draft.orderIds.map(order_id => ({ order_id }))
      : (ids.length ? payable.filter(r => ids.includes(r.commission_id)) : payable)
    const payableCents = draft ? draft.amountCents : selected.reduce((s, r) => s + Number(r.payable_cents), 0)

    let selectedMissing = 0, selectedIncomplete = 0
    if (ids.length) {
      const own = await sql`SELECT id, incomplete FROM affiliate_commissions WHERE id = ANY(${ids}::uuid[]) AND affiliate_id = ${affiliateId}::uuid` as any[]
      selectedMissing = ids.length - own.length
      selectedIncomplete = own.filter(r => r.incomplete === true).length
    }
    const incompleteAll = await sql`SELECT COUNT(*)::int AS n FROM affiliate_commissions WHERE affiliate_id = ${affiliateId}::uuid AND incomplete` as any[]
    const flags = await sql`
      SELECT COUNT(*) FILTER (WHERE freeze_commissions)::int AS frozen,
             COUNT(*) FILTER (WHERE NOT freeze_commissions)::int AS review
        FROM affiliate_fraud_flags WHERE affiliate_id = ${affiliateId}::uuid AND status IN ('open','investigating')` as any[]

    // Orders contract: order_fraud_reviews(order_id, hold_state). Optional — absent until the orders workstream ships.
    let holdCount = 0
    const present = await sql`SELECT to_regclass('public.order_fraud_reviews') IS NOT NULL AS present` as any[]
    const orderIds = selected.map(r => r.order_id)
    if (present[0]?.present === true && orderIds.length) {
      const h = await sql`SELECT COUNT(*)::int AS n FROM order_fraud_reviews WHERE order_id = ANY(${orderIds}::uuid[]) AND hold_state = 'active'` as any[]
      holdCount = Number(h[0]?.n ?? 0)
    }
    const owed = await sql`SELECT COALESCE(SUM(affiliate_commission_overpaid(id)),0)::bigint AS n FROM affiliate_commissions WHERE affiliate_id = ${affiliateId}::uuid` as any[]

    return evaluateGateInputs({
      profile, financialStatus: aff[0]?.status ?? null, taxRequired, payableCents,
      selectedMissingCount: selectedMissing, selectedIncompleteCount: selectedIncomplete,
      frozenFlagCount: Number(flags[0]?.frozen ?? 0), reviewFlagCount: Number(flags[0]?.review ?? 0),
      fraudHoldOrderCount: holdCount,
      incompleteElsewhereCount: Math.max(0, Number(incompleteAll[0]?.n ?? 0) - selectedIncomplete),
      owedBackCents: Number(owed[0]?.n ?? 0),
    })
  } catch {
    return {
      allowed: false,
      blockers: [{ code: 'gate_unavailable', message: 'Payout readiness could not be checked. Try again.' }],
      warnings: [],
      snapshot: { programStatus: null, financialStatus: null, kyc: null, tax: null, payoutMethod: null, payableCents: 0, thresholdCents: null, taxRequired: true },
    }
  }
}

/**
 * Create a DRAFT payout only if the gate allows it. The creation itself is the unchanged, idempotent SQL
 * (create_affiliate_payout — amounts recomputed under lock, second call finds nothing payable).
 */
export async function createGatedPayout(
  sql: Sql, affiliateId: string, commissionIds: string[], actorEmail: string,
  createPayout: (affiliateId: string, ids: string[], actor: string) => Promise<any>,
): Promise<{ blocked: true; gate: GateResult } | { blocked: false; gate: GateResult; result: any }> {
  const gate = await canPayAffiliate(sql, affiliateId, { commissionIds })
  if (!gate.allowed) return { blocked: true, gate }
  const result = await createPayout(affiliateId, commissionIds, actorEmail)
  return { blocked: false, gate, result }
}
