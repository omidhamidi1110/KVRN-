// lib/__tests__/abandoned-checkout.test.ts — pure logic + source guards (no database needed).
import fs from 'fs'
import path from 'path'
import {
  signToken, verifyToken, getLinkSecret, MIN_SECRET_LENGTH, ABANDONED_RECOVERY_COOKIE,
} from '../abandoned-checkout-token'
import {
  validateAbandonedConfig, normalizeAbandonedConfig, decideConsent, mayTrackClicks,
  DEFAULT_ABANDONED_CONFIG, MAX_SEND_ATTEMPTS, MAX_MANUAL_RETRIES, CONSENT_MODES,
} from '../abandoned-checkout-config'
import { renderRecoveryEmail, resolveEmailLocale, RECOVERY_STRINGS, escapeHtml } from '../abandoned-checkout-email'
import { parseAcceptLanguage, normalizeEmail, viewStates, recoverySendKey } from '../abandoned-checkout'
import { evaluateLine, applyBundleRule, resolveRecoveryCurrency, type VariantFacts } from '../abandoned-checkout-resume'
import {
  stateBadge, ineligibleLabel, summarizeCart, revenueDisplay, canRetry, persistRecoveredCart, currentBagCount,
  CART_STORAGE_KEY, RECOVER_STATUS_COPY, formatMoney,
} from '../abandoned-checkout-ui'
import { isFeatureEnabled } from '../feature-flags'
import { createResendAdapter } from '../resend-adapter'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const SECRET = 'k'.repeat(40)
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const NOW = 1_800_000_000

describe('recovery tokens', () => {
  test('round trip; bound to id + purpose + expiry', () => {
    const t = signToken(SECRET, { purpose: 'recover', id: ID, expiresAtSec: NOW + 100 })
    expect(verifyToken(SECRET, t, 'recover', NOW)).toEqual({ ok: true, id: ID, expiresAtSec: NOW + 100 })
    expect(verifyToken(SECRET, t, 'unsubscribe', NOW)).toEqual({ ok: false, reason: 'wrong_purpose' })
    expect(verifyToken(SECRET, t, 'recover', NOW + 100)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyToken(SECRET, t, 'recover', NOW + 99)).toMatchObject({ ok: true })
  })
  test('opaque: no secret, no order/session ids, id only inside a signed base64url payload', () => {
    const t = signToken(SECRET, { purpose: 'recover', id: ID, expiresAtSec: NOW })
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(t).not.toContain(SECRET); expect(t).not.toContain(ID)
    expect(t.length).toBeLessThan(200)
  })
  test('tampering with any part is rejected', () => {
    const t = signToken(SECRET, { purpose: 'recover', id: ID, expiresAtSec: NOW + 100 })
    const [v, p, s] = t.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ p: 'r', a: ID, e: NOW + 999999 })).toString('base64url')
    for (const bad of [`${v}.${forgedPayload}.${s}`, `${v}.${p}.${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`, `v2.${p}.${s}`, `${v}.${p}`, `${v}.${p}.${s}.x`]) {
      expect(verifyToken(SECRET, bad, 'recover', NOW).ok).toBe(false)
    }
    expect(verifyToken('z'.repeat(40), t, 'recover', NOW)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  test('never throws on hostile input', () => {
    for (const x of [undefined, null, 1, {}, [], '', '.', '..', '...', 'v1.%%%.%%%', '\u0000', 'a'.repeat(100000), '😀.😀.😀']) {
      expect(() => verifyToken(SECRET, x, 'recover', NOW)).not.toThrow()
      expect(verifyToken(SECRET, x, 'recover', NOW).ok).toBe(false)
    }
    expect(verifyToken('', signToken(SECRET, { purpose: 'recover', id: ID, expiresAtSec: NOW }), 'recover', NOW).ok).toBe(false)
  })
  test('signing refuses a weak secret or bad id', () => {
    expect(() => signToken('short', { purpose: 'recover', id: ID, expiresAtSec: NOW })).toThrow()
    expect(() => signToken(SECRET, { purpose: 'recover', id: 'not-a-uuid', expiresAtSec: NOW })).toThrow()
  })
  test('the secret is a dedicated variable; short or missing => null (fail closed)', () => {
    expect(getLinkSecret({ ABANDONED_LINK_SECRET: SECRET })).toBe(SECRET)
    expect(getLinkSecret({ ABANDONED_LINK_SECRET: 'x'.repeat(MIN_SECRET_LENGTH - 1) })).toBeNull()
    expect(getLinkSecret({ CRON_SECRET: SECRET, STRIPE_WEBHOOK_SECRET: SECRET })).toBeNull()
    expect(getLinkSecret({})).toBeNull()
    expect(ABANDONED_RECOVERY_COOKIE).toBe('kvrn_recover')
  })
})

