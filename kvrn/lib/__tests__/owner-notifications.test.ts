import fs from 'fs'
import path from 'path'

// A tagged-template `sql` double: every call is recorded and answered from a queue.
const dbSql = jest.fn<Promise<any[]>, any[]>()
const pushSend = jest.fn<Promise<{ outcome: 'sent' } | { outcome: 'failed'; reason: string }>, [any]>()
let configured = true

jest.mock('../db', () => ({
  sql: (...args: any[]) => dbSql(...args),
}))
jest.mock('../pushover', () => ({
  isPushoverConfigured: () => configured,
  sendPushoverNotification: (n: any) => pushSend(n),
}))

import {
  isProviderException, isResendProviderFault, isStripeProviderFault,
  notifyBackupFailure, notifyDispute, notifyFinancialIntegrityRun, notifyPaymentIssue, notifyRefund,
  notifySaleAndInventory, notifySecurityAlert, notifySupportEmail, readRefundStatusForNotify, recordProviderFailure,
} from '../owner-notifications'

const ORDER = '22222222-2222-2222-2222-222222222222'
const VARIANT = '11111111-1111-1111-1111-111111111111'
const titles = () => pushSend.mock.calls.map(c => c[0].title)
const sqlText = (i: number) => (dbSql.mock.calls[i][0] as TemplateStringsArray).join('?')
const CLAIMED = [{ id: 'claim-1' }]       // INSERT ... WHERE NOT EXISTS ... RETURNING id  -> this caller won
const NOT_CLAIMED: any[] = []             //                                                 -> already claimed

function sale(stockOnHand: number, quantity = 1) {
  dbSql
    .mockResolvedValueOnce([{ orderNumber: 'KVRN-001234', totalCents: 8598, currency: 'usd' }])
    .mockResolvedValueOnce([{ productName: 'Heavyweight Hoodie', color: 'Black', size: 'M', quantity,
      variantId: VARIANT, stockOnHand, reservedQuantity: 0 }])
}

