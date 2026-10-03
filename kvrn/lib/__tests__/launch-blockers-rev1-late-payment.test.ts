// lib/__tests__/launch-blockers-rev1-late-payment.test.ts
//
// FINAL LAUNCH BLOCKER 2 — a paid customer must never end up with no order.
//
// Before migration 022, a successful-payment webhook that arrived after expiry cleanup
// had released the reservation returned 'reservation_not_eligible', marked the Stripe
// event PROCESSED (so Stripe never retried) and left nothing behind: charged customer,
// no order, no record.
//
// Real-PostgreSQL blocks run only with a LOCAL TEST_DATABASE_URL (helpers/fi-pg.ts).

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

const MIG = path.join(__dirname, '../../db/migrations')
const read = (f: string) => fs.readFileSync(path.join(MIG, f), 'utf8')
const md5 = (f: string) => crypto.createHash('md5').update(fs.readFileSync(path.join(MIG, f))).digest('hex')

// ── Static: migration 022 structure (always runs) ────────────────────────────
describe('migration 022 structure', () => {
  test('018, 019, 020 and 021 are byte-identical to the frozen versions', () => {
    expect(md5('018_returns_exchanges_disputes.sql')).toBe('385b099ac542032df47766dc78676b2b')
    expect(md5('019_inventory_fifo_layers.sql')).toBe('922f36c20fb71d21e6fe2b0054a77716')
    expect(md5('020_affiliates.sql')).toBe('9251fab7750f694dfa17303aad400f72')
    expect(md5('021_financial_integrity.sql')).toBe('e7e0cd801ec63b4f22345eb448a9ebba')
  })
  test('022 is the only new migration and runs after 021', () => {
    const files = fs.readdirSync(MIG).filter(f => /^\d+_/.test(f)).sort()
    expect(files.slice(-2)).toEqual(['021_financial_integrity.sql', '022_late_payment_recovery.sql'])
  })
  test('is idempotent by construction', () => {
    const sql = read('022_late_payment_recovery.sql').replace(/--.*$/gm, '')
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payment_exceptions/)
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_payment_exceptions_no_delete/)
    expect(sql).not.toMatch(/\bDROP TABLE\b|\bTRUNCATE\b|\bDELETE FROM\b/i)
  })
  test('keeps every 019 guard: amount, currency, deduct invariant, FIFO, idempotency locks', () => {
    const fn = read('022_late_payment_recovery.sql')
    for (const g of ['KVRN_RESERVATION|CURRENCY_MISMATCH', 'KVRN_RESERVATION|AMOUNT_MISMATCH',
                     'KVRN_RESERVATION|DEDUCT_INVARIANT', 'consume_inventory_fifo(',
                     'ON CONFLICT (stripe_event_id) DO NOTHING', 'ON CONFLICT (order_id, email_type) DO NOTHING',
                     'NO_CLAIM_FOR_LIMITED_CODE']) {
      expect(fn).toContain(g)
    }
  })
  test('recovery locks variants in sku order and checks availability before touching stock', () => {
    const fn = read('022_late_payment_recovery.sql')
    const rec = fn.slice(fn.indexOf('LATE-PAYMENT RECOVERY'))
    expect(rec.indexOf('FOR UPDATE')).toBeGreaterThan(0)
    expect(rec.indexOf("'insufficient_stock'")).toBeLessThan(rec.indexOf("'late_payment_recovery'"))
    expect(rec).toContain('ORDER BY pv.sku')
  })
})

// ── Real PostgreSQL ──────────────────────────────────────────────────────────
const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: late-payment DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: late-payment real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

let F: FiDb
let pgFail: string | null = null
const q = (t: string, p: unknown[] = []) => F.q(t, p)
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }

beforeAll(async () => {
  if (!HAVE_DB) return
  try { F = await createFiDb('kvrn_lb_rev1') } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })

let seq = 0
const PRICE = 8000
const SHIP = 700