describe('config', () => {
  const ok = { enabled: true, delay_minutes: 60, max_emails: 1, consent_mode: 'require_opt_in', window_hours: 72 }
  test('defaults are the safe ones', () => {
    expect(DEFAULT_ABANDONED_CONFIG).toEqual(ok)
    expect(MAX_SEND_ATTEMPTS).toBe(3); expect(MAX_MANUAL_RETRIES).toBe(1)
    expect(CONSENT_MODES).toEqual(['require_opt_in', 'cart_reminder_no_consent'])
  })
  test('validation', () => {
    expect(validateAbandonedConfig(ok)).toEqual({ ok: true, value: ok })
    const bad = (o: any) => { const r = validateAbandonedConfig({ ...ok, ...o }); return r.ok ? null : r.errors }
    expect(bad({ max_emails: 2 })).toHaveProperty('max_emails')
    expect(bad({ delay_minutes: 5 })).toHaveProperty('delay_minutes')
    expect(bad({ delay_minutes: 1.5 })).toHaveProperty('delay_minutes')
    expect(bad({ delay_minutes: '60' })).toHaveProperty('delay_minutes')
    expect(bad({ window_hours: 10 })).toHaveProperty('window_hours')
    expect(bad({ delay_minutes: 1440, window_hours: 24 })).toHaveProperty('window_hours')
    expect(bad({ consent_mode: 'anything' })).toHaveProperty('consent_mode')
    expect(bad({ enabled: 'yes' })).toHaveProperty('enabled')
    expect(bad({ surprise: 1 })).toHaveProperty('surprise')
    for (const x of [null, [], 'x', 3]) expect(validateAbandonedConfig(x).ok).toBe(false)
  })
  test('read-side normalisation never widens behaviour', () => {
    expect(normalizeAbandonedConfig(null)).toEqual(ok)
    expect(normalizeAbandonedConfig({ consent_mode: 'cart_reminder_no_consent', delay_minutes: 30 })).toMatchObject({ consent_mode: 'cart_reminder_no_consent', delay_minutes: 30 })
    expect(normalizeAbandonedConfig({ consent_mode: 'x', delay_minutes: -1, window_hours: 9999, enabled: 'x' })).toEqual(ok)
    expect(normalizeAbandonedConfig({ delay_minutes: 1440, window_hours: 24 })).toMatchObject({ delay_minutes: 60, window_hours: 72 })
  })
})

describe('consent decision matrix', () => {
  const m = (mode: any, status: any, extra: any = {}) => decideConsent(mode, { subscriberStatus: status, ...extra })
  test('require_opt_in', () => {
    expect(m('require_opt_in', 'subscribed')).toEqual({ ok: true })
    expect(m('require_opt_in', null)).toEqual({ ok: false, reason: 'no_consent' })
    expect(m('require_opt_in', 'unsubscribed')).toEqual({ ok: false, reason: 'suppressed' })
  })
  test('cart_reminder_no_consent', () => {
    expect(m('cart_reminder_no_consent', null)).toEqual({ ok: true })
    expect(m('cart_reminder_no_consent', 'subscribed')).toEqual({ ok: true })
    expect(m('cart_reminder_no_consent', 'unsubscribed')).toEqual({ ok: false, reason: 'suppressed' })
  })
  test('a recovery suppression always wins, unless the person re-subscribed LATER', () => {
    const supp = '2026-01-10T00:00:00Z'
    for (const mode of CONSENT_MODES) {
      expect(m(mode, null, { suppressedAt: supp })).toEqual({ ok: false, reason: 'suppressed' })
      expect(m(mode, 'subscribed', { suppressedAt: supp, consentedAt: '2026-01-01T00:00:00Z' })).toEqual({ ok: false, reason: 'suppressed' })
      expect(m(mode, 'subscribed', { suppressedAt: supp, consentedAt: '2026-02-01T00:00:00Z' })).toEqual({ ok: true })
    }
  })
  test('clicks are tracked only with an explicit opt-in', () => {
    expect(mayTrackClicks({ subscriberStatus: 'subscribed' })).toBe(true)
    expect(mayTrackClicks({ subscriberStatus: null })).toBe(false)
    expect(mayTrackClicks({ subscriberStatus: 'unsubscribed' })).toBe(false)
  })
})

