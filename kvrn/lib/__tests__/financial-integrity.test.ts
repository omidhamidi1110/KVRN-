// lib/__tests__/financial-integrity.test.ts
//
// Financial integrity & reconciliation batch.
//
//   PART A  pure: canonical profit derivation, CSV export, filters, structural
//           guarantees about migration 021 (forward-only, frozen 018/019/020).
//   PART B  real PostgreSQL: the production SQL (financialSelect LATERALs, the scan
//           and history functions) run against a throwaway database that has
//           migrations 001..latest applied. Nothing about the money logic is mocked.
//
// FAILURE-ORIENTED: most cases state a way the books could silently go wrong and
// assert the system refuses to hide it (null instead of zero, an exception instead
// of a quiet double count, a finding that clears only when the DATA is fixed).

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Client } from 'pg'
import {
  computeOrderEconomics,
  computePeriodEconomics,
  knownSoFarContribution,
  type OrderFinancialInputs,
  type OrderEconomics,
} from '../financial-calculator'
import {
  csvCell, amountsOf, findingsToCsv, parseFindingFilter, CSV_COLUMNS,
  createFinancialIntegrityService, type IntegrityFinding,
} from '../financial-integrity'
import { createFinancialService } from '../financials'

const ROOT = path.resolve(__dirname, '../..')
const MIG = (f: string) => fs.readFileSync(path.join(ROOT, 'db/migrations', f), 'utf8')
const M021 = MIG('021_financial_integrity.sql')

// ─────────────────────────────────────────────────────────────────────────────
// PART A — pure
// ─────────────────────────────────────────────────────────────────────────────

const base = (over: Partial<OrderFinancialInputs> = {}): OrderFinancialInputs => ({
  subtotalCents: 1000, merchandiseDiscountCents: 0, shippingRevenueCents: 500,
  shippingQuotedCents: 500, shippingPromoDiscountCents: 0, shippingAutoFreeDiscountCents: 0,
  taxCents: 0, cogsCents: 300, shippingCostCents: 450, stripeFeeCents: 100,
  refundCents: 0, refundedFeeCents: null,
  ...over,
})

describe('canonical order contribution', () => {
  test('back-compat: callers that omit the new inputs get the original formula', () => {
    const e = computeOrderEconomics(base())
    expect(e.contributionProfitCents).toBe(1500 - 300 - 450 - 100)
    expect(e.reconciliation.state).toBe('complete')
    expect(e.disputeLossCents).toBe(0)
    expect(e.netProductCostCents).toBe(300)
  })

  test.each([
    ['returnCogsCreditCents', 'return_cogs_credit'],
    ['exchangeCogsCents', 'exchange_cogs'],
    ['exchangeShippingCostCents', 'exchange_shipping_cost'],
    ['returnLabelCostCents', 'return_label_cost'],
    ['disputeFeeCents', 'dispute_fee'],
    ['affiliateCommissionCents', 'affiliate_commission'],
  ] as const)('an unknown %s makes profit UNKNOWN, never zero', (field, missingField) => {
    const e = computeOrderEconomics(base({ [field]: null } as any))
    expect(e.contributionProfitCents).toBeNull()
    expect(e.contributionMarginPct).toBeNull()
    expect(e.reconciliation.missing.map(m => m.field)).toContain(missingField)
    expect(e.reconciliation.state).toBe('partial')
  })

  test('unknown core costs still read as unknown when all three are missing', () => {
    const e = computeOrderEconomics(base({ cogsCents: null, shippingCostCents: null, stripeFeeCents: null }))
    expect(e.reconciliation.state).toBe('unknown')
    expect(e.contributionProfitCents).toBeNull()
  })

  test('a refund and a lost dispute over the SAME money are never reversed twice', () => {
    // Paid $15.00. Dispute lost in full ($15.00 recognised), later $5.00 refunded.
    const e = computeOrderEconomics(base({ refundCents: 500, refundedFeeCents: 0, disputeLossCents: 1500, disputeFeeCents: 1500 }))
    expect(e.disputeLossCents).toBe(1000)            // only what was still unrefunded
    expect(e.disputeRefundOverlapCents).toBe(500)    // the removed overlap is reported
    expect(e.netRevenueCents).toBe(0)                // 1500 - 500 - 1000, not -500
    expect(e.contributionProfitCents).toBe(0 - 300 - 450 - 100 - 1500)
  })

  test('revenue can never go negative through a dispute', () => {
    const e = computeOrderEconomics(base({ disputeLossCents: 99999 }))
    expect(e.netRevenueCents).toBe(0)
    expect(e.disputeRefundOverlapCents).toBe(99999 - 1500)
  })

  test('a won dispute (no impact) changes nothing but its fee', () => {
    const e = computeOrderEconomics(base({ disputeLossCents: 0, disputeFeeCents: 1500 }))
    expect(e.netRevenueCents).toBe(1500)
    expect(e.contributionProfitCents).toBe(1500 - 300 - 450 - 100 - 1500)
  })

  test('returned stock credits cost back; replacement cost and shipping add it', () => {
    const e = computeOrderEconomics(base({
      returnCogsCreditCents: 300, exchangeCogsCents: 320, exchangeShippingCostCents: 650,
      returnLabelCostCents: 700,
    }))
    expect(e.netProductCostCents).toBe(300 - 300 + 320)
    expect(e.otherOrderCostsCents).toBe(450 + 650 + 700 + 100)
    expect(e.contributionProfitCents).toBe(1500 - (320) - (450 + 650 + 700 + 100))
  })

  test('affiliate commission is an expense; payout cash is not an input at all', () => {
    const a = computeOrderEconomics(base({ affiliateCommissionCents: 100 }))
    expect(a.contributionProfitCents).toBe(650 - 100)
    // There is deliberately no payout field on the order inputs.
    expect(Object.keys(base())).not.toContain('affiliatePayoutCents')
  })

  test('exchange revenue is collected extra merchandise (already net of tax)', () => {
    const e = computeOrderEconomics(base({ exchangeRevenueCents: 800 }))
    expect(e.netRevenueCents).toBe(1500 + 800)
  })

  test('tax is never revenue or profit', () => {
    const a = computeOrderEconomics(base({ taxCents: 0 }))
    const b = computeOrderEconomics(base({ taxCents: 123 }))
    expect(b.netRevenueCents).toBe(a.netRevenueCents)
    expect(b.contributionProfitCents).toBe(a.contributionProfitCents)
    expect(b.taxCollectedCents).toBe(123)
  })

  test('shipping revenue and shipping expense stay separate terms', () => {
    const e = computeOrderEconomics(base({ shippingRevenueCents: 500, shippingCostCents: 800 }))
    expect(e.shippingRevenueCents).toBe(500)
    expect(e.shippingCostCents).toBe(800)
    expect(e.shippingMarginCents).toBe(-300)
    // subsidy is reporting only: profit is revenue - cost once, not twice
    expect(e.contributionProfitCents).toBe(1500 - 300 - 800 - 100)
  })

  test('the Stripe fee is recognised once, net of any fee Stripe returned', () => {
    const e = computeOrderEconomics(base({ refundCents: 500, refundedFeeCents: 20 }))
    expect(e.netStripeFeeCents).toBe(80)
    expect(e.contributionProfitCents).toBe(1000 - 300 - 450 - 80)
  })
})

