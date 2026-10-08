// lib/__tests__/abandoned-checkout-db.test.ts
//
// Abandoned-checkout recovery against REAL PostgreSQL (migrations 001-027 + 032, the real
// reserve_inventory / finalize_paid_order / release_expired_reservations). Substituted: the email
// provider (a recorder), the clock (injected), and validateDiscount (a stub; the real one is
// bound to the Neon HTTP driver).
//
// Requires a LOCAL TEST_DATABASE_URL; skips visibly otherwise.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { Client } from 'pg'
import { HAVE_DB, createFiDb, pgConfig, type FiDb } from './helpers/fi-pg'
import { createAbandonedCheckoutService, RetryError, recoverySendKey } from '../abandoned-checkout'
import { createResumeService } from '../abandoned-checkout-resume'
import { signToken, verifyToken } from '../abandoned-checkout-token'
import { putSetting } from '../site-settings'

const d = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test('NOTE: abandoned-checkout DB tests skipped — TEST_DATABASE_URL absent or not local.', () => expect(true).toBe(true))

const SECRET = 's3cr3t-'.repeat(8)
const FLAG = 'KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS'
const ENV_ON = { [FLAG]: 'on', ABANDONED_LINK_SECRET: SECRET, RESEND_API_KEY: 're_test', SITE_URL: 'https://kvrn.test' }
const ORIGIN = 'https://kvrn.test'
const PRICE = 8000
const SHIP = 700
const MIN = 60_000

let F: FiDb
let dbName = ''
let T = new Date()
const advance = (minutes: number) => { T = new Date(T.getTime() + minutes * MIN) }

const sent: any[] = []
let providerImpl: (m: any) => Promise<any> = async () => ({ ok: true, providerMessageId: 'msg_1' })
const provider = { send: jest.fn(async (m: any) => { sent.push(m); return providerImpl(m) }) }
const to = (email: string) => sent.filter(m => m.to === email)

let unsubscribed: string[] = []
const mk = (sqlx: () => any = () => F.sql, env: Record<string, string | undefined> = ENV_ON, extra: any = {}) =>
  createAbandonedCheckoutService(sqlx(), {
    now: () => T, env, getProvider: () => provider as any, getOrigin: () => ORIGIN,
    unsubscribeMarketing: async (e: string) => { unsubscribed.push(e) }, ...extra,
  })

const q = (t: string, p: unknown[] = []) => F.q(t, p)

function mkSql(c: Client): any {
  const run = async (s: TemplateStringsArray, ...v: unknown[]) => {
    let t = ''; s.forEach((p, i) => { t += p; if (i < v.length) t += `$${i + 1}` })
    return (await c.query(t, v as any[])).rows
  }
  return Object.assign(run, { query: (t: string, p: unknown[] = []) => c.query(t, p as any[]).then(r => r.rows) })
}
async function extraClients(n: number) {
  const { isLocal: _l, ...cfg } = pgConfig(dbName)
  const out: Client[] = []
  for (let i = 0; i < n; i++) { const c = new Client(cfg); await c.connect(); out.push(c) }
  return out
}

