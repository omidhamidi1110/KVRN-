// lib/funnel-analytics.ts — first-party ecommerce funnel analytics (server-only)
//
// Five stages, recorded in the analytics_sessions / analytics_events tables that
// migration 011 created and nothing had ever written to:
//
//   1 session_start        browser, once per browsing session
//   2 product_viewed       browser, once per session + product
//   3 add_to_cart          browser, one per successful add
//   4 checkout_started     SERVER, after the Stripe session was created AND attached
//   5 purchase_completed   SERVER, from the paid-order finalization path
//
// TRUST MODEL (matches the 011 design notes)
//   The browser can only ever submit stages 1-3. Stages 4 and 5 are written by server
//   code that already holds authoritative ids, so a visitor cannot forge a checkout or a
//   purchase. Product and variant ids are resolved server-side from slug/sku against the
//   catalog; the browser never supplies a price, a total or an id column.
//
// PRIVACY
//   No PII is accepted or stored: the ingest validator is a strict allowlist, so an
//   unknown field (email, name, phone, address, ...) makes the whole event invalid.
//   Referrers are reduced to their origin, landing pages to a path without query string,
//   UTM values are short plain tokens. No IP, no user agent, no fingerprint is stored.
//
// IDEMPOTENCY WITHOUT A SCHEMA CHANGE
//   analytics_events.id is the primary key, so every event gets a DETERMINISTIC id derived
//   from what makes it unique (see funnelEventId) and is inserted ON CONFLICT DO NOTHING.
//   Duplicate delivery - a React double effect, a retried request, a Stripe webhook replay,
//   two concurrent webhook deliveries - is absorbed by the database itself.
//
// BEST-EFFORT
//   Nothing here may block a customer or a paid order. Callers on the money path use the
//   try* wrappers, which swallow and log (message only, truncated) any failure.

import { createHash } from 'crypto'
import type { NeonQueryFunction } from '@neondatabase/serverless'
import { normalizeReferrer } from './affiliate-session'
import { buildBuckets } from './chart-math'

type Sql = NeonQueryFunction<false, false>

// ─────────────────────────────────────────────────────────────────────────────
// EVENT NAMES (allowlist)
// ─────────────────────────────────────────────────────────────────────────────

export const FUNNEL_EVENTS = [
  'session_start', 'product_viewed', 'add_to_cart', 'checkout_started', 'purchase_completed',
] as const
export type FunnelEvent = typeof FUNNEL_EVENTS[number]

/** The only events the PUBLIC endpoint accepts. Stages 4 and 5 are server-set. */
export const CLIENT_EVENTS = ['session_start', 'product_viewed', 'add_to_cart'] as const
export type ClientEventName = typeof CLIENT_EVENTS[number]

/** Hard cap on events per session; a runaway client cannot grow the table without bound. */
export const MAX_EVENTS_PER_SESSION = 500
export const MAX_BODY_BYTES = 2048
const MAX_CHECKOUT_ITEMS = 20

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/
// UTM values are plain marketing tokens. '@' is deliberately outside the class so an
// email address pasted into a campaign link can never be stored.
const UTM_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-+:/%]{0,99}$/
// ONLY source / medium / campaign are retained. utm_content and utm_term are deliberately
// not accepted: unnecessary for the funnel and a free-form/privacy exposure.
const UTM_KEYS = ['source', 'medium', 'campaign'] as const
const DEVICES = ['mobile', 'desktop', 'tablet'] as const

export type Utm = Partial<Record<typeof UTM_KEYS[number], string>>
export type Device = typeof DEVICES[number]

export type ClientEvent =
  | { event: 'session_start'; sid: string; landing: string | null; referrer: string | null
      utm: Utm | null; device: Device | null }
  | { event: 'product_viewed'; sid: string; slug: string; sku: string | null }
  | { event: 'add_to_cart'; sid: string; eid: string; slug: string; sku: string | null; qty: number }

export type Validation =
  | { ok: true; value: ClientEvent }
  | { ok: false; reason: string }

const bad = (reason: string): Validation => ({ ok: false, reason })

function exactKeys(o: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(o).every(k => allowed.includes(k))
}

/**
 * Reduce a landing path to a bare, same-site path: no query string, no fragment, no
 * scheme/host. Returns null when it cannot be made safe. Query strings are dropped
 * because they routinely carry tokens, emails and order ids.
 */