// A small deterministic generator so the period/order identity is checked on many shapes.
function lcg(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 }
function randomInputs(r: () => number): OrderFinancialInputs {
  const pick = (v: number) => (r() < 0.2 ? null : v)
  const n = (max: number) => Math.floor(r() * max)
  return base({
    subtotalCents: 500 + n(5000), shippingRevenueCents: n(900),
    cogsCents: pick(n(2000)), shippingCostCents: pick(n(900)), stripeFeeCents: pick(n(300)),
    refundCents: r() < 0.3 ? n(400) : 0,
    disputeLossCents: r() < 0.2 ? n(3000) : 0, disputeFeeCents: r() < 0.2 ? pick(1500) : undefined,
    affiliateCommissionCents: r() < 0.3 ? pick(n(300)) : undefined,
    returnCogsCreditCents: r() < 0.2 ? pick(n(300)) : undefined,
    exchangeCogsCents: r() < 0.1 ? pick(n(300)) : undefined,
    exchangeShippingCostCents: r() < 0.1 ? pick(n(700)) : undefined,
    returnLabelCostCents: r() < 0.1 ? pick(n(700)) : undefined,
    exchangeRevenueCents: r() < 0.1 ? n(500) : undefined,
  })
}

describe('canonical period economics', () => {
  const periodInput = (orders: OrderEconomics[], over: any = {}) => ({
    orders, recognizedOperatingExpensesCents: 0, recognizedDevelopmentExpensesCents: 0,
    advertisingSpendCents: 0, estimatedAccruedOperatingExpensesCents: 0,
    projectedOperatingExpensesCents: 0, ...over,
  })

  test('exact when every input is known; null the moment one order is not', () => {
    const known = computeOrderEconomics(base())
    const unknown = computeOrderEconomics(base({ stripeFeeCents: null }))
    const ok = computePeriodEconomics(periodInput([known, known]))
    expect(ok.canonicalOrderContributionCents).toBe(2 * 650)
    expect(ok.canonicalOperatingProfitCents).toBe(2 * 650)
    expect(ok.profitCompleteness).toBe('complete')
    expect(ok.profitBasis).toBe('cohort')

    const partial = computePeriodEconomics(periodInput([known, unknown]))
    expect(partial.canonicalOrderContributionCents).toBeNull()
    expect(partial.canonicalOperatingProfitCents).toBeNull()
    expect(partial.profitCompleteness).toBe('incomplete')
    expect(partial.isPartial).toBe(true)
    expect(partial.ordersWithUnknownCosts).toBe(1)
    // the numeric field is the known-so-far FLOOR, not a claim of exactness
    expect(partial.contributionProfitCents).toBe(650 + (1500 - 300 - 450))
  })

  test('operating profit subtracts opex, development, ads and write-offs; none are cash', () => {
    const e = computeOrderEconomics(base())
    const p = computePeriodEconomics(periodInput([e], {
      recognizedOperatingExpensesCents: 100, recognizedDevelopmentExpensesCents: 50,
      advertisingSpendCents: 70, writeOffCostCents: 30,
    }))
    expect(p.canonicalOperatingProfitCents).toBe(650 - 100 - 50 - 70 - 30)
    expect(p.realizedProfitAfterDevelopmentCents).toBe(650 - 100 - 50 - 70 - 30)
  })

  test('a write-off with unknown cost makes operating profit unknown', () => {
    const p = computePeriodEconomics(periodInput([computeOrderEconomics(base())],
      { writeOffCostCents: 30, writeOffCostUnknown: true }))
    expect(p.canonicalOperatingProfitCents).toBeNull()
    expect(p.isPartial).toBe(true)
  })

  test('cash flow is not part of the profit result', () => {
    const p = computePeriodEconomics(periodInput([computeOrderEconomics(base())]))
    const keys = Object.keys(p).join(' ')
    for (const cashWord of ['inventoryPurchase', 'payoutPaid', 'cashFlow', 'receipts']) {
      expect(keys).not.toContain(cashWord)
    }
  })

  test('IDENTITY: sum of per-order known-so-far contributions == the period floor, on 300 random shapes', () => {
    const r = lcg(2026)
    for (let i = 0; i < 300; i++) {
      const orders = Array.from({ length: 1 + Math.floor(r() * 6) }, () =>
        computeOrderEconomics(randomInputs(r)))
      const p = computePeriodEconomics(periodInput(orders))
      expect(orders.reduce((s, o) => s + knownSoFarContribution(o), 0)).toBe(p.contributionProfitCents)
      // exact figure is null iff any order is unknown, and equals the floor otherwise
      const anyUnknown = orders.some(o => o.contributionProfitCents === null)
      expect(p.canonicalOrderContributionCents === null).toBe(anyUnknown)
      if (!anyUnknown) expect(p.canonicalOrderContributionCents).toBe(p.contributionProfitCents)
      // an order with nothing unknown has exact == known-so-far
      for (const o of orders) {
        if (o.contributionProfitCents !== null) {
          expect(knownSoFarContribution(o)).toBe(o.contributionProfitCents)
        }
      }
    }
  })

  test('PROPERTY: no dispute loss ever exceeds what remained after refunds', () => {
    const r = lcg(7)
    for (let i = 0; i < 300; i++) {
      const e = computeOrderEconomics(randomInputs(r))
      expect(e.netRevenueCents).toBeGreaterThanOrEqual(
        Math.min(0, e.grossCustomerRevenueCents + e.exchangeRevenueCents - e.refundCents))
      expect(e.disputeLossCents).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('reconciliation CSV', () => {
  const finding = (over: Partial<IntegrityFinding> = {}): IntegrityFinding => ({
    fingerprint: 'ORDER_TOTAL_MISMATCH|order|abc', issueCode: 'ORDER_TOTAL_MISMATCH', state: 'exception',
    domain: 'order', entityType: 'order', entityId: 'abc', entityLabel: 'KVRN-1', orderId: 'abc',
    summary: 'Total, "quoted", does not match', evidence: { total_cents: 1600, expected_cents: 1500, nested: { fee_cents: null } },
    resolution: 'manual_review', actionPath: '/admin/orders', detectedAt: null, ...over,
  })

  test('header is the documented machine-readable column set', () => {
    const csv = findingsToCsv([], '2026-10-01T00:00:00.000Z')
    expect(csv).toBe(CSV_COLUMNS.join(',') + '\r\n')
    expect(CSV_COLUMNS).toEqual(expect.arrayContaining([
      'issue_code', 'state', 'entity_type', 'entity_id', 'summary', 'resolution',
      'action_path', 'detected_at', 'last_check_at', 'amounts_cents_json', 'evidence_json']))
  })

  test('RFC 4180 quoting and a parseable amounts column', () => {
    const csv = findingsToCsv([finding()], '2026-10-01T00:00:00.000Z')
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(3)                         // header, row, trailing ''
    expect(lines[1]).toContain('"Total, ""quoted"", does not match"')
    expect(lines[1]).toContain('2026-10-01T00:00:00.000Z')
    expect(amountsOf(finding().evidence)).toEqual({
      total_cents: 1600, expected_cents: 1500, 'nested.fee_cents': null })
  })

  test('unknown amounts stay null in the export, never 0', () => {
    expect(amountsOf({ stripe_fee_cents: null }).stripe_fee_cents).toBeNull()
    expect(csvCell(null)).toBe('')
  })

  test.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx'])(
    'spreadsheet formula injection is neutralised: %j', (cell) => {
      expect(csvCell(cell).replace(/^"/, '')).toMatch(/^'/)
    })

  test('a malicious entity label cannot become a formula', () => {
    const csv = findingsToCsv([finding({ entityLabel: '=HYPERLINK("http://x","y")' })], 'now')
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`)
  })

  test('same findings in -> byte-identical file out', () => {
    const f = [finding(), finding({ entityId: 'z', fingerprint: 'k|order|z' })]
    expect(findingsToCsv(f, 't')).toBe(findingsToCsv(f, 't'))
  })
})

describe('finding filter parsing is strict', () => {
  test('accepts known values', () => {
    const f = parseFindingFilter(new URLSearchParams('state=incomplete&domain=refund&code=ORDER_X&limit=10&offset=5&entityType=order'))
    expect(f).toEqual({ state: 'incomplete', domain: 'refund', issueCode: 'ORDER_X', entityType: 'order', limit: 10, offset: 5 })
  })
  test('drops anything unsafe or unknown rather than forwarding it', () => {
    const f = parseFindingFilter(new URLSearchParams(`state=hax&domain=a';drop&code=lower&limit=-1&offset=x&entityType=A B`))
    expect(f).toEqual({})
  })
  test('limit is capped', () => {
    expect(parseFindingFilter(new URLSearchParams('limit=999999')).limit).toBe(5000)
  })
})

describe('migration 021 structure', () => {
  test('018, 019 and 020 are byte-identical to the frozen versions', () => {
    const md5 = (f: string) => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'db/migrations', f))).digest('hex')
    expect(md5('018_returns_exchanges_disputes.sql')).toBe('385b099ac542032df47766dc78676b2b')
    expect(md5('019_inventory_fifo_layers.sql')).toBe('922f36c20fb71d21e6fe2b0054a77716')
    expect(md5('020_affiliates.sql')).toBe('9251fab7750f694dfa17303aad400f72')
  })

  test('021 is the only new migration and runs after 020', () => {
    const files = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => /^\d+_/.test(f)).sort()
    expect(files.slice(-2)).toEqual(['020_affiliates.sql', '021_financial_integrity.sql'])
  })

  test('forward-only and non-destructive: never rewrites or deletes economic rows', () => {
    const noComments = M021.replace(/--.*$/gm, '')
    // no DML against any economic table
    // The ONLY permitted economic-row DML is four narrow, audited, write-once/idempotent writers:
    //   void_expense_transaction / void_ad_spend (set voided_* only), the exchange shipping-cost
    //   writer, and the refund-fee-returned writer. No DELETE, no other column, no other table.
    const dml = [...noComments.matchAll(/\b(UPDATE|DELETE\s+FROM)\s+(orders|order_items|order_refunds|order_disputes|order_returns|order_exchanges|inventory_\w*|affiliate_\w*|expense_transactions|ad_spend|shipments)\b([^;]*)/gi)]
    expect(dml.every(m => m[1].toUpperCase() === 'UPDATE')).toBe(true)
    const sig = dml.map(m => `${m[2]}:${m[3].replace(/\s+/g, ' ').match(/SET\s+(\w+)/i)![1]}`).sort()
    expect(sig).toEqual([
      'ad_spend:voided_at', 'expense_transactions:voided_at',
      'order_exchanges:replacement_shipping_cost_cents', 'order_refunds:fee_refunded_cents',
    ])
    // the only DROP of data-bearing objects allowed is the obsolete function and triggers
    const drops = [...noComments.replace(/ON COMMIT DROP/gi, '').matchAll(/\bDROP\s+(\w+)/gi)].map(m => m[1].toUpperCase())
    for (const d of drops) expect(['FUNCTION', 'TRIGGER', 'TABLE']).toContain(d)
    expect(noComments).not.toMatch(/DROP\s+TABLE\s+(?!IF EXISTS pg_temp\.fi_now)/i)
    // TRUNCATE may appear only as a trigger event that BLOCKS it (BEFORE TRUNCATE ON ...), never as a statement
    expect(noComments).not.toMatch(/^\s*TRUNCATE\b/im)
    expect(noComments).not.toMatch(/ALTER\s+TABLE[^;]*DROP\s+COLUMN/i)
  })

  test('idempotent: every CREATE is guarded or OR REPLACE', () => {
    const noComments = M021.replace(/--.*$/gm, '')
    for (const m of noComments.matchAll(/\bCREATE\s+(OR REPLACE\s+)?(TABLE|INDEX|FUNCTION|TRIGGER|TYPE)\s+(IF NOT EXISTS\s+)?/gi)) {
      const kind = m[2].toUpperCase()
      if (kind === 'FUNCTION') expect(m[1]).toBeTruthy()
      else if (kind === 'TRIGGER') { /* preceded by DROP TRIGGER IF EXISTS, asserted below */ }
      else if (kind === 'TYPE') { /* wrapped in a pg_type existence check, asserted below */ }
      else expect(m[3]).toBeTruthy()
    }
    const triggers = [...noComments.matchAll(/CREATE\s+TRIGGER\s+(\w+)/gi)].map(m => m[1])
    expect(triggers.length).toBeGreaterThan(4)
    for (const t of triggers) expect(noComments).toMatch(new RegExp(`DROP TRIGGER IF EXISTS ${t}\\b`))
    expect(noComments).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'financial_integrity_finding'\)/)
  })

  test('is wrapped in one transaction', () => {
    const noComments = M021.replace(/--.*$/gm, '').trim()
    expect(noComments.startsWith('BEGIN;')).toBe(true)
    expect(noComments.endsWith('COMMIT;')).toBe(true)
  })

  test('issue codes are stable, well-formed and each means one thing', () => {
    const emitted = [...M021.matchAll(/fi_f\('([A-Z0-9_]+)','(exception|incomplete|advisory)','([a-z_]+)','([a-z_]+)'/g)]
    expect(emitted.length).toBeGreaterThan(60)
    const byCode = new Map<string, Set<string>>()
    for (const [, code, state, domain, entity] of emitted) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]+(_[A-Z0-9]+)+$/)
      const k = byCode.get(code) ?? new Set<string>()
      k.add(`${state}/${domain}/${entity}`); byCode.set(code, k)
    }
    // A code never changes class between branches (that would make its meaning ambiguous).
    for (const [code, variants] of byCode) {
      const states = new Set([...variants].map(v => v.split('/')[0]))
      expect({ code, states: states.size }).toEqual({ code, states: 1 })
    }
  })

  test('every action_path points at a real admin page', () => {
    const pages = new Set<string>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name === 'page.tsx') pages.add('/' + path.relative(path.join(ROOT, 'app'), dir).replace(/\\/g, '/'))
      }
    }
    walk(path.join(ROOT, 'app/admin'))
    const paths = new Set([...M021.matchAll(/'(\/admin[^']*)'/g)].map(m => m[1]))
    expect(paths.size).toBeGreaterThan(5)
    for (const p of paths) expect({ p, exists: pages.has(p) }).toEqual({ p, exists: true })
  })

  test('no hand-maintained status flag: findings are derived, history is separate', () => {
    expect(M021).not.toMatch(/ALTER TABLE\s+\w+\s+ADD COLUMN[^;]*reconcil/i)
    expect(M021).toMatch(/financial_integrity_events/)
    expect(M021).toMatch(/KVRN_INTEGRITY\|APPEND_ONLY/)
  })

  test('the obsolete 7-argument save_reservation_checkout_details is dropped by exact signature', () => {
    expect(M021).toMatch(/DROP FUNCTION IF EXISTS save_reservation_checkout_details\(\s*UUID, TEXT, TEXT, TEXT, JSONB, TEXT, INTEGER\s*\)/)
    // and the application only ever calls the long form
    const src = fs.readFileSync(path.join(ROOT, 'lib/reservations.ts'), 'utf8')
    const call = src.match(/save_reservation_checkout_details\(([\s\S]*?)\)\s*(?:AS|`|\n)/)
    expect(call).toBeTruthy()
    // 8+ positional parameters: the dropped overload had 7
    expect((call![1].match(/\$\{|\$\d+/g) ?? []).length).toBeGreaterThanOrEqual(8)
  })
})

describe('routes and surfaces', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

  test.each([
    'app/api/admin/financials/integrity/route.ts',
    'app/api/admin/financials/integrity/export/route.ts',
    'app/api/admin/financials/exchanges/[id]/shipping-cost/route.ts',
  ])('%s is admin-gated before any data access', (p) => {
    const src = read(p)
    expect(src).toMatch(/requireAdmin\(req\)/)
    expect(src.indexOf('requireAdmin(req)')).toBeLessThan(src.search(/\(sql\)|sql\.query|sql`/))
    expect(src).not.toMatch(/NextResponse\.json\(\{[^}]*err\.message/)   // no error text leakage
  })

  test('the integrity GET never writes; POST writes only through the recorder', () => {
    const src = read('app/api/admin/financials/integrity/route.ts')
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
    expect(src).toMatch(/recordRun\(identity!\.email/)
  })

  test('dashboard revenue is the canonical net revenue, not SUM(total_cents)', () => {
    const src = read('app/api/admin/dashboard/route.ts').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/SUM\(total_cents\)/)
    expect(src).toMatch(/getOrderEconomicsInRange/)
    expect(src).toMatch(/netRevenueCents/)
  })

  test('the Admin shell links to the reconciliation page', () => {
    expect(read('components/admin/AdminShell.tsx')).toContain("/admin/financials/integrity")
  })

  test('the summary route returns cash movement as its own object, apart from profit', () => {
    const src = read('app/api/admin/financials/summary/route.ts')
    expect(src).toMatch(/cashMovement/)
    expect(read('lib/financials.ts')).toMatch(/Recorded cash movement — not profit/)
  })
})