let seq = 0
async function mkVariant(stock: number, price = PRICE) {
  const n = ++seq
  const pid = `f3200000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const vid = `f3200001-0000-0000-0000-${String(n).padStart(12, '0')}`
  const sku = `KVRN-AB-${n}`
  await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
           VALUES ($1,'A',$2,'Recover Tee',$3,$4,true)`, [pid, `AB${n}`, `ab-${n}`, price])
  await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
           VALUES ($1,$2,$3,'Black','#000','M',1,0)`, [vid, pid, sku])
  if (stock > 0) {
    await q(`SELECT add_inventory_layer($1,$2,3000,'purchase',NULL,NULL,'cost_batch','jest')`, [vid, stock])
    await q(`UPDATE product_variants SET stock_on_hand=$2 WHERE id=$1`, [vid, stock])
  }
  return { vid, pid, sku }
}

/** reserve (real) + attach a Stripe session + shipping snapshot, like the checkout handler. */
async function startCheckout(sku: string, qty: number, email: string) {
  const n = ++seq
  const res = (await q(`SELECT reserve_inventory($1::jsonb, now() + interval '35 minutes') AS r`,
    [JSON.stringify([{ sku, quantity: qty }])]))[0].r
  const rid = res.reservation_id as string
  const session = `cs_test_ab_${n}_${crypto.randomBytes(3).toString('hex')}`
  await q(`SELECT attach_stripe_session($1::uuid,$2,extract(epoch from now()+interval '31 minutes')::bigint)`, [rid, session])
  await q(`SELECT save_reservation_checkout_details($1::uuid,$2,'Cust Name',NULL,
            '{"line1":"1 Main","city":"LA","state":"CA","postal_code":"90001","country":"US"}'::jsonb,
            'standard',$3,0,$3,NULL,NULL,NULL,0)`, [rid, email, SHIP])
  const items = res.items.map((i: any) => ({
    sku: i.sku, quantity: i.quantity, variantId: i.variant_id, productName: i.product_name,
    size: i.size, color: i.color, unitPriceCents: i.unit_price_cents,
  }))
  return { rid, session, email, qty, total: qty * PRICE + SHIP, items }
}

async function record(svc: ReturnType<typeof mk>, c: Awaited<ReturnType<typeof startCheckout>>, extra: any = {}) {
  return svc.recordCheckout({
    reservationId: c.rid, stripeSessionId: c.session, email: c.email, items: c.items,
    sessionExpiresAtUnix: Math.floor(Date.now() / 1000) + 31 * 60, locale: 'es-MX,es;q=0.9', ...extra,
  })
}

/** What the real world does when the customer walks away. */
async function expire(rid: string) {
  await q(`UPDATE reservations SET expires_at = now() - interval '10 minutes' WHERE id=$1`, [rid])
  await q(`SELECT release_expired_reservations()`)
}

let ev = 0
async function pay(c: { rid: string; session: string; total: number; email: string }) {
  const rows = await q(
    `SELECT finalize_paid_order($1,$2::uuid,$3,$4,'checkout.session.completed','usd',$5,$6,'Cust Name',NULL,NULL) AS r`,
    [c.session, c.rid, 'pi_' + c.session, `evt_ab_${++ev}`, c.total, c.email])
  return rows[0].r as any
}

const row = async (session: string) => (await q(`SELECT * FROM abandoned_checkouts WHERE stripe_checkout_session_id=$1`, [session]))[0]
const events = async (id: string) => (await q(`SELECT event_type FROM abandoned_checkout_events WHERE abandoned_checkout_id=$1 ORDER BY id`, [id])).map((r: any) => r.event_type)
const subscribe = (email: string, status = 'subscribed') =>
  q(`INSERT INTO marketing_subscribers (email,status,consent_source) VALUES ($1,$2,'footer')
     ON CONFLICT (email) DO UPDATE SET status=EXCLUDED.status, consented_at=now()`, [email, status])

const commerceSnapshot = async () => ({
  orders: await q(`SELECT id, payment_status, total_cents FROM orders ORDER BY id`),
  reservations: await q(`SELECT id, status, release_reason FROM reservations ORDER BY id`),
  stock: await q(`SELECT sku, stock_on_hand, reserved_quantity FROM product_variants ORDER BY sku`),
  moves: Number((await q(`SELECT count(*) AS n FROM inventory_movements`))[0].n),
  discounts: await q(`SELECT id, redemption_count FROM discounts ORDER BY id`),
})

/** A fully abandoned + opted-in checkout, ready for the delay to elapse. */
async function abandoned(email: string, opts: { stock?: number; qty?: number; optIn?: boolean; svc?: ReturnType<typeof mk> } = {}) {
  const svc = opts.svc ?? mk()
  const v = await mkVariant(opts.stock ?? 5)
  const c = await startCheckout(v.sku, opts.qty ?? 1, email)
  await record(svc, c)
  if (opts.optIn !== false) await subscribe(email)
  await expire(c.rid)
  await svc.sweep()
  return { svc, v, c }
}

beforeAll(async () => {
  if (!HAVE_DB) return
  F = await createFiDb('kvrn_abandoned')
  dbName = `kvrn_abandoned_${process.pid}`
}, 180_000)
afterAll(async () => { await F?.close() })

beforeEach(async () => {
  if (!HAVE_DB) return
  await q(`TRUNCATE abandoned_checkout_events, abandoned_checkouts, abandoned_checkout_suppressions RESTART IDENTITY CASCADE`)
  await q(`DELETE FROM marketing_subscribers`)
  await q(`DELETE FROM site_settings WHERE key='abandoned.config'`)
  sent.length = 0; unsubscribed = []
  provider.send.mockClear()
  providerImpl = async () => ({ ok: true, providerMessageId: 'msg_1' })
  T = new Date()
})

// ═════════════════════════════════════════════════════════════════════════════
d('migration 032', () => {
  const file = path.join(__dirname, '../../db/migrations/032_abandoned_checkouts.sql')

  test('re-applying is a no-op (idempotent) and keeps data', async () => {
    const svc = mk(); const v = await mkVariant(3)
    const c = await startCheckout(v.sku, 1, 'idem@a.test'); await record(svc, c)
    const before = await q(`SELECT id FROM abandoned_checkouts`)
    await F.db.query(fs.readFileSync(file, 'utf8'))
    await F.db.query(fs.readFileSync(file, 'utf8'))
    expect(await q(`SELECT id FROM abandoned_checkouts`)).toEqual(before)
  })

  test('only additive objects; no existing function/table is replaced', () => {
    const sql = fs.readFileSync(file, 'utf8').replace(/--.*$/gm, '')
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|FUNCTION|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i)
    const replaced = [...sql.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)/gi)].map(m => m[1])
    expect(replaced.sort()).toEqual(['abandoned_checkout_events_append_only', 'abandoned_checkout_payment_state', 'abandoned_checkout_queue'])
    expect(sql).not.toMatch(/ALTER TABLE\s+(orders|reservations|product_variants|products|discounts)\b/i)
  })

  test('events are append-only; states and one-order-one-link are enforced by the database', async () => {
    const svc = mk(); const v = await mkVariant(3)
    const c = await startCheckout(v.sku, 1, 'ao@a.test'); const r = await record(svc, c)
    expect(await F.err(`UPDATE abandoned_checkout_events SET event_type='x' WHERE abandoned_checkout_id=$1`, [r!.id])).toMatch(/append-only/)
    expect(await F.err(`DELETE FROM abandoned_checkout_events WHERE abandoned_checkout_id=$1`, [r!.id])).toMatch(/append-only/)
    expect(await F.err(`UPDATE abandoned_checkouts SET state='bogus' WHERE id=$1`, [r!.id])).toMatch(/ac_state_chk/)
    expect(await F.err(`UPDATE abandoned_checkouts SET state='ineligible' WHERE id=$1`, [r!.id])).toMatch(/ac_ineligible_reason_chk/)
    expect(await F.err(`UPDATE abandoned_checkouts SET manual_retries=2 WHERE id=$1`, [r!.id])).toMatch(/ac_manual_retries_chk/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('recording and abandonment', () => {
  test('a started checkout is recorded ONCE per session (re-record only touches activity)', async () => {
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 2, '  Buyer@Mail.TEST ')
    const a = await record(svc, c); const b = await record(svc, c)
    expect(a).toMatchObject({ created: true }); expect(b).toMatchObject({ created: false, id: a!.id })
    const r = await row(c.session)
    expect(r).toMatchObject({ state: 'active', email: 'buyer@mail.test', locale: 'es-MX', currency: 'usd' })
    expect(r.cart).toEqual([{
      sku: v.sku, quantity: 2, variantId: v.vid, productName: 'Recover Tee', size: 'M', color: 'Black', seenUnitPriceCents: PRICE,
    }])
    expect(await events(a!.id)).toEqual(['created'])
    expect((await q(`SELECT count(*) AS n FROM abandoned_checkouts`))[0].n).toBe('1')
  })

  test('the row never holds payment, address or phone data', async () => {
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'pii@a.test'); await record(svc, c)
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name='abandoned_checkouts'`)).map((r: any) => r.column_name)
    expect(cols.filter((n: string) => /card|pan|cvc|address|phone|name$|payment_method/.test(n))).toEqual([])
    expect(JSON.stringify(await row(c.session))).not.toMatch(/Main|90001|Cust Name/)
  })

  test('a still-open reservation is NOT abandoned; an expired one is, exactly once', async () => {
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'once@a.test'); await record(svc, c)
    let r1 = await svc.sweep()
    expect(r1.abandoned).toBe(0); expect((await row(c.session)).state).toBe('active')
    await expire(c.rid)
    r1 = await svc.sweep(); expect(r1.abandoned).toBe(1)
    const r2 = await svc.sweep(); expect(r2.abandoned).toBe(0)
    const r = await row(c.session)
    expect(r.state).toBe('abandoned'); expect(r.abandoned_at).not.toBeNull()
    expect(new Date(r.expires_at).getTime()).toBeGreaterThan(new Date(r.abandoned_at).getTime() + 71 * 60 * MIN / 60)
    expect((await events(r.id)).filter(e => e === 'abandoned')).toHaveLength(1)
  })

  test('an awaiting_payment reservation is never abandoned', async () => {
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'async@a.test'); await record(svc, c)
    await q(`UPDATE reservations SET status='awaiting_payment', expires_at = now() - interval '1 hour' WHERE id=$1`, [c.rid])
    await svc.sweep()
    expect((await row(c.session)).state).toBe('active')
  })

  test('a paid checkout becomes completed and is never abandoned or emailed', async () => {
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'paid@a.test'); await record(svc, c); await subscribe('paid@a.test')
    await pay(c)
    await svc.sweep(); advance(500); await svc.sweep()
    expect((await row(c.session)).state).toBe('completed')
    expect(sent).toHaveLength(0)
  })

  test('async payment failure is not nagged: ineligible payment_failed', async () => {
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'declined@a.test'); await record(svc, c); await subscribe('declined@a.test')
    await q(`SELECT release_reservation_for_event($1,'evt_pf','checkout.session.async_payment_failed','async_payment_failed')`, [c.session])
    await svc.sweep(); advance(120); await svc.sweep()
    expect(await row(c.session)).toMatchObject({ state: 'ineligible', ineligible_reason: 'payment_failed' })
    expect(sent).toHaveLength(0)
  })

  test('a late payment (after abandonment) completes the row and cancels the email', async () => {
    const { svc, c } = await abandoned('late@a.test')
    advance(30)
    await pay(c)   // finalize_paid_order recovers a released reservation (migration 022)
    advance(40)
    await svc.sweep()
    expect((await row(c.session)).state).toBe('completed')
    expect(to('late@a.test')).toHaveLength(0)
  })

  test('the original reservation is NOT kept alive by recovery', async () => {
    const { svc, c, v } = await abandoned('alive@a.test', { stock: 3 })
    advance(61); await svc.sweep()
    expect(to('alive@a.test')).toHaveLength(1)
    const res = (await q(`SELECT status FROM reservations WHERE id=$1`, [c.rid]))[0]
    expect(res.status).toBe('released')
    const st = (await q(`SELECT reserved_quantity AS r FROM product_variants WHERE id=$1`, [v.vid]))[0]
    expect(st.r).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('the single recovery email', () => {
  test('abandoned_checkout_queue() itself is the guard: once per row, once per address, never when paid/expired', async () => {
    const svc = mk(); const a = await mkVariant(5), b = await mkVariant(5), c3 = await mkVariant(5)
    const k1 = await startCheckout(a.sku, 1, 'fn@a.test'), k2 = await startCheckout(b.sku, 1, 'fn@a.test'), k3 = await startCheckout(c3.sku, 1, 'fn3@a.test')
    for (const k of [k1, k2, k3]) await record(svc, k)
    for (const k of [k1, k2, k3]) await expire(k.rid)
    await svc.sweep()
    const id = async (k: { session: string }) => (await row(k.session)).id
    const queue = async (k: { session: string }) =>
      (await q(`SELECT abandoned_checkout_queue($1::uuid, $2::timestamptz, 7) AS ok`, [await id(k), T.toISOString()]))[0].ok
    expect(await queue(k1)).toBe(true)
    expect(await queue(k1)).toBe(false)          // same row again
    expect(await queue(k2)).toBe(false)          // same address inside the cooldown
    await pay(k3)
    expect(await queue(k3)).toBe(false)          // paid
    await q(`UPDATE abandoned_checkouts SET expires_at = $1 WHERE stripe_checkout_session_id=$2`, [new Date(T.getTime() - 1000).toISOString(), k2.session])
    expect(await queue(k2)).toBe(false)          // expired
    expect((await row(k1.session)).recovery_send_key).toBe(recoverySendKey(await id(k1)))
  })

  test('nothing is queued before the delay; one email after it', async () => {
    const { svc, c } = await abandoned('delay@a.test')
    advance(30); await svc.sweep()
    expect(sent).toHaveLength(0); expect((await row(c.session)).state).toBe('abandoned')
    advance(31); const r = await svc.sweep()
    expect(r).toMatchObject({ queued: 1, sent: 1 })
    expect(to('delay@a.test')).toHaveLength(1)
    expect(await row(c.session)).toMatchObject({ state: 'recovery_sent', recovery_attempts: 1, provider_message_id: 'msg_1' })
  })

  test('ONE email despite repeated cron runs', async () => {
    const { svc } = await abandoned('rep@a.test')
    advance(61)
    for (let i = 0; i < 5; i++) { await svc.sweep(); advance(6) }
    expect(to('rep@a.test')).toHaveLength(1)
  })

  test('ONE email despite CONCURRENT sweeps from independent connections', async () => {
    const { c } = await abandoned('conc@a.test')
    advance(61)
    const clients = await extraClients(4)
    try {
      const svcs = clients.map(cl => mk(() => mkSql(cl)))
      await Promise.all(svcs.map(s => s.sweep()))
      await Promise.all(svcs.map(s => s.sweep()))
      expect(to('conc@a.test')).toHaveLength(1)
      expect(await row(c.session)).toMatchObject({ state: 'recovery_sent', recovery_attempts: 1 })
      expect((await events((await row(c.session)).id)).filter(e => e === 'sent')).toHaveLength(1)
    } finally { await Promise.all(clients.map(cl => cl.end())) }
  })

  test('the idempotent key is deterministic, unique and sent to the provider', async () => {
    const { svc, c } = await abandoned('key@a.test')
    advance(61); await svc.sweep()
    const r = await row(c.session)
    expect(r.recovery_send_key).toBe(recoverySendKey(r.id))
    expect(to('key@a.test')[0].idempotencyKey).toBe(r.recovery_send_key)
    expect(await F.err(`UPDATE abandoned_checkouts SET recovery_send_key=$1 WHERE id <> $2`, [r.recovery_send_key, r.id])).toBe('')
  })

  test('the email: saved-bag context only, signed recover link, unsubscribe link and header, localized', async () => {
    const { svc, c } = await abandoned('mail@a.test', { qty: 2 })
    advance(61); await svc.sweep()
    const m = to('mail@a.test')[0]
    expect(m.subject).toBe('Tu bolsa de KVRN está guardada')   // stored locale es-MX
    expect(m.html).toContain('Recover Tee'); expect(m.html).toContain('Cant. 2')
    expect(m.html).not.toMatch(/\$\s?\d|8000|80\.00|Main|90001|Cust Name|cs_test|\b[0-9a-f]{8}-[0-9a-f]{4}-/)
    const link = /href="(https:\/\/kvrn\.test\/checkout\/recover\?t=([^"]+))"/.exec(m.html)!
    expect(link).toBeTruthy()
    const id = (await row(c.session)).id
    const v = verifyToken(SECRET, link[2], 'recover')
    expect(v).toMatchObject({ ok: true, id })
    expect(m.html).toContain('https://kvrn.test/api/checkout/recover/unsubscribe?t=')
    expect(m.headers['List-Unsubscribe']).toMatch(/^<https:\/\/kvrn\.test\/api\/checkout\/recover\/unsubscribe\?t=/)
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(m.html).not.toContain(id)   // no internal id in cleartext anywhere in the mail
  })

  test('an English email when the locale has no strings', async () => {
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'ja@a.test'); await record(svc, c, { locale: 'ja-JP' }); await subscribe('ja@a.test')
    await expire(c.rid); await svc.sweep(); advance(61); await svc.sweep()
    expect(to('ja@a.test')[0].subject).toBe('Your KVRN bag is saved')
  })

  test('no email AFTER a paid order: paid between queue and send', async () => {
    const { svc, c } = await abandoned('race@a.test')
    advance(61)
    await svc._steps.stepQueue(T.toISOString(), (await svc.getConfig()).config)
    expect((await row(c.session)).state).toBe('recovery_queued')
    await pay(c)                      // the customer pays (late payment recovery) before the send step
    await svc.sweep()
    expect(sent).toHaveLength(0)
    expect((await row(c.session)).state).toBe('completed')
  })

  test('no email when the customer ordered the same thing in another checkout', async () => {
    const { svc, c } = await abandoned('again@a.test')
    const v2 = await mkVariant(5)
    const c2 = await startCheckout(v2.sku, 1, 'again@a.test'); await pay(c2)
    advance(61); await svc.sweep()
    expect(sent).toHaveLength(0)
    expect(await row(c.session)).toMatchObject({ state: 'ineligible', ineligible_reason: 'customer_purchased' })
  })

  test('no email after the window expires; the row becomes expired', async () => {
    const { svc, c } = await abandoned('exp@a.test')
    // Keep the flag OFF while the window elapses, then turn it on: stale carts are never mailed.
    const off = mk(() => F.sql, { ...ENV_ON, [FLAG]: 'off' })
    advance(60 * 80); await off.sweep()
    await svc.sweep()
    expect(sent).toHaveLength(0)
    expect((await row(c.session)).state).toBe('expired')
  })

  test('a queued email whose window closes before it can be sent is expired, never sent', async () => {
    const { svc, c } = await abandoned('exp2@a.test')
    advance(61)
    await svc._steps.stepQueue(T.toISOString(), (await svc.getConfig()).config)
    advance(60 * 73)
    await svc.sweep()
    expect(sent).toHaveLength(0); expect((await row(c.session)).state).toBe('expired')
  })

  test('per-address cooldown: two abandoned bags for one address get ONE reminder (even concurrently)', async () => {
    const svc = mk()
    const a = await mkVariant(5), b = await mkVariant(5)
    const c1 = await startCheckout(a.sku, 1, 'cool@a.test'), c2 = await startCheckout(b.sku, 1, 'cool@a.test')
    await record(svc, c1); await record(svc, c2); await subscribe('cool@a.test')
    await expire(c1.rid); await expire(c2.rid); await svc.sweep()
    advance(61)
    const clients = await extraClients(2)
    try {
      const svcs = clients.map(cl => mk(() => mkSql(cl)))
      await Promise.all(svcs.map(s => s.sweep()))
      await Promise.all(svcs.map(s => s.sweep()))
      advance(10); await svc.sweep()
    } finally { await Promise.all(clients.map(cl => cl.end())) }
    expect(to('cool@a.test')).toHaveLength(1)
    const states = [(await row(c1.session)).state, (await row(c2.session)).state].sort()
    expect(states).toEqual(['ineligible', 'recovery_sent'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('feature flag and delivery readiness', () => {
  test('flag OFF: abandonment is still recorded, NOTHING is queued or sent, link is disabled', async () => {
    const off = mk(() => F.sql, { ...ENV_ON, [FLAG]: undefined })
    const { c } = await abandoned('off@a.test', { svc: off })
    advance(61); const r = await off.sweep()
    expect(r.sendSkipped).toBe('flag_off'); expect(r.queued).toBe(0); expect(r.sent).toBe(0)
    expect(sent).toHaveLength(0)
    expect((await row(c.session)).state).toBe('abandoned')
    expect(await off.resolveRecovery('v1.aaaaaaaaaa.bbbbbbbbbb')).toEqual({ status: 'disabled' })
    // even a perfectly valid token is refused while the flag is off
    const id = (await row(c.session)).id
    const tok = signToken(SECRET, { purpose: 'recover', id, expiresAtSec: Math.floor(T.getTime() / 1000) + 3600 })
    expect(await off.resolveRecovery(tok)).toEqual({ status: 'disabled' })
    expect(await off.manualRetry(id).catch(e => e.code)).toBe('disabled')
  })

  test('flag ON and OFF: turning it on later mails only rows still inside their window', async () => {
    const off = mk(() => F.sql, { ...ENV_ON, [FLAG]: 'no' })
    const { c } = await abandoned('flip@a.test', { svc: off })
    advance(61); await off.sweep(); expect(sent).toHaveLength(0)
    await mk().sweep()
    expect(to('flip@a.test')).toHaveLength(1)
    expect((await row(c.session)).state).toBe('recovery_sent')
  })

  test('config.enabled = false also stops sending', async () => {
    await putSetting(F.sql, 'abandoned.config', { enabled: false, delay_minutes: 60, max_emails: 1, consent_mode: 'require_opt_in', window_hours: 72 }, 0, 'o@k.test')
    const { svc } = await abandoned('cfgoff@a.test')
    advance(61); const r = await svc.sweep()
    expect(r.sendSkipped).toBe('config_disabled'); expect(sent).toHaveLength(0)
  })

  test('configurable delay is honoured', async () => {
    await putSetting(F.sql, 'abandoned.config', { enabled: true, delay_minutes: 240, max_emails: 1, consent_mode: 'require_opt_in', window_hours: 72 }, 0, 'o@k.test')
    const { svc } = await abandoned('slow@a.test')
    advance(180); await svc.sweep(); expect(sent).toHaveLength(0)
    advance(61); await svc.sweep(); expect(to('slow@a.test')).toHaveLength(1)
  })

  test('missing link secret / provider: fail closed, nothing claimed, nothing sent', async () => {
    const { c } = await abandoned('nosecret@a.test')
    advance(61)
    const noSecret = mk(() => F.sql, { ...ENV_ON, ABANDONED_LINK_SECRET: 'short' })
    expect((await noSecret.sweep()).sendSkipped).toBe('link_not_configured')
    const noProv = mk(() => F.sql, ENV_ON, { getProvider: () => { throw new Error('RESEND_API_KEY is not set') } })
    expect((await noProv.sweep()).sendSkipped).toBe('provider_not_configured')
    expect(sent).toHaveLength(0)
    expect(await row(c.session)).toMatchObject({ state: 'recovery_queued', recovery_attempts: 0 })
    expect(await noSecret.resolveRecovery('x'.repeat(30))).toEqual({ status: 'unconfigured' })
    expect(await noSecret.unsubscribeByToken('x'.repeat(30))).toEqual({ status: 'unconfigured' })
    // ...and once configured it sends exactly once
    await mk().sweep(); await mk().sweep()
    expect(to('nosecret@a.test')).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('consent and unsubscribe', () => {
  const run = async (email: string, mode: string, prep?: () => Promise<unknown>) => {
    await putSetting(F.sql, 'abandoned.config',
      { enabled: true, delay_minutes: 60, max_emails: 1, consent_mode: mode, window_hours: 72 },
      (await q(`SELECT revision FROM site_settings WHERE key='abandoned.config'`))[0]?.revision ?? 0, 'o@k.test')
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, email); await record(svc, c)
    if (prep) await prep()
    await expire(c.rid); await svc.sweep(); advance(61); await svc.sweep()
    return { r: await row(c.session), n: to(email).length }
  }

  test('DEFAULT require_opt_in: no marketing record => not emailed', async () => {
    const { r, n } = await run('none@a.test', 'require_opt_in')
    expect(n).toBe(0); expect(r).toMatchObject({ state: 'ineligible', ineligible_reason: 'no_consent' })
  })
  test('require_opt_in: subscribed => emailed once', async () => {
    const { r, n } = await run('sub@a.test', 'require_opt_in', () => subscribe('sub@a.test'))
    expect(n).toBe(1); expect(r.state).toBe('recovery_sent')
  })
  test('require_opt_in: unsubscribed => never', async () => {
    const { r, n } = await run('unsub@a.test', 'require_opt_in', () => subscribe('unsub@a.test', 'unsubscribed'))
    expect(n).toBe(0); expect(r).toMatchObject({ state: 'ineligible', ineligible_reason: 'suppressed' })
  })
  test('cart_reminder_no_consent: no record => emailed', async () => {
    const { r, n } = await run('nc@a.test', 'cart_reminder_no_consent')
    expect(n).toBe(1); expect(r.state).toBe('recovery_sent')
  })
  test('cart_reminder_no_consent: an unsubscribed address is STILL excluded', async () => {
    const { r, n } = await run('nc2@a.test', 'cart_reminder_no_consent', () => subscribe('nc2@a.test', 'unsubscribed'))
    expect(n).toBe(0); expect(r).toMatchObject({ ineligible_reason: 'suppressed' })
  })
  test('cart_reminder_no_consent: a recovery-email suppression is honoured', async () => {
    const { r, n } = await run('nc3@a.test', 'cart_reminder_no_consent',
      () => q(`INSERT INTO abandoned_checkout_suppressions (email) VALUES ('nc3@a.test')`).then(() => {}))
    expect(n).toBe(0); expect(r.ineligible_reason).toBe('suppressed')
  })
  test('a LATER explicit re-subscribe lifts a recovery suppression', async () => {
    const { r, n } = await run('re@a.test', 'require_opt_in', async () => {
      await q(`INSERT INTO abandoned_checkout_suppressions (email, created_at) VALUES ('re@a.test', now() - interval '2 days')`)
      await subscribe('re@a.test')
    })
    expect(n).toBe(1); expect(r.state).toBe('recovery_sent')
  })

  test('consent is checked AGAIN at send time: unsubscribing after queueing stops the email', async () => {
    const { svc, c } = await abandoned('late-unsub@a.test')
    advance(61)
    await svc._steps.stepQueue(T.toISOString(), (await svc.getConfig()).config)
    await subscribe('late-unsub@a.test', 'unsubscribed')
    await svc.sweep()
    expect(sent).toHaveLength(0)
    expect(await row(c.session)).toMatchObject({ state: 'ineligible', ineligible_reason: 'suppressed' })
  })

  test('the unsubscribe link suppresses the address, runs the marketing unsubscribe, and blocks later carts', async () => {
    const { svc, c } = await abandoned('bye@a.test')
    advance(61); await svc.sweep()
    const id = (await row(c.session)).id
    const tok = signToken(SECRET, { purpose: 'unsubscribe', id, expiresAtSec: Math.floor(T.getTime() / 1000) + 3600 })
    expect(await svc.unsubscribeByToken(tok)).toEqual({ status: 'ok' })
    expect(await svc.unsubscribeByToken(tok)).toEqual({ status: 'ok' })   // idempotent
    expect(unsubscribed).toContain('bye@a.test')
    expect(await q(`SELECT email FROM abandoned_checkout_suppressions`)).toEqual([{ email: 'bye@a.test' }])
    // a recover token is NOT an unsubscribe token
    const rt = signToken(SECRET, { purpose: 'recover', id, expiresAtSec: Math.floor(T.getTime() / 1000) + 3600 })
    expect(await svc.unsubscribeByToken(rt)).toEqual({ status: 'invalid' })
    // next abandoned bag for the same address: not emailed
    const v = await mkVariant(5); const c2 = await startCheckout(v.sku, 1, 'bye@a.test'); await record(svc, c2)
    await expire(c2.rid); await svc.sweep(); advance(60 * 24 * 8); await svc.sweep()
    expect(await row(c2.session)).toMatchObject({ state: 'ineligible', ineligible_reason: 'suppressed' })
    expect(to('bye@a.test')).toHaveLength(1)
  })

  test('unsubscribe works even with the feature flag OFF; garbage tokens never throw', async () => {
    const off = mk(() => F.sql, { ...ENV_ON, [FLAG]: undefined })
    const { c } = await abandoned('offunsub@a.test', { svc: off })
    const id = (await row(c.session)).id
    const tok = signToken(SECRET, { purpose: 'unsubscribe', id, expiresAtSec: Math.floor(T.getTime() / 1000) + 3600 })
    expect(await off.unsubscribeByToken(tok)).toEqual({ status: 'ok' })
    for (const bad of [undefined, null, '', 'v1.x.y', 'a'.repeat(5000), 42, {}]) {
      expect(await off.unsubscribeByToken(bad as any)).toEqual({ status: 'invalid' })
    }
  })

  test('clicks are tracked only for opted-in addresses (never for no-consent reminders)', async () => {
    await putSetting(F.sql, 'abandoned.config', { enabled: true, delay_minutes: 60, max_emails: 1, consent_mode: 'cart_reminder_no_consent', window_hours: 72 }, 0, 'o@k.test')
    const svc = mk()
    const a = await abandoned('clk-sub@a.test', { svc }); const b = await abandoned('clk-none@a.test', { svc, optIn: false })
    advance(61); await svc.sweep()
    const ra = (await svc.loadRow((await row(a.c.session)).id))!, rb = (await svc.loadRow((await row(b.c.session)).id))!
    expect(await svc.recordClick(ra)).toBe(true); expect(await svc.recordClick(rb)).toBe(false)
    expect((await row(a.c.session)).recovery_click_count).toBe(1)
    expect((await row(b.c.session)).recovery_click_count).toBe(0)
    expect(await events(ra.id)).toContain('clicked'); expect(await events(rb.id)).not.toContain('clicked')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('provider failure never touches commerce', () => {
  test('failure => send_failed, bounded retries with back-off, orders/reservations/stock untouched', async () => {
    const { svc, c } = await abandoned('fail@a.test')
    await pay((await (async () => { const v = await mkVariant(5); return startCheckout(v.sku, 1, 'other@a.test') })()))   // an unrelated paid order
    const before = await commerceSnapshot()
    providerImpl = async () => ({ ok: false, message: 'Email provider returned HTTP 500 for fail@a.test.' })
    advance(61); await svc.sweep()
    let r = await row(c.session)
    expect(r).toMatchObject({ state: 'send_failed', recovery_attempts: 1 })
    expect(r.last_error).not.toContain('@')            // PII scrubbed
    expect(new Date(r.next_attempt_at).getTime()).toBe(T.getTime() + 15 * MIN)
    expect(await commerceSnapshot()).toEqual(before)

    advance(5); await svc.sweep(); expect(sent).toHaveLength(1)           // not due yet
    advance(11); await svc.sweep(); expect(sent).toHaveLength(2)          // retry 1
    advance(61); await svc.sweep(); expect(sent).toHaveLength(3)          // retry 2 (last automatic)
    r = await row(c.session)
    expect(r).toMatchObject({ state: 'send_failed', recovery_attempts: 3, next_attempt_at: null })
    advance(60 * 5); await svc.sweep(); await svc.sweep(); expect(sent).toHaveLength(3)   // exhausted
    expect(await commerceSnapshot()).toEqual(before)
    // every attempt reused the SAME idempotency key
    expect(new Set(sent.map(m => m.idempotencyKey)).size).toBe(1)
  })

  test('a provider that throws is handled like a failure', async () => {
    const { svc, c } = await abandoned('throw@a.test')
    providerImpl = async () => { throw new Error('socket hang up') }
    advance(61); const r = await svc.sweep()
    expect(r.failed).toBe(1); expect((await row(c.session)).state).toBe('send_failed')
  })

  test('manual retry: exactly ONE extra attempt, once per row, audited at the route, never past conditions', async () => {
    const { svc, c } = await abandoned('manual@a.test')
    providerImpl = async () => ({ ok: false, message: 'HTTP 503' })
    advance(61); await svc.sweep(); advance(20); await svc.sweep(); advance(70); await svc.sweep()
    const id = (await row(c.session)).id
    expect((await row(c.session)).recovery_attempts).toBe(3)
    await expect(svc.manualRetry(id)).resolves.toEqual({ ok: true })
    expect(await row(c.session)).toMatchObject({ state: 'recovery_queued', manual_retries: 1 })
    await svc.sweep(); expect(sent).toHaveLength(4)
    expect((await row(c.session)).state).toBe('send_failed')
    await expect(svc.manualRetry(id)).rejects.toMatchObject({ code: 'not_retryable' })
    advance(60 * 5); await svc.sweep(); expect(sent).toHaveLength(4)       // no unlimited resend loop
    await expect(svc.manualRetry('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(RetryError)
  })

  test('manual retry is refused for rows that are not failed sends (no resend after success)', async () => {
    const { svc, c } = await abandoned('okrow@a.test')
    advance(61); await svc.sweep()
    await expect(svc.manualRetry((await row(c.session)).id)).rejects.toMatchObject({ code: 'not_retryable' })
    await svc.sweep(); expect(to('okrow@a.test')).toHaveLength(1)
  })

  test('a send that crashed after claiming is retried with the SAME idempotency key (lease expiry)', async () => {
    const { svc, c } = await abandoned('lease@a.test')
    advance(61)
    await svc._steps.stepQueue(T.toISOString(), (await svc.getConfig()).config)
    await q(`UPDATE abandoned_checkouts SET send_claimed_at=$1, recovery_attempts=1 WHERE stripe_checkout_session_id=$2`, [T.toISOString(), c.session])
    await svc.sweep(); expect(sent).toHaveLength(0)         // lease still held
    advance(11); await svc.sweep()
    expect(to('lease@a.test')).toHaveLength(1)
    expect(to('lease@a.test')[0].idempotencyKey).toBe(recoverySendKey((await row(c.session)).id))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('resume: revalidation from canonical data', () => {
  const stubDiscount = (impl: any = async () => ({ valid: true, discount: {} })) => ({ validateDiscount: jest.fn(impl) as any })

  async function sentRow(email: string, o: { stock?: number; qty?: number; discount?: string; currency?: string; bundle?: unknown } = {}) {
    const svc = mk(); const v = await mkVariant(o.stock ?? 5)
    const c = await startCheckout(v.sku, o.qty ?? 2, email)
    await record(svc, c, { discountCode: o.discount ?? null, currency: o.currency, bundleContext: o.bundle })
    await subscribe(email); await expire(c.rid); await svc.sweep(); advance(61); await svc.sweep()
    const r = (await svc.loadRow((await row(c.session)).id))!
    return { svc, v, c, r }
  }

  test('happy path: bag rebuilt from canonical data, no stock held, original reservation untouched', async () => {
    const { r, v, c } = await sentRow('res1@a.test', { qty: 2 })
    const before = await commerceSnapshot()
    const out = await createResumeService(F.sql, stubDiscount()).resume(r)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.cart).toHaveLength(1)
    expect(out.cart[0]).toMatchObject({ sku: v.sku, quantity: 2, price: PRICE, size: 'M', colorName: 'Black' })
    expect(out.subtotalCents).toBe(2 * PRICE); expect(out.priceChanged).toBe(false); expect(out.notices).toEqual([])
    expect(await commerceSnapshot()).toEqual(before)                // read-only: nothing reserved or written
    expect((await q(`SELECT status FROM reservations WHERE id=$1`, [c.rid]))[0].status).toBe('released')
  })

  test('stock re-validated fail-closed: sold out => clear failure; short => reduced; never oversold', async () => {
    const { r, v } = await sentRow('res2@a.test', { qty: 3, stock: 5 })
    const svc = createResumeService(F.sql, stubDiscount())
    await q(`UPDATE product_variants SET stock_on_hand=0 WHERE id=$1`, [v.vid])
    expect(await svc.resume(r)).toEqual({ ok: false, code: 'all_unavailable' })
    await q(`UPDATE product_variants SET stock_on_hand=2 WHERE id=$1`, [v.vid])
    const out = await svc.resume(r)
    expect(out.ok && out.lines[0]).toMatchObject({ status: 'reduced', quantity: 2, requestedQuantity: 3 })
    expect(out.ok && out.notices.map(n => n.code)).toContain('quantity_reduced')
    // someone else holds the remaining units: available = on_hand - reserved
    await q(`UPDATE product_variants SET reserved_quantity=2 WHERE id=$1`, [v.vid])
    expect(await svc.resume(r)).toEqual({ ok: false, code: 'all_unavailable' })
    // the real reservation path (used by the unchanged checkout) refuses too: nothing oversold
    await expect(q(`SELECT reserve_inventory($1::jsonb, now() + interval '35 minutes')`, [JSON.stringify([{ sku: v.sku, quantity: 1 }])]))
      .rejects.toThrow(/OUT_OF_STOCK|INSUFFICIENT_STOCK/)
  })

  test('inactive product / variant / unknown SKU are dropped and listed', async () => {
    const { r, v } = await sentRow('res3@a.test')
    const svc = createResumeService(F.sql, stubDiscount())
    await q(`UPDATE products SET active=false WHERE id=$1`, [v.pid])
    expect(await svc.resume(r)).toEqual({ ok: false, code: 'all_unavailable' })
    await q(`UPDATE products SET active=true WHERE id=$1`, [v.pid])
    await q(`UPDATE product_variants SET active=false WHERE id=$1`, [v.vid])
    expect(await svc.resume(r)).toEqual({ ok: false, code: 'all_unavailable' })
    const ghost = { ...r, cart: [...r.cart, { sku: 'KVRN-NOPE', quantity: 1, variantId: null, productName: 'Gone', size: 'M', color: 'Black', seenUnitPriceCents: 100 }] }
    await q(`UPDATE product_variants SET active=true WHERE id=$1`, [v.vid])
    const out = await svc.resume(ghost as any)
    expect(out.ok && out.lines.map(l => [l.sku, l.status, l.reason])).toEqual([[v.sku, 'ok', undefined], ['KVRN-NOPE', 'unavailable', 'not_found']])
    expect(out.ok && out.notices.map(n => n.code)).toContain('items_removed')
  })

  test('CHANGED PRICE is handled honestly: current price used, change reported before payment', async () => {
    const { r, v } = await sentRow('res4@a.test', { qty: 2 })
    await q(`UPDATE products SET price_cents=9500 WHERE id=$1`, [v.pid])
    const out = await createResumeService(F.sql, stubDiscount()).resume(r)
    expect(out.ok).toBe(true); if (!out.ok) return
    expect(out.cart[0].price).toBe(9500); expect(out.subtotalCents).toBe(19000)
    expect(out.priceChanged).toBe(true)
    expect(out.lines[0]).toMatchObject({ unitPriceCents: 9500, seenUnitPriceCents: PRICE, priceChanged: true })
    expect(out.notices.map(n => n.code)).toContain('price_changed')
  })

  test('CONTRACT: the price shown equals the price the real reserve_inventory would snapshot', async () => {
    const { r, v } = await sentRow('res5@a.test', { qty: 1 })
    await q(`UPDATE products SET price_cents=12345 WHERE id=$1`, [v.pid])
    const out = await createResumeService(F.sql, stubDiscount()).resume(r)
    const res = (await q(`SELECT reserve_inventory($1::jsonb, now() + interval '35 minutes') AS r`, [JSON.stringify([{ sku: v.sku, quantity: 1 }])]))[0].r
    expect(out.ok && out.lines[0].unitPriceCents).toBe(Number(res.items[0].unit_price_cents))
  })

  test('STALE/EXPIRED discount is reported and never resurrected; a valid one is only reported', async () => {
    const { r } = await sentRow('res6@a.test', { discount: 'KVRN-OLD' })
    const dsc = stubDiscount(async () => ({ valid: false, error: 'That code has expired.', reason: 'expired' }))
    const out = await createResumeService(F.sql, dsc).resume(r)
    expect(out.ok && out.discount).toMatchObject({ code: 'KVRN-OLD', status: 'expired' })
    expect(out.ok && out.notices.map(n => n.code)).toContain('discount_not_applied')
    expect(dsc.validateDiscount).toHaveBeenCalledWith('KVRN-OLD', expect.objectContaining({ subtotalCents: 2 * PRICE }))
    expect((await q(`SELECT count(*) AS n FROM discount_redemptions`).catch(() => [{ n: '0' }]))[0].n).toBe('0')   // nothing claimed
    const ok = await createResumeService(F.sql, stubDiscount()).resume(r)
    expect(ok.ok && ok.discount).toMatchObject({ status: 'valid' })
    const sh = await createResumeService(F.sql, stubDiscount(async () => ({ valid: false, error: 'no', reason: 'shipping_restricted' }))).resume(r)
    expect(sh.ok && sh.discount).toMatchObject({ status: 'recheck' })
    const boom = await createResumeService(F.sql, stubDiscount(async () => { throw new Error('db down') })).resume(r)
    expect(boom.ok && boom.discount).toMatchObject({ status: 'unavailable' })
  })

  test('UNSUPPORTED currency falls back to USD with a notice (no FX, no failure)', async () => {
    const { r } = await sentRow('res7@a.test', { currency: 'EUR' })
    expect(r.currency).toBe('eur')
    const out = await createResumeService(F.sql, stubDiscount()).resume(r)
    expect(out).toMatchObject({ ok: true, currency: 'usd', currencyFellBack: true })
    expect(out.ok && out.notices.map(n => n.code)).toContain('currency_fallback')
  })

  test('BUNDLE components are revalidated all-or-nothing', async () => {
    const svc = mk(); const a = await mkVariant(5), b = await mkVariant(5)
    const c = await startCheckout(a.sku, 1, 'bun@a.test')
    const items = [...c.items, { sku: b.sku, quantity: 1, variantId: b.vid, productName: 'Recover Tee', size: 'M', color: 'Black', unitPriceCents: PRICE }]
    await record(svc, { ...c, items } as any, { bundleContext: { components: [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 1 }] } })
    await subscribe('bun@a.test'); await expire(c.rid); await svc.sweep(); advance(61); await svc.sweep()
    const r = (await svc.loadRow((await row(c.session)).id))!
    const rs = createResumeService(F.sql, stubDiscount())
    const full = await rs.resume(r)
    expect(full.ok && full.lines.every(l => l.status === 'ok')).toBe(true)
    await q(`UPDATE product_variants SET stock_on_hand=0 WHERE id=$1`, [b.vid])
    const broken = await rs.resume(r)
    expect(broken).toEqual({ ok: false, code: 'all_unavailable' })   // BOTH components dropped, not a half bundle
  })

  test('affiliate attribution: a stored session id is returned only with a real click behind it', async () => {
    const sid = 'A'.repeat(43)
    const { r } = await sentRow('res8@a.test')
    const rs = createResumeService(F.sql, stubDiscount())
    expect((await rs.resume({ ...r, affiliate_session_id: sid })) as any).toMatchObject({ ok: true, affiliateSessionId: null })
    expect((await rs.resume({ ...r, affiliate_session_id: 'not valid!' })) as any).toMatchObject({ affiliateSessionId: null })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('recovery link', () => {
  async function sentFor(email: string) {
    const { svc, c } = await abandoned(email)
    advance(61); await svc.sweep()
    const id = (await row(c.session)).id
    const exp = Math.floor(new Date((await row(c.session)).expires_at).getTime() / 1000)
    return { svc, c, id, exp, tok: signToken(SECRET, { purpose: 'recover', id, expiresAtSec: exp }) }
  }

  test('a valid link resolves; used-up (paid) / expired / tampered / forged / wrong-purpose never 500', async () => {
    const { svc, id, exp, tok, c } = await sentFor('lnk@a.test')
    expect(await svc.resolveRecovery(tok)).toMatchObject({ status: 'ok', row: { id } })

    const parts = tok.split('.')

    // Deterministically alter an unused signature encoding bit.
    // The decoded MAC stays identical, but the token must be rejected.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = parts[2].slice(-1)
    const aliasLast = alphabet[alphabet.indexOf(last) ^ 1]
    const nonCanonicalSignature =
      `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${aliasLast}`

    expect(Buffer.from(nonCanonicalSignature.split('.')[2], 'base64url'))
      .toEqual(Buffer.from(parts[2], 'base64url'))

    const tampered = [
      nonCanonicalSignature,
      `${parts[0]}.${Buffer.from(JSON.stringify({ p: 'r', a: id, e: exp + 99999 })).toString('base64url')}.${parts[2]}`,
      `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`,
      tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A'),
      signToken('f'.repeat(48), { purpose: 'recover', id, expiresAtSec: exp }),            // forged with another secret
      signToken(SECRET, { purpose: 'unsubscribe', id, expiresAtSec: exp }),                // wrong purpose
      signToken(SECRET, { purpose: 'recover', id: '11111111-2222-4333-8444-555555555555', expiresAtSec: exp }),   // unknown id
      '', 'garbage', 'v1..', 'v1.a.b', '😀'.repeat(50), 'x'.repeat(10_000), undefined, null, 7, {}, [],
    ]
    for (const bad of tampered) expect(await svc.resolveRecovery(bad as any)).toEqual({ status: 'invalid' })

    const expired = signToken(SECRET, { purpose: 'recover', id, expiresAtSec: Math.floor(T.getTime() / 1000) - 5 })
    expect(await svc.resolveRecovery(expired)).toEqual({ status: 'expired' })

    advance(60 * 24 * 4)    // past the 72h window
    expect(await svc.resolveRecovery(tok)).toEqual({ status: 'expired' })
    advance(-60 * 24 * 4)

    await pay(c)            // customer ordered: link is used up
    expect(await svc.resolveRecovery(tok)).toEqual({ status: 'already_ordered' })
  })

  test('a link for a checkout that was never emailed is refused', async () => {
    const svc = mk(); const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'never@a.test'); const r = await record(svc, c)
    const tok = signToken(SECRET, { purpose: 'recover', id: r!.id, expiresAtSec: Math.floor(T.getTime() / 1000) + 3600 })
    expect(await svc.resolveRecovery(tok)).toEqual({ status: 'invalid' })
  })

  test('a recover token is bound to ONE row (swapping the id breaks the signature)', async () => {
    const a = await sentFor('bind1@a.test')
    const { c: c2 } = await abandoned('bind2@a.test')
    const id2 = (await row(c2.session)).id
    const p = a.tok.split('.')
    const swapped = `${p[0]}.${Buffer.from(JSON.stringify({ p: 'r', a: id2, e: a.exp })).toString('base64url')}.${p[2]}`
    expect(await a.svc.resolveRecovery(swapped)).toEqual({ status: 'invalid' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('recovered orders: linking and revenue counted once', () => {
  async function recoveredFlow(email: string) {
    const { svc, c: cx } = await abandoned(email)
    advance(61); await svc.sweep()
    const X = await row(cx.session)
    const tok = signToken(SECRET, { purpose: 'recover', id: X.id, expiresAtSec: Math.floor(new Date(X.expires_at).getTime() / 1000) })
    const v = await mkVariant(5)
    const cy = await startCheckout(v.sku, 2, email)
    await record(svc, cy, { recoveryCookie: tok })
    return { svc, cx, cy, X, tok }
  }

  test('the new checkout links to the recovery; paying it marks the source recovered ONCE', async () => {
    const { svc, cx, cy, X } = await recoveredFlow('rec@a.test')
    expect((await row(cy.session)).recovery_source_id).toBe(X.id)
    await pay(cy)
    const r1 = await svc.sweep(); expect(r1.recovered).toBe(1)
    const r2 = await svc.sweep(); expect(r2.recovered).toBe(0)
    const x = await row(cx.session), y = await row(cy.session)
    const order = (await q(`SELECT id, total_cents, currency FROM orders WHERE stripe_checkout_session_id=$1`, [cy.session]))[0]
    expect(x).toMatchObject({ state: 'recovered', recovered_order_id: order.id, recovery_revenue_cents: order.total_cents, recovery_revenue_currency: 'usd' })
    expect(y.state).toBe('completed')
    expect(await events(x.id)).toContain('recovered')
    // the recovered order is a NORMAL order: exactly one order row exists for that checkout
    expect((await q(`SELECT count(*) AS n FROM orders WHERE stripe_checkout_session_id=$1`, [cy.session]))[0].n).toBe('1')
    // revenue is counted once in the summary
    const sum = await svc.summary()
    expect(sum).toMatchObject({ recovered: 1, revenue: [{ currency: 'usd', cents: Number(order.total_cents) }], revenueUnknownCount: 0 })
  })

  test('the database refuses to link one order to two checkouts', async () => {
    const { svc, cx, cy } = await recoveredFlow('rec2@a.test')
    await pay(cy); await svc.sweep()
    const order = (await q(`SELECT id FROM orders WHERE stripe_checkout_session_id=$1`, [cy.session]))[0]
    const other = await mkVariant(2); const c3 = await startCheckout(other.sku, 1, 'z@a.test'); await record(svc, c3)
    expect(await F.err(`UPDATE abandoned_checkouts SET recovered_order_id=$1 WHERE stripe_checkout_session_id=$2`, [order.id, c3.session])).toMatch(/ac_recovered_order_uq/)
    expect((await row(cx.session)).state).toBe('recovered')
  })

  test('a forged / foreign / expired cookie links nothing; flag OFF ignores the cookie', async () => {
    const { svc, X } = await recoveredFlow('rec3@a.test')
    const v = await mkVariant(5)
    for (const cookie of ['garbage', signToken('e'.repeat(48), { purpose: 'recover', id: X.id, expiresAtSec: 9999999999 }),
      signToken(SECRET, { purpose: 'recover', id: X.id, expiresAtSec: 1 }),
      signToken(SECRET, { purpose: 'unsubscribe', id: X.id, expiresAtSec: 9999999999 })]) {
      const c = await startCheckout(v.sku, 1, 'rec3@a.test'); await record(svc, c, { recoveryCookie: cookie })
      expect((await row(c.session)).recovery_source_id).toBeNull()
    }
    const good = signToken(SECRET, { purpose: 'recover', id: X.id, expiresAtSec: Math.floor(T.getTime() / 1000) + 3600 })
    const off = mk(() => F.sql, { ...ENV_ON, [FLAG]: undefined })
    const c = await startCheckout(v.sku, 1, 'rec3@a.test'); await record(off, c, { recoveryCookie: good })
    expect((await row(c.session)).recovery_source_id).toBeNull()
  })

  test('a resumed checkout that is abandoned again is NOT mailed a second time', async () => {
    const { svc, cy } = await recoveredFlow('rec4@a.test')
    await expire(cy.rid); await svc.sweep(); advance(61); await svc.sweep()
    expect(await row(cy.session)).toMatchObject({ state: 'ineligible', ineligible_reason: 'resumed_from_recovery' })
    expect(to('rec4@a.test')).toHaveLength(1)
  })

  test('an organic purchase (no recovery link) is never claimed as recovered revenue', async () => {
    const { svc, c } = await abandoned('org@a.test')
    advance(61); await svc.sweep()
    const v = await mkVariant(5); const c2 = await startCheckout(v.sku, 1, 'org@a.test'); await record(svc, c2); await pay(c2)
    await svc.sweep()
    expect((await row(c.session)).state).toBe('recovery_sent')
    expect((await svc.summary()).recovered).toBe(0)
  })

  test('summary shows Unknown (never $0) when a recovered row has no stored total', async () => {
    const { svc, cx, cy } = await recoveredFlow('rec5@a.test')
    await pay(cy); await svc.sweep()
    await q(`UPDATE abandoned_checkouts SET recovery_revenue_cents=NULL, recovery_revenue_currency=NULL WHERE stripe_checkout_session_id=$1`, [cx.session])
    const s = await svc.summary()
    expect(s.revenueUnknownCount).toBe(1)
    const { revenueDisplay } = await import('../abandoned-checkout-ui')
    expect(revenueDisplay(s)).toBe('Unknown')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('admin reads', () => {
  test('list + summary + config round trip with optimistic revision', async () => {
    const { svc } = await abandoned('adm@a.test')
    advance(61); await svc.sweep()
    const rows = await svc.listForAdmin({ view: 'sent' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: 'adm@a.test', state: 'recovery_sent', locale: 'es-MX' })
    expect(await svc.listForAdmin({ view: 'failed' })).toHaveLength(0)
    expect(await svc.listForAdmin({ view: 'bogus' as any })).not.toHaveLength(0)    // unknown view => safe default

    const cfg = await svc.getConfig()
    expect(cfg.config).toMatchObject({ enabled: true, delay_minutes: 60, max_emails: 1, consent_mode: 'require_opt_in', window_hours: 72 })
    const saved = await svc.saveConfig({ ...cfg.config, delay_minutes: 120 }, cfg.revision, 'owner@kvrn.test')
    expect(saved).toMatchObject({ ok: true, revision: 1 })
    await expect(svc.saveConfig({ ...cfg.config, delay_minutes: 90 }, 0, 'owner@kvrn.test')).rejects.toMatchObject({ code: 'stale' })
    expect(await svc.saveConfig({ ...cfg.config, max_emails: 2 }, 1, 'owner@kvrn.test')).toMatchObject({ ok: false })
    const audit = await q(`SELECT action FROM admin_audit_logs WHERE resource='abandoned_checkouts' OR resource_id='abandoned.config' ORDER BY created_at`)
    expect(audit.map((a: any) => a.action)).toContain('abandoned.config.update')
  })

  test('a corrupt stored config falls back to the SAFE defaults (opt-in required)', async () => {
    await q(`INSERT INTO site_settings (key, value, revision, updated_by) VALUES ('abandoned.config', '{"consent_mode":"yolo","delay_minutes":-5}'::jsonb, 1, 'x')`)
    expect((await mk().getConfig()).config).toMatchObject({ consent_mode: 'require_opt_in', delay_minutes: 60 })
  })

  test('delivery readiness reports flag / secret / provider / origin', () => {
    expect(mk().deliveryReadiness()).toEqual({ flagEnabled: true, linkSecretConfigured: true, providerConfigured: true, originConfigured: true })
    expect(mk(() => F.sql, {}).deliveryReadiness()).toEqual({ flagEnabled: false, linkSecretConfigured: false, providerConfigured: false, originConfigured: true })
  })
})
