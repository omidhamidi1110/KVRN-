// lib/abandoned-checkout.ts — abandoned-checkout recovery service (injectable, DB-backed).
//
//   createAbandonedCheckoutService(sql, deps)
//
// SAFETY MODEL (read before changing anything)
//   * Recording never blocks or changes a checkout: tryRecordCheckout() never throws.
//   * This module NEVER writes to orders, reservations, inventory or discounts. It only reads
//     them (to learn whether a checkout was paid / released) and writes its own tables.
//   * ONE email per abandoned checkout, enforced three ways:
//       1. state machine: only 'abandoned' rows can be queued, in one guarded UPDATE
//       2. recovery_send_key (UNIQUE, derived from the row id) is the provider idempotency key
//       3. a claim lease + bounded attempts, so retries/double cron runs cannot send twice
//     Queueing is additionally serialised with an advisory lock and a per-address cooldown,
//     so two simultaneous sweeps cannot email the same address about two carts.
//   * A send is only attempted when ALL hold, re-checked at claim time inside the UPDATE:
//     flag ON, config enabled, no paid order / payment exception, not expired, consent OK.
//   * Provider failure => state 'send_failed' with bounded retries. Nothing else is touched.
//   * Fail closed: missing link secret, missing provider key or missing origin => no send.

import { isFeatureEnabled } from './feature-flags'
import { getSetting, putSetting } from './site-settings'
import {
  ABANDONED_CONFIG_KEY, ABANDON_GRACE_MINUTES, MAX_MANUAL_RETRIES, MAX_SEND_ATTEMPTS,
  PER_EMAIL_COOLDOWN_DAYS, RETRY_BACKOFF_MINUTES, SEND_LEASE_MINUTES, SWEEP_BATCH, UNSUBSCRIBE_LINK_DAYS,
  decideConsent, mayTrackClicks, normalizeAbandonedConfig, validateAbandonedConfig,
  type AbandonedConfig, type ConsentFacts, type ConsentMode,
} from './abandoned-checkout-config'
import { getLinkSecret, signToken, verifyToken } from './abandoned-checkout-token'
import { renderRecoveryEmail } from './abandoned-checkout-email'
import { getSiteOrigin } from './site-origin'
import { getEmailProvider, type EmailProvider } from './resend-adapter'

type Sql = any
type EnvLike = Record<string, string | undefined>

const FLAG = 'ABANDONED_CHECKOUT_EMAILS' as const
// ── Pure helpers ─────────────────────────────────────────────────────────────

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  if (e.length < 3 || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null
  return e
}

/** 'es-MX,es;q=0.9,en;q=0.8' -> 'es-MX'. Null when absent or not a plain language tag. */
export function parseAcceptLanguage(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const first = header.split(',')[0]?.split(';')[0]?.trim() ?? ''
  const m = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}|\d{3}))?$/.exec(first)
  if (!m) return null
  return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase()
}

export function normalizeLocale(raw: unknown): string | null {
  return parseAcceptLanguage(raw)
}

function safeError(msg: unknown): string {
  return String(msg ?? 'error')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/v1\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[token]')
    .slice(0, 200)
}

export function recoverySendKey(id: string): string { return `abandoned-recovery-v1:${id}` }

function buildFromAddress(env: EnvLike): string {
  const name = env.RESEND_FROM_NAME ?? 'KVRN'
  const email = env.RESEND_FROM_EMAIL ?? 'orders@send.kvrn.shop'
  return env.TRANSACTIONAL_EMAIL_FROM ?? `${name} <${email}>`
}

// ── Types ────────────────────────────────────────────────────────────────────

export type AbandonedState =
  | 'active' | 'abandoned' | 'recovery_queued' | 'recovery_sent' | 'recovered'
  | 'completed' | 'expired' | 'ineligible' | 'send_failed'

export type IneligibleReason =
  | 'no_email' | 'empty_cart' | 'payment_exception' | 'payment_failed' | 'resumed_from_recovery'
  | 'customer_purchased' | 'no_consent' | 'suppressed' | 'recent_recovery_email'

export interface CartLine {
  sku: string
  quantity: number
  variantId: string | null
  productName: string
  size: string
  color: string
  /** What the customer saw at checkout. A reminder only — never charged, never trusted. */
  seenUnitPriceCents: number | null
}

export interface RecordCheckoutInput {
  reservationId: string
  stripeSessionId: string
  /** Stripe session expiry (unix seconds). */
  sessionExpiresAtUnix?: number | null
  email: string
  locale?: string | null
  currency?: string | null
  items: Array<{
    sku: string; quantity: number; variantId?: string | null
    productName?: string; size?: string; color?: string; unitPriceCents?: number | null
  }>
  discountCode?: string | null
  affiliateSessionId?: string | null
  bundleContext?: unknown
  /** Raw value of the recovery cookie, when the visitor arrived through a recovery link. */
  recoveryCookie?: string | null
}

export interface ServiceDeps {
  now?: () => Date
  env?: EnvLike
  getProvider?: () => EmailProvider
  getOrigin?: () => string | null
  /** Existing marketing unsubscribe (Neon source of truth + best-effort Resend sync). */
  unsubscribeMarketing?: (email: string) => Promise<void>
}

