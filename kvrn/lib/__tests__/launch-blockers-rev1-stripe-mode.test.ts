// lib/__tests__/launch-blockers-rev1-stripe-mode.test.ts
//
// FINAL LAUNCH BLOCKER 1 — live Stripe mode was impossible.
//
// Before: lib/stripe-client.ts rejected every key that was not sk_test_, so an sk_live_ key
// made checkout, webhook signature verification and fee reconciliation all throw.
//
// After: STRIPE_MODE=test (default) | live selects the mode deliberately. A live key is
// accepted ONLY with STRIPE_MODE=live; a test key is rejected under STRIPE_MODE=live;
// anything malformed fails closed; checkout stays closed unless explicitly enabled.

import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import Stripe from 'stripe'
import { getStripe, verifyWebhookSignature } from '../stripe-client'
import {
  isCheckoutEnabled, resolveStripeMode, assertStripeKeyForMode,
  isValidStripeLiveSecretKey, isValidStripeTestSecretKey,
} from '../stripe-mode'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/reservations', () => ({
  reserveInventory: jest.fn(), saveReservationCheckoutDetails: jest.fn(), failReservation: jest.fn(),
  attachStripeSession: jest.fn(), releaseExpiredReservations: jest.fn(),
}))

const TEST_KEY = 'sk_test_' + 'A1b2C3d4E5f6G7h8'.repeat(2)
const LIVE_KEY = 'sk_live_' + 'Z9y8X7w6V5u4T3s2'.repeat(2)
const WHSEC    = 'whsec_' + 'k'.repeat(32)

const KEYS = ['STRIPE_MODE', 'STRIPE_SECRET_KEY', 'ENABLE_CHECKOUT', 'ENABLE_STRIPE_TEST_CHECKOUT', 'STRIPE_WEBHOOK_SECRET'] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

const withEnv = (e: Record<string, string>) => { for (const [k, v] of Object.entries(e)) process.env[k] = v }

describe('1. a valid sk_test_ key works in test mode (behaviour preserved)', () => {
  test('default mode (STRIPE_MODE unset)', () => {
    withEnv({ STRIPE_SECRET_KEY: TEST_KEY })
    expect(getStripe()).toBeInstanceOf(Stripe)
  })
  test.each(['test', 'TEST', ' test '])('STRIPE_MODE=%j', mode => {
    withEnv({ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_MODE: mode })
    expect(getStripe()).toBeInstanceOf(Stripe)
    expect(resolveStripeMode()).toBe('test')
  })
  test('the pre-existing validator contract is unchanged', () => {
    expect(isValidStripeTestSecretKey(TEST_KEY)).toBe(true)
    expect(isValidStripeTestSecretKey(LIVE_KEY)).toBe(false)
    expect(isValidStripeTestSecretKey('sk_test_x')).toBe(false)
    expect(isValidStripeTestSecretKey('rk_test_' + 'a'.repeat(24))).toBe(false)
  })
})

describe('2. a valid sk_live_ key is REJECTED unless live is explicitly opted into', () => {
  test.each([undefined, '', 'test'])('STRIPE_MODE=%j', mode => {
    withEnv({ STRIPE_SECRET_KEY: LIVE_KEY })
    if (mode !== undefined) process.env.STRIPE_MODE = mode
    expect(() => getStripe()).toThrow(/STRIPE_MODE/)
  })
  test('the error names the variables and never echoes the key', () => {
    withEnv({ STRIPE_SECRET_KEY: LIVE_KEY })
    let msg = ''
    try { getStripe() } catch (e: any) { msg = e.message }
    expect(msg).toMatch(/live key/i)
    expect(msg).toContain('STRIPE_MODE=live')
    expect(msg).not.toContain(LIVE_KEY)
    expect(msg).not.toContain(LIVE_KEY.slice(0, 16))
  })
})