export function cleanLandingPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null
  const path = raw.split(/[?#]/, 1)[0]
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 200) return null
  if (/[\u0000-\u001F\u007F\s\\]/.test(path)) return null
  return path
}

/** Admin screens and internal APIs are never storefront traffic. */
export function isInternalPath(path: string): boolean {
  return /^\/(admin|api|_next)(\/|$)/i.test(path)
}

function cleanUtm(raw: unknown): { ok: true; utm: Utm | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, utm: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false }
  const o = raw as Record<string, unknown>
  if (!exactKeys(o, [...UTM_KEYS])) return { ok: false }
  const out: Utm = {}
  for (const k of UTM_KEYS) {
    const v = o[k]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string') return { ok: false }
    const t = v.trim()
    // An unsafe value is DROPPED, not stored and not allowed to fail the visit.
    if (UTM_VALUE_RE.test(t)) out[k] = t
  }
  return { ok: true, utm: Object.keys(out).length ? out : null }
}

/**
 * Strict allowlist validation of a browser-submitted event. Unknown event names, unknown
 * fields, wrong types and out-of-range numbers are all rejected; nothing is coerced.
 */
export function validateClientEvent(input: unknown): Validation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('not_an_object')
  const o = input as Record<string, unknown>
  const event = o.event
  if (typeof event !== 'string' || !(CLIENT_EVENTS as readonly string[]).includes(event)) {
    return bad('event_not_allowed')
  }
  if (typeof o.sid !== 'string' || !UUID_V4.test(o.sid)) return bad('bad_session_id')
  const sid = o.sid.toLowerCase()

  if (event === 'session_start') {
    if (!exactKeys(o, ['event', 'sid', 'landing', 'referrer', 'utm', 'device'])) return bad('unknown_field')
    let landing: string | null = null
    if (o.landing !== undefined && o.landing !== null) {
      landing = cleanLandingPath(o.landing)
      // A real path that is internal is admin/API traffic and must not be counted.
      if (landing && isInternalPath(landing)) return bad('internal_path')
    }
    if (o.referrer !== undefined && o.referrer !== null && typeof o.referrer !== 'string') return bad('bad_referrer')
    const referrer = normalizeReferrer(o.referrer)
    const u = cleanUtm(o.utm)
    if (!u.ok) return bad('bad_utm')
    let device: Device | null = null
    if (o.device !== undefined && o.device !== null) {
      if (typeof o.device !== 'string' || !(DEVICES as readonly string[]).includes(o.device)) return bad('bad_device')
      device = o.device as Device
    }
    return { ok: true, value: { event, sid, landing, referrer, utm: u.utm, device } }
  }

  if (typeof o.slug !== 'string' || o.slug.length > 100 || !SLUG_RE.test(o.slug)) return bad('bad_slug')
  let sku: string | null = null
  if (o.sku !== undefined && o.sku !== null) {
    if (typeof o.sku !== 'string' || !SKU_RE.test(o.sku)) return bad('bad_sku')
    sku = o.sku
  }

  if (event === 'product_viewed') {
    if (!exactKeys(o, ['event', 'sid', 'slug', 'sku'])) return bad('unknown_field')
    return { ok: true, value: { event, sid, slug: o.slug, sku } }
  }

  // add_to_cart
  if (!exactKeys(o, ['event', 'sid', 'eid', 'slug', 'sku', 'qty'])) return bad('unknown_field')
  if (typeof o.eid !== 'string' || !UUID_V4.test(o.eid)) return bad('bad_event_id')
  if (typeof o.qty !== 'number' || !Number.isInteger(o.qty) || o.qty < 1 || o.qty > 99) return bad('bad_quantity')
  return { ok: true, value: { event: 'add_to_cart', sid, eid: o.eid.toLowerCase(), slug: o.slug, sku, qty: o.qty } }
}

export function isValidFunnelSessionId(v: unknown): v is string {
  return typeof v === 'string' && UUID_V4.test(v)
}