describe('email rendering', () => {
  const base = {
    lines: [{ name: 'Phantom <Hoodie>', size: 'M', color: 'Black', quantity: 2 }],
    recoverUrl: 'https://kvrn.shop/checkout/recover?t=abc', unsubscribeUrl: 'https://kvrn.shop/api/checkout/recover/unsubscribe?t=def', origin: 'https://kvrn.shop',
  }
  test('English default; es/fr/de strings exist; unknown locale falls back to English', () => {
    expect(Object.keys(RECOVERY_STRINGS).sort()).toEqual(['de', 'en', 'es', 'fr'])
    expect(resolveEmailLocale('es-MX')).toBe('es'); expect(resolveEmailLocale('FR_ca')).toBe('fr')
    expect(resolveEmailLocale('ja-JP')).toBe('en'); expect(resolveEmailLocale(null)).toBe('en'); expect(resolveEmailLocale('__proto__')).toBe('en')
    expect(renderRecoveryEmail({ ...base, locale: 'de' }).subject).toBe(RECOVERY_STRINGS.de.subject)
    expect(renderRecoveryEmail({ ...base, locale: 'zz' }).subject).toBe(RECOVERY_STRINGS.en.subject)
  })
  test('escapes content; contains the links; no prices; no tracking pixel', () => {
    const { html } = renderRecoveryEmail({ ...base, locale: 'en' })
    expect(html).toContain('Phantom &lt;Hoodie&gt;'); expect(html).not.toContain('<Hoodie>')
    expect(html).toContain('checkout/recover?t=abc'); expect(html).toContain('recover/unsubscribe?t=def')
    expect(html).not.toMatch(/\$|<img|pixel|track/i)
    expect(escapeHtml(`"<&'>`)).toBe('&quot;&lt;&amp;&#39;&gt;')
  })
  test('long bags are truncated', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ name: `Item ${i}`, quantity: 1 }))
    const { html } = renderRecoveryEmail({ ...base, lines, locale: 'en' })
    expect(html).toContain('Item 5'); expect(html).not.toContain('Item 6'); expect(html).toContain('+ 14 and more')
  })
})

describe('small parsers', () => {
  test('Accept-Language', () => {
    expect(parseAcceptLanguage('es-mx,es;q=0.9')).toBe('es-MX'); expect(parseAcceptLanguage('FR')).toBe('fr')
    expect(parseAcceptLanguage('*')).toBeNull(); expect(parseAcceptLanguage("en'; DROP")).toBeNull(); expect(parseAcceptLanguage(undefined)).toBeNull()
  })
  test('email normalisation', () => {
    expect(normalizeEmail('  A@B.Co ')).toBe('a@b.co'); expect(normalizeEmail('nope')).toBeNull(); expect(normalizeEmail(5)).toBeNull()
  })
  test('send key', () => { expect(recoverySendKey(ID)).toBe(`abandoned-recovery-v1:${ID}`) })
  test('admin views', () => {
    expect(viewStates('failed')).toEqual(['send_failed']); expect(viewStates('zzz')).not.toContain('active'); expect(viewStates('zzz')).not.toContain('completed')
  })
})

