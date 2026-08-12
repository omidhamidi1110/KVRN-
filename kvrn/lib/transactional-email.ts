// lib/transactional-email.ts — Retry-safe transactional email outbox service
// - Claims rows with FOR UPDATE SKIP LOCKED (no concurrent duplicates)
// - Loads authoritative data from Neon orders + order_items
// - Non-fatal: email failure never touches order/payment/inventory
// - Retry schedule: immediate → +5min → +30min → +2hr → +12hr

import type { NeonQueryFunction } from '@neondatabase/serverless'
import {
  orderConfirmationHTML,  orderConfirmationSubject,
  shippingConfirmationHTML, shippingConfirmationSubject,
  type OrderConfirmationData, type ShippingConfirmationData, type V50ShippingAddress,
} from './email'
import type { EmailProvider }    from './resend-adapter'
import { getSiteOrigin }         from './site-origin'

// FROM_ADDRESS: TRANSACTIONAL_EMAIL_FROM overrides; otherwise built from RESEND_FROM_NAME / RESEND_FROM_EMAIL
function buildFromAddress(): string {
  const name  = process.env.RESEND_FROM_NAME  ?? 'KVRN'
  const email = process.env.RESEND_FROM_EMAIL ?? 'orders@send.kvrn.shop'
  return process.env.TRANSACTIONAL_EMAIL_FROM ?? `${name} <${email}>`
}
const REPLY_TO = process.env.TRANSACTIONAL_EMAIL_REPLY_TO ?? 'support@kvrn.shop'
const MAX_ATTEMPTS           = 5
const STALE_SENDING_MINUTES  = 15   // rows stuck in 'sending' longer than this become retryable

const RETRY_DELAYS_MS = [0, 5*60_000, 30*60_000, 2*60*60_000, 12*60*60_000]

function nextAttemptAt(attemptCount: number): Date | null {
  const delayMs = RETRY_DELAYS_MS[attemptCount] ?? null
  if (delayMs === null) return null   // exhausted — no more retries
  return new Date(Date.now() + delayMs)
}

function safeError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200)
  // Strip anything that looks like an email address to avoid logging PII
  return msg.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
}

// ── Load authoritative email data from Neon ───────────────────────────────────

export async function loadOrderEmailData(
  sql: NeonQueryFunction<false, false>,
  orderId: string
): Promise<OrderConfirmationData | null> {
  const orders = await sql`
    SELECT order_number, customer_email, customer_name,
           subtotal_cents, shipping_cents, total_cents,
           shipping_method, shipping_address
    FROM orders WHERE id = ${orderId} LIMIT 1
  `
  if (orders.length === 0) return null
  const o = orders[0] as any

  const items = await sql`
    SELECT product_name, color, size, quantity, unit_price_cents, line_total_cents
    FROM order_items WHERE order_id = ${orderId} ORDER BY created_at
  `

  const addr: V50ShippingAddress | null = o.shipping_address
    ? {
        firstName:  o.shipping_address.firstName ?? '',
        lastName:   o.shipping_address.lastName  ?? '',
        line1:      o.shipping_address.line1     ?? '',
        line2:      o.shipping_address.line2     ?? null,
        city:       o.shipping_address.city      ?? '',
        state:      o.shipping_address.state     ?? '',
        postalCode: o.shipping_address.postalCode ?? '',
        country:    o.shipping_address.country   ?? 'US',
      }
    : null

  return {
    orderNumber:    o.order_number,
    customerName:   o.customer_name ?? null,
    customerEmail:  o.customer_email,
    lineItems:      (items as any[]).map(i => ({
      productName:    i.product_name,
      color:          i.color,
      size:           i.size,
      quantity:       Number(i.quantity),
      unitPriceCents: Number(i.unit_price_cents),
      lineTotalCents: Number(i.line_total_cents),
    })),
    subtotalCents:  Number(o.subtotal_cents),
    shippingCents:  Number(o.shipping_cents),
    totalCents:     Number(o.total_cents),
    shippingMethod: o.shipping_method ?? null,
    shippingAddress: addr,
  }
}

// ── Load authoritative shipping email data from Neon ─────────────────────────

export async function loadShippingEmailData(
  sql: NeonQueryFunction<false, false>,
  orderId: string
): Promise<ShippingConfirmationData | null> {
  const orders = await sql`
    SELECT o.order_number, o.customer_email, o.customer_name, o.shipping_address,
           s.carrier, s.tracking_number, s.shipped_at
    FROM orders o
    JOIN shipments s ON s.order_id = o.id
    WHERE o.id = ${orderId} LIMIT 1
  `
  if (orders.length === 0) return null
  const o = orders[0] as any

  const addr: V50ShippingAddress | null = o.shipping_address
    ? {
        firstName:  o.shipping_address.firstName ?? '',
        lastName:   o.shipping_address.lastName  ?? '',
        line1:      o.shipping_address.line1     ?? '',
        line2:      o.shipping_address.line2     ?? null,
        city:       o.shipping_address.city      ?? '',
        state:      o.shipping_address.state     ?? '',
        postalCode: o.shipping_address.postalCode ?? '',
        country:    o.shipping_address.country   ?? 'US',
      }
    : null

  return {
    orderNumber:    o.order_number,
    customerName:   o.customer_name ?? null,
    customerEmail:  o.customer_email,
    carrier:        o.carrier ?? '',
    trackingNumber: o.tracking_number ?? '',
    shippedAt:      o.shipped_at?.toISOString?.() ?? o.shipped_at ?? null,
    shippingAddress: addr,
  }
}