export type RecoveryResolution =
  | { status: 'disabled' }
  | { status: 'unconfigured' }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'already_ordered' }
  | { status: 'ok'; row: AbandonedRow }

export interface AbandonedRow {
  id: string
  stripe_checkout_session_id: string
  reservation_id: string | null
  email: string | null
  locale: string | null
  currency: string
  cart: CartLine[]
  discount_code: string | null
  affiliate_session_id: string | null
  /** Filled by the bundles feature: { bundleId?, components: [{ sku, quantity }] }. Null otherwise. */
  bundle_context: unknown
  state: AbandonedState
  expires_at: string | null
  recovery_source_id: string | null
}

export interface SweepResult {
  completed: number
  abandoned: number
  ineligible: number
  queued: number
  sent: number
  failed: number
  recovered: number
  expired: number
  /** Why sending was skipped for this run, if it was. */
  sendSkipped: null | 'flag_off' | 'config_disabled' | 'link_not_configured' | 'provider_not_configured'
}

export class RetryError extends Error {
  constructor(public code: 'not_found' | 'not_retryable' | 'disabled', message: string) { super(message) }
}

// ── Service ──────────────────────────────────────────────────────────────────

export function createAbandonedCheckoutService(sql: Sql, deps: ServiceDeps = {}) {
  const now = () => deps.now?.() ?? new Date()
  const env = (): EnvLike => deps.env ?? (process.env as EnvLike)
  const flagOn = () => isFeatureEnabled(FLAG, env())
  const origin = () => (deps.getOrigin ?? getSiteOrigin)()

  async function event(id: string, type: string, detail: Record<string, unknown> = {}) {
    await sql`INSERT INTO abandoned_checkout_events (abandoned_checkout_id, event_type, detail)
              VALUES (${id}::uuid, ${type}, ${JSON.stringify(detail)}::jsonb)`
  }

  // ── Config ────────────────────────────────────────────────────────────────

  async function getConfig(): Promise<{ config: AbandonedConfig; revision: number }> {
    try {
      const { value, revision } = await getSetting<unknown>(sql, ABANDONED_CONFIG_KEY, null)
      return { config: normalizeAbandonedConfig(value), revision }
    } catch {
      // Unreadable settings never widen behaviour: safe defaults (opt-in required, one email).
      return { config: normalizeAbandonedConfig(null), revision: 0 }
    }
  }

  async function saveConfig(input: unknown, expectedRevision: number, actor: string) {
    const v = validateAbandonedConfig(input)
    if (!v.ok) return { ok: false as const, errors: v.errors }
    const { revision } = await putSetting(sql, ABANDONED_CONFIG_KEY, v.value, expectedRevision, actor)
    await sql`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
              VALUES (${actor}, 'abandoned.config.update', 'abandoned_checkouts', ${ABANDONED_CONFIG_KEY},
                      ${JSON.stringify({ config: v.value, revision })}::jsonb)`
    return { ok: true as const, config: v.value, revision }
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  async function resolveSourceFromCookie(cookie: string | null | undefined): Promise<string | null> {
    if (!cookie || !flagOn()) return null
    const secret = getLinkSecret(env())
    if (!secret) return null
    const v = verifyToken(secret, cookie, 'recover', Math.floor(now().getTime() / 1000))
    if (!v.ok) return null
    const rows = await sql`SELECT id FROM abandoned_checkouts WHERE id = ${v.id}::uuid AND state = 'recovery_sent'` as any[]
    return rows[0]?.id ?? null
  }

  async function recordCheckout(i: RecordCheckoutInput): Promise<{ id: string; created: boolean } | null> {
    if (!i.stripeSessionId || !i.reservationId) return null
    const email = normalizeEmail(i.email)
    const cart: CartLine[] = (i.items ?? []).slice(0, 50).map(l => ({
      sku: String(l.sku),
      quantity: Number(l.quantity) || 0,
      variantId: l.variantId ?? null,
      productName: String(l.productName ?? '').slice(0, 160),
      size: String(l.size ?? '').slice(0, 40),
      color: String(l.color ?? '').slice(0, 40),
      seenUnitPriceCents: Number.isInteger(l.unitPriceCents) ? Number(l.unitPriceCents) : null,
    })).filter(l => l.sku && l.quantity > 0)

    const currency = /^[a-zA-Z]{3}$/.test(i.currency ?? '') ? String(i.currency).toLowerCase() : 'usd'
    const exp = Number(i.sessionExpiresAtUnix)
    const expiresAt = Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : new Date(now().getTime() + 35 * 60_000)
    const sourceId = await resolveSourceFromCookie(i.recoveryCookie).catch(() => null)
    const discount = typeof i.discountCode === 'string' && i.discountCode.trim() ? i.discountCode.trim().slice(0, 64) : null
    const aff = typeof i.affiliateSessionId === 'string' && i.affiliateSessionId.length <= 128 ? i.affiliateSessionId : null

    const rows = await sql`
      INSERT INTO abandoned_checkouts
        (stripe_checkout_session_id, reservation_id, email, locale, currency, cart, discount_code,
         bundle_context, affiliate_session_id, recovery_source_id, state, expires_at, created_at, last_activity_at)
      VALUES
        (${i.stripeSessionId}, ${i.reservationId}::uuid, ${email}, ${normalizeLocale(i.locale)}, ${currency},
         ${JSON.stringify(cart)}::jsonb, ${discount},
         ${i.bundleContext == null ? null : JSON.stringify(i.bundleContext)}::jsonb, ${aff}, ${sourceId}::uuid,
         'active', ${expiresAt.toISOString()}::timestamptz, ${now().toISOString()}::timestamptz, ${now().toISOString()}::timestamptz)
      ON CONFLICT (stripe_checkout_session_id) DO UPDATE SET last_activity_at = EXCLUDED.last_activity_at
      RETURNING id, (xmax = 0) AS inserted` as any[]
    const row = rows[0]
    if (!row) return null
    if (row.inserted) await event(row.id, 'created', sourceId ? { resumed_from_recovery: true } : {})
    return { id: row.id, created: !!row.inserted }
  }

  /** Never throws and never blocks a checkout: failures cost a missing reminder, nothing else. */
  async function tryRecordCheckout(i: RecordCheckoutInput): Promise<void> {
    try { await recordCheckout(i) } catch (e: any) {
      console.error('[abandoned] record failed (non-fatal):', safeError(e?.message))
    }
  }

  // ── Small readers used by the sweep ───────────────────────────────────────

  async function paymentState(sessionId: string, reservationId: string | null): Promise<'order' | 'payment_exception' | null> {
    const r = await sql`SELECT abandoned_checkout_payment_state(${sessionId}, ${reservationId}::uuid) AS s` as any[]
    return (r[0]?.s ?? null) as any
  }

  async function purchasedSince(email: string, since: string): Promise<boolean> {
    const r = await sql`
      SELECT 1 FROM orders
       WHERE lower(customer_email) = ${email} AND created_at > ${since}::timestamptz AND payment_status <> 'failed'
       LIMIT 1` as any[]
    return r.length > 0
  }

  async function consentFacts(email: string): Promise<ConsentFacts> {
    const r = await sql`
      SELECT (SELECT status FROM marketing_subscribers WHERE email = ${email}) AS status,
             (SELECT consented_at FROM marketing_subscribers WHERE email = ${email}) AS consented_at,
             (SELECT created_at FROM abandoned_checkout_suppressions WHERE email = ${email}) AS suppressed_at` as any[]
    const x = r[0] ?? {}
    return {
      subscriberStatus: x.status === 'subscribed' || x.status === 'unsubscribed' ? x.status : null,
      consentedAt: x.consented_at ? new Date(x.consented_at).toISOString() : null,
      suppressedAt: x.suppressed_at ? new Date(x.suppressed_at).toISOString() : null,
    }
  }

  async function markIneligible(id: string, reason: IneligibleReason): Promise<boolean> {
    const r = await sql`
      UPDATE abandoned_checkouts
         SET state = 'ineligible', ineligible_reason = ${reason}, send_claimed_at = NULL, next_attempt_at = NULL
       WHERE id = ${id}::uuid AND state IN ('abandoned','recovery_queued','send_failed')
       RETURNING id` as any[]
    if (r[0]) await event(id, 'ineligible', { reason })
    return !!r[0]
  }

  async function markCompleted(id: string): Promise<void> {
    const r = await sql`
      UPDATE abandoned_checkouts SET state = 'completed', send_claimed_at = NULL, next_attempt_at = NULL
       WHERE id = ${id}::uuid AND state IN ('active','abandoned','recovery_queued','send_failed','recovery_sent')
       RETURNING id` as any[]
    if (r[0]) await event(id, 'completed', {})
  }

  // ── Sweep steps ───────────────────────────────────────────────────────────

  /** A checkout that was paid (even late) is done: nothing to recover, nothing to send. */
  async function stepComplete(t: string): Promise<number> {
    const r = await sql`
      WITH upd AS (
        UPDATE abandoned_checkouts ac
           SET state = 'completed', send_claimed_at = NULL, next_attempt_at = NULL,
               last_activity_at = ${t}::timestamptz
         WHERE ac.state IN ('active','abandoned','recovery_queued','send_failed','recovery_sent')
           AND abandoned_checkout_payment_state(ac.stripe_checkout_session_id, ac.reservation_id) = 'order'
         RETURNING ac.id
      ), ev AS (
        INSERT INTO abandoned_checkout_events (abandoned_checkout_id, event_type, detail)
        SELECT id, 'completed', '{}'::jsonb FROM upd
      )
      SELECT id FROM upd` as any[]
    return r.length
  }

  /**
   * An 'active' row whose reservation ended without a paid order is abandoned — exactly once
   * (state guard + UNIQUE session id). Stripe's checkout.session.expired is a hint that makes
   * the reservation 'released' sooner; the reservation's own expiry is the backstop.
   * Rows that can never be emailed are classified here (reason recorded) rather than silently
   * dropped.
   */
  async function stepAbandon(t: string, windowHours: number): Promise<{ abandoned: number; ineligible: number }> {
    const r = await sql`
      WITH cand AS (
        SELECT ac.id,
               LEAST(${t}::timestamptz, COALESCE(r.released_at, r.expires_at)) AS ab_at,
               CASE
                 WHEN ac.email IS NULL THEN 'no_email'
                 WHEN jsonb_array_length(ac.cart) = 0 THEN 'empty_cart'
                 WHEN abandoned_checkout_payment_state(ac.stripe_checkout_session_id, ac.reservation_id) = 'payment_exception' THEN 'payment_exception'
                 WHEN r.release_reason = 'async_payment_failed' THEN 'payment_failed'
                 WHEN ac.recovery_source_id IS NOT NULL THEN 'resumed_from_recovery'
                 ELSE NULL
               END AS inel
          FROM abandoned_checkouts ac
          JOIN reservations r ON r.id = ac.reservation_id
         WHERE ac.state = 'active'
           AND ( r.status IN ('released','failed')
                 OR (r.status IN ('creating','open')
                     AND r.expires_at < ${t}::timestamptz - make_interval(mins => ${ABANDON_GRACE_MINUTES}::int)) )
           AND abandoned_checkout_payment_state(ac.stripe_checkout_session_id, ac.reservation_id) IS DISTINCT FROM 'order'
         ORDER BY ac.created_at
         LIMIT ${SWEEP_BATCH * 4}
         FOR UPDATE OF ac SKIP LOCKED
      ), upd AS (
        UPDATE abandoned_checkouts ac
           SET state = CASE WHEN cand.inel IS NULL THEN 'abandoned' ELSE 'ineligible' END,
               ineligible_reason = cand.inel,
               abandoned_at = cand.ab_at,
               expires_at = cand.ab_at + make_interval(hours => ${windowHours}::int),
               last_activity_at = ${t}::timestamptz
          FROM cand
         WHERE ac.id = cand.id AND ac.state = 'active'
         RETURNING ac.id, ac.state, ac.ineligible_reason
      ), ev AS (
        INSERT INTO abandoned_checkout_events (abandoned_checkout_id, event_type, detail)
        SELECT id,
               CASE WHEN state = 'ineligible' THEN 'ineligible' ELSE 'abandoned' END,
               CASE WHEN ineligible_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', ineligible_reason) END
          FROM upd
      )
      SELECT id, state FROM upd` as any[]
    return {
      abandoned: r.filter(x => x.state === 'abandoned').length,
      ineligible: r.filter(x => x.state === 'ineligible').length,
    }
  }

  /**
   * Queue the single email for one row via abandoned_checkout_queue() (migration 032): one
   * serialised, guarded transition. It re-checks everything that can change between the TS
   * evaluation and now (paid, expired, already queued, per-address cooldown).
   */
  async function queueOne(id: string, t: string): Promise<'queued' | 'skipped'> {
    try {
      const r = await sql`
        SELECT abandoned_checkout_queue(${id}::uuid, ${t}::timestamptz, ${PER_EMAIL_COOLDOWN_DAYS}::int) AS queued` as any[]
      return r[0]?.queued === true ? 'queued' : 'skipped'
    } catch (e: any) {
      // 23505 = recovery_send_key already exists: the email was already queued elsewhere.
      if (e?.code === '23505') return 'skipped'
      throw e
    }
  }

  async function stepQueue(t: string, cfg: AbandonedConfig): Promise<{ queued: number; ineligible: number; completed: number }> {
    const out = { queued: 0, ineligible: 0, completed: 0 }
    const due = await sql`
      SELECT id, email, stripe_checkout_session_id, reservation_id, created_at
        FROM abandoned_checkouts
       WHERE state = 'abandoned'
         AND abandoned_at <= ${t}::timestamptz - make_interval(mins => ${cfg.delay_minutes}::int)
         AND expires_at > ${t}::timestamptz
       ORDER BY abandoned_at
       LIMIT ${SWEEP_BATCH}` as any[]

    for (const c of due) {
      const pay = await paymentState(c.stripe_checkout_session_id, c.reservation_id)
      if (pay === 'order') { await markCompleted(c.id); out.completed++; continue }
      if (pay === 'payment_exception') { if (await markIneligible(c.id, 'payment_exception')) out.ineligible++; continue }
      if (!c.email) { if (await markIneligible(c.id, 'no_email')) out.ineligible++; continue }
      if (await purchasedSince(c.email, new Date(c.created_at).toISOString())) {
        if (await markIneligible(c.id, 'customer_purchased')) out.ineligible++
        continue
      }
      const decision = decideConsent(cfg.consent_mode, await consentFacts(c.email))
      if (!decision.ok) { if (await markIneligible(c.id, decision.reason)) out.ineligible++; continue }

      const cooldown = await sql`
        SELECT 1 FROM abandoned_checkouts o
         WHERE o.email = ${c.email} AND o.id <> ${c.id}::uuid
           AND (o.state IN ('recovery_queued','recovery_sent','send_failed') OR o.recovery_sent_at IS NOT NULL)
           AND o.recovery_queued_at > ${t}::timestamptz - make_interval(days => ${PER_EMAIL_COOLDOWN_DAYS}::int)
         LIMIT 1` as any[]
      if (cooldown.length) { if (await markIneligible(c.id, 'recent_recovery_email')) out.ineligible++; continue }

      const q = await queueOne(c.id, t)
      if (q === 'queued') out.queued++
    }
    return out
  }

  async function releaseClaim(id: string): Promise<void> {
    await sql`UPDATE abandoned_checkouts SET send_claimed_at = NULL WHERE id = ${id}::uuid`
  }

  async function sendOne(id: string, ctx: { provider: EmailProvider; secret: string; origin: string; cfg: AbandonedConfig }, t: string)
    : Promise<'sent' | 'failed' | 'skipped' | 'ineligible'> {
    if (!flagOn() || !ctx.cfg.enabled) return 'skipped'

    // Claim (lease) + count the attempt. Guards: still queued/failed, due, not paid, not expired,
    // attempts left (an admin retry adds exactly one), lease free.
    const claimed = await sql`
      UPDATE abandoned_checkouts ac
         SET send_claimed_at = ${t}::timestamptz, recovery_attempts = ac.recovery_attempts + 1
       WHERE ac.id = ${id}::uuid
         AND ac.state IN ('recovery_queued','send_failed')
         AND ac.recovery_send_key IS NOT NULL
         AND ac.email IS NOT NULL
         AND (ac.next_attempt_at IS NULL OR ac.next_attempt_at <= ${t}::timestamptz)
         AND ac.recovery_attempts < ${MAX_SEND_ATTEMPTS}::int + ac.manual_retries
         AND (ac.send_claimed_at IS NULL OR ac.send_claimed_at < ${t}::timestamptz - make_interval(mins => ${SEND_LEASE_MINUTES}::int))
         AND ac.expires_at > ${t}::timestamptz
         AND abandoned_checkout_payment_state(ac.stripe_checkout_session_id, ac.reservation_id) IS NULL
       RETURNING ac.id, ac.email, ac.locale, ac.cart, ac.recovery_send_key, ac.recovery_attempts, ac.manual_retries,
                 ac.expires_at, ac.created_at` as any[]
    const row = claimed[0]
    if (!row) return 'skipped'

    try {
      // Fresh facts at the last possible moment.
      if (await purchasedSince(row.email, new Date(row.created_at).toISOString())) {
        await markIneligible(id, 'customer_purchased'); return 'ineligible'
      }
      const decision = decideConsent(ctx.cfg.consent_mode, await consentFacts(row.email))
      if (!decision.ok) { await markIneligible(id, decision.reason); return 'ineligible' }

      const expSec = Math.floor(new Date(row.expires_at).getTime() / 1000)
      const recoverToken = signToken(ctx.secret, { purpose: 'recover', id, expiresAtSec: expSec })
      const unsubToken = signToken(ctx.secret, {
        purpose: 'unsubscribe', id, expiresAtSec: Math.floor(new Date(t).getTime() / 1000) + UNSUBSCRIBE_LINK_DAYS * 86400,
      })
      const recoverUrl = `${ctx.origin}/checkout/recover?t=${recoverToken}`
      const unsubscribeUrl = `${ctx.origin}/api/checkout/recover/unsubscribe?t=${unsubToken}`
      const mail = renderRecoveryEmail({
        locale: row.locale,
        lines: (Array.isArray(row.cart) ? row.cart : []).map((l: CartLine) => ({
          name: l.productName, size: l.size, color: l.color, quantity: l.quantity,
        })),
        recoverUrl, unsubscribeUrl, origin: ctx.origin,
      })

      let result: Awaited<ReturnType<EmailProvider['send']>>
      try {
        result = await ctx.provider.send({
          from: buildFromAddress(env()),
          replyTo: env().TRANSACTIONAL_EMAIL_REPLY_TO ?? 'support@kvrn.shop',
          to: row.email,
          subject: mail.subject,
          html: mail.html,
          idempotencyKey: row.recovery_send_key,
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        })
      } catch (e: any) {
        result = { ok: false, message: 'Email provider call failed.' }
      }

      if (result.ok) {
        await sql`
          UPDATE abandoned_checkouts
             SET state = 'recovery_sent', recovery_sent_at = ${t}::timestamptz,
                 provider_message_id = ${result.providerMessageId}, send_claimed_at = NULL,
                 last_error = NULL, next_attempt_at = NULL
           WHERE id = ${id}::uuid AND state IN ('recovery_queued','send_failed')`
        await event(id, 'sent', { attempt: Number(row.recovery_attempts), locale: mail.locale })
        return 'sent'
      }

      const attempts = Number(row.recovery_attempts)
      const limit = MAX_SEND_ATTEMPTS + Number(row.manual_retries)
      const backoff = RETRY_BACKOFF_MINUTES[attempts - 1]
      const next = attempts < limit && backoff !== undefined
        ? new Date(new Date(t).getTime() + backoff * 60_000).toISOString() : null
      await sql`
        UPDATE abandoned_checkouts
           SET state = 'send_failed', last_error = ${safeError(result.message)},
               next_attempt_at = ${next}::timestamptz, send_claimed_at = NULL
         WHERE id = ${id}::uuid AND state IN ('recovery_queued','send_failed')`
      await event(id, 'send_failed', { attempt: attempts, exhausted: next === null })
      return 'failed'
    } catch (e: any) {
      // Anything unexpected after the claim: release it and let the lease/attempt bound retry.
      console.error('[abandoned] send step failed:', safeError(e?.message))
      await releaseClaim(id).catch(() => {})
      return 'failed'
    }
  }

  async function stepSend(t: string, cfg: AbandonedConfig): Promise<{ sent: number; failed: number; skipped: SweepResult['sendSkipped'] }> {
    const out = { sent: 0, failed: 0, skipped: null as SweepResult['sendSkipped'] }
    const due = await sql`
      SELECT id FROM abandoned_checkouts
       WHERE state IN ('recovery_queued','send_failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ${t}::timestamptz)
         AND recovery_attempts < ${MAX_SEND_ATTEMPTS}::int + manual_retries
         AND (send_claimed_at IS NULL OR send_claimed_at < ${t}::timestamptz - make_interval(mins => ${SEND_LEASE_MINUTES}::int))
         AND expires_at > ${t}::timestamptz
       ORDER BY recovery_queued_at
       LIMIT ${Math.floor(SWEEP_BATCH / 2)}` as any[]
    if (!due.length) return out

    const secret = getLinkSecret(env())
    const o = origin()
    if (!secret || !o) { out.skipped = 'link_not_configured'; return out }
    let provider: EmailProvider
    try { provider = (deps.getProvider ?? getEmailProvider)() } catch { out.skipped = 'provider_not_configured'; return out }

    for (const d of due) {
      const r = await sendOne(d.id, { provider, secret, origin: o, cfg }, t)
      if (r === 'sent') out.sent++
      if (r === 'failed') out.failed++
    }
    return out
  }

  /** Link recovered orders. A recovered order is a NORMAL order: we only annotate the row. */
  async function stepRecovered(t: string): Promise<number> {
    try {
      const r = await sql`
        WITH cand AS (
          SELECT DISTINCT ON (x.id) x.id AS x_id, o.id AS order_id, o.total_cents, lower(o.currency) AS currency
            FROM abandoned_checkouts y
            JOIN abandoned_checkouts x ON x.id = y.recovery_source_id
            JOIN orders o ON o.stripe_checkout_session_id = y.stripe_checkout_session_id
                          OR (y.reservation_id IS NOT NULL AND o.reservation_id = y.reservation_id)
           WHERE x.state IN ('recovery_sent','expired')
             AND o.payment_status = 'paid'
             AND NOT EXISTS (SELECT 1 FROM abandoned_checkouts z WHERE z.recovered_order_id = o.id)
           ORDER BY x.id, o.created_at
        ), upd AS (
          UPDATE abandoned_checkouts x
             SET state = 'recovered', recovered_at = ${t}::timestamptz, recovered_order_id = cand.order_id,
                 recovery_revenue_cents = cand.total_cents, recovery_revenue_currency = cand.currency,
                 send_claimed_at = NULL, next_attempt_at = NULL
            FROM cand
           WHERE x.id = cand.x_id AND x.state IN ('recovery_sent','expired')
           RETURNING x.id
        ), ev AS (
          INSERT INTO abandoned_checkout_events (abandoned_checkout_id, event_type, detail)
          SELECT id, 'recovered', '{}'::jsonb FROM upd
        )
        SELECT id FROM upd` as any[]
      return r.length
    } catch (e: any) {
      if (e?.code === '23505') return 0   // another sweep linked that order first: counted once
      throw e
    }
  }

  async function stepExpire(t: string): Promise<number> {
    const r = await sql`
      WITH upd AS (
        UPDATE abandoned_checkouts
           SET state = 'expired', send_claimed_at = NULL, next_attempt_at = NULL
         WHERE state IN ('abandoned','recovery_queued','send_failed')
           AND expires_at IS NOT NULL AND expires_at <= ${t}::timestamptz
         RETURNING id
      ), ev AS (
        INSERT INTO abandoned_checkout_events (abandoned_checkout_id, event_type, detail)
        SELECT id, 'expired', '{}'::jsonb FROM upd
      )
      SELECT id FROM upd` as any[]
    return r.length
  }

  /**
   * One sweep. Every step is independent and idempotent; a failing step is logged (safe
   * message) and never prevents the others. Safe to run concurrently and repeatedly.
   */
  async function sweep(): Promise<SweepResult> {
    const t = now().toISOString()
    const res: SweepResult = {
      completed: 0, abandoned: 0, ineligible: 0, queued: 0, sent: 0, failed: 0, recovered: 0, expired: 0, sendSkipped: null,
    }
    const stepFailures: string[] = []
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn() } catch (e: any) {
        console.error(`[abandoned] sweep step ${name} failed:`, safeError(e?.message))
        stepFailures.push(name)
        return null
      }
    }
    const { config } = await getConfig()

    res.completed += (await step('complete', () => stepComplete(t))) ?? 0
    const ab = await step('abandon', () => stepAbandon(t, config.window_hours))
    if (ab) { res.abandoned = ab.abandoned; res.ineligible += ab.ineligible }

    if (!flagOn()) res.sendSkipped = 'flag_off'
    else if (!config.enabled) res.sendSkipped = 'config_disabled'
    else {
      const q = await step('queue', () => stepQueue(t, config))
      if (q) { res.queued = q.queued; res.ineligible += q.ineligible; res.completed += q.completed }
      const s = await step('send', () => stepSend(t, config))
      if (s) { res.sent = s.sent; res.failed = s.failed; res.sendSkipped = s.skipped }
    }

    res.recovered = (await step('recovered', () => stepRecovered(t))) ?? 0
    res.expired = (await step('expire', () => stepExpire(t))) ?? 0
    // Attempt all independent jobs, but never report a clean HTTP 200 when
    // a critical sweep step failed. The cron route surfaces this as a 500.
    if (stepFailures.length) throw new Error(`ABANDONED_SWEEP_FAILED:${stepFailures.join(',')}`)
    return res
  }

  // ── Recovery link / unsubscribe ───────────────────────────────────────────

  async function loadRow(id: string): Promise<AbandonedRow | null> {
    const r = await sql`
      SELECT id, stripe_checkout_session_id, reservation_id, email, locale, currency, cart, discount_code,
             affiliate_session_id, bundle_context, state, expires_at, recovery_source_id
        FROM abandoned_checkouts WHERE id = ${id}::uuid` as any[]
    return (r[0] as AbandonedRow) ?? null
  }

  /** Verify a recovery token and decide what the visitor may do. Never throws. */
  async function resolveRecovery(token: unknown): Promise<RecoveryResolution> {
    try {
      if (!flagOn()) return { status: 'disabled' }
      const secret = getLinkSecret(env())
      if (!secret) return { status: 'unconfigured' }
      const v = verifyToken(secret, token, 'recover', Math.floor(now().getTime() / 1000))
      if (!v.ok) return v.reason === 'expired' ? { status: 'expired' } : { status: 'invalid' }
      const row = await loadRow(v.id)
      if (!row) return { status: 'invalid' }
      if (row.state === 'recovered' || row.state === 'completed') return { status: 'already_ordered' }
      if (row.state === 'expired') return { status: 'expired' }
      if (row.state !== 'recovery_sent') return { status: 'invalid' }
      if (row.expires_at && new Date(row.expires_at).getTime() <= now().getTime()) return { status: 'expired' }
      if (await paymentState(row.stripe_checkout_session_id, row.reservation_id) === 'order') {
        return { status: 'already_ordered' }
      }
      return { status: 'ok', row }
    } catch (e: any) {
      console.error('[abandoned] resolve failed:', safeError(e?.message))
      return { status: 'invalid' }
    }
  }

  /** Click tracking only where an explicit marketing opt-in exists (see mayTrackClicks). */
  async function recordClick(row: AbandonedRow): Promise<boolean> {
    try {
      if (!row.email) return false
      const facts = await consentFacts(row.email)
      if (!mayTrackClicks(facts)) return false
      const r = await sql`
        UPDATE abandoned_checkouts
           SET recovery_click_count = recovery_click_count + 1,
               recovery_clicked_at = COALESCE(recovery_clicked_at, ${now().toISOString()}::timestamptz)
         WHERE id = ${row.id}::uuid
         RETURNING recovery_click_count AS n` as any[]
      if (r[0]?.n === 1) await event(row.id, 'clicked', {})
      return true
    } catch { return false }
  }

  async function recordResumed(row: AbandonedRow, detail: Record<string, unknown>): Promise<void> {
    try { await event(row.id, 'resumed', detail) } catch { /* non-fatal */ }
  }

  async function unsubscribeByToken(token: unknown): Promise<{ status: 'ok' | 'invalid' | 'unconfigured' }> {
    try {
      const secret = getLinkSecret(env())
      if (!secret) return { status: 'unconfigured' }
      const v = verifyToken(secret, token, 'unsubscribe', Math.floor(now().getTime() / 1000))
      if (!v.ok) return { status: 'invalid' }
      const row = await loadRow(v.id)
      if (!row?.email) return { status: 'invalid' }
      await sql`
        INSERT INTO abandoned_checkout_suppressions (email, reason, abandoned_checkout_id)
        VALUES (${row.email}, 'unsubscribed', ${row.id}::uuid)
        ON CONFLICT (email) DO NOTHING`
      await event(row.id, 'unsubscribed', {})
      await markIneligible(row.id, 'suppressed').catch(() => false)
      try { await deps.unsubscribeMarketing?.(row.email) } catch (e: any) {
        console.error('[abandoned] marketing unsubscribe sync failed (non-fatal):', safeError(e?.message))
      }
      return { status: 'ok' }
    } catch (e: any) {
      console.error('[abandoned] unsubscribe failed:', safeError(e?.message))
      return { status: 'invalid' }
    }
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  async function listForAdmin(opts: { view?: string; limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 100)
    const offset = Math.max(Math.floor(opts.offset ?? 0), 0)
    const states = viewStates(opts.view)
    const rows = await sql`
      SELECT ac.id, ac.email, ac.locale, ac.currency, ac.cart, ac.state, ac.ineligible_reason,
             ac.recovery_attempts, ac.manual_retries, ac.last_error, ac.created_at, ac.abandoned_at,
             ac.recovery_sent_at, ac.recovered_at, ac.expires_at, ac.next_attempt_at,
             ac.recovery_click_count, ac.recovery_revenue_cents, ac.recovery_revenue_currency,
             o.order_number AS recovered_order_number
        FROM abandoned_checkouts ac
        LEFT JOIN orders o ON o.id = ac.recovered_order_id
       WHERE ac.state = ANY(${states}::text[])
       ORDER BY COALESCE(ac.abandoned_at, ac.created_at) DESC
       LIMIT ${limit} OFFSET ${offset}` as any[]
    return rows
  }

  async function summary(days = 30) {
    const since = new Date(now().getTime() - days * 86400_000).toISOString()
    const c = (await sql`
      SELECT
        COUNT(*) FILTER (WHERE abandoned_at > ${since}::timestamptz)                              AS abandoned,
        COUNT(*) FILTER (WHERE recovery_sent_at > ${since}::timestamptz)                          AS sent,
        COUNT(*) FILTER (WHERE state = 'recovered' AND recovered_at > ${since}::timestamptz)      AS recovered,
        COUNT(*) FILTER (WHERE state = 'send_failed')                                             AS failed,
        COUNT(*) FILTER (WHERE state = 'recovered' AND recovered_at > ${since}::timestamptz
                           AND recovery_revenue_cents IS NULL)                                    AS revenue_unknown
        FROM abandoned_checkouts` as any[])[0]
    const rev = await sql`
      SELECT recovery_revenue_currency AS currency, SUM(recovery_revenue_cents)::bigint AS cents
        FROM abandoned_checkouts
       WHERE state = 'recovered' AND recovered_at > ${since}::timestamptz AND recovery_revenue_cents IS NOT NULL
       GROUP BY 1 ORDER BY 1` as any[]
    return {
      windowDays: days,
      abandoned: Number(c.abandoned), sent: Number(c.sent), recovered: Number(c.recovered),
      failed: Number(c.failed), revenueUnknownCount: Number(c.revenue_unknown),
      revenue: rev.map(r => ({ currency: String(r.currency), cents: Number(r.cents) })),
    }
  }

  /** At most ONE manual retry per row, only for a failed send, never past expiry or a payment. */
  async function manualRetry(id: string): Promise<{ ok: true }> {
    if (!flagOn()) throw new RetryError('disabled', 'Recovery emails are switched off.')
    const t = now().toISOString()
    const row = await loadRow(id)
    if (!row) throw new RetryError('not_found', 'Checkout not found.')
    const r = await sql`
      UPDATE abandoned_checkouts ac
         SET manual_retries = ac.manual_retries + 1, state = 'recovery_queued',
             next_attempt_at = ${t}::timestamptz, send_claimed_at = NULL
       WHERE ac.id = ${id}::uuid
         AND ac.state = 'send_failed'
         AND ac.manual_retries < ${MAX_MANUAL_RETRIES}::int
         AND ac.expires_at > ${t}::timestamptz
         AND abandoned_checkout_payment_state(ac.stripe_checkout_session_id, ac.reservation_id) IS NULL
       RETURNING ac.id` as any[]
    if (!r[0]) throw new RetryError('not_retryable', 'This email can’t be retried.')
    await event(id, 'manual_retry', {})
    return { ok: true }
  }

  function deliveryReadiness() {
    const e = env()
    return {
      flagEnabled: flagOn(),
      linkSecretConfigured: !!getLinkSecret(e),
      providerConfigured: !!(e.RESEND_API_KEY ?? '').trim(),
      originConfigured: !!origin(),
    }
  }

  return {
    getConfig, saveConfig, recordCheckout, tryRecordCheckout, sweep,
    loadRow, resolveRecovery, recordClick, recordResumed, unsubscribeByToken,
    listForAdmin, summary, manualRetry, deliveryReadiness,
    // exposed for tests
    _steps: { stepComplete, stepAbandon, stepQueue, stepSend, stepRecovered, stepExpire },
  }
}

export type AbandonedCheckoutService = ReturnType<typeof createAbandonedCheckoutService>

/** Admin list filters. 'all' still hides in-progress and paid checkouts (nothing to review). */
export function viewStates(view: string | undefined): AbandonedState[] {
  switch (view) {
    case 'abandoned':  return ['abandoned']
    case 'queued':     return ['recovery_queued']
    case 'sent':       return ['recovery_sent']
    case 'recovered':  return ['recovered']
    case 'failed':     return ['send_failed']
    case 'ineligible': return ['ineligible', 'expired']
    case 'active':     return ['active']
    case 'completed':  return ['completed']
    default:           return ['abandoned', 'recovery_queued', 'recovery_sent', 'recovered', 'send_failed', 'ineligible', 'expired']
  }
}

export type { ConsentMode }