describe('integrity service over a stubbed driver', () => {
  const fake = (rows: Record<string, any[]>) => ({
    query: jest.fn(async (text: string) => {
      for (const [needle, r] of Object.entries(rows)) if (text.includes(needle)) return r
      return []
    }),
  }) as any

  test('overall verdict: any exception -> EXCEPTION; else any incomplete -> INCOMPLETE; else RECONCILED', async () => {
    const mk = (states: Array<[string, string, number]>) => createFinancialIntegrityService(fake({
      'financial_integrity_entity_states': states.map(([entity_type, state, n]) => ({ entity_type, state, n })),
      'financial_integrity_scan': [],
      'MAX(ran_at)': [{ last_run: null }],
    }))
    expect((await mk([['order', 'RECONCILED', 5]]).getSummary()).overall).toBe('RECONCILED')
    expect((await mk([['order', 'RECONCILED', 5], ['order', 'INCOMPLETE', 1]]).getSummary()).overall).toBe('INCOMPLETE')
    expect((await mk([['order', 'INCOMPLETE', 1], ['refund', 'EXCEPTION', 1]]).getSummary()).overall).toBe('EXCEPTION')
    const s = await mk([['order', 'RECONCILED', 5], ['order', 'INCOMPLETE', 2]]).getSummary()
    expect(s.entities).toEqual({ total: 7, reconciled: 5, incomplete: 2, exception: 0 })
    expect(s.lastRecordedRunAt).toBeNull()
  })

  test('filters are bound parameters, never interpolated', async () => {
    const sql = fake({})
    await createFinancialIntegrityService(sql).listFindings({ state: 'exception', issueCode: "X'; DROP TABLE orders;--" })
    const [text, params] = sql.query.mock.calls[0]
    expect(text).not.toContain('DROP TABLE')
    expect(params).toContain("X'; DROP TABLE orders;--")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PART B — real PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = `kvrn_fi_jest_${process.pid}`
let admin: Client
let db: Client
let sql: any
let pgFail: string | null = null

// Same convention as reservations.test.ts: DB tests run only when TEST_DATABASE_URL is
// set, and are visibly skipped otherwise. SAFETY: this suite CREATES and DROPS a
// throwaway database on that server, so it refuses anything that is not a local server
// (localhost / 127.0.0.1 / ::1 / a unix socket) — never point it at Neon or production.
const TEST_DB_URL = process.env.TEST_DATABASE_URL
function pgConfig(database: string) {
  // `postgresql://user@/db?host=/tmp` (unix socket) is not a valid WHATWG URL; give it a placeholder host.
  const u = new URL(TEST_DB_URL!.replace(/^(postgres(?:ql)?:\/\/(?:[^@/]*@)?)\//, '$1nohost.invalid/'))
  const host = u.searchParams.get('host') ?? (u.hostname === 'nohost.invalid' ? 'localhost' : u.hostname)
  const port = Number(u.port || u.searchParams.get('port') || 5432)
  return {
    host, port, database,
    user: decodeURIComponent(u.username) || 'postgres',
    password: u.password ? decodeURIComponent(u.password) : undefined,
    isLocal: host.startsWith('/') || ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(host),
  }
}
const HAVE_DB = (() => {
  try { return !!TEST_DB_URL && pgConfig('postgres').isLocal } catch { return false }
})()
const describeDB = HAVE_DB ? describe : describe.skip

if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: DB tests skipped — TEST_DATABASE_URL is not a local server (refusing to create databases elsewhere).'
    : 'NOTE: real-PostgreSQL integrity tests skipped — TEST_DATABASE_URL absent. Run them against a LOCAL throwaway server.', () => {
    expect(true).toBe(true)
  })
}

const V = 'f2100000-0000-0000-0000-00000000bbbb'
const day = (n: number) => `(date_trunc('day', now() AT TIME ZONE 'UTC') - interval '${n} days' + interval '12 hours') AT TIME ZONE 'UTC'`
const range = (n: number) => {
  const s = new Date(); s.setUTCHours(0, 0, 0, 0); s.setUTCDate(s.getUTCDate() - n)
  const e = new Date(s); e.setUTCDate(e.getUTCDate() + 1)
  return { start: s.toISOString(), end: e.toISOString() }
}
const oid = (n: number) => `f2110000-0000-0000-0000-${String(n).padStart(12, '0')}`
const q = (text: string, params: unknown[] = []) => db.query(text, params).then(r => r.rows)

async function mkOrder(n: number, o: { daysAgo?: number; fee?: number | null; label?: number | null; cogs?: number | null; consume?: boolean } = {}) {
  const { daysAgo = n, fee = 100, label = 450, cogs = 300, consume = true } = o
  const num = `FI-${String(n).padStart(3, '0')}`
  await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
      payment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,
      shipping_quoted_cents,shipping_before_discount_cents,stripe_fee_cents,stripe_fee_source,stripe_balance_transaction_id)
    VALUES ($1,$2,$3,$4,$5,'paid','usd',1000,500,0,0,1500,${day(daysAgo)},500,500,$6,$7,$8)`,
    [oid(n), num, 'cs_' + num, 'pi_' + num, 'ch_' + num, fee, fee === null ? null : 'stripe_api', fee === null ? null : 'txn_' + num])
  const item = (await q(`INSERT INTO order_items (order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents,unit_cogs_cents,line_cogs_cents)
    VALUES ($1,$2,'F21-M','F21','M','Black',1,1000,1000,$3,$3) RETURNING id`, [oid(n), V, cogs]))[0].id
  if (consume) {
    await q(`SELECT consume_inventory_fifo($1,1,'sale',NULL,$2,$3)`, [V, oid(n), item])
    await q(`UPDATE product_variants SET stock_on_hand = stock_on_hand - 1 WHERE id = $1`, [V])
  }
  if (label !== null) {
    await q(`INSERT INTO shipments (order_id,tracking_number,carrier,label_cost_cents,cost_source) VALUES ($1,$2,'usps',$3,'shippo_label')`,
      [oid(n), 'trk' + n, label])
  }
}

const refund = (n: number, id: string, cents: number) => q(
  `INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
     merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,component_breakdown_status,component_breakdown_source,status,refunded_at)
   VALUES ($1,$2,$3,$4,$5,$5,0,0,0,'resolved','admin','succeeded',now())`,
  [oid(n), id, 'ch_FI-' + String(n).padStart(3, '0'), 'pi_FI-' + String(n).padStart(3, '0'), cents])

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    const { isLocal: _a, ...adminCfg } = pgConfig('postgres')
    admin = new Client(adminCfg)
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${DB_NAME}`)
    const { isLocal: _b, ...dbCfg } = pgConfig(DB_NAME)
    db = new Client(dbCfg)
    await db.connect()
    const dir = path.join(ROOT, 'db/migrations')
    for (const f of fs.readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
      await db.query(fs.readFileSync(path.join(dir, f), 'utf8'))
    }
    sql = Object.assign(
      async (s: TemplateStringsArray, ...v: unknown[]) => {
        let t = ''; s.forEach((p, i) => { t += p; if (i < v.length) t += `$${i + 1}` })
        return (await db.query(t, v as any[])).rows
      },
      { query: async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows })

    await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
             VALUES ('f2100000-0000-0000-0000-00000000aaaa','F','F','F21','f21',1000,true)`)
    await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
             VALUES ($1,'f2100000-0000-0000-0000-00000000aaaa','F21-M','Black','#000','M',1,100)`, [V])
    await q(`SELECT add_inventory_layer($1,100,300,'purchase',NULL,NULL,'cost_batch','jest')`, [V])
  } catch (e: any) {
    pgFail = String(e?.message ?? e)
  }
}, 120_000)