// ── Process one pending email row ─────────────────────────────────────────────

export interface ProcessEmailOpts {
  sql:      NeonQueryFunction<false, false>
  provider: EmailProvider
  rowId:    string
}

export async function processOneEmail(opts: ProcessEmailOpts): Promise<
  { outcome: 'sent' | 'already_sent' | 'skipped' | 'failed'; error?: string }
> {
  const { sql, provider, rowId } = opts

  // Claim row with row-level lock — skip if already claimed by concurrent worker
  const rows = await sql`
    SELECT id, order_id, email_type, recipient_email, status,
           attempt_count, idempotency_key
    FROM transactional_emails
    WHERE id = ${rowId}
    FOR UPDATE SKIP LOCKED
  `
  if (rows.length === 0) return { outcome: 'skipped' }   // concurrent worker claimed it
  const row = rows[0] as any

  if (row.status === 'sent') return { outcome: 'already_sent' }
  if (row.attempt_count >= MAX_ATTEMPTS) {
    return { outcome: 'failed', error: 'Max attempts reached.' }
  }

  // Mark sending
  await sql`
    UPDATE transactional_emails SET status='sending', updated_at=NOW()
    WHERE id=${row.id}
  `

  // Load authoritative data and render — branch on email_type
  const siteOrigin = getSiteOrigin() ?? undefined
  let html: string
  let subject: string

  if (row.email_type === 'order_confirmation') {
    const emailData = await loadOrderEmailData(sql, row.order_id)
    if (!emailData) {
      await sql`
        UPDATE transactional_emails
        SET status='failed', last_error='Order data not found.',
            attempt_count=attempt_count+1, updated_at=NOW()
        WHERE id=${row.id}
      `
      return { outcome: 'failed', error: 'Order data not found.' }
    }
    html    = orderConfirmationHTML(emailData, siteOrigin)
    subject = orderConfirmationSubject(emailData.orderNumber)

  } else if (row.email_type === 'shipping_confirmation') {
    const emailData = await loadShippingEmailData(sql, row.order_id)
    if (!emailData) {
      await sql`
        UPDATE transactional_emails
        SET status='failed', last_error='Shipment data not found.',
            attempt_count=attempt_count+1, updated_at=NOW()
        WHERE id=${row.id}
      `
      return { outcome: 'failed', error: 'Shipment data not found.' }
    }
    html    = shippingConfirmationHTML(emailData, siteOrigin)
    subject = shippingConfirmationSubject(emailData.orderNumber)

  } else {
    // Unknown email_type — fail safely, never send
    await sql`
      UPDATE transactional_emails
      SET status='failed', last_error='Unknown email_type.',
          attempt_count=attempt_count+1, updated_at=NOW()
      WHERE id=${row.id}
    `
    return { outcome: 'failed', error: 'Unknown email_type.' }
  }

  const result = await provider.send({
    from:           buildFromAddress(),
    replyTo:        REPLY_TO,
    to:             row.recipient_email,
    subject,
    html,
    idempotencyKey: row.idempotency_key,   // deterministic — same key on every retry
  })

  if (result.ok) {
    await sql`
      UPDATE transactional_emails
      SET status='sent', provider_message_id=${result.providerMessageId},
          provider='resend', sent_at=NOW(), attempt_count=attempt_count+1,
          last_error=NULL, next_attempt_at=NULL, updated_at=NOW()
      WHERE id=${row.id}
    `
    console.log(`[transactional-email] sent ${row.email_type}`)
    return { outcome: 'sent' }
  }

  // Provider failed — increment attempt_count, schedule retry if within limit
  const newAttemptCount = Number(row.attempt_count) + 1
  const retryAt         = nextAttemptAt(newAttemptCount)

  await sql`
    UPDATE transactional_emails
    SET status='failed', last_error=${safeError(result.message)},
        attempt_count=${newAttemptCount},
        next_attempt_at=${retryAt?.toISOString() ?? null},
        updated_at=NOW()
    WHERE id=${row.id}
  `
  console.error(`[transactional-email] retry failed ${row.email_type} attempt=${newAttemptCount}`)
  return { outcome: 'failed', error: safeError(result.message) }
}

// ── Process pending outbox rows ───────────────────────────────────────────────

export interface ProcessPendingOpts {
  sql:      NeonQueryFunction<false, false>
  provider: EmailProvider
  limit?:   number
}

export async function processPendingTransactionalEmails(
  opts: ProcessPendingOpts
): Promise<{ processed: number; sent: number; failed: number }> {
  const { sql, provider, limit = 10 } = opts

  // Find due rows — includes stale 'sending' rows for recovery.
  // A 'sending' row older than STALE_SENDING_MINUTES was likely left by a crashed Worker.
  // The deterministic idempotency key makes it safe to retry at Resend.
  const rows = await sql`
    SELECT id FROM transactional_emails
    WHERE (
      (
        status IN ('pending', 'failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      )
      OR
      (
        status = 'sending'
        AND updated_at < NOW() - INTERVAL '15 minutes'  -- see STALE_SENDING_MINUTES constant
      )
    )
    AND attempt_count < ${MAX_ATTEMPTS}
    ORDER BY created_at
    LIMIT ${limit}
  `

  let sent = 0, failed = 0
  for (const row of rows as any[]) {
    const result = await processOneEmail({ sql, provider, rowId: row.id })
    if (result.outcome === 'sent') sent++
    if (result.outcome === 'failed') failed++
  }

  return { processed: rows.length, sent, failed }
}