describe('resume line rules', () => {
  const line = (o: any = {}) => ({ sku: 'KVRN-X', quantity: 2, variantId: 'v', productName: 'Tee', size: 'M', color: 'Black', seenUnitPriceCents: 8000, ...o })
  const facts = (o: Partial<VariantFacts> = {}): VariantFacts => ({
    sku: 'KVRN-X', variant_id: 'v', product_id: 'p', product_name: 'Tee', neon_slug: 'tee', size: 'M', color_name: 'Black',
    price_cents: 8000, currency: 'usd', variant_active: true, product_active: true, available: 5, ...o,
  })
  test('ok / reduced / sold out / inactive / missing / foreign currency', () => {
    expect(evaluateLine(line(), facts())).toMatchObject({ status: 'ok', quantity: 2, unitPriceCents: 8000, priceChanged: false })
    expect(evaluateLine(line(), facts({ available: 1 }))).toMatchObject({ status: 'reduced', quantity: 1, requestedQuantity: 2 })
    expect(evaluateLine(line(), facts({ available: 0 }))).toMatchObject({ status: 'unavailable', reason: 'sold_out', unitPriceCents: null })
    expect(evaluateLine(line(), facts({ variant_active: false }))).toMatchObject({ reason: 'inactive' })
    expect(evaluateLine(line(), facts({ product_active: false }))).toMatchObject({ reason: 'inactive' })
    expect(evaluateLine(line(), facts({ currency: 'eur' }))).toMatchObject({ reason: 'inactive' })
    expect(evaluateLine(line(), undefined)).toMatchObject({ reason: 'not_found' })
    expect(evaluateLine(line({ quantity: 0 }), facts())).toMatchObject({ status: 'unavailable' })
  })
  test('quantity is capped at the per-SKU maximum; price is ALWAYS the current one', () => {
    expect(evaluateLine(line({ quantity: 99 }), facts({ available: 50 }))).toMatchObject({ quantity: 10, requestedQuantity: 10 })
    const l = evaluateLine(line({ seenUnitPriceCents: 5000 }), facts({ price_cents: 8000 }))
    expect(l).toMatchObject({ unitPriceCents: 8000, seenUnitPriceCents: 5000, priceChanged: true })
    expect(evaluateLine(line({ seenUnitPriceCents: null }), facts()).priceChanged).toBe(false)   // unknown earlier price: no false claim
  })
  test('bundle rule is all-or-nothing', () => {
    const ctx = { components: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }] }
    const mk = (sku: string, status: any) => ({ sku, name: sku, size: '', color: '', requestedQuantity: 1, quantity: 1, unitPriceCents: 1, seenUnitPriceCents: 1, priceChanged: false, status }) as any
    expect(applyBundleRule([mk('A', 'ok'), mk('B', 'ok'), mk('C', 'ok')], ctx).dropped).toBe(false)
    const r = applyBundleRule([mk('A', 'ok'), mk('B', 'reduced'), mk('C', 'ok')], ctx)
    expect(r.dropped).toBe(true)
    expect(r.lines.map(l => l.status)).toEqual(['unavailable', 'unavailable', 'ok'])
    expect(applyBundleRule([mk('A', 'ok')], ctx).dropped).toBe(true)         // a missing component
    expect(applyBundleRule([mk('A', 'ok')], null).dropped).toBe(false)
    expect(applyBundleRule([mk('A', 'ok')], { components: 'x' }).dropped).toBe(false)
  })
  test('currency', () => {
    expect(resolveRecoveryCurrency('usd')).toEqual({ currency: 'usd', fellBack: false })
    expect(resolveRecoveryCurrency('USD')).toEqual({ currency: 'usd', fellBack: false })
    expect(resolveRecoveryCurrency('eur')).toEqual({ currency: 'usd', fellBack: true })
    expect(resolveRecoveryCurrency(null)).toEqual({ currency: 'usd', fellBack: false })
  })
})