beforeEach(() => {
  configured = true
  dbSql.mockReset()
  pushSend.mockReset()
  pushSend.mockResolvedValue({ outcome: 'sent' })
  process.env.SITE_URL = 'https://kvrn.shop'
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { jest.restoreAllMocks() })

describe('sale / low stock / sold out', () => {
  test('sale push includes order, amount and item; no customer data is selected', async () => {
    sale(5)
    await notifySaleAndInventory(ORDER)
    expect(titles()).toEqual(['KVRN SALE 💰'])
    const m = pushSend.mock.calls[0][0].message
    expect(m).toContain('KVRN-001234'); expect(m).toContain('$85.98 paid'); expect(m).toContain('Heavyweight Hoodie')
    for (let i = 0; i < dbSql.mock.calls.length; i++) expect(sqlText(i)).not.toMatch(/email|phone|address|customer_name|stripe_/i)
  })

  test('sold-out fires only on the transition to zero, and only once for concurrent orders', async () => {
    sale(0); dbSql.mockResolvedValueOnce(CLAIMED)
    await notifySaleAndInventory(ORDER)
    expect(titles()).toEqual(['KVRN SALE 💰', 'KVRN SOLD OUT 🚫'])
    expect(pushSend.mock.calls[1][0].priority).toBe(1)

    // a second order that also observes 0 in the same minutes loses the claim -> no second sold-out push
    dbSql.mockReset(); pushSend.mockClear()
    sale(0); dbSql.mockResolvedValueOnce(NOT_CLAIMED)
    await notifySaleAndInventory(ORDER)
    expect(titles()).toEqual(['KVRN SALE 💰'])
  })

  test('low-stock fires only when physical stock crosses from >2 to <=2', async () => {
    sale(2); dbSql.mockResolvedValueOnce(CLAIMED)
    await notifySaleAndInventory(ORDER)
    expect(titles()).toEqual(['KVRN SALE 💰', 'KVRN LOW STOCK 📦'])

    dbSql.mockReset(); pushSend.mockClear()
    sale(1)                                   // 2 -> 1 is not a crossing
    await notifySaleAndInventory(ORDER)
    expect(titles()).toEqual(['KVRN SALE 💰'])

    dbSql.mockReset(); pushSend.mockClear()
    sale(9)                                   // plenty left
    await notifySaleAndInventory(ORDER)
    expect(titles()).toEqual(['KVRN SALE 💰'])
  })

  test('a database failure never throws and never blocks the caller', async () => {
    dbSql.mockRejectedValueOnce(new Error('neon down'))
    await expect(notifySaleAndInventory(ORDER)).resolves.toBeUndefined()
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('unconfigured Pushover causes no DB work and no push', async () => {
    configured = false
    await notifySaleAndInventory(ORDER)
    await notifyPaymentIssue({ amountCents: 100 })
    await notifyBackupFailure('dr_drill')
    await recordProviderFailure('Stripe', 'x')
    await notifySecurityAlert('x')
    expect(dbSql).not.toHaveBeenCalled()
    expect(pushSend).not.toHaveBeenCalled()
  })
})

describe('payment issue / refund / dispute / backup / financial', () => {
  test('payment exception is urgent and contains the amount but no customer data', async () => {
    await notifyPaymentIssue({ amountCents: 8700, currency: 'usd', reason: 'insufficient_stock' })
    expect(pushSend).toHaveBeenCalledTimes(1)
    expect(pushSend.mock.calls[0][0]).toMatchObject({ title: 'KVRN PAYMENT ISSUE ⚠️', priority: 1 })
    expect(pushSend.mock.calls[0][0].message).toContain('$87.00')
  })

  test('refund identifies full vs partial and is claimed once per Stripe refund id', async () => {
    dbSql.mockResolvedValueOnce(CLAIMED).mockResolvedValueOnce([{ orderNumber: 'KVRN-1000' }])
    await notifyRefund({ orderId: ORDER, stripeRefundId: 're_1', amountCents: 8598, fullyRefunded: true })
    expect(titles()).toEqual(['KVRN REFUND ↩️'])
    expect(pushSend.mock.calls[0][0].message).toContain('Full refund')

    // charge.refunded and refund.updated for the same refund: the second one loses the claim
    dbSql.mockReset(); pushSend.mockClear()
    dbSql.mockResolvedValueOnce(NOT_CLAIMED)
    await notifyRefund({ orderId: ORDER, stripeRefundId: 're_1', amountCents: 8598, fullyRefunded: true })
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('readRefundStatusForNotify never throws', async () => {
    dbSql.mockResolvedValueOnce([{ status: 'pending' }])
    await expect(readRefundStatusForNotify('re_1')).resolves.toBe('pending')
    dbSql.mockResolvedValueOnce([])
    await expect(readRefundStatusForNotify('re_1')).resolves.toBeNull()
    dbSql.mockRejectedValueOnce(new Error('boom'))
    await expect(readRefundStatusForNotify('re_1')).resolves.toBeUndefined()
  })

  test('dispute push is urgent and carries only the order number, amount and status', async () => {
    dbSql.mockResolvedValueOnce([{ orderNumber: 'KVRN-77' }])
    await notifyDispute({ stripeDisputeId: 'dp_1', amountCents: 5000, status: 'needs_response' })
    expect(pushSend.mock.calls[0][0]).toMatchObject({ title: 'KVRN DISPUTE 🚨', priority: 1 })
    expect(pushSend.mock.calls[0][0].message).toContain('NEEDS RESPONSE')
  })

  test('backup failure is urgent', async () => {
    await notifyBackupFailure('restore_verification')
    expect(pushSend.mock.calls[0][0]).toMatchObject({ title: 'KVRN BACKUP FAILURE 💾', priority: 1 })
  })

  test('financial push is silent unless THIS run detected/changed an exception', async () => {
    dbSql.mockResolvedValueOnce([])
    await notifyFinancialIntegrityRun('33333333-3333-3333-3333-333333333333')
    expect(pushSend).not.toHaveBeenCalled()

    dbSql.mockReset()
    dbSql.mockResolvedValueOnce([{ issueCode: 'ORDER_TOTAL_MISMATCH', entityType: 'order' }])
    await notifyFinancialIntegrityRun('33333333-3333-3333-3333-333333333333')
    expect(pushSend).toHaveBeenCalledTimes(1)
    expect(pushSend.mock.calls[0][0]).toMatchObject({ title: 'KVRN FINANCIAL EXCEPTION 🔴', priority: 1 })
  })
})

describe('provider down', () => {
  // call order: 1 cooling check, 2 failure insert, 3 count, 4 attempt claim, 5 alert marker
  test('below the threshold: records the failure, no push', async () => {
    dbSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 2 }])
    await recordProviderFailure('Shippo', 'checkout_missing_token')
    expect(pushSend).not.toHaveBeenCalled()
    expect(dbSql).toHaveBeenCalledTimes(3)
  })

  test('at the threshold: claims the attempt, pushes once, writes the cooldown marker', async () => {
    dbSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 3 }])
      .mockResolvedValueOnce(CLAIMED).mockResolvedValueOnce([])
    await recordProviderFailure('Stripe', 'checkout_session_create')
    expect(titles()).toEqual(['KVRN PROVIDER DOWN ⚡'])
    expect(sqlText(3)).toMatch(/NOT EXISTS/)                   // claim is a single atomic statement
    expect(sqlText(4)).toMatch(/PUSHOVER_PROVIDER_ALERT/)
  })

  test('during cooldown NOTHING is written and nothing is pushed (an outage cannot grow the audit table)', async () => {
    dbSql.mockResolvedValueOnce([{ '?column?': 1 }])
    await recordProviderFailure('Stripe', 'checkout_session_create')
    expect(dbSql).toHaveBeenCalledTimes(1)
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('losing the attempt claim means no push', async () => {
    dbSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 9 }]).mockResolvedValueOnce(NOT_CLAIMED)
    await recordProviderFailure('Resend', 'x')
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('a failing Pushover writes no cooldown marker but the attempt claim stops a retry on every failure', async () => {
    pushSend.mockResolvedValue({ outcome: 'failed', reason: 'http_400' })
    dbSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 3 }]).mockResolvedValueOnce(CLAIMED)
    await recordProviderFailure('Stripe', 'x')
    expect(pushSend).toHaveBeenCalledTimes(1)
    expect(dbSql).toHaveBeenCalledTimes(4)                      // no ALERT marker
    expect(sqlText(0)).toMatch(/PUSHOVER_PROVIDER_ATTEMPT/)     // the next failure sees the attempt and returns at once
  })

  test('a database error never throws; non-Neon providers do not bypass the durable debounce', async () => {
    dbSql.mockRejectedValue(new Error('db down'))
    for (let i = 0; i < 5; i++) await expect(recordProviderFailure('Shippo', 'x')).resolves.toBeUndefined()
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('Neon outage: in-isolate streak pushes once after three failures, then stays quiet', async () => {
    dbSql.mockRejectedValue(new Error('db down'))
    for (let i = 0; i < 6; i++) await recordProviderFailure('Neon', 'x')
    expect(pushSend).toHaveBeenCalledTimes(1)
  })
})

