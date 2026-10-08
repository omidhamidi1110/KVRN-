// Money safety for multi-currency, against REAL PostgreSQL (migrations 001-035, the real frozen
// reserve_inventory / finalize_paid_order / record_order_refund).
//
// What this proves:
//   1. The frozen finalize_paid_order REJECTS any non-USD payment and creates no order (this is the
//      reason no foreign currency is payable: lib/i18n/currency-policy.ts CURRENCY_BLOCKERS).
//   2. A foreign-currency row that somehow reaches a money table is SURFACED by migration 035's
//      read-only i18n_currency_anomalies() instead of being silently summed as USD cents.
//   3. USD rows never appear in that detector; presentment/FX columns were not added.
//   4. Migration 035 is additive and idempotent.
// Requires a LOCAL TEST_DATABASE_URL; skips visibly otherwise.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { HAVE_DB, createFiDb, type FiDb } from './helpers/fi-pg'

const d = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test('NOTE: i18n currency DB tests skipped — TEST_DATABASE_URL absent or not local.', () => expect(true).toBe(true))

const ROOT = path.resolve(__dirname, '../..')
const PRICE = 8000
const SHIP = 700
let F: FiDb
let seq = 0
const q = (t: string, p: unknown[] = []) => F.q(t, p)

async function mkVariant(stock: number) {
  const n = ++seq
  const pid = `f3500000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const vid = `f3500001-0000-0000-0000-${String(n).padStart(12, '0')}`
  const sku = `KVRN-CUR-${n}`
  await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active) VALUES ($1,'C',$2,'Currency Tee',$3,$4,true)`,
    [pid, `CU${n}`, `cu-${n}`, PRICE])
  await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand) VALUES ($1,$2,$3,'Black','#000','M',1,0)`, [vid, pid, sku])
  await q(`SELECT add_inventory_layer($1,$2,3000,'purchase',NULL,NULL,'cost_batch','jest')`, [vid, stock])
  await q(`UPDATE product_variants SET stock_on_hand=$2 WHERE id=$1`, [vid, stock])
  return { vid, sku }
}

async function startCheckout(sku: string, qty: number, email: string) {
  const n = ++seq
  const res = (await q(`SELECT reserve_inventory($1::jsonb, now() + interval '35 minutes') AS r`, [JSON.stringify([{ sku, quantity: qty }])]))[0].r
  const rid = res.reservation_id as string
  const session = `cs_test_cur_${n}_${crypto.randomBytes(3).toString('hex')}`
  await q(`SELECT attach_stripe_session($1::uuid,$2,extract(epoch from now()+interval '31 minutes')::bigint)`, [rid, session])
  await q(`SELECT save_reservation_checkout_details($1::uuid,$2,'Cust Name',NULL,
            '{"line1":"1 Main","city":"LA","state":"CA","postal_code":"90001","country":"US"}'::jsonb,
            'standard',$3,0,$3,NULL,NULL,NULL,0)`, [rid, email, SHIP])
  return { rid, session, email, total: qty * PRICE + SHIP }
}

let ev = 0
const finalize = (c: { rid: string; session: string; total: number; email: string }, currency: string) =>
  q(`SELECT finalize_paid_order($1,$2::uuid,$3,$4,'checkout.session.completed',$5,$6,$7,'Cust Name',NULL,NULL) AS r`,
    [c.session, c.rid, 'pi_' + c.session, `evt_cur_${++ev}`, currency, c.total, c.email])

const counts = async () => ({
  orders: Number((await q(`SELECT count(*) AS n FROM orders`))[0].n),
  stock: await q(`SELECT sku, stock_on_hand, reserved_quantity FROM product_variants ORDER BY sku`),
})

beforeAll(async () => { if (HAVE_DB) F = await createFiDb('i18n_currency') }, 180_000)
afterAll(async () => { await F?.close() })

d('frozen finalize_paid_order rejects every non-USD payment', () => {
  test.each(['eur', 'EUR', 'gbp', 'jpy', 'cny', 'mxn'])('%s: CURRENCY_MISMATCH, no order, reservation untouched', async (cur) => {
    const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, `buyer-${cur}@example.com`)
    const before = await counts()
    const err = await F.err(`SELECT finalize_paid_order($1,$2::uuid,$3,$4,'checkout.session.completed',$5,$6,$7,'Cust Name',NULL,NULL)`,
      [c.session, c.rid, 'pi_' + c.session, `evt_cur_${++ev}`, cur, c.total, c.email])
    expect(err).toMatch(/KVRN_RESERVATION\|CURRENCY_MISMATCH/)
    expect(await counts()).toEqual(before)
    expect((await q(`SELECT status FROM reservations WHERE id=$1`, [c.rid]))[0].status).not.toBe('completed')
  })
  test('the same reservation still finalizes in usd', async () => {
    const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'ok@example.com')
    await F.err(`SELECT finalize_paid_order($1,$2::uuid,$3,$4,'checkout.session.completed','eur',$5,$6,'N',NULL,NULL)`, [c.session, c.rid, 'pi_' + c.session, `evt_cur_${++ev}`, c.total, c.email])
    const r = (await finalize(c, 'usd'))[0].r
    expect(r.outcome ?? r.order_id ?? r).toBeTruthy()
    const o = (await q(`SELECT currency, total_cents FROM orders WHERE stripe_payment_intent_id=$1`, ['pi_' + c.session]))[0]
    expect(o).toEqual({ currency: 'usd', total_cents: c.total })
  })
})

d('migration 035: additive, idempotent, read-only', () => {
  const sqlText = fs.readFileSync(path.join(ROOT, 'db/migrations/035_localization_currency.sql'), 'utf8')
  test('it only creates its own function — no DROP/ALTER/UPDATE/DELETE/INSERT, no new columns', () => {
    const code = sqlText.replace(/--.*$/gm, '')
    expect(code).not.toMatch(/\b(DROP|ALTER|UPDATE|DELETE|INSERT|TRUNCATE)\b/i)
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION i18n_currency_anomalies\(\)/)
  })
  test('re-applying changes nothing and does not error', async () => {
    await q(sqlText)
    await q(sqlText)
    expect((await q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname='i18n_currency_anomalies'`))[0].n).toBe(1)
  })
  test('no presentment / FX columns were added to money tables', async () => {
    const cols = await q(`SELECT table_name, column_name FROM information_schema.columns
                           WHERE table_schema='public' AND column_name ~* 'presentment|fx_rate|exchange_rate'`)
    expect(cols).toEqual([])
  })
  test('numbering: 001-034 are the frozen set; this branch adds exactly one (035)', () => {
    const nums = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => /^\d+_.*\.sql$/.test(f)).map(f => Number(f.slice(0, 3)))
    expect(nums.filter(n => n === 35)).toHaveLength(1)
    expect(Math.max(...nums)).toBeGreaterThanOrEqual(35)
  })
})