describe('ui helpers', () => {
  test('state badges use the shared vocabulary and say Failed when failed', () => {
    expect(stateBadge('send_failed')).toEqual({ status: 'Failed', label: 'Send failed' })
    expect(stateBadge('recovered').status).toBe('Recovered'); expect(stateBadge('whatever').status).toBe('Pending')
    // AdminUI is TSX (no JSX transform under jest): read the vocabulary out of its source.
    const tones = read('components/admin/ui/AdminUI.tsx').match(/export const STATUS_TONES = \{([\s\S]*?)\} as const/)![1]
    const STATUS_TONES: Record<string, true> = {}
    for (const m of tones.matchAll(/(\w+):\s*'/g)) STATUS_TONES[m[1]] = true
    for (const s of ['active', 'abandoned', 'recovery_queued', 'recovery_sent', 'recovered', 'completed', 'expired', 'ineligible', 'send_failed', 'x'])
      expect(STATUS_TONES).toHaveProperty(stateBadge(s).status)
  })
  test('revenue is never shown as $0 when unknown', () => {
    expect(revenueDisplay({ recovered: 2, revenueUnknownCount: 1, revenue: [{ currency: 'usd', cents: 5000 }] })).toBe('Unknown')
    expect(revenueDisplay({ recovered: 0, revenueUnknownCount: 0, revenue: [] })).toBe('—')
    expect(revenueDisplay({ recovered: 1, revenueUnknownCount: 0, revenue: [{ currency: 'usd', cents: 8700 }] })).toBe('$87.00')
    expect(revenueDisplay({ recovered: 2, revenueUnknownCount: 0, revenue: [{ currency: 'usd', cents: 100 }, { currency: 'eur', cents: 200 }] })).toBe('$1.00 · 2.00 EUR')
    expect(formatMoney(123456, 'usd')).toBe('$1,234.56')
  })
  test('retry offered only for a failed send with the retry unused and the flag on', () => {
    expect(canRetry({ state: 'send_failed', manual_retries: 0 }, true)).toBe(true)
    expect(canRetry({ state: 'send_failed', manual_retries: 1 }, true)).toBe(false)
    expect(canRetry({ state: 'send_failed', manual_retries: 0 }, false)).toBe(false)
    expect(canRetry({ state: 'recovery_sent', manual_retries: 0 }, true)).toBe(false)
  })
  test('labels and cart summary', () => {
    expect(ineligibleLabel('no_consent')).toBe('No marketing opt-in.'); expect(ineligibleLabel(null)).toBe(''); expect(ineligibleLabel('zzz')).toBe('Not eligible.')
    expect(summarizeCart([{ productName: 'Tee', color: 'Black', size: 'M', quantity: 2 }, { productName: 'B' }, { productName: 'C' }])).toBe('Tee · Black / M ×2, B ×1 +1 more')
    expect(summarizeCart([])).toBe('Empty bag'); expect(summarizeCart(null)).toBe('Empty bag')
  })
  test('recovered bag is written to the key CartContext hydrates from; storage failures are reported', () => {
    const store: Record<string, string> = {}
    expect(persistRecoveredCart({ setItem: (k, v) => { store[k] = v } }, [{ a: 1 }])).toBe(true)
    expect(JSON.parse(store[CART_STORAGE_KEY])).toEqual([{ a: 1 }]); expect(CART_STORAGE_KEY).toBe('kvrn_cart')
    expect(persistRecoveredCart({ setItem: () => { throw new Error('quota') } }, [{ a: 1 }])).toBe(false)
    expect(persistRecoveredCart(null, [{ a: 1 }])).toBe(false); expect(persistRecoveredCart({ setItem: () => {} }, [])).toBe(false)
    expect(currentBagCount({ getItem: () => '[{},{}]' })).toBe(2); expect(currentBagCount({ getItem: () => '{bad' })).toBe(0)
    for (const k of Object.keys(RECOVER_STATUS_COPY)) expect((RECOVER_STATUS_COPY as any)[k].title).toBeTruthy()
  })
})

describe('feature flag', () => {
  test('ABANDONED_CHECKOUT_EMAILS defaults OFF and is independent', () => {
    expect(isFeatureEnabled('ABANDONED_CHECKOUT_EMAILS', {})).toBe(false)
    expect(isFeatureEnabled('ABANDONED_CHECKOUT_EMAILS', { KVRN_FLAG_MULTI_CURRENCY_CHECKOUT: 'on', KVRN_FLAG_CMS_PRODUCT_ROUTING: 'on' })).toBe(false)
    expect(isFeatureEnabled('ABANDONED_CHECKOUT_EMAILS', { KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS: 'on' })).toBe(true)
    expect(isFeatureEnabled('ABANDONED_CHECKOUT_EMAILS', { KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS: 'maybe' })).toBe(false)
  })
})

describe('resend adapter: optional headers are additive (shared edit)', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })
  async function bodyFor(msg: any) {
    let captured: any
    global.fetch = (async (_u: any, init: any) => { captured = JSON.parse(init.body); return { ok: true, json: async () => ({ id: 'm1' }) } }) as any
    await createResendAdapter('re_x').send({ from: 'a', replyTo: 'b', to: 'c@d.e', subject: 's', html: 'h', ...msg })
    return captured
  }
  test('without headers the request body is exactly what it was before', async () => {
    expect(Object.keys(await bodyFor({})).sort()).toEqual(['from', 'html', 'reply_to', 'subject', 'to'])
    expect(Object.keys(await bodyFor({ headers: {} })).sort()).toEqual(['from', 'html', 'reply_to', 'subject', 'to'])
  })
  test('with headers they are forwarded (List-Unsubscribe)', async () => {
    expect((await bodyFor({ headers: { 'List-Unsubscribe': '<https://x>' } })).headers).toEqual({ 'List-Unsubscribe': '<https://x>' })
  })
})