/** A fresh variant with `stock` units on hand AND matching FIFO layers (cost 3000). */
async function mkVariant(stock: number) {
  const n = ++seq
  const pid = `f2200000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const vid = `f2200001-0000-0000-0000-${String(n).padStart(12, '0')}`
  const sku = `KVRN-LB-${n}`
  await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
           VALUES ($1,'L',$2,'LB tee',$3,$4,true)`, [pid, `LB${n}`, `lb-${n}`, PRICE])
  await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
           VALUES ($1,$2,$3,'Black','#000','M',1,0)`, [vid, pid, sku])
  if (stock > 0) {
    await q(`SELECT add_inventory_layer($1,$2,3000,'purchase',NULL,NULL,'cost_batch','jest')`, [vid, stock])
    await q(`UPDATE product_variants SET stock_on_hand=$2 WHERE id=$1`, [vid, stock])
  }
  return { vid, sku }
}

const stockOf = async (vid: string) =>
  (await q(`SELECT stock_on_hand AS s, reserved_quantity AS r FROM product_variants WHERE id=$1`, [vid]))[0] as { s: number; r: number }

/** reserve + attach a Stripe session + shipping snapshot; returns what Stripe would charge. */
async function checkout(sku: string, qty = 1, opts: { discountId?: string; discountCents?: number } = {}) {
  const n = ++seq
  const res = (await q(
    `SELECT reserve_inventory($1::jsonb, now() + interval '35 minutes') AS r`,
    [JSON.stringify([{ sku, quantity: qty }])]))[0].r
  const rid = res.reservation_id as string
  const session = `cs_test_lb_${n}_${crypto.randomBytes(3).toString('hex')}`
  await q(`SELECT attach_stripe_session($1::uuid,$2,extract(epoch from now()+interval '31 minutes')::bigint)`, [rid, session])
  const disc = opts.discountCents ?? 0
  await q(`SELECT save_reservation_checkout_details($1::uuid,'late@buyer.test','Late Buyer',NULL,
            '{"line1":"1 Main","city":"LA","state":"CA","postal_code":"90001","country":"US"}'::jsonb,
            'standard',$2,0,$2,$3::uuid,$4,$5,$6)`,
    [rid, SHIP, opts.discountId ?? null, opts.discountId ? 'LBCODE' : null,
     opts.discountId ? 'fixed_amount' : null, disc])
  return { rid, session, total: qty * PRICE - disc + SHIP, qty }
}

const expireNow = async (rid: string) => {
  await q(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id=$1`, [rid])
  return (await q(`SELECT release_expired_reservations() AS n`))[0].n as number
}

let ev = 0
async function finalize(c: { rid: string; session: string; total: number }, event = `evt_lb_${++ev}`,
                        client?: { query: (t: string, p?: any[]) => Promise<any> }) {
  const run = client ? (t: string, p: unknown[]) => client.query(t, p as any[]).then(r => r.rows) : q
  const rows = await run(
    `SELECT finalize_paid_order($1,$2::uuid,$3,$4,'checkout.session.completed','usd',$5,
       'late@buyer.test','Late Buyer',NULL,NULL) AS r`,
    [c.session, c.rid, 'pi_' + c.session, event, c.total])
  return rows[0].r as any
}

async function counts(session: string, vid: string) {
  const g = async (t: string, p: unknown[]) => Number((await q(t, p))[0].n)
  return {
    orders:   await g(`SELECT count(*) AS n FROM orders WHERE stripe_checkout_session_id=$1`, [session]),
    items:    await g(`SELECT count(*) AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.stripe_checkout_session_id=$1`, [session]),
    emails:   await g(`SELECT count(*) AS n FROM transactional_emails te JOIN orders o ON o.id=te.order_id WHERE o.stripe_checkout_session_id=$1`, [session]),
    deducts:  await g(`SELECT count(*) AS n FROM inventory_movements WHERE variant_id=$1 AND movement_type='DEDUCT'`, [vid]),
    consumed: await g(`SELECT count(*) AS n FROM inventory_layer_consumptions c JOIN orders o ON o.id=c.order_id WHERE o.stripe_checkout_session_id=$1`, [session]),
    exceptions: await g(`SELECT count(*) AS n FROM payment_exceptions WHERE stripe_checkout_session_id=$1`, [session]),
    refunds:  await g(`SELECT count(*) AS n FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE o.stripe_checkout_session_id=$1`, [session]),
  }
}

