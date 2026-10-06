// lib/support-email.ts — isolated Resend sender for the support inbox
// Server-only. Never import in client code.
//
// Deliberately SEPARATE from lib/resend-adapter.ts / lib/transactional-email.ts: the
// transactional outbox is a working, retry-safe path and is not touched. Support replies need
// things that adapter does not carry (custom In-Reply-To / References headers, a text body,
// a read-back of the RFC Message-ID), and a support failure must never be able to affect order
// email.
//
// SENDER: replies go out FROM "KVRN Support <support@kvrn.shop>" with Reply-To support@kvrn.shop.
// If Resend has not verified that domain/address, Resend refuses the send and this module
// reports `sender_not_verified` with the exact thing to fix. It NEVER falls back to a different
// sender, because a reply from an unexpected address would split the conversation.
//
// PII: no function here logs an address, subject or body.

import { SUPPORT_MAILBOX, SUPPORT_FROM_NAME, cleanLine } from './support-inbox'

export interface OutboundSupportEmail {
  to:             string
  subject:        string
  text:           string
  inReplyTo:      string | null    // "<id>" form
  references:     string | null    // "<id> <id>" form
  idempotencyKey: string
}

export type SupportSendOutcome =
  | { ok: true;  providerMessageId: string }
  | { ok: false; code: 'not_configured' | 'sender_not_verified' | 'provider_error' | 'network'; message: string }

export interface SupportMailer {
  send(m: OutboundSupportEmail): Promise<SupportSendOutcome>
  /** The RFC 5322 Message-ID of a sent email, or null if unavailable. Never throws. */
  retrieveMessageId(providerMessageId: string): Promise<string | null>
}

export const SUPPORT_FROM = `${SUPPORT_FROM_NAME} <${SUPPORT_MAILBOX}>`

const RESEND_BASE = 'https://api.resend.com'

export const SENDER_NOT_VERIFIED_MESSAGE =
  `Resend refused to send from ${SUPPORT_MAILBOX}. In the Resend dashboard, verify the kvrn.shop domain ` +
  `(Domains → Add/verify kvrn.shop, DNS records published) so ${SUPPORT_MAILBOX} is an allowed sender, then retry. ` +
  `No email was sent and nothing was saved.`