afterAll(async () => {
  try { await db?.end() } catch { /* ignore */ }
  try { await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`); await admin?.end() } catch { /* ignore */ }
})

const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }

describeDB('canonical profit against the real SQL', () => {
  test('a fully known order: every term is read from its authoritative table', async () => {
    needDb()
    await mkOrder(1)
    const r = await createFinancialService(sql).getOrderEconomics(oid(1))
    const e = r!.economics
    expect(e.contributionProfitCents).toBe(1500 - 300 - 450 - 100)   // 650
    expect(e.reconciliation.missing).toEqual([])
  })

  test('unknown Stripe fee / unknown COGS / missing label => profit is null, not zero', async () => {
    needDb()
    await mkOrder(2, { fee: null })
    await mkOrder(3, { cogs: null, consume: false })
    await mkOrder(4, { label: null })
    const svc = createFinancialService(sql)
    for (const [n, field] of [[2, 'stripe_fee'], [3, 'cogs'], [4, 'shipping_cost']] as const) {
      const e = (await svc.getOrderEconomics(oid(n)))!.economics
      expect(e.contributionProfitCents).toBeNull()
      expect(e.reconciliation.missing.map(m => m.field)).toContain(field)
    }
  })

  test('refund + lost dispute on the same money: loss is capped, never double reversed', async () => {
    needDb()
    await mkOrder(5)
    await q(`SELECT upsert_order_dispute('du_fi5','ch_FI-005','pi_FI-005',1500,'usd','lost','lost','evt_fi5','charge.dispute.closed',now(),now()-interval '10 days','{}'::jsonb)`)
    await q(`INSERT INTO dispute_balance_transactions (dispute_id,stripe_balance_transaction_id,amount_cents,fee_cents,net_cents)
             SELECT id,'txn_du_fi5',-1500,1500,-3000 FROM order_disputes WHERE stripe_dispute_id='du_fi5'`)
    await refund(5, 're_fi5', 500)            // refund AFTER the dispute: the frozen-offset gap
    const e = (await createFinancialService(sql).getOrderEconomics(oid(5)))!.economics
    expect(e.disputeLossCents).toBe(1000)
    expect(e.disputeRefundOverlapCents).toBe(500)
    expect(e.netRevenueCents).toBe(0)
    expect(e.disputeFeeCents).toBe(1500)
    expect(e.contributionProfitCents).toBe(0 - 300 - 450 - 100 - 1500)
    // ...and the integrity scan reports the same overlap as an exception
    const f = await createFinancialIntegrityService(sql).listFindings({ issueCode: 'DISPUTE_REFUND_OVERLAP_DOUBLE_COUNTED' })
    expect(f).toHaveLength(1)
    expect(f[0].state).toBe('exception')
  })

  test('a dispute with no balance transaction has an UNKNOWN fee', async () => {
    needDb()
    await mkOrder(6)
    await q(`SELECT upsert_order_dispute('du_fi6','ch_FI-006','pi_FI-006',1500,'usd','under_review','under_review','evt_fi6','charge.dispute.created',now(),now(),'{}'::jsonb)`)
    const e = (await createFinancialService(sql).getOrderEconomics(oid(6)))!.economics
    expect(e.disputeFeeCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
    expect(e.reconciliation.missing.map(m => m.field)).toContain('dispute_fee')
  })

  test('affiliate commission is an EXPENSE from the ledger; paying it out changes cash, not profit', async () => {
    needDb()
    const aid = (await q(`SELECT (create_affiliate('FIA','FI Aff',NULL::text,'percentage',1000,NULL::integer,'proportional',30,0,NULL::uuid,NULL::text,'admin')->>'affiliate_id') AS id`))[0].id
    await q(`UPDATE affiliates SET created_at = now()-interval '365 days' WHERE id=$1`, [aid])
    await q(`UPDATE affiliate_terms_events SET effective_at = now()-interval '365 days' WHERE affiliate_id=$1`, [aid])
    await q(`UPDATE affiliate_status_events SET effective_at = now()-interval '365 days' WHERE affiliate_id=$1`, [aid])
    await mkOrder(7)
    await q(`UPDATE orders SET discount_code='FIA' WHERE id=$1`, [oid(7)])
    await q(`SELECT resolve_order_affiliate_attribution($1,NULL,'s')`, [oid(7)])
    const svc = createFinancialService(sql)
    const before = (await svc.getOrderEconomics(oid(7)))!.economics
    expect(before.affiliateCommissionCents).toBe(100)
    expect(before.contributionProfitCents).toBe(650 - 100)

    const cid = (await q(`SELECT id FROM affiliate_commissions WHERE order_id=$1`, [oid(7)]))[0].id
    await q(`SELECT refresh_affiliate_commission_state($1)`, [cid])
    const pid = (await q(`SELECT create_affiliate_payout($1,ARRAY[$2::uuid],'admin')->>'payout_id' AS id`, [aid, cid]))[0].id
    await q(`SELECT mark_affiliate_payout_paid($1,now(),'ach','ref','admin')`, [pid])
    const after = (await svc.getOrderEconomics(oid(7)))!.economics
    expect(after.contributionProfitCents).toBe(before.contributionProfitCents)   // payout is cash, not a second expense
    const cash = await svc.getRecordedCashMovement({ start: new Date(Date.now() - 864e5).toISOString(), end: new Date(Date.now() + 864e5).toISOString() })
    expect(cash.affiliatePayoutsPaidCents).toBe(100)
    expect(cash.isComplete).toBe(false)
    expect(cash.label).toMatch(/not profit/)
    expect(cash.notIncluded.length).toBeGreaterThan(0)
  })

  test('a shipped exchange with no recorded carrier cost is unknown; the writer fixes it once', async () => {
    needDb()
    await mkOrder(8)
    await q(`INSERT INTO order_exchanges (id,order_id,exchange_number,status,shipped_at)
             VALUES ('f2130000-0000-0000-0000-0000000000f8',$1,'EX-FI-8','shipped',now())`, [oid(8)])
    const svc = createFinancialService(sql)
    let e = (await svc.getOrderEconomics(oid(8)))!.economics
    expect(e.exchangeShippingCostCents).toBeNull()
    expect(e.contributionProfitCents).toBeNull()
    await q(`SELECT record_exchange_replacement_shipping_cost('f2130000-0000-0000-0000-0000000000f8',650,'jest')`)
    e = (await svc.getOrderEconomics(oid(8)))!.economics
    expect(e.exchangeShippingCostCents).toBe(650)
    expect(e.contributionProfitCents).toBe(650 - 650)
  })

  test('period report: exact profit only when nothing is unknown; known-so-far otherwise', async () => {
    needDb()
    const svc = createFinancialService(sql)
    const exact = await svc.getPeriodReport(range(1))              // order 1 only
    expect(exact.period.canonicalOperatingProfitCents).toBe(650)
    expect(exact.period.profitCompleteness).toBe('complete')
    const partial = await svc.getPeriodReport(range(2))            // order 2: fee unknown
    expect(partial.period.canonicalOperatingProfitCents).toBeNull()
    expect(partial.period.contributionProfitCents).toBe(1500 - 300 - 450)   // known-so-far ceiling
    expect(partial.period.profitCompleteness).toBe('incomplete')
  })

  test('chart buckets add up to the headline period figure exactly', async () => {
    needDb()
    const svc = createFinancialService(sql)
    const r = { start: range(10).start, end: range(0).end }
    const [period, series] = await Promise.all([svc.getPeriodReport(r), svc.getFinancialTimeSeries(r, 'day')])
    const sum = (k: string) => series.buckets.reduce((s: number, b: any) => s + b[k], 0)
    expect(sum('netRevenueCents')).toBe(period.period.netRevenueCents)
    expect(sum('contributionProfitCents')).toBe(period.period.contributionProfitCents)
    expect(sum('realizedProfitCents')).toBe(period.period.realizedProfitAfterDevelopmentCents)
    expect(series.buckets.some((b: any) => b.isPartial)).toBe(true)
  })

  test('write-offs are recognised by their own date and unknown cost is never zero', async () => {
    needDb()
    const svc = createFinancialService(sql)
    const win = { start: new Date(Date.now() - 864e5).toISOString(), end: new Date(Date.now() + 864e5).toISOString() }
    const before = await svc.getWriteOffCostInRange(win)
    await q(`SELECT record_inventory_write_off($1,2,'damaged','jest','jest')`, [V])
    const after = await svc.getWriteOffCostInRange(win)
    expect(after.costCents - before.costCents).toBe(600)
    expect(after.unknown).toBe(false)
    // A variant whose ONLY stock has unknown cost: writing it off must not become a $0 loss.
    const V2 = 'f2100000-0000-0000-0000-00000000bbb2'
    await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
             VALUES ($1,'f2100000-0000-0000-0000-00000000aaaa','F21-L','Black','#000','L',2,3)`, [V2])
    await q(`SELECT add_inventory_layer($1,3,NULL,'opening_balance',NULL,NULL,'unknown','jest')`, [V2])
    const known = (await svc.getWriteOffCostInRange(win)).costCents
    await q(`SELECT record_inventory_write_off($1,2,'lost','jest','jest')`, [V2])
    const unk = await svc.getWriteOffCostInRange(win)
    expect(unk.unknown).toBe(true)
    expect(unk.costCents).toBe(known)                       // unknown adds nothing to the known floor
    const f = await createFinancialIntegrityService(sql).listFindings({ issueCode: 'WRITE_OFF_COST_UNKNOWN' })
    expect(f.length).toBe(1)
    expect(f[0].state).toBe('incomplete')
    const { period } = await svc.getPeriodReport(win)
    expect(period.isPartial).toBe(true)
    expect(period.canonicalOperatingProfitCents).toBeNull()      // unknown is never zero
  })
})