describe('security alert', () => {
  // call order: 1 cooling check, 2 incident insert, 3 count, 4 attempt claim, 5 alert marker
  test('requires three incidents, then pushes once and records the cooldown', async () => {
    dbSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 2 }])
    await notifySecurityAlert('x')
    expect(pushSend).not.toHaveBeenCalled()

    dbSql.mockReset()
    dbSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 3 }])
      .mockResolvedValueOnce(CLAIMED).mockResolvedValueOnce([])
    await notifySecurityAlert('x')
    expect(titles()).toEqual(['KVRN SECURITY ALERT 🔐'])
    expect(pushSend.mock.calls[0][0].priority).toBe(1)
  })

  test('during cooldown nothing is written (a stream of denied requests cannot grow the audit table)', async () => {
    dbSql.mockResolvedValueOnce([{ '?column?': 1 }])
    await notifySecurityAlert('x')
    expect(dbSql).toHaveBeenCalledTimes(1)
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('stores no raw identity, e-mail, JWT or IP (fixed reason text, bounded)', async () => {
    dbSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 1 }])
    await notifySecurityAlert('x'.repeat(5000))
    const params = JSON.stringify(dbSql.mock.calls[1].slice(1))
    expect(params.length).toBeLessThan(400)
  })
})

describe('what counts as a provider fault (customer input must not read as "provider down")', () => {
  test('Stripe: 5xx / connection / rate-limit / auth count; request-caused 4xx do not', () => {
    expect(isStripeProviderFault({ type: 'StripeConnectionError' })).toBe(true)
    expect(isStripeProviderFault({ type: 'StripeAPIError', statusCode: 500 })).toBe(true)
    expect(isStripeProviderFault({ statusCode: 429 })).toBe(true)
    expect(isStripeProviderFault({ statusCode: 401 })).toBe(true)
    expect(isStripeProviderFault(new Error('socket hang up'))).toBe(true)
    expect(isStripeProviderFault({ type: 'StripeInvalidRequestError', statusCode: 400 })).toBe(false)
    expect(isStripeProviderFault({ type: 'StripeCardError', statusCode: 402 })).toBe(false)
  })
  test('Resend: 5xx / 401 / 403 / 429 / network count; 400 / 404 / 422 (bad recipient) do not', () => {
    expect(isResendProviderFault('Network error contacting email provider.')).toBe(true)
    expect(isResendProviderFault('Email provider returned HTTP 503.')).toBe(true)
    expect(isResendProviderFault('Email provider returned HTTP 403.')).toBe(true)
    expect(isResendProviderFault('Email provider returned HTTP 422.')).toBe(false)
    expect(isResendProviderFault('Email provider returned HTTP 400.')).toBe(false)
  })
  test('thrown TypeError / RangeError / SyntaxError (bad input, code bugs) are not provider faults', () => {
    expect(isProviderException(new TypeError('x'))).toBe(false)
    expect(isProviderException(new RangeError('x'))).toBe(false)
    expect(isProviderException(new SyntaxError('x'))).toBe(false)
    expect(isProviderException(new Error('fetch failed'))).toBe(true)
  })
})

