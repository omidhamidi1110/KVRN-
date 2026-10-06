// lib/owner-notifications.ts — KVRN owner-only operational push alerts.
//
// Scope is intentionally narrow: money, customer-service-adjacent incidents,
// inventory sell-through, critical provider health, security, backup failures,
// and reconciliation exceptions. Routine successes/cron noise are excluded.
//
// Every exported function is FAIL-OPEN. Callers must never depend on a push being
// delivered for the underlying business operation to succeed.

import { sql } from './db'
import { isPushoverConfigured, sendPushoverNotification, type PushoverPriority } from './pushover'

const SYSTEM_ACTOR = 'system@kvrn.internal'
const LOW_STOCK_THRESHOLD = 2
const PROVIDER_WINDOW_MINUTES = 5
const PROVIDER_FAILURE_THRESHOLD = 3
const PROVIDER_ALERT_COOLDOWN_MINUTES = 60
const SECURITY_WINDOW_MINUTES = 10
const SECURITY_FAILURE_THRESHOLD = 3
const SECURITY_ALERT_COOLDOWN_MINUTES = 60
// A push attempt is claimed BEFORE it is made, so a failing Pushover (bad token, outage) is retried at most
// once per window instead of on every provider failure / denied request.
const ATTEMPT_WINDOW_MINUTES = 10
const STOCK_ALERT_WINDOW_MINUTES = 15
const REFUND_ALERT_WINDOW_MINUTES = 7 * 24 * 60

// Neon outages can prevent the audit-log debounce itself from writing. Keep a
// small in-isolate fallback streak so a database outage can still produce a push
// without immediately alerting on one transient failure. Cloudflare may recycle
// an isolate, so this is intentionally best-effort rather than durable state.
let neonFallbackFailures = 0
let neonFallbackLastAlertAt = 0

export type CriticalProvider = 'Stripe' | 'Shippo' | 'Resend' | 'Neon'

function money(cents: number, currency = 'usd'): string {
  if ((currency || 'usd').toLowerCase() === 'usd') return `$${(Number(cents || 0) / 100).toFixed(2)}`
  return `${(Number(cents || 0) / 100).toFixed(2)} ${(currency || '').toUpperCase()}`
}