describe('3. a valid sk_live_ key WORKS with explicit live opt-in', () => {
  test.each(['live', 'LIVE', ' live '])('STRIPE_MODE=%j builds a client', mode => {
    withEnv({ STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_MODE: mode })
    expect(resolveStripeMode()).toBe('live')
    expect(getStripe()).toBeInstanceOf(Stripe)
  })
  test('webhook signature verification works in live mode (it builds on getStripe)', async () => {
    withEnv({ STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_MODE: 'live' })
    const payload = JSON.stringify({ id: 'evt_live_1', object: 'event', type: 'checkout.session.completed',
                                     livemode: true, data: { object: { id: 'cs_live_1' } } })
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC })
    const ev = await verifyWebhookSignature(payload, header, WHSEC)
    expect(ev.id).toBe('evt_live_1')
    await expect(verifyWebhookSignature(payload + ' ', header, WHSEC)).rejects.toThrow()
  })
  test('webhook verification in test mode still works with a test key', async () => {
    withEnv({ STRIPE_SECRET_KEY: TEST_KEY })
    const payload = JSON.stringify({ id: 'evt_t_1', object: 'event', type: 'x', data: { object: {} } })
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC })
    expect((await verifyWebhookSignature(payload, header, WHSEC)).id).toBe('evt_t_1')
  })
  test('a TEST key is rejected under STRIPE_MODE=live (no half-configured live deployment)', () => {
    withEnv({ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_MODE: 'live' })
    expect(() => getStripe()).toThrow(/sk_live_/)
  })
})

