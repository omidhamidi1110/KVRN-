// lib/__tests__/audit-a-checkout.test.ts
//
// Adversarial audit tests for the checkout path as changed by the admin-refresh batch:
//   * bundle pricing: TS <-> SQL parity and exact allocation (property sweep, through the REAL
//     reserve_inventory_v2),
//   * lock-order safety of reserve_inventory_v2 against a concurrent bundle re-projection,
//   * the abandoned-checkout per-address cooldown (must survive a recovery / late payment).
//
// Real PostgreSQL (local TEST_DATABASE_URL only); skips visibly otherwise.
import crypto from 'crypto'
import { Client } from 'pg'
import { HAVE_DB, createFiDb, pgConfig, type FiDb } from './helpers/fi-pg'
import {
  computeSetDiscount, priceBundle, verifyAllocation, MAX_UNIT_PRICE_CENTS, type BundlePricingMode,
} from '../bundle-pricing'
import { createBundleCheckout, quoteBundle, buildReserveItems, type BundleFacts } from '../bundle-checkout'
import { createAbandonedCheckoutService } from '../abandoned-checkout'

const d = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test('NOTE: audit-a DB tests skipped — TEST_DATABASE_URL absent or not local.', () => expect(true).toBe(true))

let F: FiDb
let dbName = ''
const q = (t: string, p: unknown[] = []) => F.q(t, p)

beforeAll(async () => {
  if (!HAVE_DB) return
  F = await createFiDb('kvrn_audita')
  dbName = `kvrn_audita_${process.pid}`
}, 180_000)
afterAll(async () => { await F?.close() })

// ── seeded PRNG so a failure is reproducible ───────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

