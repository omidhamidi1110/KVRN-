// lib/tax-export.ts
//
// Tax-year bookkeeping SUMMARY (CSV). Deliberately NOT a second calculator:
// every figure comes from createFinancialService().getPeriodReport() — the same
// source of truth as the admin financial summary — and this file only LAYS IT OUT.
//
// Rules this file enforces:
//   • Money is integer cents; USD text is derived by integer arithmetic, never floats.
//   • UNKNOWN IS NOT ZERO. A line whose inputs are unknown exports a BLANK amount with
//     status INCOMPLETE; the known-so-far floor goes in its own column.
//   • Canonical profit lines are blank whenever the reconciliation gate nulls them.
//   • Sales tax is its own line and is never inside any revenue line.
//   • Only the fields the calculator already produced are exported; nothing is derived
//     here except lines the calculator itself defines (net product cost = cogs − credit + exchange).
//   • Recurring DEFINITIONS are never turned into expense: expenses come exclusively
//     from recognised expense_transactions. A definition is only counted, as a review aid.
//   • No tax advice, no deductibility claims, no filing logic.

import type { NeonQueryFunction } from '@neondatabase/serverless'
import { csvCell } from './financial-integrity'
import type { PeriodEconomics } from './financial-calculator'
import type { PeriodIntegrity } from './financial-integrity'
import type { DateRange } from './financials'

export const TAX_EXPORT_DISCLAIMER =
  'Bookkeeping summary generated from KVRN records. It is NOT a filed tax return and is not ' +
  'tax, legal or accounting advice. It makes no statement about what is taxable or deductible. ' +
  'Review with a qualified accountant before relying on it.'

export const TAX_EXPORT_BASIS =
  'Orders are included by the UTC date they were paid (orders.paid_at), half-open year ' +
  '[Jan 1 00:00Z, next Jan 1 00:00Z). Refunds, disputes, COGS, fees and commissions are the ' +
  'lifetime effects recorded to date against those orders (cohort basis), not events dated ' +
  'inside the year. Expense transactions are recognised over their service period (or on the ' +
  'paid date when none is set). Advertising spend is pro-rated over its period.'

// ─────────────────────────────────────────────────────────────────────────────
// YEAR
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_TAX_YEAR = 2000

export type TaxYearResult = { ok: true; year: number } | { ok: false; error: string }

/** Strict: exactly four digits, MIN_TAX_YEAR ≤ year ≤ the current UTC year. */
export function parseTaxYear(raw: string | null | undefined, now: Date = new Date()): TaxYearResult {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: 'year is required (YYYY).' }
  }
  if (!/^\d{4}$/.test(raw)) return { ok: false, error: 'year must be a four-digit year (YYYY).' }
  const year = Number(raw)
  const current = now.getUTCFullYear()
  if (year < MIN_TAX_YEAR || year > current) {
    return { ok: false, error: `year must be between ${MIN_TAX_YEAR} and ${current}.` }
  }
  return { ok: true, year }
}

