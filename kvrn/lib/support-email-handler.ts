// lib/support-email-handler.ts — Cloudflare Email Worker handler for support@kvrn.shop
//
// Imported by cloudflare-cron-wrapper.js (the Worker entry). Written as a pure function over
// injected dependencies so it is unit-tested without Cloudflare, Gmail, Resend or a network.
// Relative imports only: this file is bundled by wrangler, which does not resolve the "@/" alias.
//
// ── WHAT HAPPENS TO AN EMAIL ────────────────────────────────────────────────
//
//   support@kvrn.shop → Cloudflare Email Routing → THIS handler
//     1. read the raw message (bounded)             — failure does not stop step 2
//     2. message.forward(SUPPORT_FORWARD_TO)        — the FULL original message, attachments included
//     3. parse the MIME (postal-mime) and POST a bounded JSON copy to the internal ingest route
//        through openNextWorker.fetch (same no-self-fetch pattern as the cron handler)
//
// ── FAILURE DESIGN: a support email must not vanish silently ────────────────
//
//   forward ok,  ingest failed → safe in the owner's mailbox (logged, no PII)
//   forward fail, ingest ok    → safe in Admin → Support       (logged, no PII)
//   BOTH failed                → message.setReject(...): the sender gets an explicit, permanent
//                                SMTP rejection and can resend or use the contact form. This is
//                                the only outcome Cloudflare documents for "I could not take
//                                this"; silently accepting would lose the message.
//   MIME parse failure         → a headers-only copy is still ingested and the forward is not
//                                affected.
//   Oversize / unreadable raw  → forward still happens; a headers-only stub is ingested.
//
// An unsupported attachment never causes a rejection: attachments are recorded as metadata only.
//
// PII: nothing here logs an address, subject or body. Logs carry outcome codes only.

import { SUPPORT_MAILBOX, SUPPORT_LIMITS, normalizeEmail } from './support-inbox'

/** Largest raw message the Worker will read and parse (Cloudflare's own limit is 25 MiB). */
export const MAX_PARSE_BYTES = 10 * 1024 * 1024
/** Worker-side pre-truncation; the service truncates again to its exact limit. */
const TEXT_CAP = SUPPORT_LIMITS.INBOUND_BODY_CHARS + 1000
const HTML_CAP = SUPPORT_LIMITS.INBOUND_HTML_CHARS + 1000
export const INGEST_PATH = '/api/internal/support-email-ingest'

export const REJECT_MESSAGE =
  'KVRN Support could not accept your message right now. Please try again shortly, or use the contact form at kvrn.shop/contact.'

export interface EmailMessageLike {
  readonly from: string
  readonly to: string
  readonly headers: Headers
  readonly raw: ReadableStream<Uint8Array>
  readonly rawSize: number
  forward(rcptTo: string, headers?: Headers): Promise<unknown>
  setReject(reason: string): void
}

export interface SupportEmailEnv {
  SUPPORT_FORWARD_TO?: string
  SUPPORT_EMAIL_INGEST_SECRET?: string
}

/** The slice of postal-mime's result this handler reads. */
export interface ParsedMime {
  subject?: string
  messageId?: string
  inReplyTo?: string
  references?: string
  date?: string
  from?: { name?: string; address?: string; group?: { name?: string; address?: string }[] }
  text?: string
  html?: string
  attachments?: { filename?: string | null; mimeType?: string; disposition?: string | null; content?: ArrayBuffer | Uint8Array | string }[]
}

export interface HandlerDeps {
  parseMime(raw: ArrayBuffer): Promise<ParsedMime>
  /** POST to the in-process Next route (openNextWorker.fetch). */
  ingest(req: Request): Promise<Response>
  /** Outcome codes only. Never pass an address, subject or body. */
  log?: { info(msg: string): void; error(msg: string): void }
}

export interface HandlerOutcome {
  outcome:   'handled' | 'rejected' | 'ignored_recipient'
  forwarded: boolean
  ingested:  boolean
}

const noop = { info() {}, error() {} }

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}