// ═════════════════════════════════════════════════════════════════════════════
d('bundle pricing: TS and SQL agree, allocation is exact (property sweep through reserve_inventory_v2)', () => {
  const N = 6
  const pids: string[] = [], vids: string[] = [], skus: string[] = []
  const bundleId = 'a0000000-0000-4000-8000-0000000000b1'
  const ownerId = 'a0000000-0000-4000-8000-0000000000a1'

  beforeAll(async () => {
    for (let i = 0; i < N; i++) {
      const pid = `a0000000-0000-4000-8000-0000000000a${i + 1}`
      const vid = `a0000001-0000-4000-8000-0000000000a${i + 1}`
      const sku = `KVRN-AUD-${i + 1}`
      pids.push(pid); vids.push(vid); skus.push(sku)
      await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
               VALUES ($1,'A',$2,$3,$4,1000,true)`, [pid, `AUD${i + 1}`, `Audit ${i + 1}`, `audit-${i + 1}`])
      await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
               VALUES ($1,$2,$3,'Black','#000','M',1,0)`, [vid, pid, sku])
      await q(`SELECT add_inventory_layer($1,$2,100,'purchase',NULL,NULL,'cost_batch','jest')`, [vid, 100000])
      await q(`UPDATE product_variants SET stock_on_hand=100000 WHERE id=$1`, [vid])
    }
    await q(`INSERT INTO bundles (id, owner_product_id, enabled, include_owner, pricing_mode, pricing_value)
             VALUES ($1,$2,true,true,'fixed_discount',0)`, [bundleId, ownerId])
  }, 120_000)

  // rewrite the bundle projection + canonical prices directly (the CMS is not under test here)
  async function setup(prices: number[], mode: BundlePricingMode, value: number) {
    for (let i = 0; i < prices.length; i++) await q(`UPDATE products SET price_cents=$2 WHERE id=$1`, [pids[i], prices[i]])
    await q(`DELETE FROM bundle_components WHERE bundle_id=$1`, [bundleId])
    for (let i = 0; i < prices.length; i++) {
      await q(`INSERT INTO bundle_components (bundle_id, component_product_id, is_owner, sort_order) VALUES ($1,$2,$3,$4)`,
        [bundleId, pids[i], i === 0, i])
    }
    await q(`UPDATE bundles SET pricing_mode=$2, pricing_value=$3 WHERE id=$1`, [bundleId, mode, value])
  }

  function facts(prices: number[], mode: BundlePricingMode, value: number): BundleFacts {
    return {
      bundle: { id: bundleId, ownerProductId: ownerId, enabled: true, includeOwner: true, mode, value, revision: 1, presentation: {} },
      components: prices.map((p, i) => ({
        productId: pids[i], isOwner: i === 0, viewSeparately: true, sortOrder: i, allowedVariantIds: null,
        name: `Audit ${i + 1}`, priceCents: p, active: true, currency: 'usd', live: true,
      })),
      variants: prices.map((_p, i) => ({
        id: vids[i], productId: pids[i], sku: skus[i], size: 'M', sizeSort: 1, color: 'Black', colorCode: '#000', active: true, available: 100000,
      })),
    }
  }

  const PRICE_POOL = [1, 1, 2, 3, 7, 99, 100, 101, 333, 1999, 2500, 9999, 12345, 999_999, MAX_UNIT_PRICE_CENTS]

  test('pure sweep: 20000 random sets reconcile exactly (alloc sum, bounds, net lines), all modes, quantity 1..10', () => {
    const r = rng(20260707)
    let ok = 0, rejected = 0
    for (let n = 0; n < 20000; n++) {
      const k = 1 + Math.floor(r() * 6)
      const prices = Array.from({ length: k }, () => r() < 0.6 ? PRICE_POOL[Math.floor(r() * PRICE_POOL.length)] : 1 + Math.floor(r() * 200000))
      const sub = prices.reduce((a, b) => a + b, 0)
      const mode = (['set_price', 'fixed_discount', 'percent_discount'] as const)[Math.floor(r() * 3)]
      const value = mode === 'percent_discount'
        ? [0, 1, 2, 5000, 9998, 9999, Math.floor(r() * 10000)][Math.floor(r() * 7)]
        : mode === 'set_price'
          ? [1, sub, sub - 1, Math.floor(r() * sub) + 1][Math.floor(r() * 4)]
          : [0, 1, sub - 1, Math.floor(r() * sub)][Math.floor(r() * 4)]
      const qty = 1 + Math.floor(r() * 10)
      const p = priceBundle({ mode, value, setQuantity: qty, components: prices.map((u, i) => ({ key: `k${i}`, unitPriceCents: u, sortKey: String(i).padStart(3, '0') })) })
      if (!p.ok) { rejected++; continue }
      ok++
      expect(verifyAllocation(p)).toEqual([])
      expect(p.lines.every(l => l.netUnitPriceCents >= 0 && l.netUnitPriceCents <= l.originalUnitPriceCents)).toBe(true)
      expect(p.setNetCents).toBeGreaterThanOrEqual(1)
      expect(p.lines.reduce((s, l) => s + l.netLineCents, 0)).toBe(p.netCents)
      expect(p.netCents).toBe(p.setNetCents * qty)
    }
    expect(ok).toBeGreaterThan(5000)
    expect(rejected).toBeGreaterThan(10)
  })

  test('SQL bundle_set_discount == computeSetDiscount for the same inputs (ok flag, code and cents)', async () => {
    const r = rng(7)
    const rows: any[] = []
    for (let n = 0; n < 1500; n++) {
      const sub = [1, 2, 3, 99, 100, 5000, 123456, 6_000_000][Math.floor(r() * 8)] + Math.floor(r() * 50)
      const mode = (['set_price', 'fixed_discount', 'percent_discount', 'bogus'] as const)[Math.floor(r() * 4)]
      const value = [-1, 0, 1, 2, 9999, 10000, 10001, sub - 1, sub, sub + 1, Math.floor(r() * sub)][Math.floor(r() * 11)]
      rows.push({ sub, mode, value })
    }
    for (const c of rows) {
      const ts = computeSetDiscount(c.mode, c.value, c.sub)
      const sqlRes = (await q(`SELECT bundle_set_discount($1,$2::int,$3::int) AS r`, [c.mode, c.value, c.sub]))[0].r
      expect({ c, ok: sqlRes.ok }).toEqual({ c, ok: ts.ok })
      if (ts.ok) expect({ c, d: sqlRes.discount_cents }).toEqual({ c, d: ts.discountCents })
      else expect({ c, code: sqlRes.code }).toEqual({ c, code: (ts as any).code })
    }
  }, 120_000)

  test('end to end: every priceable set reserves in SQL at exactly the TS net prices (1-cent components, qty 10, tiny/huge discounts)', async () => {
    const r = rng(424242)
    const bc = createBundleCheckout(F.sql, { isEnabled: () => true })
    let reserved = 0
    const interesting: Array<[number[], BundlePricingMode, number, number]> = [
      [[1, 1], 'fixed_discount', 1, 10],
      [[1, 100], 'fixed_discount', 100, 10],       // 1-cent component taking a whole cent of discount
      [[1, 1, 1], 'set_price', 1, 7],
      [[1, 1, 1, 1, 1, 1], 'percent_discount', 9999, 10],
      [[999_999, 1_000_000, 1], 'percent_discount', 1, 3],
      [[MAX_UNIT_PRICE_CENTS, MAX_UNIT_PRICE_CENTS, MAX_UNIT_PRICE_CENTS, MAX_UNIT_PRICE_CENTS, MAX_UNIT_PRICE_CENTS, MAX_UNIT_PRICE_CENTS], 'percent_discount', 9999, 10],
      [[3333, 3333, 3334], 'fixed_discount', 1, 1],
      [[3333, 3333, 3334], 'set_price', 9999, 10],
      [[100, 100, 100], 'percent_discount', 3333, 9],
    ]
    const cases: Array<[number[], BundlePricingMode, number, number]> = [...interesting]
    for (let n = 0; n < 120; n++) {
      const k = 1 + Math.floor(r() * 6)
      const prices = Array.from({ length: k }, () => r() < 0.5 ? PRICE_POOL[Math.floor(r() * PRICE_POOL.length)] : 1 + Math.floor(r() * 50000))
      const sub = prices.reduce((a, b) => a + b, 0)
      const mode = (['set_price', 'fixed_discount', 'percent_discount'] as const)[Math.floor(r() * 3)]
      const value = mode === 'percent_discount' ? Math.floor(r() * 10000)
        : mode === 'set_price' ? 1 + Math.floor(r() * sub) : Math.floor(r() * sub)
      cases.push([prices, mode, value, 1 + Math.floor(r() * 10)])
    }
    for (const [prices, mode, value, qty] of cases) {
      await setup(prices, mode, value)
      const f = facts(prices, mode, value)
      const quote = quoteBundle(f, {
        bundleId, quantity: qty, selections: prices.map((_p, i) => ({ productId: pids[i], sku: skus[i] })), expectedSetNetCents: null,
      })
      if (!quote.ok) continue
      const prep = { quote, reserveItems: buildReserveItems([], quote), shippingItems: [] }
      const res: any = await bc.reserve(prep, [])
      if (!res.ok) throw new Error(`SQL refused a set TS priced: ${JSON.stringify({ prices, mode, value, qty })} -> ${res.code}`)
      reserved++
      const merch = res.items.reduce((s: number, i: any) => s + i.unitPriceCents * i.quantity, 0)
      expect({ prices, mode, value, qty, merch }).toEqual({ prices, mode, value, qty, merch: quote.netCents })
      const rb = (await q(`SELECT * FROM reservation_bundles WHERE reservation_id=$1`, [res.reservationId]))[0]
      expect(rb.bundle_net_cents).toBe(quote.netCents)
      expect(rb.component_subtotal_cents - rb.bundle_discount_cents).toBe(rb.bundle_net_cents)
      const items = await q(`SELECT sum(unit_price_cents*quantity)::int AS s FROM reservation_items WHERE reservation_id=$1`, [res.reservationId])
      expect(items[0].s).toBe(quote.netCents)
    }
    expect(reserved).toBeGreaterThan(60)
  }, 300_000)
})