// ── HTML helpers (customer text is ALWAYS escaped before it enters any HTML) ─────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Plain text → minimal safe HTML (escape first, then newlines to <br>). */
export function textToSafeHtml(text: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1a1a1a;white-space:normal">${
    escapeHtml(text).replace(/\n/g, '<br>')}</div>`
}

// ── Resend mailer ────────────────────────────────────────────────────────────

export function createResendSupportMailer(
  apiKey: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): SupportMailer {
  const doFetch = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const timeoutMs = deps.timeoutMs ?? 8000

  async function call(path: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try { return await doFetch(`${RESEND_BASE}${path}`, { ...init, signal: ctl.signal }) }
    finally { clearTimeout(t) }
  }

  return {
    async send(m) {
      const headers: Record<string, string> = {}
      if (m.inReplyTo)  headers['In-Reply-To'] = m.inReplyTo
      if (m.references) headers['References']  = m.references
      const body: Record<string, unknown> = {
        from: SUPPORT_FROM, reply_to: SUPPORT_MAILBOX, to: [m.to],
        subject: cleanLine(m.subject, 998), text: m.text, html: textToSafeHtml(m.text),
      }
      if (Object.keys(headers).length) body.headers = headers

      let res: Response
      try {
        res = await call('/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Idempotency-Key': m.idempotencyKey,
          },
          body: JSON.stringify(body),
        })
      } catch {
        return { ok: false, code: 'network', message: 'Could not reach the email provider; the email was not confirmed as sent. Retrying is safe: the same request is never sent twice.' }
      }

      if (!res.ok) {
        let providerMessage = ''
        try { providerMessage = String((await res.json())?.message ?? '').slice(0, 300) } catch { /* unreadable */ }
        if (res.status === 403 && /domain|verif|sender|from/i.test(providerMessage)) {
          return { ok: false, code: 'sender_not_verified', message: SENDER_NOT_VERIFIED_MESSAGE }
        }
        if (res.status === 401 || res.status === 403) {
          return { ok: false, code: 'provider_error', message: `Email provider rejected the API key or permissions (HTTP ${res.status}). The email was not sent.` }
        }
        return { ok: false, code: 'provider_error', message: `Email provider returned HTTP ${res.status}; the email was not confirmed as sent. Retrying is safe: the same request is never sent twice.` }
      }

      let data: any
      try { data = await res.json() } catch {
        return { ok: false, code: 'provider_error', message: 'Email provider returned an unreadable response; delivery is unknown. Check Resend before retrying.' }
      }
      const id = typeof data?.id === 'string' ? data.id : ''
      if (!id) {
        return { ok: false, code: 'provider_error', message: 'Email provider returned no message id; delivery is unknown. Check Resend before retrying.' }
      }
      return { ok: true, providerMessageId: id }
    },

    async retrieveMessageId(providerMessageId) {
      try {
        const res = await call(`/emails/${encodeURIComponent(providerMessageId)}`, {
          method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        if (!res.ok) return null
        const data: any = await res.json()
        return typeof data?.message_id === 'string' && data.message_id ? data.message_id : null
      } catch { return null }
    },
  }
}

/** The configured mailer, or a mailer that reports `not_configured` (never a silent success). */
export function getSupportMailer(): SupportMailer {
  const key = process.env.RESEND_API_KEY ?? ''
  if (!key) {
    return {
      async send() {
        return { ok: false, code: 'not_configured', message: 'Email sending is not configured (RESEND_API_KEY is missing).' }
      },
      async retrieveMessageId() { return null },
    }
  }
  return createResendSupportMailer(key)
}

// ── storefront contact-form owner notification (fail-open) ──────────────────────────────────────

export interface ContactNotificationInput {
  firstName: string; lastName: string; email: string
  orderNumber: string | null; subject: string; message: string
}

function notificationFrom(): string {
  const name  = process.env.RESEND_FROM_NAME  ?? 'KVRN'
  const email = process.env.RESEND_FROM_EMAIL ?? 'orders@send.kvrn.shop'
  return process.env.TRANSACTIONAL_EMAIL_FROM ?? `${name} <${email}>`
}

/** Subject/HTML/text for the owner copy. Everything customer-supplied is escaped. */
export function buildContactNotification(c: ContactNotificationInput) {
  const subject = cleanLine(`[KVRN Contact] ${c.subject} — ${c.firstName} ${c.lastName}`, 200)
  const lines = [
    `From: ${c.firstName} ${c.lastName} <${c.email}>`,
    `Subject: ${c.subject}`,
    ...(c.orderNumber ? [`Order: ${c.orderNumber}`] : []),
    '',
    c.message,
    '',
    '— Stored in KVRN Admin → Support. Reply there so the conversation stays threaded.',
  ]
  const text = lines.join('\n')
  const html =
    `<p><strong>From:</strong> ${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)} &lt;${escapeHtml(c.email)}&gt;</p>` +
    `<p><strong>Subject:</strong> ${escapeHtml(c.subject)}</p>` +
    (c.orderNumber ? `<p><strong>Order:</strong> ${escapeHtml(c.orderNumber)}</p>` : '') +
    `<hr>${textToSafeHtml(c.message)}` +
    `<p style="color:#777;font-size:12px">Stored in KVRN Admin → Support. Reply there so the conversation stays threaded.</p>`
  return { subject, text, html }
}

/**
 * Send the owner a copy of a contact-form submission. FAIL-OPEN by design: the database copy is
 * authoritative, so this returns a status and never throws. Without SUPPORT_FORWARD_TO it is
 * skipped. The destination is runtime configuration and never leaves the server.
 */
export async function sendContactNotification(
  c: ContactNotificationInput,
  deps: { fetchImpl?: typeof fetch; apiKey?: string; forwardTo?: string } = {},
): Promise<'sent' | 'skipped_no_destination' | 'skipped_no_key' | 'failed'> {
  const to = normalizeDest(deps.forwardTo ?? process.env.SUPPORT_FORWARD_TO)
  if (!to) return 'skipped_no_destination'
  const key = deps.apiKey ?? process.env.RESEND_API_KEY ?? ''
  if (!key) return 'skipped_no_key'
  const n = buildContactNotification(c)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 5000)          // the customer is waiting on this request
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${RESEND_BASE}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        from: notificationFrom(), to: [to], reply_to: c.email,
        subject: n.subject, text: n.text, html: n.html,
      }),
      signal: ctl.signal,
    })
    return res.ok ? 'sent' : 'failed'
  } catch { return 'failed' } finally { clearTimeout(timer) }
}

function normalizeDest(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase()
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s) ? s : null
}