describe('source guards', () => {
  test('migration 032 is the only migration this workstream adds, and 001-027 are untouched', () => {
    const files = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => /^\d+_/.test(f))
    expect(files).toContain('032_abandoned_checkouts.sql')
    expect(files.filter(f => /abandon/i.test(f))).toEqual(['032_abandoned_checkouts.sql'])
  })
  test('cron route authenticates with requireCronSecret first and returns counts only', () => {
    const src = read('app/api/internal/abandoned-checkout-sweep/route.ts')
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    const body = src.slice(src.indexOf('export async function POST'))
    expect(body.indexOf('requireCronSecret(req)')).toBeGreaterThan(-1)
    expect(body.indexOf('requireCronSecret(req)')).toBeLessThan(body.indexOf('abandonedService'))
    expect(src).not.toMatch(/console\.log/)
  })
  test('every admin handler calls requireAdmin before anything else', () => {
    const src = read('app/api/admin/abandoned-checkouts/route.ts')
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1])
    expect(handlers.sort()).toEqual(['GET', 'POST', 'PUT'])
    for (const h of handlers) {
      const start = src.indexOf(`export async function ${h}`)
      const body = src.slice(start, start + 400)
      expect(body.indexOf('requireAdmin(req)')).toBeGreaterThan(-1)
      expect(body).toMatch(/if \(error\) return error/)
    }
  })
  test('public pages and routes are dynamic and noindex; admin client uses shared primitives', () => {
    const page = read('app/checkout/recover/page.tsx')
    expect(page).toMatch(/dynamic = 'force-dynamic'/); expect(page).toMatch(/index: false/)
    const api = read('app/api/checkout/recover/route.ts')
    expect(api).toMatch(/dynamic = 'force-dynamic'/); expect(api).toMatch(/no-store/); expect(api).toMatch(/noindex/)
    const unsub = read('app/api/checkout/recover/unsubscribe/route.ts')
    expect(unsub).toMatch(/noindex/)
    const ui = read('app/admin/abandoned-checkouts/AbandonedCheckoutsClient.tsx')
    for (const p of ['AdminPageHeader', 'AdminTable', 'StatusBadge', 'AdminEmpty', 'AdminLoading', 'AdminError', 'InfoTip', 'AdminNotice']) expect(ui).toContain(p)
    expect(ui).not.toMatch(/authoritative|deterministic|canonical/i)
    expect(ui).toContain('KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS')
  })
  test('the admin page keeps warnings visible (not only in tooltips)', () => {
    const ui = read('app/admin/abandoned-checkouts/AbandonedCheckoutsClient.tsx')
    expect(ui).toMatch(/<AdminNotice tone="warning"[^>]*title="Legal decision\."/)
    expect(ui).toMatch(/tone="danger"[^>]*title="Link secret missing\./)
    expect(ui).toMatch(/send\${data\.summary\.failed === 1/)
  })
  test('the checkout handler hook is optional, post-attach, time-bounded and non-fatal', () => {
    const h = read('lib/checkout-session-handler.ts')
    expect(h).toMatch(/recordCheckoutStarted\?:/)
    const hook = h.slice(h.indexOf('if (deps.recordCheckoutStarted)'))
    expect(h.indexOf('attachStripeSession(reservation.reservationId')).toBeLessThan(h.indexOf('if (deps.recordCheckoutStarted)'))
    expect(hook).toMatch(/Promise\.race/); expect(hook).toMatch(/setTimeout\(resolve, 2000\)/); expect(hook).toMatch(/catch \(e: any\)/)
    expect(h.indexOf('if (deps.recordCheckoutStarted)')).toBeLessThan(h.indexOf('tryRecordCheckoutStarted(sql'))
    // it must not add a return path
    expect(hook.slice(0, hook.indexOf('Funnel analytics')).match(/return /g)).toBeNull()
  })
  test('this module never writes to orders / reservations / inventory / discounts', () => {
    for (const f of ['lib/abandoned-checkout.ts', 'lib/abandoned-checkout-resume.ts']) {
      const src = read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(src).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(orders|order_items|reservations|reservation_items|product_variants|products|inventory_\w+|discounts|discount_\w+|payment_exceptions|webhook_events)\b/i)
      expect(src).not.toMatch(/reserve_inventory|release_reservation|finalize_paid_order|attach_stripe_session|claimDiscount|reserveInventory/)
    }
  })
})