describeDB('late payment — real finalize_paid_order / reserve_inventory (migration 022)', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('1. a normal completed checkout still finalizes exactly once', async () => {
    needDb()
    const { vid, sku } = await mkVariant(3)
    const c = await checkout(sku, 1)
    const r = await finalize(c)
    expect(r.outcome).toBe('order_created')
    expect(r.recovered).toBe(false)
    expect(await stockOf(vid)).toEqual({ s: 2, r: 0 })
    expect(await counts(c.session, vid)).toEqual(
      { orders: 1, items: 1, emails: 1, deducts: 1, consumed: 1, exceptions: 0, refunds: 0 })
    const ord = (await q(`SELECT total_cents, payment_status FROM orders WHERE stripe_checkout_session_id=$1`, [c.session]))[0]
    expect(ord).toEqual({ total_cents: c.total, payment_status: 'paid' })
    expect((await q(`SELECT result FROM webhook_events ORDER BY created_at DESC LIMIT 1`))[0].result).toBe('order_created')
  })

  // 2 + 3 ─────────────────────────────────────────────────────────────────────
  test('2. REPRO: a paid webhook delayed past expiry cleanup is NOT dropped (stock available -> recovered)', async () => {
    needDb()
    const { vid, sku } = await mkVariant(1)
    const c = await checkout(sku, 1)
    expect(await expireNow(c.rid)).toBeGreaterThanOrEqual(1)          // lazy cleanup ran first
    expect(await stockOf(vid)).toEqual({ s: 1, r: 0 })               // unit is free again

    const r = await finalize(c)
    // pre-022 this was { outcome: 'reservation_not_eligible' } with ZERO orders
    expect(r.outcome).toBe('order_created')
    expect(r.recovered).toBe(true)
    expect(await stockOf(vid)).toEqual({ s: 0, r: 0 })               // deducted, never negative
    const cnt = await counts(c.session, vid)
    expect(cnt).toEqual({ orders: 1, items: 1, emails: 1, deducts: 1, consumed: 1, exceptions: 0, refunds: 0 })

    const resv = (await q(`SELECT status, released_at, release_reason FROM reservations WHERE id=$1`, [c.rid]))[0]
    expect(resv).toEqual({ status: 'completed', released_at: null, release_reason: null })
    // the audit trail shows exactly why the stock moved
    const mv = await q(`SELECT movement_type AS t, reason, quantity_delta AS d FROM inventory_movements
                        WHERE reservation_id=$1 ORDER BY created_at, id`, [c.rid])
    // (rows written in one transaction share created_at, so compare as a set)
    expect(mv.map((m: any) => `${m.t}:${m.reason}:${m.d}`).sort()).toEqual([
      'DEDUCT:paid_order:-1', 'RELEASE:expired_cleanup:-1',
      'RESERVE:checkout_reservation:1', 'RESERVE:late_payment_recovery:1'])
    expect((await q(`SELECT result FROM webhook_events WHERE stripe_event_id=$1`, [`evt_lb_${ev}`]))[0].result)
      .toBe('order_created_recovered')
  })

  test('3. recovery is deterministic and idempotent: same event, new event, and 10-way concurrency', async () => {
    needDb()
    const { vid, sku } = await mkVariant(1)
    const c = await checkout(sku, 1)
    await expireNow(c.rid)

    const evt = `evt_lb_det_${++ev}`
    const first = await finalize(c, evt)
    const replay = await finalize(c, evt)                          // 5. same Stripe event
    const other = await finalize(c, `evt_lb_det2_${++ev}`)         // 6. new event, same session
    expect(first.outcome).toBe('order_created')
    expect(replay).toMatchObject({ outcome: 'already_processed', already_processed: true, order_id: first.order_id })
    expect(other).toMatchObject({ outcome: 'already_had_order', already_processed: true, order_id: first.order_id })
    expect(await counts(c.session, vid)).toEqual(
      { orders: 1, items: 1, emails: 1, deducts: 1, consumed: 1, exceptions: 0, refunds: 0 })
    expect(await stockOf(vid)).toEqual({ s: 0, r: 0 })

    // 10 deliveries racing on separate connections, all different event ids, fresh session
    const { vid: v2, sku: sku2 } = await mkVariant(1)
    const c2 = await checkout(sku2, 1)
    await expireNow(c2.rid)
    const clients = await Promise.all(Array.from({ length: 10 }, async () => {
      const cl = new Client((F.db as any).connectionParameters); await cl.connect(); return cl
    }))
    try {
      const outs = await Promise.all(clients.map((cl, i) => finalize(c2, `evt_lb_race_${ev}_${i}`, cl)))
      expect(outs.filter(o => o.outcome === 'order_created')).toHaveLength(1)
      expect(outs.filter(o => o.outcome === 'already_had_order' || o.outcome === 'already_processed')).toHaveLength(9)
    } finally { await Promise.all(clients.map(cl => cl.end())) }
    expect(await counts(c2.session, v2)).toEqual(
      { orders: 1, items: 1, emails: 1, deducts: 1, consumed: 1, exceptions: 0, refunds: 0 })
    expect(await stockOf(v2)).toEqual({ s: 0, r: 0 })
  })

  // 4 + 5 + 6 + 8 ─────────────────────────────────────────────────────────────
  test('4. stock gone after release: durable payment exception, NO stock touched, NO order, NO email', async () => {
    needDb()
    const { vid, sku } = await mkVariant(1)
    const late = await checkout(sku, 1)
    await expireNow(late.rid)
    const winner = await checkout(sku, 1)                          // another customer takes the last unit
    expect(await stockOf(vid)).toEqual({ s: 1, r: 1 })

    const r = await finalize(late)
    expect(r.outcome).toBe('payment_exception')
    expect(r.reason).toBe('insufficient_stock')
    expect(r.payment_exception_id).toBeTruthy()

    expect(await stockOf(vid)).toEqual({ s: 1, r: 1 })             // 7. no oversell, nothing decremented
    expect(await counts(late.session, vid)).toMatchObject({ orders: 0, items: 0, emails: 0, deducts: 0, consumed: 0, exceptions: 1, refunds: 0 })
    expect((await q(`SELECT status FROM reservations WHERE id=$1`, [late.rid]))[0].status).toBe('released')

    const ex = (await q(`SELECT * FROM payment_exceptions WHERE stripe_checkout_session_id=$1`, [late.session]))[0]
    expect(ex).toMatchObject({
      reason: 'insufficient_stock', status: 'open', resolution: null, amount_cents: late.total,
      currency: 'usd', customer_email: 'late@buyer.test', reservation_id: late.rid,
      stripe_payment_intent_id: 'pi_' + late.session,
    })
    expect(ex.detail.shortages).toEqual([{ sku, wanted: 1, available: 0 }])
    expect(ex.detail.items[0]).toMatchObject({ sku, quantity: 1, unit_price_cents: PRICE })
    expect((await q(`SELECT processed, result FROM webhook_events WHERE stripe_event_id=$1`, [`evt_lb_${ev}`]))[0])
      .toEqual({ processed: true, result: 'payment_exception' })

    // the winner is unaffected and still finalizes
    expect((await finalize(winner)).outcome).toBe('order_created')
    expect(await stockOf(vid)).toEqual({ s: 0, r: 0 })
  })

  test('5/6. exception replay: same event is a no-op, a new event never duplicates, and a later restock never resurrects it', async () => {
    needDb()
    const { vid, sku } = await mkVariant(1)
    const late = await checkout(sku, 1)
    await expireNow(late.rid)
    const hog = await checkout(sku, 1)

    const evt = `evt_lb_ex_${++ev}`
    const first = await finalize(late, evt)
    const same = await finalize(late, evt)
    const fresh = await finalize(late, `evt_lb_ex2_${++ev}`)
    expect(first.outcome).toBe('payment_exception')
    expect(same).toMatchObject({ outcome: 'already_processed', already_processed: true })
    expect(fresh).toMatchObject({ outcome: 'payment_exception', duplicate: true, payment_exception_id: first.payment_exception_id })

    // stock becomes available again (hog abandons) and an admin restocks: a replay must NOT create an
    // order for money that is being / has been refunded.
    await q(`SELECT release_reservation_by_id($1::uuid,'test_abandon')`, [hog.rid])
    await q(`SELECT adjust_inventory_with_layers($1::uuid,'ADD',5,'restock','jest','jest@test')`, [vid])
    const late2 = await finalize(late, `evt_lb_ex3_${++ev}`)
    expect(late2).toMatchObject({ outcome: 'payment_exception', duplicate: true })
    expect(await counts(late.session, vid)).toMatchObject({ orders: 0, items: 0, emails: 0, deducts: 0, exceptions: 1 })
  })

  // 7 ─────────────────────────────────────────────────────────────────────────
  test('7. no oversell under contention: a late payment races new reservations for the last unit', async () => {
    needDb()
    for (let round = 0; round < 3; round++) {
      const { vid, sku } = await mkVariant(1)
      const late = await checkout(sku, 1)
      await expireNow(late.rid)
      const clients = await Promise.all(Array.from({ length: 6 }, async () => {
        const cl = new Client((F.db as any).connectionParameters); await cl.connect(); return cl
      }))
      try {
        const reserveTry = (cl: Client) => cl.query(
          `SELECT reserve_inventory($1::jsonb, now() + interval '35 minutes') AS r`,
          [JSON.stringify([{ sku, quantity: 1 }])]).then(() => 'reserved', () => 'refused')
        const results = await Promise.all([
          finalize(late, `evt_lb_c_${++ev}`, clients[0]).then(o => o.outcome as string),
          ...clients.slice(1).map(reserveTry),
        ])
        const gotOrder = results[0] === 'order_created'
        const reservedByOthers = results.slice(1).filter(x => x === 'reserved').length
        // exactly one claimant can own the single unit
        expect(Number(gotOrder) + reservedByOthers).toBe(1)
        if (!gotOrder) expect(results[0]).toBe('payment_exception')
      } finally { await Promise.all(clients.map(cl => cl.end())) }
      const st = await stockOf(vid)
      expect(st.s - st.r).toBeGreaterThanOrEqual(0)
      expect(st.s).toBeGreaterThanOrEqual(0)
      expect(st.r).toBeLessThanOrEqual(1)
    }
  }, 60_000)

  // 8 + 9 ─────────────────────────────────────────────────────────────────────
  test('8/9. no duplicate outbox row and no duplicate financial recognition across recovery + replays', async () => {
    needDb()
    const { vid, sku } = await mkVariant(2)
    const c = await checkout(sku, 2)
    await expireNow(c.rid)
    await finalize(c); await finalize(c); await finalize(c, `evt_lb_fin_${++ev}`)
    const cnt = await counts(c.session, vid)
    expect(cnt).toEqual({ orders: 1, items: 1, emails: 1, deducts: 1, consumed: 1, exceptions: 0, refunds: 0 })
    // revenue recognised once, at the amount Stripe charged
    const o = (await q(`SELECT sum(total_cents)::int AS rev, count(*)::int AS n FROM orders WHERE stripe_payment_intent_id=$1`, ['pi_' + c.session]))[0]
    expect(o).toEqual({ rev: c.total, n: 1 })
    // COGS drawn once from FIFO: 2 units x 3000
    const cogs = (await q(`SELECT line_cogs_cents AS l FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.stripe_checkout_session_id=$1`, [c.session]))[0]
    expect(cogs.l).toBe(6000)
    expect(Number((await q(`SELECT sum(quantity) AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.stripe_checkout_session_id=$1`, [c.session]))[0].n)).toBe(2)
    // layers still reconcile to physical stock
    expect(await q(`SELECT * FROM reconcile_inventory_layers()`)).toEqual([])
    // and a payment exception recognises NOTHING: no order, no revenue, no refund row
    const a = await mkVariant(1); const l = await checkout(a.sku, 1); await expireNow(l.rid)
    const b = await checkout(a.sku, 1)
    expect((await finalize(l)).outcome).toBe('payment_exception')
    expect(Number((await q(`SELECT count(*) AS n FROM orders WHERE stripe_payment_intent_id=$1`, ['pi_' + l.session]))[0].n)).toBe(0)
    expect(await q(`SELECT * FROM reconcile_inventory_layers()`)).toEqual([])
    await finalize(b)
  })

  test('recovered order honours a limited-use discount exactly once', async () => {
    needDb()
    const d = (await q(`INSERT INTO discounts (code,name,type,amount_cents,single_use,active)
                        VALUES ('LB'||substr(md5(random()::text),1,6),'lb','fixed_amount',1000,true,true) RETURNING id`))[0].id
    const { vid, sku } = await mkVariant(1)
    const c = await checkout(sku, 1, { discountId: d, discountCents: 1000 })
    await q(`SELECT claim_discount($1::uuid,$2::uuid,now()+interval '35 minutes')`, [d, c.rid])
    await expireNow(c.rid)                                           // releases the claim too
    expect((await q(`SELECT released_at IS NOT NULL AS rel FROM discount_claims WHERE reservation_id=$1`, [c.rid]))[0].rel).toBe(true)

    const r = await finalize(c)
    expect(r).toMatchObject({ outcome: 'order_created', recovered: true })
    expect(Number((await q(`SELECT redemption_count AS n FROM discounts WHERE id=$1`, [d]))[0].n)).toBe(1)
    expect((await q(`SELECT finalized_at IS NOT NULL AS f FROM discount_claims WHERE reservation_id=$1`, [c.rid]))[0].f).toBe(true)
    await finalize(c, `evt_lb_disc_${++ev}`)
    expect(Number((await q(`SELECT redemption_count AS n FROM discounts WHERE id=$1`, [d]))[0].n)).toBe(1)
    expect((await counts(c.session, vid)).orders).toBe(1)
  })

  test('a paid session with no matching reservation is recorded once (legacy outcome kept)', async () => {
    needDb()
    const session = `cs_test_orphan_${++seq}`
    const call = (e: string) => q(
      `SELECT finalize_paid_order($1,NULL,'pi_orphan','${e}','checkout.session.completed','usd',8700,'o@b.test','O B',NULL,NULL) AS r`, [session])
    const a = (await call(`evt_orph_${++ev}`))[0].r
    const b = (await call(`evt_orph_${++ev}`))[0].r
    expect(a.outcome).toBe('no_reservation')
    expect(a.payment_exception_id).toBeTruthy()
    expect(b.outcome).toBe('payment_exception')
    expect(b.payment_exception_id).toBe(a.payment_exception_id)
    const rows = await q(`SELECT reason, amount_cents, customer_email FROM payment_exceptions WHERE stripe_checkout_session_id=$1`, [session])
    expect(rows).toEqual([{ reason: 'no_reservation', amount_cents: 8700, customer_email: 'o@b.test' }])
  })

  test('a reservation in an unexpected state is recorded, not dropped', async () => {
    needDb()
    const { vid, sku } = await mkVariant(1)
    const c = await checkout(sku, 1)
    await q(`UPDATE reservations SET status='completed' WHERE id=$1`, [c.rid])   // completed, but no order for THIS session
    const r = await finalize(c)
    expect(r).toMatchObject({ outcome: 'payment_exception', reason: 'reservation_not_eligible' })
    expect(await counts(c.session, vid)).toMatchObject({ orders: 0, exceptions: 1 })
  })

  test('amount and currency mismatches still roll back and raise (unchanged contract)', async () => {
    needDb()
    const { sku } = await mkVariant(1)
    const c = await checkout(sku, 1)
    expect(await F.err(`SELECT finalize_paid_order($1,$2::uuid,'pi_x','evt_mm_${++ev}','checkout.session.completed','usd',1,NULL,NULL,NULL,NULL)`, [c.session, c.rid]))
      .toContain('AMOUNT_MISMATCH')
    expect(await F.err(`SELECT finalize_paid_order($1,$2::uuid,'pi_x','evt_mc_${++ev}','checkout.session.completed','eur',${c.total},NULL,NULL,NULL,NULL)`, [c.session, c.rid]))
      .toContain('CURRENCY_MISMATCH')
    expect((await q(`SELECT status FROM reservations WHERE id=$1`, [c.rid]))[0].status).toBe('open')
  })

  // 10 ────────────────────────────────────────────────────────────────────────
  test('10. manual resolution is explicit, auditable, idempotent and the record is undeletable', async () => {
    needDb()
    const { sku } = await mkVariant(1)
    const late = await checkout(sku, 1); await expireNow(late.rid); await checkout(sku, 1)
    const id = (await finalize(late)).payment_exception_id as string

    const rs = (res: string, note: string, who = 'admin@kvrn.test') =>
      q(`SELECT resolve_payment_exception($1::uuid,$2,$3,$4) AS r`, [id, res, note, who]).then(r => r[0].r)

    expect(await F.err(`SELECT resolve_payment_exception($1::uuid,'refunded','','a@b.c')`, [id])).toContain('NOTE_REQUIRED')
    expect(await F.err(`SELECT resolve_payment_exception($1::uuid,'whatever','n','a@b.c')`, [id])).toContain('INVALID_RESOLUTION')
    expect(await F.err(`SELECT resolve_payment_exception($1::uuid,'refunded','n','')`, [id])).toContain('ACTOR_REQUIRED')
    expect((await q(`SELECT status FROM payment_exceptions WHERE id=$1`, [id]))[0].status).toBe('open')

    expect(await rs('refunded', 're_123 issued in Stripe')).toEqual({ outcome: 'resolved', resolution: 'refunded' })
    expect(await rs('refunded', 'again')).toEqual({ outcome: 'already_resolved', resolution: 'refunded' })
    expect(await rs('dismissed', 'x')).toEqual({ outcome: 'conflict', resolution: 'refunded' })
    expect((await q(`SELECT resolve_payment_exception('00000000-0000-0000-0000-000000000000','refunded','n','a@b.c') AS r`))[0].r)
      .toEqual({ outcome: 'not_found' })

    const row = (await q(`SELECT status, resolution, resolution_note, resolved_by FROM payment_exceptions WHERE id=$1`, [id]))[0]
    expect(row).toEqual({ status: 'resolved', resolution: 'refunded', resolution_note: 're_123 issued in Stripe', resolved_by: 'admin@kvrn.test' })
    const audit = await q(`SELECT actor_email, action, payload FROM admin_audit_logs WHERE resource='payment_exceptions' AND resource_id=$1`, [id])
    expect(audit).toHaveLength(1)                                   // exactly one audit row despite 3 attempts
    expect(audit[0]).toMatchObject({ actor_email: 'admin@kvrn.test', action: 'PAYMENT_EXCEPTION_RESOLVED' })
    expect(audit[0].payload).toMatchObject({ resolution: 'refunded', amount_cents: late.total })

    expect(await F.err(`DELETE FROM payment_exceptions WHERE id=$1`, [id])).toContain('DELETE_FORBIDDEN')
    expect(await F.err(`UPDATE payment_exceptions SET status='resolved' WHERE status='open' AND id<>$1 AND false`, [id])).toBe('')
    expect(await F.err(`UPDATE payment_exceptions SET status='resolved' WHERE id IN (SELECT id FROM payment_exceptions WHERE status='open' LIMIT 1)`))
      .toContain('payment_exceptions_state_chk')                     // cannot be closed without the resolution fields
  })

  test('migration 022 re-applies three more times without error and recovery still works', async () => {
    needDb()
    for (let i = 0; i < 3; i++) await q(read('022_late_payment_recovery.sql'))
    const { vid, sku } = await mkVariant(1)
    const c = await checkout(sku, 1); await expireNow(c.rid)
    expect((await finalize(c)).outcome).toBe('order_created')
    expect((await counts(c.session, vid)).orders).toBe(1)
  })
})

