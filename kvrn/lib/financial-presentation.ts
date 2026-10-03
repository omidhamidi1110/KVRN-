// lib/financial-presentation.ts
//
// How the Admin may LABEL a profit figure. Pure, so the language rule is testable and the
// UI cannot drift from it:
//
//   RECONCILED  the exact figure may be shown, labelled exact
//   INCOMPLETE  there is no exact figure: show "Unknown" (a required fact is missing)
//   EXCEPTION   there is no valid figure: show "Invalid" (the data contradicts itself)
//
// A known-so-far number may still be shown, but only labelled as non-authoritative.

export type ProfitIntegrityState = 'RECONCILED' | 'INCOMPLETE' | 'EXCEPTION'

export interface ProfitPresentation {
  kind: 'exact' | 'unknown' | 'invalid'
  /** Card title. Contains "(exact)" only when kind === 'exact'. */
  label: string
  /** Cents to display, or null when the card must show a word instead. */
  cents: number | null
  /** The word shown instead of a number. */
  word: 'Unknown' | 'Invalid' | null
  sub: string
  /** Where to fix it. Present for every non-exact state. */
  href: string | null
}

export const RECONCILIATION_HREF = '/admin/financials/integrity'

export function profitPresentation(input: {
  canonicalOperatingProfitCents: number | null
  integrityState: ProfitIntegrityState
  exceptionCount?: number
  incompleteCount?: number
}): ProfitPresentation {
  const { canonicalOperatingProfitCents: c, integrityState: st } = input
  if (st === 'EXCEPTION') {
    const n = input.exceptionCount ?? 0
    return {
      kind: 'invalid', label: 'Operating profit', cents: null, word: 'Invalid',
      sub: `Reconciliation EXCEPTION${n ? ` (${n})` : ''}: the data contradicts itself, so no exact figure exists. Fix it in Reconciliation.`,
      href: RECONCILIATION_HREF,
    }
  }
  if (st === 'INCOMPLETE' || c === null) {
    const n = input.incompleteCount ?? 0
    return {
      kind: 'unknown', label: 'Operating profit', cents: null, word: 'Unknown',
      sub: `Not exact: a required fact in this period is still unknown or estimated${n ? ` (${n})` : ''}.`,
      href: RECONCILIATION_HREF,
    }
  }
  return {
    kind: 'exact', label: 'Operating profit (exact)', cents: c, word: null,
    sub: 'Reconciled · every required fact known · cohort basis', href: null,
  }
}

/** Label for the known-so-far figures: always non-authoritative unless fully reconciled. */
export function knownSoFarLabel(base: string, state: ProfitIntegrityState): string {
  return state === 'RECONCILED' ? base : `${base} (known so far, not exact)`
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER-LEVEL canonical result (REV2)
// ─────────────────────────────────────────────────────────────────────────────
//
// The calculator's reconciliation state (complete / partial / unknown) only says whether
// every cost INPUT was known. It cannot see a contradiction (order total vs lines, FIFO vs
// COGS snapshot, refund components ...). The scan's per-order integrity state can. An
// order's contribution is exact only when BOTH agree; the integrity state always wins:
//
//   RECONCILED + calculator complete   -> exact numeric contribution
//   INCOMPLETE                         -> no number, "Unknown"
//   EXCEPTION                          -> no number, "Invalid"   (even if every input is numeric)
//
// The raw calculator figure is a known-so-far DIAGNOSTIC and is never labelled exact.

export type CalculatorReconciliationState = 'complete' | 'partial' | 'unknown'

export interface CanonicalOrderContribution {
  kind: 'exact' | 'unknown' | 'invalid'
  state: ProfitIntegrityState
  /** Exact cents, or null (Unknown / Invalid). */
  contributionProfitCents: number | null
  contributionMarginPct: number | null
  word: 'Unknown' | 'Invalid' | null
  reason: string
  href: string | null
}

export function canonicalOrderContribution(input: {
  integrityState: ProfitIntegrityState
  contributionProfitCents: number | null
  contributionMarginPct?: number | null
}): CanonicalOrderContribution {
  const { integrityState: st, contributionProfitCents: c } = input
  if (st === 'EXCEPTION') {
    return { kind: 'invalid', state: st, contributionProfitCents: null, contributionMarginPct: null, word: 'Invalid',
      reason: 'Reconciliation EXCEPTION: this order\'s data contradicts itself, so no exact contribution exists.',
      href: RECONCILIATION_HREF }
  }
  if (st === 'INCOMPLETE') {
    return { kind: 'unknown', state: st, contributionProfitCents: null, contributionMarginPct: null, word: 'Unknown',
      reason: 'Reconciliation INCOMPLETE: a required fact for this order is unknown or unresolved.',
      href: RECONCILIATION_HREF }
  }
  if (c === null) {
    return { kind: 'unknown', state: st, contributionProfitCents: null, contributionMarginPct: null, word: 'Unknown',
      reason: 'A cost input for this order is not recorded yet.', href: RECONCILIATION_HREF }
  }
  return { kind: 'exact', state: st, contributionProfitCents: c,
    contributionMarginPct: input.contributionMarginPct ?? null, word: null,
    reason: 'Reconciled and every required input is known.', href: null }
}

export interface OrderRowPresentation {
  contribution: CanonicalOrderContribution
  /** Label of the status badge. Distinguishes INCOMPLETE from EXCEPTION. */
  badgeText: 'Reconciled' | 'Partial' | 'Unreconciled' | 'Incomplete' | 'Exception'
  badgeTone: 'ok' | 'warn' | 'bad' | 'neutral'
  /** Where to resolve it; null when the row is exact. */
  href: string | null
}

/** Recent-orders row. `integrityState` (the scan) wins over the calculator's own state. */
export function orderRowPresentation(input: {
  integrityState?: ProfitIntegrityState | null
  contributionProfitCents: number | null
  contributionMarginPct?: number | null
  calculatorState: CalculatorReconciliationState
}): OrderRowPresentation {
  // A missing integrity state is NOT treated as reconciled.
  const st: ProfitIntegrityState = input.integrityState ?? 'INCOMPLETE'
  const contribution = canonicalOrderContribution({
    integrityState: st,
    // the calculator's own incompleteness also removes the number
    contributionProfitCents: input.calculatorState === 'complete' ? input.contributionProfitCents : null,
    contributionMarginPct: input.contributionMarginPct,
  })
  if (st === 'EXCEPTION') return { contribution, badgeText: 'Exception', badgeTone: 'bad', href: RECONCILIATION_HREF }
  if (st === 'INCOMPLETE') return { contribution, badgeText: 'Incomplete', badgeTone: 'warn', href: RECONCILIATION_HREF }
  if (input.calculatorState === 'partial') return { contribution, badgeText: 'Partial', badgeTone: 'warn', href: RECONCILIATION_HREF }
  if (input.calculatorState === 'unknown') return { contribution, badgeText: 'Unreconciled', badgeTone: 'neutral', href: RECONCILIATION_HREF }
  return { contribution, badgeText: 'Reconciled', badgeTone: 'ok', href: null }
}