/** `Name <a@b.c>` or `a@b.c` → {name, address}. Used only when MIME parsing was not possible. */
export function extractAddress(headerValue: string | null | undefined): { name: string; address: string } {
  const v = (headerValue ?? '').trim()
  const m = v.match(/^(.*)<([^<>]+)>\s*$/)
  if (m) return { name: m[1].replace(/^\s*"|"\s*$/g, '').trim(), address: m[2].trim() }
  return { name: '', address: v }
}

function byteLength(c: unknown): number | null {
  if (c instanceof ArrayBuffer) return c.byteLength
  if (ArrayBuffer.isView(c)) return c.byteLength
  if (typeof c === 'string') return c.length
  return null
}

function cap(s: string | undefined, n: number): string | undefined {
  return typeof s === 'string' ? (s.length > n ? s.slice(0, n) : s) : undefined
}

/** Payload (IngestPayloadV1) from a fully parsed message. */
export function payloadFromParsed(p: ParsedMime, message: Pick<EmailMessageLike, 'from' | 'to' | 'rawSize'>, digest: string, importNote?: string) {
  let from = p.from
  if (from && !from.address && Array.isArray(from.group) && from.group[0]) from = from.group[0]
  return {
    v: 1 as const,
    envelopeFrom: message.from, envelopeTo: message.to, rawSize: message.rawSize,
    dedupeDigest: digest,
    ...(importNote ? { importNote } : {}),
    subject: p.subject, messageId: p.messageId, inReplyTo: p.inReplyTo, references: p.references, date: p.date,
    fromEmail: from?.address, fromName: from?.name,
    text: cap(p.text, TEXT_CAP),
    // HTML is sent only when there is no text part, and only so the service can reduce it to text.
    html: p.text && p.text.trim() ? undefined : cap(p.html, HTML_CAP),
    attachments: (p.attachments ?? []).slice(0, SUPPORT_LIMITS.ATTACHMENTS).map(a => ({
      filename: a.filename ?? null, mimeType: a.mimeType, disposition: a.disposition ?? null, size: byteLength(a.content),
    })),
  }
}

/** Payload from the message headers only (parse failed, or the body was too large to read). */
export function payloadFromHeaders(message: Pick<EmailMessageLike, 'from' | 'to' | 'rawSize' | 'headers'>, digest: string, importNote: string) {
  const h = message.headers
  const from = extractAddress(h.get('from'))
  return {
    v: 1 as const,
    envelopeFrom: message.from, envelopeTo: message.to, rawSize: message.rawSize,
    dedupeDigest: digest, importNote,
    subject: h.get('subject') ?? undefined, messageId: h.get('message-id') ?? undefined,
    inReplyTo: h.get('in-reply-to') ?? undefined, references: h.get('references') ?? undefined,
    date: h.get('date') ?? undefined,
    fromEmail: from.address || undefined, fromName: from.name || undefined,
    attachments: [] as unknown[],
  }
}

/** Digest of what the sender wrote (From, Date, Subject, text/html, attachment names+sizes) — not of transport headers. */
export async function contentDigest(p: ParsedMime, message: Pick<EmailMessageLike, 'from'>): Promise<string> {
  const from = p.from?.address ?? p.from?.group?.[0]?.address ?? message.from
  const atts = (p.attachments ?? []).map(a => `${a.filename ?? ''}:${a.mimeType ?? ''}:${byteLength(a.content) ?? ''}`).join(',')
  const basis = [from, p.subject ?? '', p.date ?? '', p.text ?? '', p.html ?? '', atts].join('\u0000')
  return sha256Hex(new TextEncoder().encode(basis))
}

/** Digest of the headers that identify a message, used as the dedupe fallback when raw was not read. */
async function headerDigest(m: Pick<EmailMessageLike, 'from' | 'to' | 'rawSize' | 'headers'>): Promise<string> {
  const h = m.headers
  const basis = ['from', 'to', 'subject', 'message-id', 'date'].map(k => `${k}:${h.get(k) ?? ''}`).join('\n') + `\nsize:${m.rawSize}`
  return sha256Hex(new TextEncoder().encode(basis))
}