// ── Admin API (real handlers, real SQL) ──────────────────────────────────────
jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => (global as any).__LB_ADMIN ?? ({ identity: { email: 'api-admin@kvrn.test' }, error: null }),
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__LB_SQL } }))

describeDB('admin payment-exceptions API', () => {
  const req = (url: string, init?: RequestInit) => {
    const r: any = new Request(url, init); r.nextUrl = new URL(url); return r as NextRequest
  }
  test('GET lists open exceptions; PATCH resolves with audit; bad input and auth are enforced', async () => {
    needDb()
    ;(global as any).__LB_SQL = F.sql
    const { GET } = await import('../../app/api/admin/payment-exceptions/route')
    const { PATCH } = await import('../../app/api/admin/payment-exceptions/[id]/route')

    const { sku } = await mkVariant(1)
    const late = await checkout(sku, 1); await expireNow(late.rid); await checkout(sku, 1)
    const exId = (await finalize(late)).payment_exception_id as string

    const list = await GET(req('https://kvrn.shop/api/admin/payment-exceptions'))
    const body: any = await list.json()
    expect(list.status).toBe(200)
    expect(body.data.find((r: any) => r.id === exId)).toMatchObject({
      reason: 'insufficient_stock', status: 'open', amountCents: late.total, customerEmail: 'late@buyer.test' })
    expect((await GET(req('https://kvrn.shop/api/admin/payment-exceptions?status=nope'))).status).toBe(400)

    const patch = (id: string, b: unknown) => PATCH(
      req(`https://kvrn.shop/api/admin/payment-exceptions/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
      { params: Promise.resolve({ id }) })
    expect((await patch('not-a-uuid', {})).status).toBe(400)
    expect((await patch(exId, { resolution: 'refunded' })).status).toBe(400)               // note required
    expect((await patch(exId, { resolution: 'nope', note: 'x' })).status).toBe(400)
    expect((await patch('00000000-0000-4000-8000-000000000000', { resolution: 'refunded', note: 'x' })).status).toBe(404)
    const ok = await patch(exId, { resolution: 'refunded', note: 'refund re_999 issued' })
    expect(ok.status).toBe(200)
    expect((await patch(exId, { resolution: 'dismissed', note: 'x' })).status).toBe(409)
    expect((await q(`SELECT actor_email FROM admin_audit_logs WHERE resource_id=$1`, [exId]))[0].actor_email).toBe('api-admin@kvrn.test')
    const after: any = await (await GET(req('https://kvrn.shop/api/admin/payment-exceptions?status=open'))).json()
    expect(after.data.find((r: any) => r.id === exId)).toBeUndefined()

    // unauthenticated: the handlers return the auth error and touch nothing
    ;(global as any).__LB_ADMIN = { identity: null, error: new Response('no', { status: 401 }) }
    try {
      expect((await GET(req('https://kvrn.shop/api/admin/payment-exceptions'))).status).toBe(401)
      expect((await patch(exId, { resolution: 'refunded', note: 'x' })).status).toBe(401)
    } finally { delete (global as any).__LB_ADMIN }
  })
})