// ═════════════════════════════════════════════════════════════════════════════
d('reserve_inventory_v2 (no bundle) is reserve_inventory: same errors, same effects', () => {
  const ids = { p: 'd0000000-0000-4000-8000-0000000000a1', pi: 'd0000000-0000-4000-8000-0000000000a2', pe: 'd0000000-0000-4000-8000-0000000000a3' }
  beforeAll(async () => {
    const mkp = async (pid: string, n: string, currency: string, active: boolean, stock: number, vActive = true) => {
      await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active,currency) VALUES ($1,'A',$2,$3,$4,4200,$5,$6)`,
        [pid, `DF${n}`, `Diff ${n}`, `diff-${n}`, active, currency])
      await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,active) VALUES ($1,$2,$3,'Black','#000','M',1,0,$4)`,
        [pid.replace('d0000000', 'd0000001'), pid, `KVRN-DF-${n}`, vActive])
      if (stock) { await q(`SELECT add_inventory_layer($1,$2,100,'purchase',NULL,NULL,'cost_batch','jest')`, [pid.replace('d0000000', 'd0000001'), stock]); await q(`UPDATE product_variants SET stock_on_hand=$2 WHERE id=$1`, [pid.replace('d0000000', 'd0000001'), stock]) }
    }
    await mkp(ids.p, '1', 'usd', true, 3)
    await mkp(ids.pi, '2', 'usd', false, 3)          // inactive product
    await mkp(ids.pe, '3', 'eur', true, 3)           // non-USD product
    await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ('d0000000-0000-4000-8000-0000000000a4','A','DF4','Diff 4','diff-4',100,true)`)
    await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand) VALUES ('d0000001-0000-4000-8000-0000000000a4','d0000000-0000-4000-8000-0000000000a4','KVRN-DF-4','Black','#000','M',1,0)`)  // out of stock
  }, 60_000)

  const expiry = () => new Date(Date.now() + 35 * 60_000).toISOString()
  const strip = (m: string) => m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
  const cases: Array<[string, unknown, string | null]> = [
    ['empty array', [], null], ['not an array', { sku: 'KVRN-DF-1', quantity: 1 }, null], ['item not an object', ['KVRN-DF-1'], null],
    ['missing sku', [{ quantity: 1 }], null], ['empty sku', [{ sku: '', quantity: 1 }], null], ['foreign sku', [{ sku: 'ABC-1', quantity: 1 }], null],
    ['unknown sku', [{ sku: 'KVRN-NOPE', quantity: 1 }], null],
    ['qty 0', [{ sku: 'KVRN-DF-1', quantity: 0 }], null], ['qty 11', [{ sku: 'KVRN-DF-1', quantity: 11 }], null],
    ['qty string', [{ sku: 'KVRN-DF-1', quantity: '2' }], null], ['qty float', [{ sku: 'KVRN-DF-1', quantity: 1.5 }], null],
    ['qty negative', [{ sku: 'KVRN-DF-1', quantity: -1 }], null], ['qty null', [{ sku: 'KVRN-DF-1', quantity: null }], null],
    ['duplicate sku', [{ sku: 'KVRN-DF-1', quantity: 1 }, { sku: 'KVRN-DF-1', quantity: 1 }], null],
    ['inactive product', [{ sku: 'KVRN-DF-2', quantity: 1 }], null], ['non-usd product', [{ sku: 'KVRN-DF-3', quantity: 1 }], null],
    ['out of stock', [{ sku: 'KVRN-DF-4', quantity: 1 }], null], ['short stock', [{ sku: 'KVRN-DF-1', quantity: 4 }], null],
    ['one good one bad (all-or-nothing)', [{ sku: 'KVRN-DF-1', quantity: 1 }, { sku: 'KVRN-DF-4', quantity: 1 }], null],
    ['expiry in the past', [{ sku: 'KVRN-DF-1', quantity: 1 }], new Date(Date.now() - 60_000).toISOString()],
    ['ok', [{ sku: 'KVRN-DF-1', quantity: 2 }], null],
  ]
  test.each(cases)('%s', async (_n, items, exp) => {
    const run = async (fn: string, extra: string) => {
      await q(`UPDATE product_variants SET reserved_quantity=0 WHERE sku='KVRN-DF-1'`)
      const before = (await q(`SELECT reserved_quantity::int r FROM product_variants WHERE sku='KVRN-DF-1'`))[0].r
      let out: any
      try { out = (await q(`SELECT ${fn}($1::jsonb,$2::timestamptz${extra}) AS r`, [JSON.stringify(items), exp ?? expiry()]))[0].r }
      catch (e: any) { out = { error: strip(String(e.message)) } }
      const after = (await q(`SELECT reserved_quantity::int r FROM product_variants WHERE sku='KVRN-DF-1'`))[0].r
      return { out, delta: after - before }
    }
    const a = await run('reserve_inventory', '')
    const b = await run('reserve_inventory_v2', ',NULL')
    if (a.out.error !== undefined) expect(b.out.error).toBe(a.out.error)
    else {
      expect(b.out.error).toBeUndefined()
      expect(b.out.items.map((i: any) => [i.sku, i.unit_price_cents, i.quantity])).toEqual(a.out.items.map((i: any) => [i.sku, i.unit_price_cents, i.quantity]))
    }
    expect(b.delta).toBe(a.delta)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
d('reserve_inventory_v2 vs a concurrent bundle re-projection (lock order)', () => {
  const ownerId = 'b0000000-0000-4000-8000-0000000000a1'
  const compId = 'b0000000-0000-4000-8000-0000000000a2'
  const bundleId = 'b0000000-0000-4000-8000-0000000000b1'

  beforeAll(async () => {
    for (const [i, pid] of [ownerId, compId].entries()) {
      const vid = `b0000001-0000-4000-8000-0000000000a${i + 1}`
      await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ($1,'A',$2,$3,$4,5000,true)`,
        [pid, `LK${i + 1}`, `Lock ${i + 1}`, `lock-${i + 1}`])
      await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand) VALUES ($1,$2,$3,'Black','#000','M',1,0)`,
        [vid, pid, `KVRN-LK-${i + 1}`])
      await q(`SELECT add_inventory_layer($1,$2,100,'purchase',NULL,NULL,'cost_batch','jest')`, [vid, 50])
      await q(`UPDATE product_variants SET stock_on_hand=50 WHERE id=$1`, [vid])
    }
    await q(`INSERT INTO bundles (id, owner_product_id, enabled, include_owner, pricing_mode, pricing_value) VALUES ($1,$2,true,true,'fixed_discount',1000)`, [bundleId, ownerId])
    await q(`INSERT INTO bundle_components (bundle_id, component_product_id, is_owner, sort_order) VALUES ($1,$2,true,0),($1,$3,false,1)`, [bundleId, ownerId, compId])
  }, 60_000)

  test('a publish that touches the owner variants, then re-projects the bundle, never deadlocks with a checkout reserving that set', async () => {
    const { isLocal: _l, ...cfg } = pgConfig(dbName)
    const pub = new Client(cfg), buyer = new Client(cfg)
    await Promise.all([pub.connect(), buyer.connect()])
    const items = JSON.stringify([
      { sku: 'KVRN-LK-1', quantity: 1, unit_price_cents: 4500, bundle: true },
      { sku: 'KVRN-LK-2', quantity: 1, unit_price_cents: 4500, bundle: true }])
    const bundle = JSON.stringify({ bundle_id: bundleId, quantity: 1 })
    try {
      // Publish transaction, in the order migrations 028 -> 029 really run it: the catalog sync
      // updates the product's variants first, then bundle_project() updates the `bundles` row.
      await pub.query('BEGIN')
      await pub.query(`UPDATE product_variants SET updated_at = NOW() WHERE product_id = $1`, [ownerId])
      // The buyer starts reserving the set: it needs the same variant rows.
      await buyer.query('BEGIN')
      const buyerRun = buyer.query(`SELECT reserve_inventory_v2($1::jsonb, now() + interval '35 minutes', $2::jsonb)`, [items, bundle])
        .then(() => 'ok', (e: any) => `err:${e.code}:${String(e.message).slice(0, 60)}`)
      await new Promise(r => setTimeout(r, 400))       // let the buyer reach its first lock
      // Publish continues: re-project the bundle (the UPDATE ... ON CONFLICT in bundle_project)
      const pubRun = pub.query(`UPDATE bundles SET revision = revision + 1 WHERE id = $1`, [bundleId])
        .then(() => 'ok', (e: any) => `err:${e.code}:${String(e.message).slice(0, 60)}`)
      const pubOut = await Promise.race([pubRun, new Promise<string>(r => setTimeout(() => r('pending'), 3500))])
      // Whatever happened, finish both transactions
      if (pubOut === 'ok') await pub.query('COMMIT').catch(() => {})
      else await pub.query('ROLLBACK').catch(() => {})
      const buyerOut = await buyerRun
      await buyer.query(buyerOut === 'ok' ? 'COMMIT' : 'ROLLBACK').catch(() => {})
      if (pubOut === 'pending') await pubRun.catch(() => {})
      // No 40P01 deadlock on either side.
      expect([pubOut, buyerOut].filter(x => x.startsWith('err:40P01'))).toEqual([])
      expect(buyerOut).toBe('ok')
      expect(pubOut).not.toBe('pending')
    } finally {
      await pub.query('ROLLBACK').catch(() => {}); await buyer.query('ROLLBACK').catch(() => {})
      await Promise.all([pub.end(), buyer.end()])
    }
  }, 60_000)
})

// ═════════════════════════════════════════════════════════════════════════════
d('abandoned checkout: the per-address cooldown survives a recovery or a late payment', () => {
  const SECRET = 's3cr3t-'.repeat(8)
  const FLAG = 'KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS'
  const ENV_ON = { [FLAG]: 'on', ABANDONED_LINK_SECRET: SECRET, RESEND_API_KEY: 're_test', SITE_URL: 'https://kvrn.test' }
  const MIN = 60_000
  let T = new Date()
  const advance = (m: number) => { T = new Date(T.getTime() + m * MIN) }
  const sent: any[] = []
  const provider = { send: jest.fn(async (m: any) => { sent.push(m); return { ok: true, providerMessageId: 'm' } }) }
  const mk = () => createAbandonedCheckoutService(F.sql, { now: () => T, env: ENV_ON, getProvider: () => provider as any, getOrigin: () => 'https://kvrn.test' })
  let seq = 0
  let ev = 0

  async function startCheckout(email: string) {
    const n = ++seq
    const pid = `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const vid = `c0000001-0000-4000-8000-${String(n).padStart(12, '0')}`
    const sku = `KVRN-CD-${n}`
    await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ($1,'A',$2,'Cool Tee',$3,8000,true)`, [pid, `CD${n}`, `cd-${n}`])
    await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand) VALUES ($1,$2,$3,'Black','#000','M',1,0)`, [vid, pid, sku])
    await q(`SELECT add_inventory_layer($1,$2,3000,'purchase',NULL,NULL,'cost_batch','jest')`, [vid, 5])
    await q(`UPDATE product_variants SET stock_on_hand=5 WHERE id=$1`, [vid])
    const res = (await q(`SELECT reserve_inventory($1::jsonb, now() + interval '35 minutes') AS r`, [JSON.stringify([{ sku, quantity: 1 }])]))[0].r
    const rid = res.reservation_id as string
    const session = `cs_test_cd_${n}_${crypto.randomBytes(3).toString('hex')}`
    await q(`SELECT attach_stripe_session($1::uuid,$2,extract(epoch from now()+interval '31 minutes')::bigint)`, [rid, session])
    await q(`SELECT save_reservation_checkout_details($1::uuid,$2,'Cust Name',NULL,
              '{"line1":"1 Main","city":"LA","state":"CA","postal_code":"90001","country":"US"}'::jsonb,'standard',700,0,700,NULL,NULL,NULL,0)`, [rid, email])
    await mk().recordCheckout({
      reservationId: rid, stripeSessionId: session, email, sessionExpiresAtUnix: Math.floor(Date.now() / 1000) + 31 * 60,
      items: res.items.map((i: any) => ({ sku: i.sku, quantity: i.quantity, variantId: i.variant_id, productName: i.product_name, size: i.size, color: i.color, unitPriceCents: i.unit_price_cents })),
    })
    await q(`UPDATE reservations SET expires_at = now() - interval '10 minutes' WHERE id=$1`, [rid])
    await q(`SELECT release_expired_reservations()`)
    return { rid, session, email, total: 8700 }
  }
  async function pay(c: { rid: string; session: string; total: number; email: string }) {
    await q(`SELECT finalize_paid_order($1,$2::uuid,$3,$4,'checkout.session.completed','usd',$5,$6,'Cust Name',NULL,NULL) AS r`,
      [c.session, c.rid, 'pi_' + c.session, `evt_aud_${++ev}`, c.total, c.email])
  }

  beforeEach(async () => {
    await q(`TRUNCATE abandoned_checkout_events, abandoned_checkouts, abandoned_checkout_suppressions RESTART IDENTITY CASCADE`)
    await q(`DELETE FROM marketing_subscribers`)
    sent.length = 0; provider.send.mockClear(); T = new Date()
  })

  test('policy: one reminder per address per 7 days, even when the first reminder led to a recovered/completed row', async () => {
    const email = 'repeat@a.test'
    await q(`INSERT INTO marketing_subscribers (email,status,consent_source) VALUES ($1,'subscribed','footer')`, [email])
    const svc = mk()
    const c1 = await startCheckout(email)
    await svc.sweep(); advance(61); await svc.sweep()          // abandon -> queue -> send
    expect(sent.filter(m => m.to === email)).toHaveLength(1)
    // The customer pays the ORIGINAL session late (or buys through the link): the row leaves 'recovery_sent'.
    await pay(c1)
    advance(5); await svc.sweep()
    expect((await q(`SELECT state FROM abandoned_checkouts WHERE stripe_checkout_session_id=$1`, [c1.session]))[0].state).toBe('completed')
    // Two days later the same address abandons ANOTHER bag.
    advance(2 * 24 * 60)
    const c2 = await startCheckout(email)
    await svc.sweep(); advance(61); await svc.sweep(); advance(30); await svc.sweep()
    const st = (await q(`SELECT state, ineligible_reason FROM abandoned_checkouts WHERE stripe_checkout_session_id=$1`, [c2.session]))[0]
    expect({ mails: sent.filter(m => m.to === email).length, st }).toEqual({
      mails: 1, st: { state: 'ineligible', ineligible_reason: 'recent_recovery_email' },
    })
  })
})