export async function handleSupportEmail(
  message: EmailMessageLike, env: SupportEmailEnv, deps: HandlerDeps,
): Promise<HandlerOutcome> {
  const log = deps.log ?? noop

  // Only the support mailbox is a support inbox. Anything else routed here is refused, not forwarded.
  if (normalizeEmail(message.to) !== SUPPORT_MAILBOX) {
    log.error('[support-email] ignored: recipient is not the support mailbox')
    message.setReject('Unknown recipient.')
    return { outcome: 'ignored_recipient', forwarded: false, ingested: false }
  }

  // 1. Read the raw message (bounded). A failure here must not stop the forward.
  let raw: ArrayBuffer | null = null
  let rawNote: string | null = null
  if (message.rawSize > MAX_PARSE_BYTES) {
    rawNote = 'Message too large to import; the full message is in the forwarded mailbox.'
  } else {
    try { raw = await new Response(message.raw).arrayBuffer() }
    catch { rawNote = 'Message body could not be read for import; the full message is in the forwarded mailbox.' }
  }

  // 2. Forward the FULL original message to the owner's verified destination (runtime config).
  let forwarded = false
  const dest = (env.SUPPORT_FORWARD_TO ?? '').trim()
  if (!dest) {
    log.error('[support-email] SUPPORT_FORWARD_TO is not configured — skipping forward')
  } else {
    try {
      await message.forward(dest, new Headers({ 'X-KVRN-Support': SUPPORT_MAILBOX }))
      forwarded = true
    } catch (e: any) {
      log.error(`[support-email] forward failed: ${String(e?.name ?? 'Error').slice(0, 40)}`)
    }
  }

  // 3. Store the database copy.
  let ingested = false
  const secret = env.SUPPORT_EMAIL_INGEST_SECRET ?? ''
  if (!secret) {
    log.error('[support-email] SUPPORT_EMAIL_INGEST_SECRET is not configured — skipping database copy')
  } else {
    try {
      let payload: Record<string, unknown>
      if (raw) {
        const rawDigest = await sha256Hex(raw)
        try {
          const parsed = await deps.parseMime(raw)
          // Dedupe fallback for mail WITHOUT a Message-ID: a digest of the message's own content, so it is
          // stable across SMTP retries (the raw bytes also carry per-hop Received headers that change).
          payload = payloadFromParsed(parsed, message, await contentDigest(parsed, message))
        } catch {
          log.error('[support-email] MIME parse failed — storing a headers-only copy')
          payload = payloadFromHeaders(message, rawDigest, 'Message could not be parsed; the full message is in the forwarded mailbox.')
        }
      } else {
        payload = payloadFromHeaders(message, await headerDigest(message), rawNote ?? 'Message body not imported.')
      }
      const body = JSON.stringify(payload)

      for (let attempt = 0; attempt < 2 && !ingested; attempt++) {
        try {
          const res = await deps.ingest(new Request(`https://internal${INGEST_PATH}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
            body,
          }))
          if (res.ok) ingested = true
          else if (res.status < 500) { log.error(`[support-email] ingest refused: HTTP ${res.status}`); break }   // a 4xx will not heal on retry
          else log.error(`[support-email] ingest failed: HTTP ${res.status}`)
        } catch (e: any) {
          log.error(`[support-email] ingest error: ${String(e?.name ?? 'Error').slice(0, 40)}`)
        }
      }
    } catch (e: any) {
      log.error(`[support-email] ingest preparation failed: ${String(e?.name ?? 'Error').slice(0, 40)}`)
    }
  }

  if (!forwarded && !ingested) {
    log.error('[support-email] BOTH forward and database copy failed — rejecting so the sender is told')
    message.setReject(REJECT_MESSAGE)
    return { outcome: 'rejected', forwarded, ingested }
  }
  log.info(`[support-email] handled forwarded=${forwarded} ingested=${ingested}`)
  return { outcome: 'handled', forwarded, ingested }
}