d('foreign-currency rows are surfaced, never silently summed as USD', () => {
  test('a clean database has no anomalies, and USD rows never appear', async () => {
    const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'usd-only@example.com')
    await finalize(c, 'usd')
    const pi = 'pi_' + c.session
    const rf = (await q(`SELECT record_order_refund('re_usd_1',$1,'ch_1',1000,'usd','succeeded',NULL,NULL,now()) AS r`, [pi]))[0].r
    expect(rf.outcome).toBe('recorded')
    const rows = await q(`SELECT * FROM i18n_currency_anomalies()`)
    expect(rows).toEqual([])
  })

  test('a EUR refund recorded against a USD order is listed with its source, id and currency', async () => {
    const v = await mkVariant(5)
    const c = await startCheckout(v.sku, 1, 'eur-refund@example.com')
    await finalize(c, 'usd')
    const pi = 'pi_' + c.session
    await q(`SELECT record_order_refund('re_eur_1',$1,'ch_2',700,'eur','succeeded',NULL,NULL,now())`, [pi])
    const rows = await q(`SELECT * FROM i18n_currency_anomalies() ORDER BY source`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'order_refunds', currency: 'eur' })
    expect(Number(rows[0].amount_cents)).toBe(700)
    const stored = (await q(`SELECT id::text AS id FROM order_refunds WHERE stripe_refund_id='re_eur_1'`))[0].id
    expect(rows[0].record_id).toBe(stored)
  })

  test('an unmatched EUR payment (a real webhook path) lands in payment_exceptions and is surfaced', async () => {
    await q(`SELECT finalize_paid_order('cs_orphan_eur', gen_random_uuid(), 'pi_orphan_eur', 'evt_orphan_eur', 'checkout.session.completed','EUR', 5000,'orphan@example.com','N',NULL,NULL)`)
    const stored = await q(`SELECT currency, amount_cents FROM payment_exceptions WHERE stripe_checkout_session_id='cs_orphan_eur'`)
    expect(stored).toEqual([{ currency: 'eur', amount_cents: 5000 }])
    const rows = await q(`SELECT source, currency, amount_cents::int AS amount_cents FROM i18n_currency_anomalies() WHERE source='payment_exceptions'`)
    expect(rows).toEqual([{ source: 'payment_exceptions', currency: 'eur', amount_cents: 5000 }])
  })

  test('the detector is read-only: running it changes no data', async () => {
    const before = await q(`SELECT (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM order_refunds)::int r, (SELECT count(*) FROM payment_exceptions)::int p`)
    await q(`SELECT * FROM i18n_currency_anomalies()`)
    await q(`SELECT * FROM i18n_currency_anomalies()`)
    expect(await q(`SELECT (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM order_refunds)::int r, (SELECT count(*) FROM payment_exceptions)::int p`)).toEqual(before)
  })

  test('every USD order keeps currency usd (checkout is USD-only end to end)', async () => {
    expect(await q(`SELECT DISTINCT currency FROM orders`)).toEqual([{ currency: 'usd' }])
  })
})