describe('4. malformed keys and modes fail closed', () => {
  const bad = ['', 'sk_live_short', 'sk_test_short', 'rk_live_' + 'a'.repeat(30), 'rk_test_' + 'a'.repeat(30),
               'pk_live_' + 'a'.repeat(30), 'not-a-key', LIVE_KEY + '\n', ' ' + LIVE_KEY, LIVE_KEY + '!', 'sk_live_' + 'a-'.repeat(20)]
  test.each(bad)('rejects key %j in BOTH modes', key => {
    for (const mode of ['test', 'live']) {
      withEnv({ STRIPE_SECRET_KEY: key, STRIPE_MODE: mode })
      expect(() => getStripe()).toThrow()
    }
  })
  test('missing key throws', () => { expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not set.') })
  test.each(['livee', 'production', 'true', '1', 'liv e'])('unknown STRIPE_MODE=%j is rejected, not defaulted', mode => {
    withEnv({ STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_MODE: mode })
    expect(() => getStripe()).toThrow('STRIPE_MODE must be "test" or "live".')
    withEnv({ STRIPE_SECRET_KEY: TEST_KEY })
    expect(() => getStripe()).toThrow('STRIPE_MODE must be "test" or "live".')
  })
  test('validators accept only their own mode', () => {
    expect(isValidStripeLiveSecretKey(LIVE_KEY)).toBe(true)
    expect(isValidStripeLiveSecretKey(TEST_KEY)).toBe(false)
    expect(isValidStripeLiveSecretKey(undefined)).toBe(false)
    expect(() => assertStripeKeyForMode(LIVE_KEY, 'test')).toThrow()
    expect(() => assertStripeKeyForMode(TEST_KEY, 'live')).toThrow()
  })
})

describe('5. the checkout gate still defaults CLOSED and live can never be opened by the legacy flag', () => {
  test('nothing set -> closed', () => { expect(isCheckoutEnabled()).toBe(false) })
  test('wrangler.toml default (legacy flag "false") -> closed', () => {
    withEnv({ ENABLE_STRIPE_TEST_CHECKOUT: 'false' })
    expect(isCheckoutEnabled()).toBe(false)
  })
  test('legacy flag opens TEST mode only (backward compatible)', () => {
    withEnv({ ENABLE_STRIPE_TEST_CHECKOUT: 'true' })
    expect(isCheckoutEnabled()).toBe(true)
    withEnv({ STRIPE_MODE: 'test' })
    expect(isCheckoutEnabled()).toBe(true)
  })
  test('legacy flag can NEVER open live checkout', () => {
    withEnv({ ENABLE_STRIPE_TEST_CHECKOUT: 'true', STRIPE_MODE: 'live' })
    expect(isCheckoutEnabled()).toBe(false)
  })
  test('a misspelled STRIPE_MODE closes the legacy gate too', () => {
    withEnv({ ENABLE_STRIPE_TEST_CHECKOUT: 'true', STRIPE_MODE: 'prod' })
    expect(isCheckoutEnabled()).toBe(false)
  })
  test('canonical ENABLE_CHECKOUT=true opens it, in either mode', () => {
    withEnv({ ENABLE_CHECKOUT: 'true' }); expect(isCheckoutEnabled()).toBe(true)
    withEnv({ STRIPE_MODE: 'live' });      expect(isCheckoutEnabled()).toBe(true)
  })
  test('canonical wins over the legacy flag, so wrangler.toml\'s hard-coded "false" cannot block live and "true" cannot override a deliberate close', () => {
    withEnv({ ENABLE_CHECKOUT: 'true', ENABLE_STRIPE_TEST_CHECKOUT: 'false', STRIPE_MODE: 'live' })
    expect(isCheckoutEnabled()).toBe(true)
    withEnv({ ENABLE_CHECKOUT: 'false', ENABLE_STRIPE_TEST_CHECKOUT: 'true', STRIPE_MODE: 'test' })
    expect(isCheckoutEnabled()).toBe(false)
  })
  test.each(['TRUE', '1', 'yes', 'on', ' false ', 'enabled'])('ENABLE_CHECKOUT=%j is not "true" -> closed', v => {
    withEnv({ ENABLE_CHECKOUT: v, ENABLE_STRIPE_TEST_CHECKOUT: 'true' })
    expect(isCheckoutEnabled()).toBe(false)
  })
  test('the real route answers 503 by default and never reaches Stripe or the database', async () => {
    const { POST } = await import('../../app/api/checkout/session/route')
    const req: any = new Request('https://kvrn.shop/api/checkout/session', { method: 'POST', body: '{}' })
    req.nextUrl = new URL('https://kvrn.shop/api/checkout/session')
    const res = await POST(req as NextRequest)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('Checkout is not enabled.')
  }, 60_000)   // first import of the route compiles the checkout module graph under ts-jest
  test('with live mode but a TEST key, an enabled checkout fails closed with a config error (no reservation)', async () => {
    withEnv({ ENABLE_CHECKOUT: 'true', STRIPE_MODE: 'live', STRIPE_SECRET_KEY: TEST_KEY, SITE_URL: 'https://kvrn.shop' })
    const { POST } = await import('../../app/api/checkout/session/route')
    const { reserveInventory } = await import('@/lib/reservations')
    const req: any = new Request('https://kvrn.shop/api/checkout/session', { method: 'POST', body: '{}' })
    req.nextUrl = new URL('https://kvrn.shop/api/checkout/session')
    const res = await POST(req as NextRequest)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Payment configuration error.')
    expect(reserveInventory).not.toHaveBeenCalled()
  }, 60_000)
})

describe('6. no client bundle receives secret keys', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.open-next', '__tests__', '.git'].includes(e.name) || e.name.startsWith('backup-before')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p)
    }
    return out
  }
  const files = ['app', 'components', 'context', 'lib', 'data'].flatMap(d => fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)) : [])
  const clientFiles = files.filter(f => /^\s*['"]use client['"]/m.test(fs.readFileSync(f, 'utf8').slice(0, 400)))
  const SERVER_ONLY = /stripe-client|stripe-mode|STRIPE_SECRET_KEY|STRIPE_MODE|STRIPE_WEBHOOK_SECRET|ENABLE_CHECKOUT|ENABLE_STRIPE_TEST_CHECKOUT/

  test('there are client components to check', () => { expect(clientFiles.length).toBeGreaterThan(10) })
  test('no "use client" module imports or references the Stripe key/mode/secret modules or variables', () => {
    const offenders = clientFiles.filter(f => SERVER_ONLY.test(fs.readFileSync(f, 'utf8')))
    expect(offenders.map(f => path.relative(ROOT, f))).toEqual([])
  })
  test('no NEXT_PUBLIC_ variable carries a secret, and next.config.js does not inline env into the bundle', () => {
    const used = new Set<string>()
    for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) used.add(m[1])
    for (const name of used) expect(name).not.toMatch(/SECRET|STRIPE|TOKEN|PRIVATE|PASSWORD|API_KEY|LIVE/)
    expect(fs.readFileSync(path.join(ROOT, 'next.config.js'), 'utf8')).not.toMatch(/^\s*env\s*:/m)
  })
  test('only stripe-client / stripe-mode read the Stripe secret key or mode', () => {
    const readers = files.filter(f => /process\.env\.(STRIPE_SECRET_KEY|STRIPE_MODE)\b/.test(fs.readFileSync(f, 'utf8')))
    expect(readers.map(f => path.relative(ROOT, f)).sort()).toEqual(['lib/stripe-client.ts', 'lib/stripe-mode.ts'])
  })
  const staticDir = path.join(ROOT, '.next/static')
  ;(fs.existsSync(staticDir) ? test : test.skip)('built client assets (.next/static) contain no Stripe secret material', () => {
    const hits: string[] = []
    const scan = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) scan(p)
        else if (/\.(js|css|html|json|map)$/.test(e.name)) {
          const t = fs.readFileSync(p, 'utf8')
          if (/sk_(live|test)_[A-Za-z0-9]{8}|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|whsec_[A-Za-z0-9]{8}/.test(t)) hits.push(path.relative(ROOT, p))
        }
      }
    }
    scan(staticDir)
    expect(hits).toEqual([])
  })
})