/** Obvious automation. Dropped silently so it cannot inflate the funnel. */
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|curl\/|wget|python-requests|node-fetch|undici|go-http|java\//i
export function isLikelyBot(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_RE.test(userAgent)
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC EVENT IDS
// ─────────────────────────────────────────────────────────────────────────────

/** Stable UUID (v5-shaped) from a uniqueness key. Same key -> same id -> one row. */
export function funnelEventId(key: string): string {
  const b = Buffer.from(createHash('sha256').update('kvrn-funnel-v1:' + key).digest().subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const eventKeys = {
  sessionStart:    (sid: string)                  => `ss:${sid}`,
  productViewed:   (sid: string, productId: string) => `pv:${sid}:${productId}`,
  addToCart:       (sid: string, eid: string)     => `atc:${sid}:${eid}`,
  checkoutStarted: (reservationId: string)        => `cs:${reservationId}`,
  purchase:        (orderId: string)              => `pc:${orderId}`,
}

// ─────────────────────────────────────────────────────────────────────────────
// RATES (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cumulative session counts: a session is counted at a stage if it reached that stage
 * OR ANY LATER ONE. That keeps every count <= the one before it, so a rate can never
 * exceed 100%: a returning visitor whose saved cart goes straight to checkout, or a
 * quick-add from a listing with no product-page view, still counts as having reached
 * the earlier stages instead of producing a nonsensical 120% step.
 */
export interface FunnelStages {
  visits: number
  reachedProduct: number
  reachedCart: number
  reachedCheckout: number
  purchased: number
}

export interface FunnelRates {
  visitToProduct: number | null
  productToCart: number | null
  cartToCheckout: number | null
  checkoutToPurchase: number | null
  visitToPurchase: number | null
}

/** Percentage with two decimals, or null when the denominator is 0 (unknown is not 0%). */
export function ratePct(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return Math.round((numerator / denominator) * 10000) / 100
}

export function computeFunnelRates(s: FunnelStages): FunnelRates {
  return {
    visitToProduct:     ratePct(s.reachedProduct, s.visits),
    productToCart:      ratePct(s.reachedCart, s.reachedProduct),
    cartToCheckout:     ratePct(s.reachedCheckout, s.reachedCart),
    checkoutToPurchase: ratePct(s.purchased, s.reachedCheckout),
    visitToPurchase:    ratePct(s.purchased, s.visits),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RANGES
// ─────────────────────────────────────────────────────────────────────────────

export const FUNNEL_RANGES = ['7d', '30d', '90d'] as const
export type FunnelRange = typeof FUNNEL_RANGES[number]

export function parseFunnelRange(raw: string | null): FunnelRange | null {
  if (raw === null || raw === '') return '30d'
  return (FUNNEL_RANGES as readonly string[]).includes(raw) ? (raw as FunnelRange) : null
}

/** Rolling half-open window [now - N days, now). */
export function funnelWindow(range: FunnelRange, now: Date = new Date()): { start: string; end: string } {
  const days = Number(range.slice(0, -1))
  return { start: new Date(now.getTime() - days * 86_400_000).toISOString(), end: now.toISOString() }
}

// ─────────────────────────────────────────────────────────────────────────────
// TREND OVER TIME (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One UTC calendar day of the funnel, for the trend chart.
 *
 * COHORT BASIS: a session is placed in the day its session_start was recorded, and
 * then carries its furthest stage whenever that stage happened. Summing every
 * bucket therefore reproduces the summary funnel exactly (asserted in the test
 * suite), and a purchase is credited to the day its session STARTED, not the day
 * the order was paid. Revenue/order trends live in the financial charts instead.
 */
export interface FunnelTrendBucket {
  /** YYYY-MM-DD, UTC. */
  date: string
  label: string
  /** Bucket bounds, clipped to the requested window. */
  start: string
  end: string
  /** True when the window edge cuts this UTC day short (first and last bucket of a rolling window). */
  partial: boolean
  /**
   * Whether first-party collection existed for this bucket:
   *   'full'    collection had begun before the bucket started
   *   'partial' the very first recorded session falls inside the bucket
   *   'none'    nothing had ever been recorded yet - the bucket is NOT a real zero
   */
  coverage: 'full' | 'partial' | 'none'
  /** null when coverage is 'none': no data existed, so no zero is invented. */
  stages: FunnelStages | null
  /** null with no sessions (zero denominator) or no coverage; never 0%. */
  rates: FunnelRates | null
}

export interface FunnelTrend {
  granularity: 'day'
  /** Instant of the first session_start ever recorded, or null when none exists. */
  collectionStartedAt: string | null
  buckets: FunnelTrendBucket[]
}

export interface FunnelTrendRow {
  day: string
  visits: number
  reached_product: number
  reached_cart: number
  reached_checkout: number
  purchased: number
}

export function buildFunnelTrend(
  w: { start: string; end: string },
  rows: FunnelTrendRow[],
  collectionStartedAt: string | Date | null,
): FunnelTrend {
  const first = collectionStartedAt === null || collectionStartedAt === undefined
    ? null : new Date(collectionStartedAt)
  const firstMs = first && !Number.isNaN(first.getTime()) ? first.getTime() : null
  const byDay = new Map<string, FunnelTrendRow>()
  for (const r of rows) byDay.set(String(r.day), r)

  const buckets = buildBuckets(w.start, w.end, 'day').map<FunnelTrendBucket>(b => {
    const startMs = Date.parse(b.start)
    const endMs = Date.parse(b.end)
    const coverage: FunnelTrendBucket['coverage'] =
      firstMs === null || endMs <= firstMs ? 'none'
      : firstMs > startMs ? 'partial'
      : 'full'
    const date = b.start.slice(0, 10)
    const partial = endMs - startMs < 86_400_000
    if (coverage === 'none') {
      return { date, label: b.label, start: b.start, end: b.end, partial, coverage, stages: null, rates: null }
    }
    // A day inside the collection period with no recorded sessions is a real count of zero;
    // its rates are null (zero denominator), never 0%.
    const r = byDay.get(date)
    const stages: FunnelStages = {
      visits: Number(r?.visits ?? 0),
      reachedProduct: Number(r?.reached_product ?? 0),
      reachedCart: Number(r?.reached_cart ?? 0),
      reachedCheckout: Number(r?.reached_checkout ?? 0),
      purchased: Number(r?.purchased ?? 0),
    }
    return { date, label: b.label, start: b.start, end: b.end, partial, coverage, stages, rates: computeFunnelRates(stages) }
  })

  return { granularity: 'day', collectionStartedAt: firstMs === null ? null : new Date(firstMs).toISOString(), buckets }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export type RecordOutcome = 'recorded' | 'duplicate' | 'ignored'

export function createFunnelService(sql: Sql) {
  /** Make sure the session row and its single session_start event exist. Idempotent. */
  async function ensureSession(sid: string, d: {
    landing?: string | null; referrer?: string | null; utm?: Utm | null; device?: Device | null
  } = {}): Promise<boolean> {
    const utm = d.utm ? JSON.stringify(d.utm) : null
    await sql`
      INSERT INTO analytics_sessions
        (session_id, device_type, landing_page, referrer, first_touch_utm, last_touch_utm, last_seen_at)
      VALUES (${sid}, ${d.device ?? null}, ${d.landing ?? null}, ${d.referrer ?? null},
              ${utm}::jsonb, ${utm}::jsonb, NOW())
      ON CONFLICT (session_id) DO UPDATE SET
        last_seen_at    = NOW(),
        device_type     = COALESCE(analytics_sessions.device_type,     EXCLUDED.device_type),
        landing_page    = COALESCE(analytics_sessions.landing_page,    EXCLUDED.landing_page),
        referrer        = COALESCE(analytics_sessions.referrer,        EXCLUDED.referrer),
        first_touch_utm = COALESCE(analytics_sessions.first_touch_utm, EXCLUDED.first_touch_utm),
        last_touch_utm  = COALESCE(EXCLUDED.last_touch_utm, analytics_sessions.last_touch_utm)
    `
    const rows = await sql`
      INSERT INTO analytics_events (id, session_id, event_name)
      VALUES (${funnelEventId(eventKeys.sessionStart(sid))}::uuid, ${sid}, 'session_start')
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `
    return (rows as any[]).length > 0
  }

  return {
    ensureSession,

    /** Stages 1-3, from the browser. The caller has already run validateClientEvent. */
    async recordClientEvent(ev: ClientEvent): Promise<RecordOutcome> {
      if (ev.event === 'session_start') {
        const created = await ensureSession(ev.sid, ev)
        return created ? 'recorded' : 'duplicate'
      }

      // Resolve identifiers from the catalog; the browser's word is never stored.
      const found = await sql`
        SELECT p.id AS product_id, p.price_cents, v.id AS variant_id, v.sku AS variant_sku
        FROM products p
        LEFT JOIN product_variants v ON v.product_id = p.id AND v.sku = ${ev.sku}
        WHERE p.slug = ${ev.slug} AND p.active
        LIMIT 1
      ` as any[]
      const row = found[0]
      if (!row) return 'ignored'                       // not a real, live product page

      await ensureSession(ev.sid)

      const productId: string = row.product_id
      const variantId: string | null = row.variant_id ?? null
      const variantSku: string | null = row.variant_sku ?? null

      let id: string
      let valueCents: number | null = null
      let meta: string | null = null
      if (ev.event === 'product_viewed') {
        id = funnelEventId(eventKeys.productViewed(ev.sid, productId))
      } else {
        id = funnelEventId(eventKeys.addToCart(ev.sid, ev.eid))
        const line = Number(row.price_cents) * ev.qty            // server price x validated qty
        valueCents = Number.isSafeInteger(line) ? line : null     // unknown stays NULL, never 0
        meta = JSON.stringify({ qty: ev.qty })
      }

      const rows = await sql`
        INSERT INTO analytics_events
          (id, session_id, event_name, product_id, variant_id, variant_sku, value_cents, meta)
        SELECT ${id}::uuid, ${ev.sid}, ${ev.event}, ${productId}::uuid, ${variantId}::uuid,
               ${variantSku}, ${valueCents}::int, ${meta}::jsonb
        WHERE (SELECT COUNT(*) FROM analytics_events WHERE session_id = ${ev.sid}) < ${MAX_EVENTS_PER_SESSION}
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      ` as any[]
      return rows.length > 0 ? 'recorded' : 'duplicate'
    },

    /**
     * Stage 4. Called only after the Stripe Checkout Session exists and is attached to the
     * reservation, so it cannot claim a checkout that failed to start. One row per
     * reservation; the cart's variants ride in meta (ids and quantities only).
     */
    async recordCheckoutStarted(a: {
      sessionId: string; reservationId: string; subtotalCents: number | null
      items: Array<{ variantId: string; quantity: number }>
    }): Promise<RecordOutcome> {
      if (!isValidFunnelSessionId(a.sessionId) || !UUID_ANY.test(a.reservationId)) return 'ignored'
      const sid = a.sessionId.toLowerCase()
      const items = a.items
        .filter(i => UUID_ANY.test(i.variantId) && Number.isInteger(i.quantity) && i.quantity > 0)
        .slice(0, MAX_CHECKOUT_ITEMS)
        .map(i => ({ v: i.variantId, q: i.quantity }))
      const value = a.subtotalCents !== null && Number.isSafeInteger(a.subtotalCents) && a.subtotalCents >= 0
        ? a.subtotalCents : null
      await ensureSession(sid)
      const rows = await sql`
        INSERT INTO analytics_events (id, session_id, event_name, reservation_id, value_cents, meta)
        VALUES (${funnelEventId(eventKeys.checkoutStarted(a.reservationId))}::uuid, ${sid},
                'checkout_started', ${a.reservationId}::uuid, ${value}::int,
                ${JSON.stringify({ items })}::jsonb)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      ` as any[]
      return rows.length > 0 ? 'recorded' : 'duplicate'
    },

    /**
     * Stage 5. Called only from the paid-order path. The session is recovered from this
     * order's own checkout_started row (same reservation), so a purchase can only attach to
     * a session that really reached checkout. The value is orders.total_cents copied by SQL
     * (no arithmetic here). An order whose visitor did not consent to analytics has no such
     * row and records nothing: 'ignored'.
     */
    async recordPurchase(a: { orderId: string; reservationId: string }): Promise<RecordOutcome> {
      if (!UUID_ANY.test(a.orderId) || !UUID_ANY.test(a.reservationId)) return 'ignored'
      const id = funnelEventId(eventKeys.purchase(a.orderId))
      const csId = funnelEventId(eventKeys.checkoutStarted(a.reservationId))
      const rows = await sql`
        INSERT INTO analytics_events
          (id, session_id, event_name, reservation_id, order_id, value_cents)
        SELECT ${id}::uuid, cs.session_id, 'purchase_completed', o.reservation_id, o.id, o.total_cents
        FROM analytics_events cs
        JOIN orders o ON o.id = ${a.orderId}::uuid AND o.reservation_id = ${a.reservationId}::uuid
        WHERE cs.id = ${csId}::uuid AND cs.event_name = 'checkout_started'
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      ` as any[]
      if (rows.length > 0) return 'recorded'
      const existing = await sql`SELECT 1 FROM analytics_events WHERE id = ${id}::uuid` as any[]
      return existing.length > 0 ? 'duplicate' : 'ignored'
    },

    /** Admin report for a half-open [start, end) window. */
    async getFunnelReport(w: { start: string; end: string }) {
      const [stageRows, totalRows, orderRows, productRows, trendRows, firstRows] = await Promise.all([
        sql`
          WITH cohort AS (
            SELECT DISTINCT session_id FROM analytics_events
            WHERE event_name = 'session_start'
              AND created_at >= ${w.start}::timestamptz AND created_at < ${w.end}::timestamptz
          ), tops AS (
            SELECT c.session_id,
                   COALESCE(MAX(CASE e.event_name
                     WHEN 'product_viewed'     THEN 2
                     WHEN 'add_to_cart'        THEN 3
                     WHEN 'checkout_started'   THEN 4
                     WHEN 'purchase_completed' THEN 5 END), 1) AS top
            FROM cohort c
            LEFT JOIN analytics_events e
              ON e.session_id = c.session_id AND e.event_name <> 'session_start'
            GROUP BY c.session_id
          )
          SELECT COUNT(*)::int                          AS visits,
                 COUNT(*) FILTER (WHERE top >= 2)::int  AS reached_product,
                 COUNT(*) FILTER (WHERE top >= 3)::int  AS reached_cart,
                 COUNT(*) FILTER (WHERE top >= 4)::int  AS reached_checkout,
                 COUNT(*) FILTER (WHERE top >= 5)::int  AS purchased
          FROM tops
        `,
        sql`
          SELECT event_name, COUNT(*)::int AS n, SUM(value_cents)::bigint AS value_cents,
                 COUNT(*) FILTER (WHERE value_cents IS NULL)::int AS value_unknown
          FROM analytics_events
          WHERE created_at >= ${w.start}::timestamptz AND created_at < ${w.end}::timestamptz
          GROUP BY event_name
        `,
        // COVERAGE: one cohort for numerator AND denominator — orders whose paid_at is in the
        // window. "Tracked" = such an order has a purchase_completed event, whenever that event
        // was written (a healed/late event must not move an order between windows). tracked is a
        // subset of the cohort by construction, so the share can never exceed 100%.
        sql`
          SELECT COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM analytics_events e
                   WHERE e.event_name = 'purchase_completed' AND e.order_id = o.id
                 ))::int AS tracked
          FROM orders o
          WHERE o.paid_at IS NOT NULL
            AND o.paid_at >= ${w.start}::timestamptz AND o.paid_at < ${w.end}::timestamptz
        `,
        sql`
          WITH stage AS (
            SELECT product_id, session_id, 1 AS rank FROM analytics_events
             WHERE event_name = 'product_viewed' AND product_id IS NOT NULL
               AND created_at >= ${w.start}::timestamptz AND created_at < ${w.end}::timestamptz
            UNION ALL
            SELECT product_id, session_id, 2 FROM analytics_events
             WHERE event_name = 'add_to_cart' AND product_id IS NOT NULL
               AND created_at >= ${w.start}::timestamptz AND created_at < ${w.end}::timestamptz
            UNION ALL
            SELECT pv.product_id, e.session_id, 3
              FROM analytics_events e
              CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.meta->'items', '[]'::jsonb)) it
              JOIN product_variants pv ON pv.id = (it->>'v')::uuid
             WHERE e.event_name = 'checkout_started'
               AND e.created_at >= ${w.start}::timestamptz AND e.created_at < ${w.end}::timestamptz
            UNION ALL
            SELECT pv.product_id, e.session_id, 4
              FROM analytics_events e
              JOIN order_items oi ON oi.order_id = e.order_id
              JOIN product_variants pv ON pv.id = oi.variant_id
             WHERE e.event_name = 'purchase_completed'
               AND e.created_at >= ${w.start}::timestamptz AND e.created_at < ${w.end}::timestamptz
          ), per_session AS (
            SELECT product_id, session_id, MAX(rank) AS top,
                   bool_or(rank = 1) AS viewed, bool_or(rank = 2) AS added,
                   bool_or(rank = 3) AS checked_out, bool_or(rank = 4) AS bought
            FROM stage GROUP BY product_id, session_id
          )
          SELECT p.id AS product_id, p.slug, p.name,
                 COUNT(*)::int                                  AS reached,
                 COUNT(*) FILTER (WHERE ps.viewed)::int         AS views,
                 COUNT(*) FILTER (WHERE ps.added)::int          AS adds,
                 COUNT(*) FILTER (WHERE ps.checked_out)::int    AS checkouts,
                 COUNT(*) FILTER (WHERE ps.bought)::int         AS purchases,
                 COUNT(*) FILTER (WHERE ps.top >= 2)::int       AS cart_or_later
          FROM per_session ps JOIN products p ON p.id = ps.product_id
          GROUP BY p.id, p.slug, p.name
          ORDER BY views DESC, purchases DESC, p.name
          LIMIT 50
        `,
        // TREND: the same cohort and the same stage ladder as the summary query above,
        // grouped by the UTC day the session started. Aggregates only; no event rows.
        sql`
          WITH cohort AS (
            SELECT session_id, MIN(created_at) AS started_at FROM analytics_events
            WHERE event_name = 'session_start'
              AND created_at >= ${w.start}::timestamptz AND created_at < ${w.end}::timestamptz
            GROUP BY session_id
          ), tops AS (
            SELECT c.session_id, c.started_at,
                   COALESCE(MAX(CASE e.event_name
                     WHEN 'product_viewed'     THEN 2
                     WHEN 'add_to_cart'        THEN 3
                     WHEN 'checkout_started'   THEN 4
                     WHEN 'purchase_completed' THEN 5 END), 1) AS top
            FROM cohort c
            LEFT JOIN analytics_events e
              ON e.session_id = c.session_id AND e.event_name <> 'session_start'
            GROUP BY c.session_id, c.started_at
          )
          SELECT to_char((started_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
                 COUNT(*)::int                          AS visits,
                 COUNT(*) FILTER (WHERE top >= 2)::int  AS reached_product,
                 COUNT(*) FILTER (WHERE top >= 3)::int  AS reached_cart,
                 COUNT(*) FILTER (WHERE top >= 4)::int  AS reached_checkout,
                 COUNT(*) FILTER (WHERE top >= 5)::int  AS purchased
          FROM tops
          GROUP BY 1
          ORDER BY 1
        `,
        // When first-party collection began, so days before it are shown as "no data", not zero.
        sql`SELECT MIN(created_at) AS first_at FROM analytics_events WHERE event_name = 'session_start'`,
      ]) as any[][]

      const s = (stageRows[0] ?? {}) as Record<string, number>
      const stages: FunnelStages = {
        visits: Number(s.visits ?? 0),
        reachedProduct: Number(s.reached_product ?? 0),
        reachedCart: Number(s.reached_cart ?? 0),
        reachedCheckout: Number(s.reached_checkout ?? 0),
        purchased: Number(s.purchased ?? 0),
      }

      const totals: Record<string, { events: number; valueCents: number | null }> = {}
      for (const r of totalRows) {
        // A sum that includes a NULL value is a floor; flag it unknown instead of presenting it as exact.
        totals[r.event_name] = {
          events: Number(r.n),
          valueCents: Number(r.value_unknown) > 0 ? null : (r.value_cents === null ? null : Number(r.value_cents)),
        }
      }
      const ordersPaid = Number(orderRows[0]?.n ?? 0)
      const ordersTracked = Math.min(Number(orderRows[0]?.tracked ?? 0), ordersPaid)
      const purchaseEvents = totals.purchase_completed?.events ?? 0

      return {
        window: w,
        stages,
        rates: computeFunnelRates(stages),
        events: {
          productViews:    totals.product_viewed?.events ?? 0,
          addToCarts:      totals.add_to_cart?.events ?? 0,
          checkoutStarts:  totals.checkout_started?.events ?? 0,
          purchases:       purchaseEvents,
          purchaseValueCents: totals.purchase_completed ? totals.purchase_completed.valueCents : 0,
        },
        coverage: {
          ordersPaid,
          // Paid orders (paid_at in the window) that have a purchase_completed event. Distinct from
          // events.purchases, which counts events created in the window.
          trackedPurchases: ordersTracked,
          // null, never 0%, when there were no orders to compare against
          trackedPurchaseSharePct: ratePct(ordersTracked, ordersPaid),
        },
        trend: buildFunnelTrend(w, trendRows as FunnelTrendRow[], (firstRows[0]?.first_at ?? null) as string | Date | null),
        products: productRows.map((r: any) => {
          const reached = Number(r.reached)
          return {
            productId: r.product_id as string,
            slug: r.slug as string,
            name: r.name as string,
            views: Number(r.views),
            adds: Number(r.adds),
            checkouts: Number(r.checkouts),
            purchases: Number(r.purchases),
            addRatePct: ratePct(Number(r.cart_or_later), reached),
            purchaseRatePct: ratePct(Number(r.purchases), reached),
          }
        }),
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BEST-EFFORT WRAPPERS FOR THE MONEY PATH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HARD BOUND for a best-effort analytics write on the money path (checkout response, Stripe
 * webhook). One Neon HTTP write is normally tens of milliseconds, a cold connection can take
 * around a second; checkout_started is two statements (session upsert + event). 2.5 s covers
 * ordinary latency with margin, while a hung query can delay the money path by no more than this.
 * Normal successful writes finish well inside it, so ordinary data is still captured reliably.
 */
export const MONEY_PATH_ANALYTICS_TIMEOUT_MS = 2500

export const ANALYTICS_TIMEOUT = Symbol('funnel-analytics-timeout')

/**
 * Race `work` against a timer. Portable (setTimeout only; no runtime-specific API).
 *  - resolves with work's value if it finishes first, otherwise with ANALYTICS_TIMEOUT;
 *  - a late rejection of `work` after the timeout is swallowed (no unhandled rejection);
 *  - the timer is always cleared, so nothing is left pending when work wins;
 *  - rejects only if `work` rejects BEFORE the timeout (the caller treats that as a miss).
 */
export function withAnalyticsTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof ANALYTICS_TIMEOUT> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(ANALYTICS_TIMEOUT) } }, ms)
    work.then(
      v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } },
      e => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } /* else: late failure, deliberately ignored */ },
    )
  })
}