function adminUrl(path: string): string | null {
  const base = (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? '').trim()
  if (!base) return null
  try {
    const u = new URL(path, base)
    if (u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

async function push(input: {
  title: string
  message: string
  priority?: PushoverPriority
  path?: string
}): Promise<boolean> {
  try {
    if (!isPushoverConfigured()) return false
    const result = await sendPushoverNotification({
      title: input.title,
      message: input.message,
      priority: input.priority ?? 0,
      url: input.path ? adminUrl(input.path) : null,
      urlTitle: input.path ? 'Open KVRN Admin' : null,
    })
    if (result.outcome === 'failed') {
      console.error('[owner-notify] delivery failed:', result.reason)
    }
    return result.outcome === 'sent'
  } catch (err: any) {
    console.error('[owner-notify] unexpected failure:', String(err?.message ?? err).slice(0, 100))
    return false
  }
}


/**
 * Durable, single-statement "have I already pushed this?" claim, stored in the existing append-only
 * admin_audit_logs table (no migration). Returns true when THIS caller won the claim.
 * It collapses duplicate Stripe events and near-simultaneous orders into one push. It is not a
 * distributed lock: two callers inside the same few milliseconds could both win, which at worst
 * produces one extra push - never a missed business operation.
 */
async function claimOnce(action: string, resource: string, resourceId: string,
                         windowMinutes: number, payload: Record<string, unknown> = {}): Promise<boolean> {
  const rows = await sql`
    INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
    SELECT ${SYSTEM_ACTOR}, ${action}, ${resource}, ${resourceId}, ${JSON.stringify(payload)}::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE action=${action} AND resource=${resource} AND resource_id=${resourceId}
        AND created_at >= NOW() - make_interval(mins => ${windowMinutes}::int)
    )
    RETURNING id
  `
  return (rows as any[]).length > 0
}

/** The stored status of a Stripe refund, or null/undefined. Never throws (notification evidence only). */
export async function readRefundStatusForNotify(stripeRefundId: string): Promise<string | null | undefined> {
  try {
    const rows = await sql`SELECT status FROM order_refunds WHERE stripe_refund_id=${stripeRefundId} LIMIT 1`
    return (rows as any[])[0]?.status ?? null
  } catch {
    return undefined
  }
}

/**
 * Only a failure that says something about the PROVIDER counts toward "provider down".
 * A Stripe 4xx caused by the request we sent (invalid_request / card / idempotency) is not an outage.
 */
export function isStripeProviderFault(err: any): boolean {
  const type = String(err?.type ?? err?.rawType ?? '')
  const status = Number(err?.statusCode ?? err?.raw?.statusCode ?? 0)
  if (['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError', 'StripeAuthenticationError'].includes(type)) return true
  if (status >= 500 || status === 401 || status === 403 || status === 429) return true
  return !status && !type          // no HTTP status and no Stripe type: transport-level failure
}

/**
 * A thrown error from a provider call counts only when it is not a programming / input error
 * (TypeError, RangeError, SyntaxError): malformed customer input must never read as "provider down".
 */
export function isProviderException(err: unknown): boolean {
  return !(err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError)
}

/** Resend sends fail with "Email provider returned HTTP <n>.": a 400/404/422 is a bad recipient or payload, not an outage. */
export function isResendProviderFault(message: string): boolean {
  const m = /HTTP (\d{3})/.exec(String(message ?? ''))
  if (!m) return true                // network error / unreadable response / no id
  const status = Number(m[1])
  return status >= 500 || status === 401 || status === 403 || status === 429
}

/** Paid order + low-stock/sold-out transitions. Called only for outcome=order_created. */
export async function notifySaleAndInventory(orderId: string): Promise<void> {
  if (!isPushoverConfigured() || !orderId) return
  try {
    const orderRows = await sql`
      SELECT order_number AS "orderNumber", total_cents AS "totalCents", currency
      FROM orders WHERE id = ${orderId}::uuid LIMIT 1
    `
    const order = (orderRows as any[])[0]
    if (!order) return

    const items = await sql`
      SELECT oi.product_name AS "productName", oi.color, oi.size, oi.quantity,
             oi.variant_id AS "variantId",
             pv.stock_on_hand AS "stockOnHand", pv.reserved_quantity AS "reservedQuantity"
      FROM order_items oi
      LEFT JOIN product_variants pv ON pv.id = oi.variant_id
      WHERE oi.order_id = ${orderId}::uuid
      ORDER BY oi.created_at ASC, oi.id ASC
    ` as any[]

    const itemLines = items.slice(0, 4).map((i: any) =>
      `${Number(i.quantity)}× ${i.productName} — ${i.color} / ${i.size}`)
    if (items.length > 4) itemLines.push(`+${items.length - 4} more line${items.length - 4 === 1 ? '' : 's'}`)

    await push({
      title: 'KVRN SALE 💰',
      message: [
        `Order ${order.orderNumber}`,
        `${money(Number(order.totalCents), order.currency)} paid`,
        ...itemLines,
      ].join('\n'),
      path: '/admin/orders',
    })

    // Physical stock crosses only when a paid order deducts units. A reservation by
    // itself cannot trigger an owner sell-through push, so abandoned carts stay quiet.
    // Aggregate duplicate lines for the same variant before evaluating a threshold.
    const byVariant = new Map<string, any>()
    for (const item of items as any[]) {
      if (!item.variantId || item.stockOnHand === null || item.stockOnHand === undefined) continue
      const key = String(item.variantId)
      const existing = byVariant.get(key)
      if (existing) existing.sold += Number(item.quantity)
      else byVariant.set(key, { ...item, sold: Number(item.quantity) })
    }

    for (const item of byVariant.values()) {
      const current = Number(item.stockOnHand)
      const previous = current + Number(item.sold)
      const label = `${item.productName}\n${item.color} / ${item.size}`

      if (current === 0 && previous > 0) {
        // Two orders for the last units can finish at nearly the same time and each see 0.
        if (!(await claimOnce('PUSHOVER_STOCK_ALERT', 'inventory', `${item.variantId}:sold_out`, STOCK_ALERT_WINDOW_MINUTES))) continue
        await push({
          title: 'KVRN SOLD OUT 🚫',
          message: `${label}\n0 in physical stock`,
          priority: 1,
          path: '/admin/inventory',
        })
      } else if (current <= LOW_STOCK_THRESHOLD && previous > LOW_STOCK_THRESHOLD) {
        if (!(await claimOnce('PUSHOVER_STOCK_ALERT', 'inventory', `${item.variantId}:low_stock`, STOCK_ALERT_WINDOW_MINUTES))) continue
        await push({
          title: 'KVRN LOW STOCK 📦',
          message: `${label}\n${current} remaining in physical stock`,
          path: '/admin/inventory',
        })
      }
    }
  } catch (err: any) {
    console.error('[owner-notify] sale/inventory skipped:', String(err?.message ?? err).slice(0, 100))
  }
}

/** Durable paid-but-unfinalized state. Call only for a newly-created exception, never a replay. */
export async function notifyPaymentIssue(input: {
  amountCents: number
  currency?: string
  reason?: string | null
}): Promise<void> {
  if (!isPushoverConfigured()) return
  const reason = input.reason === 'insufficient_stock'
    ? 'Paid checkout could not be finalized because inventory was no longer available.'
    : 'A paid checkout could not be finalized automatically.'
  await push({
    title: 'KVRN PAYMENT ISSUE ⚠️',
    message: `${money(input.amountCents, input.currency)} payment needs attention\n${reason}\nCheck Payment Exceptions.`,
    priority: 1,
    path: '/admin',
  })
}

/** Call only on a transition into Stripe refund status=succeeded. */
export async function notifyRefund(input: {
  orderId: string
  /** Stripe refund id: charge.refunded and refund.updated can arrive together for one refund. */
  stripeRefundId?: string
  amountCents: number
  currency?: string
  fullyRefunded?: boolean
}): Promise<void> {
  if (!isPushoverConfigured() || !input.orderId) return
  try {
    if (input.stripeRefundId &&
        !(await claimOnce('PUSHOVER_REFUND_ALERT', 'refund', input.stripeRefundId, REFUND_ALERT_WINDOW_MINUTES))) return
    const rows = await sql`SELECT order_number AS "orderNumber" FROM orders WHERE id=${input.orderId}::uuid LIMIT 1`
    const orderNumber = (rows as any[])[0]?.orderNumber ?? 'Unknown order'
    await push({
      title: 'KVRN REFUND ↩️',
      message: [
        `Order ${orderNumber}`,
        `${money(input.amountCents, input.currency)} refunded`,
        input.fullyRefunded ? 'Full refund' : 'Partial refund',
      ].join('\n'),
      path: '/admin/financials/returns',
    })
  } catch (err: any) {
    console.error('[owner-notify] refund skipped:', String(err?.message ?? err).slice(0, 100))
  }
}

/** Call only when the authoritative dispute state actually changes. */
export async function notifyDispute(input: {
  stripeDisputeId: string
  amountCents: number
  currency?: string
  status: string
}): Promise<void> {
  if (!isPushoverConfigured() || !input.stripeDisputeId) return
  try {
    const rows = await sql`
      SELECT o.order_number AS "orderNumber"
      FROM order_disputes d JOIN orders o ON o.id=d.order_id
      WHERE d.stripe_dispute_id=${input.stripeDisputeId} LIMIT 1
    `
    const orderNumber = (rows as any[])[0]?.orderNumber ?? 'Unknown order'
    const status = String(input.status || 'under_review').replace(/_/g, ' ').toUpperCase()
    await push({
      title: 'KVRN DISPUTE 🚨',
      message: `Order ${orderNumber}\n${money(input.amountCents, input.currency)} disputed\nStatus: ${status}\nReview immediately.`,
      priority: 1,
      path: '/admin/financials/disputes',
    })
  } catch (err: any) {
    console.error('[owner-notify] dispute skipped:', String(err?.message ?? err).slice(0, 100))
  }
}

/** Notify only for exception findings that were detected/changed in THIS recorded run. */
export async function notifyFinancialIntegrityRun(runId: string): Promise<void> {
  if (!isPushoverConfigured() || !runId) return
  try {
    const rows = await sql`
      SELECT issue_code AS "issueCode", entity_type AS "entityType"
      FROM financial_integrity_events
      WHERE run_id=${runId}::uuid
        AND state='exception'
        AND event_type IN ('detected','changed')
      ORDER BY observed_at ASC, id ASC
    ` as any[]
    if (rows.length === 0) return
    const sample = rows.slice(0, 3).map((r: any) => `${r.issueCode} (${r.entityType})`)
    if (rows.length > 3) sample.push(`+${rows.length - 3} more`)
    await push({
      title: 'KVRN FINANCIAL EXCEPTION 🔴',
      message: [`${rows.length} new/changed reconciliation exception${rows.length === 1 ? '' : 's'}`, ...sample, 'Check Reconciliation.'].join('\n'),
      priority: 1,
      path: '/admin/financials/integrity',
    })
  } catch (err: any) {
    console.error('[owner-notify] integrity alert skipped:', String(err?.message ?? err).slice(0, 100))
  }
}

export async function notifyBackupFailure(kind: 'restore_verification' | 'dr_drill'): Promise<void> {
  if (!isPushoverConfigured()) return
  const description = kind === 'restore_verification'
    ? 'A recorded backup restore verification FAILED.'
    : 'A recorded disaster-recovery drill FAILED.'
  await push({
    title: 'KVRN BACKUP FAILURE 💾',
    message: `${description}\nCheck Admin → Backups.`,
    priority: 1,
    path: '/admin/backups',
  })
}

// ── support inbox: a NEW inbound email on support@kvrn.shop ──────────────────────────────────────

const SUPPORT_NAME_MAX = 40
const SUPPORT_SUBJECT_MAX = 80

/** Lock-screen-safe text from sender-controlled input: no control chars, links, addresses or long digit runs. */
function lockScreenSafe(raw: string | null | undefined, max: number): string {
  let t = String(raw ?? '').slice(0, 400)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]')
    .replace(/[^\s<>"'()]+@[^\s<>"'()]+/g, '[address]')
    .replace(/<\s*\[address\]\s*>/g, '')
    .replace(/\b\d[\d -]{10,}\d\b/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > max) t = t.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
  return t
}

/**
 * Owner push for a REAL inbound email that the support-email ingest route has just persisted as a NEW
 * (non-duplicate) message. The caller decides "new": this never touches the database and writes nothing,
 * so a redelivered email (duplicate=true) simply never reaches it. Contact-form submissions, admin
 * replies and status changes never call it.
 *
 * Privacy: sender display name (never the address) and a bounded subject only. No body, no attachment
 * names, no headers, no order/payment data. Fail-open: never throws, bounded by the Pushover timeout.
 */
export async function notifySupportEmail(input: { fromName?: string | null; subject?: string | null }): Promise<void> {
  if (!isPushoverConfigured()) return
  try {
    const name = lockScreenSafe(input.fromName, SUPPORT_NAME_MAX).replace(/^\[(?:address|link|number)\]$/, '')
    const subject = lockScreenSafe(input.subject, SUPPORT_SUBJECT_MAX)
    await push({
      title: 'KVRN SUPPORT ✉️',
      message: [
        'New customer email',
        `From: ${name || 'Customer'}`,
        `Subject: ${subject || '(No subject)'}`,
        'Open Admin → Support',
      ].join('\n'),
      path: '/admin/support',
    })
  } catch (err: any) {
    console.error('[owner-notify] support push skipped:', String(err?.message ?? err).slice(0, 100))
  }
}

/**
 * Provider-down debounce using the existing append-only admin audit log (no migration).
 * Three observed provider failures inside five minutes trigger ONE push per hour.
 *  - While a push for this provider is cooling down (or was just attempted) nothing is written, so
 *    traffic during an outage cannot grow the audit table.
 *  - The push attempt is claimed before it is made: a failing Pushover is retried at most once per
 *    ATTEMPT_WINDOW_MINUTES, never on every failure.
 * Callers pass only genuine provider faults (not bad customer input). No customer data or provider
 * response bodies are stored.
 */
export async function recordProviderFailure(provider: CriticalProvider, source: string): Promise<void> {
  if (!isPushoverConfigured()) return
  try {
    const cooling = await sql`
      SELECT 1 FROM admin_audit_logs
      WHERE resource='provider_health' AND resource_id=${provider}
        AND ( (action='PUSHOVER_PROVIDER_ALERT'   AND created_at >= NOW() - make_interval(mins => ${PROVIDER_ALERT_COOLDOWN_MINUTES}::int))
           OR (action='PUSHOVER_PROVIDER_ATTEMPT' AND created_at >= NOW() - make_interval(mins => ${ATTEMPT_WINDOW_MINUTES}::int)) )
      LIMIT 1
    `
    if ((cooling as any[]).length > 0) { if (provider === 'Neon') neonFallbackFailures = 0; return }

    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${SYSTEM_ACTOR}, 'PUSHOVER_PROVIDER_FAILURE', 'provider_health', ${provider},
              ${JSON.stringify({ source: String(source).slice(0, 80) })}::jsonb)
    `
    if (provider === 'Neon') neonFallbackFailures = 0

    const countRows = await sql`
      SELECT COUNT(*)::int AS n FROM admin_audit_logs
      WHERE action='PUSHOVER_PROVIDER_FAILURE' AND resource='provider_health'
        AND resource_id=${provider}
        AND created_at >= NOW() - make_interval(mins => ${PROVIDER_WINDOW_MINUTES}::int)
    `
    const failures = Number((countRows as any[])[0]?.n ?? 0)
    if (failures < PROVIDER_FAILURE_THRESHOLD) return
    if (!(await claimOnce('PUSHOVER_PROVIDER_ATTEMPT', 'provider_health', provider, ATTEMPT_WINDOW_MINUTES, { failures }))) return

    const sent = await push({
      title: 'KVRN PROVIDER DOWN ⚡',
      message: `${provider} has failed ${failures} times within ${PROVIDER_WINDOW_MINUTES} minutes.\nCustomer operations may be affected.\nCheck the integration.`,
      priority: 1,
      path: '/admin',
    })
    if (sent) {
      await sql`
        INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
        VALUES (${SYSTEM_ACTOR}, 'PUSHOVER_PROVIDER_ALERT', 'provider_health', ${provider},
                ${JSON.stringify({ failures, windowMinutes: PROVIDER_WINDOW_MINUTES,
                                  cooldownMinutes: PROVIDER_ALERT_COOLDOWN_MINUTES })}::jsonb)
      `
    }
  } catch (err: any) {
    // If Neon itself is unavailable, the audit-log debounce cannot operate.
    // For Neon failures only, keep a best-effort in-isolate streak so three
    // consecutive observations can still notify the owner. Other providers
    // deliberately do not bypass the durable debounce. Isolate memory is NOT durable:
    // a recycled isolate restarts the streak (a missed alert, never a duplicate flood:
    // the cooldown below is also per-isolate).
    if (provider === 'Neon') {
      neonFallbackFailures += 1
      const now = Date.now()
      if (neonFallbackFailures >= PROVIDER_FAILURE_THRESHOLD &&
          now - neonFallbackLastAlertAt >= PROVIDER_ALERT_COOLDOWN_MINUTES * 60_000) {
        neonFallbackLastAlertAt = now        // claim before the push: a failing push is not retried per request
        await push({
          title: 'KVRN PROVIDER DOWN ⚡',
          message: `Neon database operations have failed repeatedly.\nCustomer operations may be affected.\nCheck Neon and KVRN immediately.`,
          priority: 1,
          path: '/admin',
        })
      }
    }
    console.error('[owner-notify] provider health tracking skipped:', String(err?.message ?? err).slice(0, 100))
  }
}

/**
 * High-signal Admin security debounce. A single blocked authenticated identity can
 * be a harmless account/config mismatch; three within ten minutes is worth waking
 * the owner. Raw email/JWT/IP data is deliberately not stored in this alert ledger.
 * Same bounded-write / claim-first design as recordProviderFailure.
 */
export async function notifySecurityAlert(reason: string): Promise<void> {
  if (!isPushoverConfigured()) return
  try {
    const cooling = await sql`
      SELECT 1 FROM admin_audit_logs
      WHERE resource='admin_security' AND resource_id='access_allowlist'
        AND ( (action='PUSHOVER_SECURITY_ALERT'   AND created_at >= NOW() - make_interval(mins => ${SECURITY_ALERT_COOLDOWN_MINUTES}::int))
           OR (action='PUSHOVER_SECURITY_ATTEMPT' AND created_at >= NOW() - make_interval(mins => ${ATTEMPT_WINDOW_MINUTES}::int)) )
      LIMIT 1
    `
    if ((cooling as any[]).length > 0) return

    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${SYSTEM_ACTOR}, 'PUSHOVER_SECURITY_INCIDENT', 'admin_security', 'access_allowlist',
              ${JSON.stringify({ reason: String(reason).slice(0, 120) })}::jsonb)
    `

    const countRows = await sql`
      SELECT COUNT(*)::int AS n FROM admin_audit_logs
      WHERE action='PUSHOVER_SECURITY_INCIDENT' AND resource='admin_security'
        AND resource_id='access_allowlist'
        AND created_at >= NOW() - make_interval(mins => ${SECURITY_WINDOW_MINUTES}::int)
    `
    const incidents = Number((countRows as any[])[0]?.n ?? 0)
    if (incidents < SECURITY_FAILURE_THRESHOLD) return
    if (!(await claimOnce('PUSHOVER_SECURITY_ATTEMPT', 'admin_security', 'access_allowlist', ATTEMPT_WINDOW_MINUTES, { incidents }))) return

    const sent = await push({
      title: 'KVRN SECURITY ALERT 🔐',
      message: `${incidents} authenticated but non-allowlisted Admin access attempts occurred within ${SECURITY_WINDOW_MINUTES} minutes.\nReview Cloudflare Access and Admin security.`,
      priority: 1,
      path: '/admin',
    })
    if (sent) {
      await sql`
        INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
        VALUES (${SYSTEM_ACTOR}, 'PUSHOVER_SECURITY_ALERT', 'admin_security', 'access_allowlist',
                ${JSON.stringify({ incidents, windowMinutes: SECURITY_WINDOW_MINUTES,
                                  cooldownMinutes: SECURITY_ALERT_COOLDOWN_MINUTES })}::jsonb)
      `
    }
  } catch (err: any) {
    console.error('[owner-notify] security tracking skipped:', String(err?.message ?? err).slice(0, 100))
  }
}