// ── source guards: where the hooks are, and where they are NOT ───────────────────────────────
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8')

describe('call-site guards', () => {
  const checkout = read('lib/checkout-session-handler.ts')
  const rates = read('app/api/shipping-rates/route.ts')

  test('no provider-down hook on the "Shippo returned null / no rate" paths (indistinguishable from a bad customer address)', () => {
    expect(checkout).not.toMatch(/rate_unavailable/)
    expect(rates).not.toMatch(/shipping_rates_unavailable/)
  })

  test('checkout cleanup (claim release, reservation release, Stripe expiry) runs BEFORE any provider-down push', () => {
    for (const [hook, cleanup] of [
      ['checkout_snapshot_write', "failReservation(reservation.reservationId, 'save_checkout_details_failed')"],
      ['checkout_session_create', "failReservation(reservation.reservationId, 'stripe_session_creation_failed')"],
      ['checkout_invalid_session_url', "failReservation(reservation.reservationId, 'null_session_url')"],
      ['checkout_attach_session', "failReservation(reservation.reservationId, 'attach_failed')"],
    ] as const) {
      const h = checkout.indexOf(hook), c = checkout.indexOf(cleanup)
      expect([hook, h]).not.toEqual([hook, -1]); expect([cleanup, c]).not.toEqual([cleanup, -1])
      expect([hook, h > c]).toEqual([hook, true])
    }
  })

  test('refund handlers contain no try/catch of their own (persistence failures still reach Stripe)', () => {
    const w = read('app/api/stripe/webhook/route.ts')
    const a = w.indexOf('async function handleChargeRefunded'), b = w.indexOf('async function handleRefundObject')
    const body = w.slice(a, w.indexOf('\n}\n', b))
    expect(body).not.toMatch(/\bcatch\b/)
  })

  test('refund / dispute pushes are sent BEFORE the follow-up processing that could throw and make a Stripe retry miss them', () => {
    const w = read('app/api/stripe/webhook/route.ts')
    const fn = (name: string) => {
      const a = w.indexOf(`async function ${name}`)
      expect([name, a]).not.toEqual([name, -1])
      const rest = w.slice(a + 10), n = rest.search(/\n(?:\/\*\*|async function |function )/)
      return n === -1 ? w.slice(a) : w.slice(a, a + 10 + n)
    }
    for (const name of ['handleChargeRefunded', 'handleRefundObject']) {
      const body = fn(name)
      const push = body.indexOf('await notifyRefund('), follow = body.indexOf('await applyAffiliateRefundEffect(')
      expect([name, push > 0, follow > 0, push < follow]).toEqual([name, true, true, true])
      // the refund is persisted first: the push is after recordOrderRefund
      expect(body.indexOf('recordOrderRefund(')).toBeLessThan(push)
    }
    const d = fn('handleDispute')
    const pushes = [...d.matchAll(/await notifyDispute\(/g)].map(m => m.index!)
    const follows = [...d.matchAll(/await recordDisputeBalanceTransactions\(service/g)].map(m => m.index!)
    expect([pushes.length, follows.length]).toEqual([2, 2])
    // both paths (equal-timestamp reconciliation, normal) push first, then record balance transactions / affiliate effects
    expect(pushes[0]).toBeLessThan(follows[0])
    expect(pushes[1]).toBeGreaterThan(follows[0])          // second push is in the normal path, after the first path's follow-up
    expect(pushes[1]).toBeLessThan(follows[1])
    expect(d.indexOf('await applyAffiliateDisputeEffects(', pushes[1])).toBeGreaterThan(pushes[1])
    // the persistence of the transition itself still precedes the push
    expect(d.indexOf('reconcileFromStripe(')).toBeLessThan(pushes[0])
  })

  test('secrets and push code are server-only: no client component imports them', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__' ? [] :
      e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [path.join(d, e.name)] : [])
    const root = path.join(__dirname, '..', '..')
    for (const dir of ['app', 'components']) {
      for (const f of walk(path.join(root, dir))) {
        const src = fs.readFileSync(f, 'utf8')
        if (/^\s*['"]use client['"]/m.test(src.slice(0, 200))) {
          expect([f, /owner-notifications|\/pushover|PUSHOVER_/.test(src)]).toEqual([f, false])
        }
      }
    }
    expect(read('lib/owner-notifications.ts') + read('lib/pushover.ts')).not.toMatch(/NEXT_PUBLIC_PUSHOVER/)
  })

  test('no log line in the push modules can print a token, user key, address or message body', () => {
    for (const f of ['lib/pushover.ts', 'lib/owner-notifications.ts']) {
      const logs = read(f).split('\n').filter(l => /console\.(log|error|warn)/.test(l))
      for (const l of logs) expect(l).not.toMatch(/token|userKey|PUSHOVER_|message\b(?!\s*\?)|\.body|email/i)
    }
  })
})

describe('support email push content', () => {
  const sent = () => pushSend.mock.calls[0][0]

  test('title, lock-screen-safe lines and the admin link; priority is normal', async () => {
    await notifySupportEmail({ fromName: 'Ada Lovelace', subject: 'Where is my order?' })
    expect(pushSend).toHaveBeenCalledTimes(1)
    expect(sent().title).toBe('KVRN SUPPORT ✉️')
    expect(sent().message).toBe(['New customer email', 'From: Ada Lovelace', 'Subject: Where is my order?', 'Open Admin → Support'].join('\n'))
    expect(sent().priority).toBe(0)
    expect(dbSql).not.toHaveBeenCalled()                      // writes nothing: dedupe is the ingest's duplicate flag
  })

  test('falls back to "Customer" and "(No subject)"; never prints an address', async () => {
    await notifySupportEmail({ fromName: null, subject: '' })
    expect(sent().message).toContain('From: Customer'); expect(sent().message).toContain('Subject: (No subject)')
    pushSend.mockClear()
    await notifySupportEmail({ fromName: 'ada@example.com', subject: 'Re: ada@example.com order' })
    expect(sent().message).toContain('From: Customer')
    expect(sent().message).not.toMatch(/ada@|example\.com/)
    expect(sent().message).toContain('[address]')
  })

  test('a "Name <address>" display string shows only the name', async () => {
    await notifySupportEmail({ fromName: 'Pat Private <pat.private@example.net>', subject: 's' })
    expect(sent().message).toContain('From: Pat Private\n')
    expect(sent().message).not.toMatch(/@|example\.net|\[address\]/)
  })

  test('sanitizes sender-controlled text: links, control characters, card-like digit runs, length', async () => {
    await notifySupportEmail({
      fromName: 'Evil\nSupport https://phish.example/login ' + 'N'.repeat(300),
      subject: 'Pay now www.bad.example\r\nBcc: x 4111 1111 1111 1111 ' + 'S'.repeat(500),
    })
    const lines = sent().message.split('\n')
    expect(lines).toHaveLength(4)                              // an injected newline cannot add lines
    expect(sent().message).not.toMatch(/https?:|www\.|phish|bad\.example|4111/)
    expect(lines[1].length).toBeLessThanOrEqual('From: '.length + 40)
    expect(lines[2].length).toBeLessThanOrEqual('Subject: '.length + 80)
  })

  test('hostile / huge input cannot stall the request (linear time)', async () => {
    const t0 = Date.now()
    await notifySupportEmail({ fromName: '@'.repeat(100000), subject: ('a@'.repeat(50000)) })
    await notifySupportEmail({ fromName: '1 '.repeat(100000), subject: '-'.repeat(100000) })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  test('unconfigured: nothing happens; a transport that throws never escapes', async () => {
    configured = false
    await notifySupportEmail({ fromName: 'x', subject: 'y' })
    expect(pushSend).not.toHaveBeenCalled()
    configured = true
    pushSend.mockRejectedValue(new Error('boom'))
    await expect(notifySupportEmail({ fromName: 'x', subject: 'y' })).resolves.toBeUndefined()
    pushSend.mockResolvedValue({ outcome: 'failed', reason: 'timeout' })
    await expect(notifySupportEmail({ fromName: 'x', subject: 'y' })).resolves.toBeUndefined()
  })
})
