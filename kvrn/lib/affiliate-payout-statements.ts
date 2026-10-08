// lib/affiliate-payout-statements.ts — explainable payout statements + CSV export.
// Server-only.
//
// A statement reproduces each payout line from the append-only ledger AS IT STOOD when the payout was created
// (SQL: affiliate_payout_statement, migration 034). The header is derived from those lines, so:
//
//     net payout = gross commission earned + adjustments (reversals / corrections, signed)
//                  − already paid on earlier payouts + cash recovered from the affiliate
//
// `reconciled` is true only when every line's reproduction equals its stored amount AND the lines add up to the
// payout total. Otherwise the statement says so ("Needs review") — it is never quietly adjusted.
//
// The affiliate view carries NO order number/UUID (only the non-reversible sale reference), no customer data and
// no other affiliate. The Admin view adds the order number for reconciliation.
type Sql = any

export interface StatementLine {
  saleRef: string | null
  orderNumber?: string            // Admin view only
  saleDate: string | null
  earnedCents: number
  adjustmentsCents: number
  previouslyPaidCents: number
  recoveredCents: number
  lineAmountCents: number
  reconciled: boolean
}

export interface Statement {
  payoutRef: string | null
  payoutNumber?: string           // Admin view only
  status: 'draft' | 'paid' | 'void'
  currency: string
  date: string | null
  method: string | null
  amountCents: number
  totals: {
    grossEarnedCents: number
    adjustmentsCents: number
    previouslyPaidCents: number
    recoveredCents: number
    netCents: number
    reconciled: boolean
  }
  lines: StatementLine[]
}

const n = (v: unknown) => Number(v ?? 0)

export function summarizeLines(lines: Array<Pick<StatementLine, 'earnedCents' | 'adjustmentsCents' | 'previouslyPaidCents' | 'recoveredCents' | 'lineAmountCents' | 'reconciled'>>, payoutAmountCents: number) {
  const t = lines.reduce((a, l) => ({
    gross: a.gross + l.earnedCents, adj: a.adj + l.adjustmentsCents, prev: a.prev + l.previouslyPaidCents,
    rec: a.rec + l.recoveredCents, line: a.line + l.lineAmountCents, ok: a.ok && l.reconciled,
  }), { gross: 0, adj: 0, prev: 0, rec: 0, line: 0, ok: true })
  const net = t.gross + t.adj - t.prev + t.rec
  return {
    grossEarnedCents: t.gross, adjustmentsCents: t.adj, previouslyPaidCents: t.prev, recoveredCents: t.rec,
    netCents: payoutAmountCents,
    reconciled: t.ok && lines.length > 0 && net === payoutAmountCents && t.line === payoutAmountCents,
  }
}

export async function buildStatement(sql: Sql, payoutId: string, view: 'affiliate' | 'admin'): Promise<Statement | null> {
  const ph = await sql`
    SELECT p.id, p.affiliate_id, p.payout_number, p.status, p.amount_cents, p.paid_at, p.created_at, p.method
      FROM affiliate_payouts p WHERE p.id = ${payoutId}::uuid` as any[]
  const p = ph[0]
  if (!p) return null
  const rows = await sql`
    SELECT s.commission_id, s.line_amount_cents, s.earned_cents, s.adjustments_cents, s.previously_paid_cents,
           s.recovered_cents, s.reconciled,
           affiliate_public_ref('sale', s.commission_id, ${p.affiliate_id}::uuid) AS sale_ref,
           att.attributed_at, o.order_number
      FROM affiliate_payout_statement(${payoutId}::uuid) s
      JOIN affiliate_commissions c ON c.id = s.commission_id
      JOIN order_affiliate_attributions att ON att.id = c.attribution_id
      JOIN orders o ON o.id = c.order_id
     ORDER BY att.attributed_at, s.commission_id` as any[]
  const lines: StatementLine[] = rows.map(r => ({
    saleRef: r.sale_ref ?? null,
    ...(view === 'admin' ? { orderNumber: r.order_number as string } : {}),
    saleDate: r.attributed_at ? new Date(r.attributed_at).toISOString().slice(0, 10) : null,
    earnedCents: n(r.earned_cents), adjustmentsCents: n(r.adjustments_cents),
    previouslyPaidCents: n(r.previously_paid_cents), recoveredCents: n(r.recovered_cents),
    lineAmountCents: n(r.line_amount_cents), reconciled: r.reconciled === true,
  }))
  const ref = await sql`SELECT affiliate_public_ref('payout', ${payoutId}::uuid, ${p.affiliate_id}::uuid) AS ref` as any[]
  return {
    payoutRef: ref[0]?.ref ?? null,
    ...(view === 'admin' ? { payoutNumber: p.payout_number as string } : {}),
    status: p.status, currency: 'USD',
    date: new Date(p.paid_at ?? p.created_at).toISOString().slice(0, 10),
    method: typeof p.method === 'string' && /^[A-Za-z0-9 _-]{1,24}$/.test(p.method) ? p.method : null,
    amountCents: n(p.amount_cents),
    totals: summarizeLines(lines, n(p.amount_cents)),
    lines,
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────
/** Neutralise spreadsheet formula injection and quote when needed. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  // Plain signed decimals (our own money formatting) are safe and must stay numeric.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const usd = (c: number) => (c / 100).toFixed(2)

export function statementToCsv(s: Statement): string {
  const rows: unknown[][] = [
    ['KVRN affiliate payout statement'],
    ['Payout', s.payoutRef ?? ''],
    ['Status', s.status === 'void' ? 'cancelled' : s.status],
    ['Date', s.date ?? ''],
    ['Currency', s.currency],
    [],
    ['Sale reference', 'Sale date', 'Commission earned', 'Adjustments', 'Previously paid', 'Recovered', 'Line amount', 'Checks out'],
    ...s.lines.map(l => [l.saleRef, l.saleDate, usd(l.earnedCents), usd(l.adjustmentsCents), usd(-l.previouslyPaidCents),
      usd(l.recoveredCents), usd(l.lineAmountCents), l.reconciled ? 'yes' : 'needs review']),
    [],
    ['Gross commission earned', usd(s.totals.grossEarnedCents)],
    ['Adjustments (reversals and corrections)', usd(s.totals.adjustmentsCents)],
    ['Already paid on earlier payouts', usd(-s.totals.previouslyPaidCents)],
    ['Recovered from you', usd(s.totals.recoveredCents)],
    ['Net payout', usd(s.totals.netCents)],
    ['Statement reconciles', s.totals.reconciled ? 'yes' : 'needs review'],
  ]
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
