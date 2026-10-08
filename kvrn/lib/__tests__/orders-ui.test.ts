/** @jest-environment node */
// Orders page refresh: pure display helpers + source guards (no jsdom in this repo).
import fs from 'fs'
import path from 'path'
import {
  paymentBadge, fulfillmentBadge, riskBadge, holdBadge, reviewBadge, listFraudBadge,
  checkLabel, threeDSLabel, countryLabel, eventLabel, holdNotAppliedWhy, tagChipClass, CANCEL_WARNING, TAG_CHIP_CLASSES,
} from '@/app/admin/orders/orders-ui'

const root = path.join(__dirname, '..', '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
// AdminUI is TSX (no jsdom/JSX transform here): read the vocabulary from source.
const toneBlock = read('components/admin/ui/AdminUI.tsx').match(/export const STATUS_TONES = \{([\s\S]*?)\} as const/)![1]
const VOCAB = Array.from(toneBlock.matchAll(/\b([A-Z][A-Za-z]+):\s*'/g)).map(m => m[1])

describe('status vocabulary', () => {
  it('vocabulary parsed from AdminUI', () => { expect(VOCAB).toEqual(expect.arrayContaining(['Held', 'Review', 'Released', 'Unknown', 'Exception'])) })
  const specs = [
    ...['paid', 'pending', 'failed', 'refunded', 'weird'].map(paymentBadge),
    ...['unfulfilled', 'processing', 'shipped', 'delivered', 'cancelled', 'weird'].map(fulfillmentBadge),
    riskBadge({ hasRecord: false, riskLevel: null }),
    ...(['normal', 'elevated', 'highest', 'not_assessed'] as const).map(l => riskBadge({ hasRecord: true, riskLevel: l })),
    holdBadge('none'), holdBadge('active'), holdBadge('released'),
    reviewBadge(null),
  ]
  it('every badge uses a label from the shared vocabulary', () => {
    for (const s of specs) expect(VOCAB).toContain(s.status)
  })
  it('unknown values are Unknown, not a success state', () => {
    expect(paymentBadge('weird').status).toBe('Unknown')
    expect(fulfillmentBadge('weird').status).toBe('Unknown')
  })
  it('shipped/delivered are Fulfilled with an explicit label', () => {
    expect(fulfillmentBadge('shipped')).toEqual({ status: 'Fulfilled', label: 'Shipped' })
    expect(fulfillmentBadge('delivered').label).toBe('Delivered')
  })
})

describe('fraud wording: unknown is never normal or zero', () => {
  it('no record or null level is Unknown', () => {
    expect(riskBadge({ hasRecord: false, riskLevel: null }).status).toBe('Unknown')
    expect(riskBadge({ hasRecord: true, riskLevel: null }).status).toBe('Unknown')
    expect(riskBadge({ hasRecord: true, riskLevel: 'not_assessed' }).status).toBe('Unknown')
  })
  it('levels map to distinct tones', () => {
    expect(riskBadge({ hasRecord: true, riskLevel: 'normal' }).status).toBe('Verified')
    expect(riskBadge({ hasRecord: true, riskLevel: 'elevated' }).status).toBe('Review')
    expect(riskBadge({ hasRecord: true, riskLevel: 'highest' }).status).toBe('Exception')
  })
  it('hold + review badges', () => {
    expect(holdBadge('active').status).toBe('Held')
    expect(holdBadge('released').status).toBe('Released')
    expect(reviewBadge({ state: 'open' } as any).label).toBe('Open')
    expect(reviewBadge({ state: 'closed' } as any).status).toBe('Resolved')
  })
  it('checks / 3DS / country default to Unknown, never Pass', () => {
    expect(checkLabel(null)).toBe('Unknown')
    expect(checkLabel('pass')).toBe('Pass')
    expect(checkLabel('fail')).toBe('Fail')
    expect(threeDSLabel(null)).toBe('Unknown')
    expect(threeDSLabel({ used: false, result: null } as any)).toBe('Not used')
    expect(countryLabel(null)).toBe('Unknown')
  })
  it('list indicator: held > flagged > sync error > nothing', () => {
    expect(listFraudBadge(null)).toBeNull()
    expect(listFraudBadge({ hold: 'none', flagged: false, syncError: false })).toBeNull()
    expect(listFraudBadge({ hold: 'active', flagged: true, syncError: true })?.status).toBe('Held')
    expect(listFraudBadge({ hold: 'none', flagged: true, syncError: false })?.label).toBe('Flagged')
    expect(listFraudBadge({ hold: 'none', flagged: false, syncError: true })?.label).toBe('Risk unknown')
    expect(listFraudBadge({ hold: 'released', flagged: true, syncError: false })).toBeNull()
  })
  it('event labels and hold-not-applied reasons', () => {
    expect(eventLabel('hold_created')).toBe('Hold created')
    expect(eventLabel('zzz')).toBe('Update')
    expect(holdNotAppliedWhy('holds_disabled')).toMatch(/switched off/)
    expect(holdNotAppliedWhy('order_cancelled')).toBe('order is cancelled')
    expect(holdNotAppliedWhy(5)).toBe('not applicable')
  })
})

describe('tag chips', () => {
  it('falls back to neutral for unknown colours', () => {
    expect(tagChipClass('nope')).toBe(TAG_CHIP_CLASSES.neutral)
    expect(tagChipClass('red')).toBe(TAG_CHIP_CLASSES.red)
  })
})

describe('Orders client source guards', () => {
  const client = read('app/admin/orders/AdminOrdersClient.tsx')
  const fraud = read('app/admin/orders/FraudReviewPanel.tsx')
  const tags = read('app/admin/orders/OrderTagsPanel.tsx')

  it('destructive cancellation warning is visible text, not a tooltip', () => {
    expect(CANCEL_WARNING).toMatch(/cannot be undone/)
    expect(CANCEL_WARNING).toMatch(/original cost/)
    expect(client).toMatch(/<AdminNotice[^>]*>\{CANCEL_WARNING\}<\/AdminNotice>/)
    expect(client).toMatch(/window\.confirm\(/)
  })
  it('critical states are never hidden behind InfoTip/title tooltips', () => {
    for (const src of [client, fraud]) {
      for (const m of src.matchAll(/<InfoTip[^>]*>([\s\S]*?)<\/InfoTip>/g)) {
        // tooltips may define terms; they must not carry the warning itself
        expect(m[1]).not.toMatch(/cannot be undone|On fraud hold|Risk is unknown|confirmed fraud/i)
      }
    }
    expect(fraud).toMatch(/On fraud hold/)
    expect(fraud).toMatch(/Risk is unknown/)
  })
  it('uses AdminUI primitives and the fixed StatusBadge', () => {
    expect(client).toMatch(/from '@\/components\/admin\/ui\/AdminUI'/)
    expect(client).toMatch(/StatusBadge/)
    expect(client).toMatch(/AdminEmpty/)
    expect(client).toMatch(/AdminLoading/)
    expect(client).toMatch(/AdminError/)
  })
  it('fraud mutations are confirmed and go through the admin API', () => {
    expect(fraud).toMatch(/window\.confirm\(/)
    expect(fraud).toMatch(/\/api\/admin\/orders\/\$\{orderId\}\/fraud\/\$\{kind\}/)
    for (const k of ['release', 'refresh', 'confirm']) expect(fraud).toContain(`'${k}'`)
    expect(fraud).toMatch(/confirm:\s*true/)
  })
  it('does not render tag or fraud data for customers (admin-only paths)', () => {
    expect(tags).toMatch(/\/api\/admin\/orders/)
    for (const p of ['app/api/admin/orders/[id]/tags/route.ts', 'app/api/admin/orders/[id]/fraud/route.ts',
      'app/api/admin/orders/[id]/fraud/release/route.ts', 'app/api/admin/orders/[id]/fraud/refresh/route.ts',
      'app/api/admin/orders/[id]/fraud/confirm/route.ts', 'app/api/admin/orders/tags/route.ts',
      'app/api/admin/orders/tags/[tagId]/route.ts']) {
      expect(read(p)).toMatch(/requireAdmin\(req/)
    }
  })
  it('customer-facing order surfaces never reference tags or fraud', () => {
    for (const dir of ['app/api/checkout', 'app/api/stripe/checkout', 'app/order', 'app/account']) {
      const full = path.join(root, dir)
      if (!fs.existsSync(full)) continue
      const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
      for (const f of walk(full).filter(f => /\.(ts|tsx)$/.test(f))) {
        expect(fs.readFileSync(f, 'utf8')).not.toMatch(/order_tag|fraud_review|order-tags|fraud-review/)
      }
    }
  })
})
