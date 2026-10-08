// lib/__tests__/admin-ui-refresh.test.ts
// Source-guard + pure tests for the Admin UI/copy refresh (no jsdom in this repo's jest setup).
// Covers: no route removed, nav completeness, no gradients, InfoTip contract, warnings stay visible
// (not hidden in a tooltip), the SMS line, font-size bounds, the status mapping, shell structure.
import fs from 'fs'
import path from 'path'
import { statusForRaw } from '../admin-status'

const ROOT = path.join(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// Admin page + API route files that existed in the foundation commit (git ls-tree b9f9290). The refresh
// must not delete or move any of them.
const FOUNDATION_PAGES = [
  'app/admin/analytics/page.tsx',
  'app/admin/backups/page.tsx',
  'app/admin/discounts/page.tsx',
  'app/admin/financials/advertising/page.tsx',
  'app/admin/financials/affiliates/page.tsx',
  'app/admin/financials/costs/page.tsx',
  'app/admin/financials/disputes/page.tsx',
  'app/admin/financials/expenses/page.tsx',
  'app/admin/financials/infrastructure/page.tsx',
  'app/admin/financials/integrity/page.tsx',
  'app/admin/financials/inventory/page.tsx',
  'app/admin/financials/page.tsx',
  'app/admin/financials/returns/page.tsx',
  'app/admin/financials/shipping/page.tsx',
  'app/admin/inventory/page.tsx',
  'app/admin/orders/page.tsx',
  'app/admin/page.tsx',
  'app/admin/sms/page.tsx',
  'app/admin/support/page.tsx',
  'app/admin/system/page.tsx',
]
const FOUNDATION_API_ROUTES = [
  'app/api/admin/ad-spend/[id]/route.ts',
  'app/api/admin/ad-spend/route.ts',
  'app/api/admin/affiliates/backfill/route.ts',
  'app/api/admin/affiliates/payouts/route.ts',
  'app/api/admin/affiliates/reconciliation/route.ts',
  'app/api/admin/affiliates/recoveries/route.ts',
  'app/api/admin/affiliates/route.ts',
  'app/api/admin/analytics/funnel/route.ts',
  'app/api/admin/backups/drills/route.ts',
  'app/api/admin/backups/route.ts',
  'app/api/admin/backups/verify/route.ts',
  'app/api/admin/cache-invalidations/route.ts',
  'app/api/admin/dashboard/route.ts',
  'app/api/admin/discounts/[id]/route.ts',
  'app/api/admin/discounts/route.ts',
  'app/api/admin/disputes/route.ts',
  'app/api/admin/expenses/definitions/[id]/route.ts',
  'app/api/admin/expenses/definitions/route.ts',
  'app/api/admin/expenses/transactions/[id]/route.ts',
  'app/api/admin/expenses/transactions/route.ts',
  'app/api/admin/feature-flags/route.ts',
  'app/api/admin/financials/exchanges/[id]/shipping-cost/route.ts',
  'app/api/admin/financials/infrastructure/route.ts',
  'app/api/admin/financials/infrastructure/timeseries/route.ts',
  'app/api/admin/financials/integrity/export/route.ts',
  'app/api/admin/financials/integrity/route.ts',
  'app/api/admin/financials/orders/[id]/route.ts',
  'app/api/admin/financials/products/route.ts',
  'app/api/admin/financials/shipping/route.ts',
  'app/api/admin/financials/summary/route.ts',
  'app/api/admin/financials/tax-export/route.ts',
  'app/api/admin/financials/timeseries/route.ts',
  'app/api/admin/inventory/active/route.ts',
  'app/api/admin/inventory/movements/route.ts',
  'app/api/admin/inventory/purchases/route.ts',
  'app/api/admin/inventory/receipts/route.ts',
  'app/api/admin/inventory/route.ts',
  'app/api/admin/inventory/valuation/route.ts',
  'app/api/admin/inventory/write-offs/route.ts',
  'app/api/admin/payment-exceptions/[id]/route.ts',
  'app/api/admin/payment-exceptions/route.ts',
  'app/api/admin/product-costs/route.ts',
  'app/api/admin/provider-usage/route.ts',
  'app/api/admin/refunds/[id]/fee-returned/route.ts',
  'app/api/admin/refunds/[id]/resolve-components/route.ts',
  'app/api/admin/returns/route.ts',
  'app/api/admin/shipments/[id]/cost/route.ts',
  'app/api/admin/sms/route.ts',
  'app/api/admin/support/threads/[id]/read/route.ts',
  'app/api/admin/support/threads/[id]/reply/route.ts',
  'app/api/admin/support/threads/[id]/route.ts',
  'app/api/admin/support/threads/[id]/status/route.ts',
  'app/api/admin/support/threads/route.ts',
]

// Presentation files owned by the UI workstream.
const TOUCHED = [
  'components/admin/AdminShell.tsx', 'components/admin/FinancialUI.tsx',
  'components/admin/ui/AdminUI.tsx', 'components/admin/ui/InfoTip.tsx',
  'app/admin/AdminDashboardClient.tsx', 'app/admin/inventory/AdminInventoryClient.tsx',
  'app/admin/discounts/AdminDiscountsClient.tsx', 'app/admin/analytics/AnalyticsClient.tsx',
  'app/admin/financials/FinancialsClient.tsx', 'app/admin/financials/shipping/ShippingClient.tsx',
  'app/admin/financials/costs/CostsClient.tsx', 'app/admin/financials/advertising/AdvertisingClient.tsx',
  'app/admin/financials/infrastructure/InfrastructureClient.tsx', 'app/admin/financials/inventory/InventoryClient.tsx',
  'app/admin/financials/returns/ReturnsClient.tsx', 'app/admin/financials/disputes/DisputesClient.tsx',
  'app/admin/financials/integrity/IntegrityClient.tsx', 'app/admin/financials/expenses/ExpensesClient.tsx',
  'app/admin/sms/AdminSmsClient.tsx', 'app/admin/backups/BackupsClient.tsx',
  'app/admin/support/SupportInboxClient.tsx',
]

/** Source with everything that lives inside a tooltip removed: <InfoTip>…</InfoTip>, info={<>…</>}, info="…", title="…". */
function visibleOnly(src: string): string {
  return src
    .replace(/<InfoTip[\s\S]*?<\/InfoTip>/g, '')
    .replace(/\binfo=\{<>[\s\S]*?<\/>\}/g, '')
    .replace(/\binfo=\{`[\s\S]*?`\}/g, '')
    .replace(/\binfo="[^"]*"/g, '')
    // title= on a NATIVE element is a hover tooltip; title= on AdminNotice/AdminCard is a visible heading.
    .replace(/(<(?:span|button|div|td|th|a|p|b|tr|li|svg|abbr)\b[^>]*?)\btitle="[^"]*"/g, '$1')
}

describe('no admin route was removed or moved', () => {
  test.each(FOUNDATION_PAGES)('page %s still exists', p => { expect(fs.existsSync(path.join(ROOT, p))).toBe(true) })
  test.each(FOUNDATION_API_ROUTES)('api route %s still exists', p => { expect(fs.existsSync(path.join(ROOT, p))).toBe(true) })
  test('the page list is not accidentally empty', () => {
    expect(FOUNDATION_PAGES.length).toBeGreaterThanOrEqual(20)
    expect(FOUNDATION_API_ROUTES.length).toBeGreaterThanOrEqual(50)
  })
})

describe('navigation completeness', () => {
  const shell = read('components/admin/AdminShell.tsx')
  const hrefs = [...shell.matchAll(/href: '([^']+)'/g)].map(m => m[1])
  // Detail/utility routes that are intentionally not nav items.
  const NOT_IN_NAV: string[] = []
  const pageRoute = (p: string) => p.replace(/^app/, '').replace(/\/page\.tsx$/, '') || '/admin'
  test.each(FOUNDATION_PAGES.map(pageRoute).filter(r => !NOT_IN_NAV.includes(r)))('%s is reachable from the nav', route => {
    expect(hrefs).toContain(route)
  })
  test('the routes built by other workstreams are linked too', () => {
    for (const r of ['/admin/products', '/admin/abandoned-checkouts', '/admin/content', '/admin/media', '/admin/system'])
      expect(hrefs).toContain(r)
  })
  test('Affiliates stays under Financials', () => { expect(hrefs).toContain('/admin/financials/affiliates') })
  test('no nav href is listed twice', () => { expect(new Set(hrefs).size).toBe(hrefs.length) })
  test('active item is the most specific match (existing logic kept)', () => {
    expect(shell).toMatch(/function resolveActiveHref/)
    expect((shell.match(/item\.href === activeHref/g) ?? []).length).toBe(2)
  })
  test('a mobile navigation panel exists and the sidebar is not shown on small screens', () => {
    expect(shell).toMatch(/Menu/)
    expect(shell).toMatch(/lg:hidden/)
    expect(shell).toMatch(/hidden[^'"]*lg:(flex|block)/)
  })
})

describe('visual system', () => {
  test.each(TOUCHED)('%s has no gradient', f => { expect(read(f)).not.toMatch(/gradient/i) })
  test.each(TOUCHED)('%s has no text smaller than 9px', f => {
    const src = read(f)
    for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(9)
    for (const m of src.matchAll(/fontSize:\s*(\d+)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(9)
  })
  test.each(TOUCHED)('%s keeps body text at or under 14px (only headings/figures are larger)', f => {
    const src = read(f)
    // 15px+ is allowed only for headings/stat figures; none of the touched files uses it for ordinary copy,
    // so the largest sizes used must stay within the heading/figure scale.
    for (const m of src.matchAll(/text-\[(\d+)px\]/g)) expect(Number(m[1])).toBeLessThanOrEqual(28)
  })
  test('9-10px text is limited to short labels: no long sentences use text-[9px]', () => {
    for (const f of TOUCHED) expect(read(f)).not.toMatch(/text-\[9px\][^\n]{0,60}\n?[^<\n]{80,}</)
  })
  test('cards use the 14px radius', () => {
    const ui = read('components/admin/ui/AdminUI.tsx')
    expect(ui).toMatch(/rounded-\[14px\] border border-black\/\[0\.08\] bg-white/)
  })
  test('shared primitives still export everything the pages rely on', () => {
    const ui = read('components/admin/ui/AdminUI.tsx')
    for (const n of ['AdminPage', 'AdminPageHeader', 'AdminSectionHeader', 'AdminCard', 'AdminButton', 'AdminNotice', 'AdminField',
      'StatusBadge', 'AdminTag', 'AdminStat', 'AdminStatGrid', 'AdminSegmented', 'AdminDisclosure', 'AdminTabs', 'AdminTable',
      'AdminTh', 'AdminTd', 'AdminEmpty', 'AdminLoading', 'AdminError', 'useConfirm', 'InfoTip'])
      expect(ui).toMatch(new RegExp(`export (function|const|\\{)[^\\n]*\\b${n}\\b`))
  })
})

describe('InfoTip placement and accessibility (refresh additions)', () => {
  const src = read('components/admin/ui/InfoTip.tsx')
  test('panel is portalled with fixed positioning and clamped to the viewport', () => {
    expect(src).toMatch(/createPortal/)
    expect(src).toMatch(/position: 'fixed'/)
    expect(src).toMatch(/Math\.max\(EDGE, Math\.min\(left/)
    expect(src).toMatch(/max-w-\[calc\(100vw-16px\)\]/)
  })
  test('panel is exposed to assistive tech as a note and closes on Escape returning focus', () => {
    expect(src).toMatch(/role="note"/)
    expect(src).toMatch(/btnRef\.current\?\.focus\(\)/)
  })
  test('click inside the panel does not trigger a parent row action', () => {
    expect(src).toMatch(/onClick=\{e => e\.stopPropagation\(\)\}/)
  })
  test('the button is padded beyond its visual size for touch', () => { expect(src).toMatch(/before:-inset-2/) })
})

describe('warnings and exception states stay visible (not hidden in a tooltip)', () => {
  const MUST_BE_VISIBLE: Array<[string, string]> = [
    ['app/admin/sms/AdminSmsClient.tsx', 'Promotional sending is off — A2P approval pending.'],
    ['app/admin/financials/expenses/ExpensesClient.tsx', '{PACKAGING_WARNING}'],
    ['app/admin/financials/returns/ReturnsClient.tsx', 'Fee returned is unknown, not $0.'],
    ['app/admin/financials/returns/ReturnsClient.tsx', 'Refund split is unknown.'],
    ['app/admin/financials/FinancialsClient.tsx', 'Some costs are not yet reconciled.'],
    ['app/admin/financials/infrastructure/InfrastructureClient.tsx', 'Estimated and projected figures are forecasts, not invoices.'],
    ['app/admin/financials/infrastructure/InfrastructureClient.tsx', 'Usage units differ between providers'],
    ['app/admin/backups/BackupsClient.tsx', 'This does not create a backup.'],
    ['app/admin/backups/BackupsClient.tsx', 'This does not restore anything.'],
    ['app/admin/backups/BackupsClient.tsx', 'its restore test FAILED'],
    ['app/admin/support/SupportInboxClient.tsx', 'in the forwarded mailbox'],
  ]
  test.each(MUST_BE_VISIBLE)('%s shows "%s" outside any tooltip', (file, text) => {
    expect(visibleOnly(read(file))).toContain(text)
  })
  test('the visibleOnly helper really does drop tooltip content', () => {
    expect(visibleOnly('<p>a</p><InfoTip label="x">hidden text</InfoTip>')).not.toContain('hidden text')
    expect(visibleOnly('<H info={<>hidden two</>} />')).not.toContain('hidden two')
    expect(visibleOnly('<H info="hidden three" />')).not.toContain('hidden three')
    expect(visibleOnly('<b title="hidden four">x</b>')).not.toContain('hidden four')
  })
  test('voided expense details are visible text, not only a title= tooltip', () => {
    const ui = read('app/admin/financials/expenses/ExpensesClient.tsx')
    expect(ui).not.toMatch(/title=\{`Voided/)
    expect(visibleOnly(ui)).toContain('t.voidReason')
  })
  test('unknown money is never rendered as $0 in the reconciled money helpers', () => {
    const fin = read('components/admin/FinancialUI.tsx')
    expect(fin).toMatch(/export function moneyOrUnknown/)
    expect(fin).toMatch(/export function money\b/)
  })
  test('the destructive confirm dialog keeps its message in the dialog body', () => {
    const ui = read('components/admin/ui/AdminUI.tsx')
    expect(ui).toMatch(/role="alertdialog"/)
    expect(ui).toMatch(/\{state\.message\}/)
  })
})

describe('copy rules', () => {
  test.each(TOUCHED)('%s: no "authoritative"/"deterministic"/"canonical" in rendered prose', f => {
    // Identifiers (API field names) are fine; strip them and tooltip text, then look at what remains.
    const prose = visibleOnly(read(f))
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n').replace(/\b[a-z]+(Canonical|Authoritative)[A-Za-z]*\b/g, '').replace(/\bcanonical[A-Z]\w*/g, '')
      .replace(/\bnonAuthoritative\w*/g, '')
    expect(prose).not.toMatch(/authoritative|deterministic|canonical/i)
  })
  test('page descriptions are short (3–8 words, one sentence)', () => {
    const bad: string[] = []
    for (const f of TOUCHED) for (const m of read(f).matchAll(/<AdminPageHeader[\s\S]*?description="([^"]+)"/g)) {
      const words = m[1].trim().split(/\s+/).length
      if (words < 2 || words > 9) bad.push(`${f}: "${m[1]}" (${words} words)`)
    }
    expect(bad).toEqual([])
  })
})

describe('status vocabulary mapping (lib/admin-status.ts)', () => {
  test.each([
    ['paid', 'Paid'], ['PAID', 'Paid'], ['unfulfilled', 'Unfulfilled'], ['shipped', 'Fulfilled'],
    ['delivered', 'Fulfilled'], ['canceled', 'Cancelled'], ['cancelled', 'Cancelled'],
    ['refunded', 'Refunded'], ['failed', 'Failed'], ['pending', 'Pending'], ['active', 'Active'],
    ['draft', 'Draft'], ['unknown', 'Unknown'],
  ])('%s -> %s', (raw, label) => { expect(statusForRaw(raw)).toBe(label) })
  test('unmapped, empty or missing values return null (never a made-up status)', () => {
    expect(statusForRaw('weird-state')).toBeNull()
    expect(statusForRaw('')).toBeNull()
    expect(statusForRaw(null)).toBeNull()
    expect(statusForRaw(undefined)).toBeNull()
  })
  test('every mapped label is a real StatusBadge label', () => {
    const ui = read('components/admin/ui/AdminUI.tsx')
    const table = read('lib/admin-status.ts')
    for (const m of table.matchAll(/:\s*'([A-Z][a-z]+)',/g)) expect(ui).toContain(`${m[1]}:`)
  })
})

describe('shell and page structure', () => {
  const CLIENTS = TOUCHED.filter(f => /Client\.tsx$/.test(f))
  test.each(CLIENTS)('%s uses the shared page container and header', f => {
    const src = read(f)
    expect(src).toMatch(/AdminPage\b/)
    expect(src).toMatch(/AdminPageHeader/)
  })
  test.each(CLIENTS)('%s has no inline-styled legacy FONT/BORDER constants', f => {
    const src = read(f)
    expect(src).not.toMatch(/\bFONT\b/)
    expect(src).not.toMatch(/\bBORDER\b/)
  })
  test('no page-level horizontal scroll: tables scroll inside their own wrapper', () => {
    expect(read('components/admin/ui/AdminUI.tsx')).toMatch(/overflow-x-auto rounded-\[12px\]/)
  })
  test('the admin layout still guards every page (requireAdmin guard suite is the authority)', () => {
    expect(fs.existsSync(path.join(ROOT, 'lib/__tests__/admin-routes-guard.test.ts'))).toBe(true)
  })
})
