// lib/__tests__/helpers/fi-pg.ts
//
// Shared harness for the Financial Integrity real-PostgreSQL tests.
//
// SAFETY: the harness CREATES and DROPS a throwaway database on the server named by
// TEST_DATABASE_URL, so it refuses anything that is not a LOCAL server (localhost /
// 127.0.0.1 / ::1 / a unix socket). Never point it at Neon or production. When the
// variable is absent or non-local, HAVE_DB is false and the suites skip visibly —
// the same convention as reservations.test.ts.

import fs from 'fs'
import path from 'path'
import { Client, types } from 'pg'

// Match the Neon driver the app runs on: DATE columns arrive as 'YYYY-MM-DD' strings,
// not JS Date objects (the expense/ad-spend readers slice them as strings).
types.setTypeParser(1082, (v: string) => v)

export const ROOT = path.resolve(__dirname, '../../..')
export const TEST_DB_URL = process.env.TEST_DATABASE_URL

export function pgConfig(database: string) {
  // `postgresql://user@/db?host=/tmp` (unix socket) is not a valid WHATWG URL.
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

export const HAVE_DB = (() => {
  try { return !!TEST_DB_URL && pgConfig('postgres').isLocal } catch { return false }
})()

export interface FiDb {
  db: Client
  /** Neon-style tagged template + .query, backed by the throwaway database. */
  sql: any
  q: (text: string, params?: unknown[]) => Promise<any[]>
  /** Run a statement expected to FAIL; returns the error message ('' if it succeeded). */
  err: (text: string, params?: unknown[]) => Promise<string>
  close: () => Promise<void>
}

export async function createFiDb(prefix: string): Promise<FiDb> {
  const name = `${prefix}_${process.pid}`
  const { isLocal: _a, ...adminCfg } = pgConfig('postgres')
  const admin = new Client(adminCfg)
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${name}`)
  const { isLocal: _b, ...dbCfg } = pgConfig(name)
  const db = new Client(dbCfg)
  await db.connect()
  const dir = path.join(ROOT, 'db/migrations')
  for (const f of fs.readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    await db.query(fs.readFileSync(path.join(dir, f), 'utf8'))
  }
  const q = (text: string, params: unknown[] = []) => db.query(text, params).then(r => r.rows)
  const sql: any = Object.assign(
    async (s: TemplateStringsArray, ...v: unknown[]) => {
      let t = ''; s.forEach((p, i) => { t += p; if (i < v.length) t += `$${i + 1}` })
      return (await db.query(t, v as any[])).rows
    },
    { query: q })
  const err = async (text: string, params: unknown[] = []) => {
    // A failed statement aborts nothing here (no open transaction), but use a savepoint-free
    // single statement so the connection stays usable.
    try { await db.query(text, params); return '' } catch (e: any) { return String(e?.message ?? e) }
  }
  return {
    db, sql, q, err,
    close: async () => {
      try { await db.end() } catch { /* ignore */ }
      try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) } catch { /* ignore */ }
      try { await admin.end() } catch { /* ignore */ }
    },
  }
}

// ── deterministic ids / dates ────────────────────────────────────────────────
export const P = 'f2100000-0000-0000-0000-00000000aaaa'
export const V = 'f2100000-0000-0000-0000-00000000bbbb'
export const oid = (n: number) => `f2110000-0000-0000-0000-${String(n).padStart(12, '0')}`
export const num = (n: number) => `FI-${String(n).padStart(3, '0')}`
/** noon UTC, n days ago, as a SQL expression */
export const dayExpr = (n: number) =>
  `(date_trunc('day', now() AT TIME ZONE 'UTC') - interval '${n} days' + interval '12 hours') AT TIME ZONE 'UTC'`
/** half-open UTC day window, n days ago */
export const dayRange = (n: number) => {
  const s = new Date(); s.setUTCHours(0, 0, 0, 0); s.setUTCDate(s.getUTCDate() - n)
  const e = new Date(s); e.setUTCDate(e.getUTCDate() + 1)
  return { start: s.toISOString(), end: e.toISOString() }
}
export const ymd = (n: number) => dayRange(n).start.slice(0, 10)

export async function seedCatalog(q: FiDb['q']) {
  await q(`INSERT INTO products (id,drop_code,product_code,name,slug,price_cents,active)
           VALUES ($1,'F','F','F21','f21',1000,true)`, [P])
  await q(`INSERT INTO product_variants (id,product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
           VALUES ($1,$2,'F21-M','Black','#000','M',1,1000)`, [V, P])
  await q(`SELECT add_inventory_layer($1,1000,300,'purchase',NULL,NULL,'cost_batch','jest')`, [V])
}

export interface MkOrder {
  daysAgo?: number
  fee?: number | null
  /** label cost; null = no shipment row at all */
  label?: number | null
  labelSource?: 'shippo_label' | 'shippo_quote' | 'manual' | null
  cogs?: number | null
  consume?: boolean
  tax?: number
  fulfillment?: string
}

/** A paid $10 + $5 shipping order with one line, FIFO-consumed unless told otherwise. */
export async function mkOrder(q: FiDb['q'], n: number, o: MkOrder = {}) {
  const { daysAgo = 5, fee = 100, label = 450, labelSource = 'shippo_label', cogs = 300,
          consume = true, tax = 0, fulfillment = 'unfulfilled' } = o
  const total = 1500 + tax
  await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
      payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,
      shipping_quoted_cents,shipping_before_discount_cents,stripe_fee_cents,stripe_fee_source,stripe_balance_transaction_id)
    VALUES ($1,$2,$3,$4,$5,'paid',$9,'usd',1000,500,0,$10,$11,${dayExpr(daysAgo)},500,500,$6,$7,$8)`,
    [oid(n), num(n), 'cs_' + num(n), 'pi_' + num(n), 'ch_' + num(n), fee,
     fee === null ? null : 'stripe_api', fee === null ? null : 'txn_' + num(n), fulfillment, tax, total])
  const item = (await q(`INSERT INTO order_items (order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents,unit_cogs_cents,line_cogs_cents)
    VALUES ($1,$2,'F21-M','F21','M','Black',1,1000,1000,$3,$3) RETURNING id`, [oid(n), V, cogs]))[0].id
  if (consume) {
    await q(`SELECT consume_inventory_fifo($1,1,'sale',NULL,$2,$3)`, [V, oid(n), item])
    await q(`UPDATE product_variants SET stock_on_hand = stock_on_hand - 1 WHERE id = $1`, [V])
  }
  if (label !== null) await addShipment(q, n, label, labelSource, `trk${n}`)
}

export const addShipment = (q: FiDb['q'], n: number, cost: number | null, source: string | null, trk: string) =>
  q(`INSERT INTO shipments (order_id,tracking_number,carrier,label_cost_cents,cost_source)
     VALUES ($1,$2,'usps',$3,$4)`, [oid(n), trk, cost, source])

/** A succeeded refund; fee = null leaves fee_refunded_cents UNKNOWN. */
export const addRefund = (q: FiDb['q'], n: number, id: string, cents: number, o: {
  fee?: number | null; merch?: number | null; ship?: number | null; taxPart?: number | null; resolved?: boolean } = {}) => {
  const { fee = null, merch = cents, ship = 0, taxPart = 0, resolved = true } = o
  return q(
    `INSERT INTO order_refunds (order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
       merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,fee_refunded_cents,
       component_breakdown_status,component_breakdown_source,status,refunded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'succeeded',now())`,
    [oid(n), id, 'ch_' + num(n), 'pi_' + num(n), cents,
     resolved ? merch : null, resolved ? ship : null, resolved ? taxPart : null, fee,
     resolved ? 'resolved' : 'unknown', resolved ? 'admin' : null])
}