/** Half-open UTC range for a tax year: [Jan 1 of year, Jan 1 of year+1). */
export function taxYearRange(year: number): DateRange {
  return { start: `${year}-01-01T00:00:00.000Z`, end: `${year + 1}-01-01T00:00:00.000Z` }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROWS
// ─────────────────────────────────────────────────────────────────────────────

export type LineStatus =
  | 'COMPLETE'     // every input known and the period reconciles
  | 'UNVERIFIED'   // amount shown, but the period reconciliation is not RECONCILED — review
  | 'INCOMPLETE'   // an input is unknown: amount BLANK, floor in known_so_far
  | 'EXCEPTION'    // the period reconciliation reports a contradiction: amount BLANK
  | 'INFO'         // informational / metadata, not a ledger total

export interface TaxRow {
  section: string
  line: string
  amountCents: number | null
  status: LineStatus | ''
  knownSoFarCents: number | null
  detail: string
}

/** The per-order slice the builder needs (OrderEconomicsRow satisfies this structurally). */
export interface TaxOrderLike {
  economics: { reconciliation: { missing: Array<{ field: string }> } }
}

export interface TaxExportInput {
  year:        number
  generatedAt: string
  now?:        Date
  period:      PeriodEconomics
  orders:      TaxOrderLike[]
  integrity:   Pick<PeriodIntegrity, 'state' | 'exceptionCount' | 'incompleteCount' | 'orderCohortCount'>
  writeOffUnknown: boolean
  /** Cash facts in the year, informational only (never mixed into profit). */
  cashRefundsPaidCents:    number
  cashExpensePaymentsCents: number
  /** Active monthly/annual definitions with no paid, non-voided transaction in the year. */
  fixedDefinitionsWithoutPaidBill: number
}

/** Integer cents → "-12.34". No floating point anywhere. */
export function centsToUsd(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

function missingOrders(orders: TaxOrderLike[], fields: string[]): number {
  return orders.filter(o => o.economics.reconciliation.missing.some(m => fields.includes(m.field))).length
}

export function buildTaxExportRows(i: TaxExportInput): TaxRow[] {
  const p = i.period
  const reconciled = i.integrity.state === 'RECONCILED'
  const rows: TaxRow[] = []
  const meta = (line: string, detail: string) =>
    rows.push({ section: 'REPORT', line, amountCents: null, status: '', knownSoFarCents: null, detail })
  const info = (section: string, line: string, cents: number, detail: string) =>
    rows.push({ section, line, amountCents: cents, status: 'INFO', knownSoFarCents: null, detail })

  /** A sum that is exact unless `unknownFields` appear on any order. */
  const money = (
    section: string, line: string, cents: number, detail: string,
    unknownFields: string[] = [], extraUnknown = false,
  ) => {
    const n = unknownFields.length ? missingOrders(i.orders, unknownFields) : 0
    if (n > 0 || extraUnknown) {
      rows.push({
        section, line, amountCents: null, status: 'INCOMPLETE', knownSoFarCents: cents,
        detail: `${detail} UNKNOWN: ${n > 0 ? `${n} order(s) lack this data` : 'source data incomplete'}; ` +
                'known_so_far is a floor, not the total.',
      })
      return
    }
    rows.push({
      section, line, amountCents: cents, status: reconciled ? 'COMPLETE' : 'UNVERIFIED',
      knownSoFarCents: null, detail,
    })
  }

  // ── REPORT metadata ────────────────────────────────────────────────────────
  const inProgress = i.year === (i.now ?? new Date()).getUTCFullYear()
  meta('Report', 'KVRN tax-year bookkeeping summary')
  meta('Tax year requested', String(i.year))
  meta('Period start (UTC, inclusive)', `${i.year}-01-01T00:00:00.000Z`)
  meta('Period end (UTC, exclusive)', `${i.year + 1}-01-01T00:00:00.000Z`)
  meta('Year status', inProgress ? 'IN PROGRESS: year-to-date only, not a complete year' : 'Completed calendar year')
  meta('Generated at (UTC)', i.generatedAt)
  meta('Currency', 'USD. amount_cents is the exact integer; amount_usd is the same value in dollars.')
  meta('Notice', TAX_EXPORT_DISCLAIMER)
  meta('Basis', TAX_EXPORT_BASIS)
  meta('Blank amounts', 'A blank amount means UNKNOWN, never zero. See status and known_so_far_usd.')
  meta('Reconciliation state', i.integrity.state +
    (reconciled ? '' : ` (${i.integrity.exceptionCount} exception(s), ${i.integrity.incompleteCount} incomplete finding(s)); ` +
      'amounts marked UNVERIFIED should be reviewed before use'))
  // Counts are carried in `detail`, never in an amount column, so no sum can mix them with money.
  meta('Orders paid in year', `Count: ${p.orderCount} (a count, not a money amount).`)

  // ── REVENUE ────────────────────────────────────────────────────────────────
  money('REVENUE', 'Gross merchandise sales', p.grossMerchandiseCents,
    'Merchandise at list price before discounts. Sales tax excluded.')
  money('REVENUE', 'Merchandise discounts', p.merchandiseDiscountCents,
    'Reduces gross merchandise. Shown as a positive amount.')
  money('REVENUE', 'Merchandise revenue (after discounts)', p.merchandiseRevenueCents,
    'Gross merchandise sales minus discounts.')
  money('REVENUE', 'Shipping revenue', p.shippingRevenueCents,
    'Shipping charged to customers. Separate from shipping expense.')
  money('REVENUE', 'Exchange revenue', p.exchangeRevenueCents,
    'Additional customer charges on exchanges.')
  money('REVENUE', 'Refunds paid to customers', p.refundCents,
    'Total customer cash refunded for these orders. May include refunded sales tax; only the ' +
    'revenue portion reduces net revenue.')
  money('REVENUE', 'Disputes lost (revenue reversed)', p.disputeLossCents,
    'Dispute loss after removing any part already refunded, so the same money is not reversed twice.')
  info('REVENUE', 'Dispute amount already covered by refunds', p.disputeRefundOverlapCents,
    'Not reversed a second time. Informational.')
  money('REVENUE', 'Net revenue', p.netRevenueCents,
    'Gross customer revenue + exchange revenue − revenue-portion of refunds − disputes lost. Sales tax excluded.',
    ['refund_revenue_split'])

  // ── SALES TAX ──────────────────────────────────────────────────────────────
  money('SALES TAX', 'Sales tax collected', p.taxCollectedCents,
    'Collected on behalf of tax authorities. A liability, NOT revenue: it is in no revenue or profit line.')

  // ── COSTS ──────────────────────────────────────────────────────────────────
  money('COSTS', 'Product COGS recognized', p.cogsCents,
    'Immutable per-order COGS snapshots for orders paid in the year. Inventory purchases are ' +
    'capitalised and are not expensed here.', ['cogs'])
  money('COSTS', 'Less: returned-stock COGS credit', p.returnCogsCreditCents,
    'Reduces COGS when returned stock goes back to inventory.', ['return_cogs_credit'])
  money('COSTS', 'Replacement (exchange) COGS', p.exchangeCogsCents,
    'COGS of replacement items sent on exchanges.', ['exchange_cogs'])
  money('COSTS', 'Shipping / fulfillment expense', p.shippingCostCents,
    'Outbound carrier label cost. Separate from shipping revenue.', ['shipping_cost'])
  money('COSTS', 'Exchange shipping expense', p.exchangeShippingCostCents,
    'Carrier cost of shipping replacements.', ['exchange_shipping_cost'])
  money('COSTS', 'Return label expense', p.returnLabelCostCents,
    'Carrier cost of return labels.', ['return_label_cost'])
  money('COSTS', 'Stripe / payment processing fees', p.stripeFeeCents,
    'Recognised once per order, net of any fee Stripe returned on refunds.', ['stripe_fee', 'refund_fee'])
  money('COSTS', 'Dispute fees', p.disputeFeeCents,
    'Stripe dispute fees recorded against these orders.', ['dispute_fee'])
  money('COSTS', 'Affiliate commission expense', p.affiliateCommissionCents,
    'Commission recognised per order. Payout cash timing is NOT used here.', ['affiliate_commission'])
  money('COSTS', 'Advertising spend (recognized)', p.advertisingSpendCents,
    'Non-voided ad spend pro-rated over its period.')
  money('COSTS', 'Operating expenses (recognized)', p.recognizedOperatingExpensesCents,
    'Actual expense transactions (non-voided, paid), excluding development. Recurring definitions ' +
    'alone are never included.')
  money('COSTS', 'Development expenses (recognized)', p.recognizedDevelopmentExpensesCents,
    'Actual expense transactions in the development category.')
  money('COSTS', 'Inventory write-offs', p.writeOffCostCents,
    'Cost of inventory written off in the year.', [], i.writeOffUnknown)

  // ── PROFIT (canonical only) ────────────────────────────────────────────────
  const gated = (cents: number | null, floor: number, line: string, detail: string) => {
    if (cents !== null) {
      rows.push({ section: 'PROFIT', line, amountCents: cents, status: 'COMPLETE', knownSoFarCents: null, detail })
      return
    }
    const exception = p.profitCompleteness === 'exception'
    rows.push({
      section: 'PROFIT', line, amountCents: null,
      status: exception ? 'EXCEPTION' : 'INCOMPLETE', knownSoFarCents: floor,
      detail: `${detail} ${exception
        ? 'INVALID: reconciliation reports a contradiction in this period.'
        : 'UNKNOWN: an input is missing or the period is not reconciled.'} ` +
        'known_so_far is a non-authoritative figure that leaves unknowns out.',
    })
  }
  gated(p.canonicalOrderContributionCents, p.contributionProfitCents, 'Order contribution',
    'Net revenue − product cost − shipping − fees − commission, before operating expenses and advertising.')
  gated(p.canonicalOperatingProfitCents, p.nonAuthoritativeOperatingProfitCents,
    'Operating profit (before income tax)',
    'Order contribution − operating and development expenses − advertising − write-offs. ' +
    'Gross profit is not exported: KVRN does not define it canonically.')

  // ── CASH BASIS (informational, never profit) ───────────────────────────────
  info('CASH (informational)', 'Refunds paid in year (cash basis)', i.cashRefundsPaidCents,
    'Succeeded refunds dated inside the year, for any order. Different basis from the cohort line above.')
  info('CASH (informational)', 'Expense invoices paid in year (cash basis)', i.cashExpensePaymentsCents,
    'Non-voided expense transactions with a paid date in the year, at full paid amount. ' +
    'Differs from recognized expenses when a bill covers other periods. Not profit.')

  // ── REVIEW (expected, NOT recognized) ──────────────────────────────────────
  rows.push({
    section: 'REVIEW (expected, not recognized)',
    line: 'Active fixed-recurring obligations with no paid bill in year',
    amountCents: null, status: 'INFO', knownSoFarCents: null,
    detail: `Count: ${i.fixedDefinitionsWithoutPaidBill} (a count, not money). Monthly/annual ` +
      'definitions are expectations only; no expense is recorded until an actual invoice is ' +
      'entered. Uses each definition\'s current active flag.',
  })

  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

export const TAX_CSV_HEADER = [
  'section', 'line_item', 'amount_usd', 'amount_cents', 'status', 'known_so_far_usd', 'detail',
]

/**
 * RFC 4180 CSV with CRLF endings. Text goes through csvCell (quoting + formula-injection
 * neutralisation). Numeric cells are generated here from integers, so they are written
 * raw: a negative profit must stay a real number, not become the text "'-12.50".
 */
export function taxRowsToCsv(rows: TaxRow[]): string {
  const num = (c: number | null, usd: boolean) =>
    c === null ? '' : usd ? centsToUsd(c) : String(c)
  const lines = [TAX_CSV_HEADER.join(',')]
  for (const r of rows) {
    lines.push([
      csvCell(r.section),
      csvCell(r.line),
      num(r.amountCents, true),
      num(r.amountCents, false),
      csvCell(r.status),
      num(r.knownSoFarCents, true),
      csvCell(r.detail),
    ].join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

export function taxExportFilename(year: number): string {
  return `kvrn-tax-summary-${year}.csv`
}

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW AID (a COUNT, never money)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active monthly/annual definitions that existed during the year and have NO paid,
 * non-voided expense_transaction linked to them with a paid date inside the year.
 * Read-only. It creates nothing and feeds no total: a definition is an expectation,
 * and an expense exists only when an actual invoice is entered.
 */
export async function countFixedDefinitionsWithoutPaidBill(
  sql: NeonQueryFunction<false, false>, year: number,
): Promise<number> {
  const startDate = `${year}-01-01`
  const endDate   = `${year}-12-31`
  const rows = await sql.query(
    `SELECT COUNT(*)::int AS n
     FROM expense_definitions d
     WHERE d.active
       AND d.cadence IN ('monthly', 'annual')
       AND d.created_at < $1::timestamptz
       AND (d.renewal_date IS NULL OR d.renewal_date <= $3::date)
       AND NOT EXISTS (
         SELECT 1 FROM expense_transactions t
         WHERE t.expense_definition_id = d.id
           AND t.voided_at IS NULL
           AND t.paid_at IS NOT NULL
           AND t.paid_at >= $2::date AND t.paid_at <= $3::date
       )`,
    [`${year + 1}-01-01T00:00:00.000Z`, startDate, endDate],
  )
  return Number((rows as any[])[0]?.n ?? 0)
}