describeDB('integrity layer against the real SQL', () => {
  test('summary, findings and the export agree with each other', async () => {
    needDb()
    const svc = createFinancialIntegrityService(sql)
    const [summary, findings] = await Promise.all([svc.getSummary(), svc.listFindings({ limit: 5000 })])
    expect(summary.findings.exception + summary.findings.incomplete + summary.findings.advisory).toBe(findings.length)
    expect(summary.overall).toBe('EXCEPTION')            // the overlap scenario above
    expect(summary.entities.total).toBeGreaterThan(0)
    expect(summary.entities.exception + summary.entities.incomplete + summary.entities.reconciled).toBe(summary.entities.total)

    const csv = findingsToCsv(findings, summary.scannedAt)
    const rows = csv.trim().split('\r\n')
    expect(rows).toHaveLength(findings.length + 1)
    // one row per finding, same order, same codes
    expect(rows.slice(1).map(r => r.split(',')[1])).toEqual(findings.map(f => f.issueCode))
  })

  test('severity ordering: exceptions first, then incomplete, then advisory', async () => {
    needDb()
    const f = await createFinancialIntegrityService(sql).listFindings({ limit: 5000 })
    const rank = { exception: 0, incomplete: 1, advisory: 2 } as const
    for (let i = 1; i < f.length; i++) expect(rank[f[i].state]).toBeGreaterThanOrEqual(rank[f[i - 1].state])
  })

  test('recording a run is append-only, idempotent on unchanged data, and resolves on correction', async () => {
    needDb()
    const svc = createFinancialIntegrityService(sql)
    const r1 = await svc.recordRun('jest', 'manual')
    expect(r1.new_count).toBeGreaterThan(0)
    const r2 = await svc.recordRun('jest', 'manual')
    expect([r2.new_count, r2.changed_count, r2.resolved_count]).toEqual([0, 0, 0])

    // fix the refund overlap by removing the cause is NOT allowed (history), so resolve a different one:
    // supply the missing label cost on order 4 -> its finding resolves.
    await q(`INSERT INTO shipments (order_id,tracking_number,carrier,label_cost_cents,cost_source) VALUES ($1,'fix4','usps',450,'shippo_label')`, [oid(4)])
    const r3 = await svc.recordRun('jest', 'manual')
    expect(r3.resolved_count).toBeGreaterThanOrEqual(1)
    const live = await svc.listFindings({ issueCode: 'ORDER_SHIPPING_COST_MISSING', limit: 100 })
    expect(live.find(f => f.entityId === oid(4))).toBeUndefined()

    await expect(q(`UPDATE financial_integrity_events SET state='advisory'`)).rejects.toThrow(/APPEND_ONLY/)
    await expect(q(`DELETE FROM financial_integrity_runs`)).rejects.toThrow(/APPEND_ONLY/)
    const hist = await svc.getHistory(10)
    expect(hist.runs.length).toBeGreaterThanOrEqual(3)
  })

  test('every current finding carries a first-detected time once a run was recorded', async () => {
    needDb()
    const f = await createFinancialIntegrityService(sql).listFindings({ limit: 5000 })
    expect(f.length).toBeGreaterThan(0)
    expect(f.every(x => x.detectedAt !== null)).toBe(true)
  })

  test('the scan changes no economic row', async () => {
    needDb()
    const digest = async () => (await q(`SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
      SELECT o::text AS x FROM orders o UNION ALL SELECT i::text FROM order_items i
      UNION ALL SELECT r::text FROM order_refunds r UNION ALL SELECT d::text FROM order_disputes d
      UNION ALL SELECT c::text FROM inventory_layer_consumptions c) t`))[0].h
    const a = await digest()
    await createFinancialIntegrityService(sql).getSummary()
    await createFinancialIntegrityService(sql).listFindings({ limit: 5000 })
    expect(await digest()).toBe(a)
  })

  test('re-applying migration 021 changes neither the scan nor existing history', async () => {
    needDb()
    const scan = async () => (await q(`SELECT md5(string_agg(t::text,'|' ORDER BY t::text)) AS h FROM financial_integrity_scan() t`))[0].h
    const hist = async () => (await q(`SELECT count(*)::int AS n FROM financial_integrity_events`))[0].n
    const [s1, h1] = [await scan(), await hist()]
    for (let i = 0; i < 2; i++) await db.query(M021)
    expect([await scan(), await hist()]).toEqual([s1, h1])
  })
})