type Outcome = RecordOutcome | 'error' | 'timeout'

async function bounded(label: string, work: () => Promise<RecordOutcome>, timeoutMs: number): Promise<Outcome> {
  try {
    // work() is invoked inside the try so a synchronous throw is also a miss.
    const r = await withAnalyticsTimeout(work(), timeoutMs)
    if (r === ANALYTICS_TIMEOUT) {
      console.error(`[funnel] ${label} skipped (non-fatal): timed out after ${timeoutMs}ms`)
      return 'timeout'
    }
    return r
  } catch (e: any) {
    console.error(`[funnel] ${label} skipped (non-fatal):`, String(e?.message ?? e).slice(0, 80))
    return 'error'
  }
}

/** Never throws, never takes longer than the bound. Logs a truncated, non-PII message on a miss. */
export function tryRecordCheckoutStarted(
  sql: Sql, a: Parameters<ReturnType<typeof createFunnelService>['recordCheckoutStarted']>[0],
  timeoutMs: number = MONEY_PATH_ANALYTICS_TIMEOUT_MS,
): Promise<Outcome> {
  return bounded('checkout_started', () => createFunnelService(sql).recordCheckoutStarted(a), timeoutMs)
}

/** Never throws, never takes longer than the bound. A miss here must not touch the paid order. */
export function tryRecordPurchase(
  sql: Sql, a: { orderId: string; reservationId: string | null | undefined },
  timeoutMs: number = MONEY_PATH_ANALYTICS_TIMEOUT_MS,
): Promise<Outcome> {
  if (!a.reservationId) return Promise.resolve('ignored')
  const reservationId = a.reservationId
  return bounded('purchase_completed', () => createFunnelService(sql).recordPurchase({ orderId: a.orderId, reservationId }), timeoutMs)
}
