// lib/support-inbox.ts — KVRN support inbox domain service (support@kvrn.shop + contact form)
// Server-only. Never import in client code.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
//
// One small support inbox. Messages are immutable facts (migration 026 enforces it); only a
// thread's status / read counter / last-message pointers change. Nothing here reads or writes
// an order, payment, inventory, FIFO, refund or cancellation object.
//
// The ATOMIC writes live in SQL (support_ingest_message, support_record_outbound,
// support_set_thread_status). This file owns the RULES that must exist in exactly one place:
// address / subject / Message-ID normalization, payload validation, size bounds and the reply
// orchestration (provider first, store only after the provider accepted).
//
// PII: nothing in this file logs an address, a subject or a body.

import type { NeonQueryFunction } from '@neondatabase/serverless'
import type { SupportMailer } from './support-email'

export const SUPPORT_MAILBOX = 'support@kvrn.shop'
export const SUPPORT_FROM_NAME = 'KVRN Support'

export const SUPPORT_LIMITS = {
  /** Inbound email body characters kept in the database (the full message stays in the forwarded mailbox). */
  INBOUND_BODY_CHARS: 100_000,
  /** HTML-only mail is reduced to text from at most this many characters of HTML. */
  INBOUND_HTML_CHARS: 100_000,
  /** Admin reply body characters. */
  REPLY_BODY_CHARS: 20_000,
  SUBJECT_CHARS: 998,
  EMAIL_CHARS: 254,
  NAME_CHARS: 200,
  ORDER_NUMBER_CHARS: 60,
  ATTACHMENTS: 100,
  FILENAME_CHARS: 255,
  MIME_CHARS: 100,
  /** Largest ingest request body the internal route will read (characters). */
  INGEST_BODY_CHARS: 2_000_000,
  CONTACT_MESSAGE_CHARS: 5_000,
  CONTACT_NAME_CHARS: 100,
  CONTACT_SUBJECT_CHARS: 120,
  CONTACT_PER_EMAIL_PER_HOUR: 5,
  CONTACT_GLOBAL_PER_HOUR: 100,
  LIST_DEFAULT: 50,
  LIST_MAX: 100,
  SEARCH_CHARS: 100,
  REFERENCE_IDS_MAX: 50,
  REPLY_REFERENCES_MAX: 20,
} as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

// ── errors ───────────────────────────────────────────────────────────────────

export type SupportErrorCode =
  | 'invalid_payload' | 'wrong_recipient' | 'no_sender' | 'invalid_request' | 'not_found'
  | 'self_recipient' | 'empty_body' | 'body_too_long' | 'duplicate_conflict'
  | 'not_configured' | 'sender_not_verified' | 'provider_error' | 'sent_not_recorded'
  | 'rate_limited' | 'storage_error'

/** A support failure with a SAFE message (never contains message content or addresses). */
export class SupportError extends Error {
  constructor(
    public readonly code: SupportErrorCode,
    message: string,
    public readonly status: number,
    public readonly extra?: Record<string, unknown>,
  ) { super(message); this.name = 'SupportError' }
}

// ── normalization ────────────────────────────────────────────────────────────

// NUL cannot be stored in PostgreSQL text; other C0 controls are noise and a header-injection risk.
// eslint-disable-next-line no-control-regex
const CTRL_KEEP_NL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
// eslint-disable-next-line no-control-regex
const CTRL_ALL = /[\u0000-\u001F\u007F\u2028\u2029]/g

/** Body text: LF newlines, no NUL / C0 controls (tab and newline kept). */
export function cleanText(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input.replace(/\r\n?/g, '\n').replace(CTRL_KEEP_NL, '')
}

/** One-line text (subjects, names, filenames): controls collapse to a space, whitespace collapsed, trimmed. */
export function cleanLine(input: unknown, max: number): string {
  if (typeof input !== 'string') return ''
  const s = input.replace(CTRL_ALL, ' ').replace(/\s+/g, ' ').trim()
  return truncateChars(s, max)
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s
  let end = max
  const code = s.charCodeAt(end - 1)
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1
  return s.slice(0, end)
}

const EMAIL_RE = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/

/**
 * Normalize ONE email address: trim, strip an enclosing <> / quotes, lower-case.
 * Returns null for anything that is not a single plausible address (lists, display-name forms,
 * whitespace, control characters, > 254 chars). Gmail dots / plus-tags are NOT collapsed:
 * two spellings are two addresses until proven otherwise.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim()
  s = s.toLowerCase()
  if (s.length < 3 || s.length > SUPPORT_LIMITS.EMAIL_CHARS) return null
  if (!EMAIL_RE.test(s)) return null
  return s
}

const SUBJECT_PREFIX_RE = /^\s*(?:re|fwd?|aw|wg|sv|vs|antw|rv|res|enc|tr)(?:\[\d+\])?\s*:\s*/i

/** Display subject: single line, bounded. Missing subject stays '' (never invented). */
export function cleanSubject(raw: unknown): string {
  return cleanLine(raw, SUPPORT_LIMITS.SUBJECT_CHARS)
}

/**
 * Normalized subject for FALLBACK thread matching only: leading Re:/Fwd:/Fw:/Aw:… chains removed,
 * lower-cased, whitespace collapsed. '' when nothing meaningful is left (then no fallback is tried).
 */
export function subjectKey(raw: unknown): string {
  let s = cleanSubject(raw)
  for (let i = 0; i < 10; i++) {
    const next = s.replace(SUBJECT_PREFIX_RE, '')
    if (next === s) break
    s = next
  }
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * One RFC 5322 Message-ID → normalized token: the id inside <>, lower-cased, no brackets.
 * Returns null if it is not a single plausible id.
 */
export function normalizeMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/<([^<>\s]+)>/)
  const s = (m ? m[1] : raw.trim()).toLowerCase()
  if (!s || s.length > 998 || /[\s<>]/.test(s) || !s.includes('@')) return null
  return s
}

/** Every <id> in an In-Reply-To / References header, normalized, in header order, de-duplicated. */
export function parseMessageIds(header: unknown): string[] {
  if (typeof header !== 'string') return []
  const out: string[] = []
  for (const m of header.matchAll(/<([^<>\s]+)>/g)) {
    const id = normalizeMessageId(`<${m[1]}>`)
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** References → candidate ids MOST RECENT FIRST (the last id in the header is the closest ancestor). */
export function referenceCandidates(header: unknown): string[] {
  return parseMessageIds(header).slice(-SUPPORT_LIMITS.REFERENCE_IDS_MAX).reverse()
}

/** "<id>" form for an outgoing In-Reply-To / References header. */
export const bracketId = (id: string) => `<${id}>`

// ── HTML → text (inbound HTML-only mail; HTML itself is never stored or rendered) ───────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
}

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'ul', 'ol'])
const SKIP_CONTENT_TAGS = ['script', 'style', 'head', 'title']
const MAX_TAG_CHARS = 1000

/** ASCII-only lower-casing that PRESERVES string length (String#toLowerCase can change it). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32))

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]{1,8}|[a-z]{2,8});/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const cp = ent[1].toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return ''
      try { return String.fromCodePoint(cp) } catch { return '' }
    }
    return ENTITIES[ent.toLowerCase()] ?? whole
  })
}

/**
 * Safe plain-text rendering of an HTML email body. The output is TEXT; it is never re-parsed as HTML.
 *
 * LINEAR TIME on purpose: this runs on attacker-controlled input inside a Worker with a CPU limit,
 * so it is a single forward scan (no backtracking regex over the markup) over at most
 * INBOUND_HTML_CHARS characters. A '<' with no '>' within MAX_TAG_CHARS is literal text.
 */
export function htmlToText(html: unknown): string {
  if (typeof html !== 'string') return ''
  const src = html.length > SUPPORT_LIMITS.INBOUND_HTML_CHARS ? html.slice(0, SUPPORT_LIMITS.INBOUND_HTML_CHARS) : html
  const lower = asciiLower(src)
  const n = src.length
  const out: string[] = []
  const closeAt: Record<string, number> = {}     // memo: where the NEXT closing tag of a skipped element is (-1 = none)
  let i = 0
  let gtCache = -2                                // last '>' position found; reused while still ahead of the scan

  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt === -1) { out.push(src.slice(i)); break }
    if (lt > i) out.push(src.slice(i, lt))

    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4)
      i = e === -1 ? n : e + 3
      continue
    }

    if (gtCache !== -1 && gtCache <= lt) gtCache = src.indexOf('>', lt + 1)
    const gt = gtCache
    if (gt === -1 || gt - lt > MAX_TAG_CHARS) { out.push('<'); i = lt + 1; continue }   // not a tag: literal '<'

    const inner = src.slice(lt + 1, gt)
    // A tag name must follow '<' (or '</') immediately, exactly as in HTML: "a < b" is plain text.
    const m = /^(\/?)([a-z][a-z0-9]{0,15})/i.exec(inner)
    if (!m) {
      if (inner[0] === '!' || inner[0] === '?' || inner[0] === '/') { i = gt + 1; continue }   // <!DOCTYPE …>, <?xml …?>, stray </…>: markup noise
      out.push('<'); i = lt + 1; continue                                                      // literal '<'
    }
    i = gt + 1
    const closing = m[1] === '/'
    const name = m[2].toLowerCase()

    if (!closing && SKIP_CONTENT_TAGS.includes(name) && !/\/\s*$/.test(inner)) {
      // drop everything up to the matching close tag (or the end if it never closes)
      const needle = `</${name}`
      let at = closeAt[name]
      if (at === undefined || (at !== -1 && at < i)) { at = lower.indexOf(needle, i); closeAt[name] = at }
      if (at === -1) { i = n; break }
      const e = src.indexOf('>', at)
      i = e === -1 ? n : e + 1
      continue
    }
    if (name === 'br') out.push('\n')
    else if (BLOCK_TAGS.has(name)) out.push(closing ? '\n' : name === 'li' ? '\n• ' : '')
  }

  const text = cleanText(decodeEntities(out.join('')))
  // trim trailing blanks per line without a backtracking regex, then collapse blank-line runs
  const lines = text.split('\n').map(l => l.trimEnd())
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── attachment metadata (never content) ─────────────────────────────────────

export interface AttachmentMeta {
  filename:    string | null
  mimeType:    string
  size:        number | null
  disposition: 'attachment' | 'inline' | null
}

export function sanitizeAttachmentMetadata(list: unknown): AttachmentMeta[] {
  if (!Array.isArray(list)) return []
  const out: AttachmentMeta[] = []
  for (const a of list.slice(0, SUPPORT_LIMITS.ATTACHMENTS)) {
    if (!a || typeof a !== 'object') continue
    const r = a as Record<string, unknown>
    const filename = cleanLine(r.filename, SUPPORT_LIMITS.FILENAME_CHARS)
    const mime = cleanLine(r.mimeType, SUPPORT_LIMITS.MIME_CHARS).toLowerCase()
    const size = typeof r.size === 'number' && Number.isFinite(r.size) && r.size >= 0 ? Math.floor(r.size) : null
    const d = typeof r.disposition === 'string' ? r.disposition.toLowerCase() : null
    out.push({
      filename: filename || null,
      mimeType: mime || 'application/octet-stream',
      size,
      disposition: d === 'attachment' || d === 'inline' ? d : null,
    })
  }
  return out
}

// ── inbound email ────────────────────────────────────────────────────────────

/** What the Email Worker posts to the internal ingest route (version 1). */
export interface IngestPayloadV1 {
  v:             1
  envelopeFrom?: string
  envelopeTo:    string
  rawSize?:      number
  /** SHA-256 hex of the raw message (or of its headers when the body was not read). Dedupe fallback. */
  dedupeDigest:  string
  importNote?:   string
  subject?:      string
  messageId?:    string
  inReplyTo?:    string
  references?:   string
  date?:         string
  fromEmail?:    string
  fromName?:     string
  text?:         string
  html?:         string
  attachments?:  unknown[]
}

export interface InboundEmailInput {
  dedupeKey:         string
  internetMessageId: string | null
  inReplyToIds:      string[]
  referenceIds:      string[]
  inReplyTo:         string | null
  referencesHeader:  string | null
  customerEmail:     string
  customerName:      string | null
  fromEmail:         string
  fromName:          string | null
  toEmail:           string
  subject:           string
  subjectKey:        string
  bodyText:          string
  attachments:       AttachmentMeta[]
  importNote:        string | null
  occurredAt:        string | null
}

const HEX64 = /^[0-9a-f]{64}$/i

const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1)
const MAX_FUTURE_SKEW_MS = 24 * 3600 * 1000

/**
 * A sender's Date header, or null when it is missing, unparseable or implausible (before 1990 or
 * more than a day ahead — the database clamps the future to now anyway). A bad Date must never make
 * a valid email unstorable, so anything outside the safe range is simply not recorded.
 */
function parseDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const t = Date.parse(raw)
  if (!Number.isFinite(t) || t < MIN_PLAUSIBLE_MS || t > Date.now() + MAX_FUTURE_SKEW_MS) return null
  return new Date(t).toISOString()
}

/**
 * Validate and normalize the Email Worker payload. Throws SupportError (4xx) for anything that
 * is not a support email addressed to support@kvrn.shop with a usable sender.
 * Missing data is never invented: no subject stays '', no Message-ID stays null.
 */
export function buildInboundEmailInput(payload: unknown): InboundEmailInput {
  if (!payload || typeof payload !== 'object') throw new SupportError('invalid_payload', 'Invalid payload.', 422)
  const p = payload as Partial<IngestPayloadV1>
  if (p.v !== 1) throw new SupportError('invalid_payload', 'Unsupported payload version.', 422)

  const to = normalizeEmail(p.envelopeTo)
  if (to !== SUPPORT_MAILBOX) throw new SupportError('wrong_recipient', 'Not the support mailbox.', 422)

  const customerEmail = normalizeEmail(p.fromEmail) ?? normalizeEmail(p.envelopeFrom)
  if (!customerEmail) throw new SupportError('no_sender', 'No usable sender address.', 422)

  if (typeof p.dedupeDigest !== 'string' || !HEX64.test(p.dedupeDigest)) {
    throw new SupportError('invalid_payload', 'Missing dedupe digest.', 422)
  }

  const mid = normalizeMessageId(p.messageId)
  const dedupeKey = mid ? `mid:${mid}` : `sha256:${p.dedupeDigest.toLowerCase()}`

  const notes: string[] = []
  if (typeof p.importNote === 'string' && p.importNote.trim()) notes.push(cleanLine(p.importNote, 200))

  let body = cleanText(p.text)
  if (!body.trim()) {
    body = htmlToText(p.html)
    if (typeof p.html === 'string' && p.html.length > SUPPORT_LIMITS.INBOUND_HTML_CHARS) {
      notes.push('HTML body truncated for import; the full message is in the forwarded mailbox.')
    }
  }
  body = body.trim() ? body : ''
  if (body.length > SUPPORT_LIMITS.INBOUND_BODY_CHARS) {
    body = truncateChars(body, SUPPORT_LIMITS.INBOUND_BODY_CHARS)
    notes.push(`Body truncated to ${SUPPORT_LIMITS.INBOUND_BODY_CHARS.toLocaleString('en-US')} characters; the full message is in the forwarded mailbox.`)
  }

  const subject = cleanSubject(p.subject)
  const name = cleanLine(p.fromName, SUPPORT_LIMITS.NAME_CHARS)
  const inReplyToRaw = typeof p.inReplyTo === 'string' ? cleanLine(p.inReplyTo, 4000) : ''
  const referencesRaw = typeof p.references === 'string' ? cleanLine(p.references, 8000) : ''

  return {
    dedupeKey,
    internetMessageId: mid,
    inReplyToIds:      parseMessageIds(inReplyToRaw).reverse(),
    referenceIds:      referenceCandidates(referencesRaw),
    inReplyTo:         inReplyToRaw || null,
    referencesHeader:  referencesRaw || null,
    customerEmail,
    customerName:      name || null,
    fromEmail:         customerEmail,
    fromName:          name || null,
    toEmail:           SUPPORT_MAILBOX,
    subject,
    subjectKey:        subjectKey(subject),
    bodyText:          body,
    attachments:       sanitizeAttachmentMetadata(p.attachments),
    importNote:        notes.length ? truncateChars(notes.join(' '), 300) : null,
    occurredAt:        parseDate(p.date),
  }
}

// ── contact form ─────────────────────────────────────────────────────────────

export interface ContactInput {
  firstName:    string
  lastName:     string
  email:        string
  orderNumber:  string | null
  subject:      string
  message:      string
  submissionId: string | null
}

export type ContactValidation = { ok: true; value: ContactInput } | { ok: false; error: string }

export function validateContactSubmission(raw: unknown): ContactValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Missing required fields.' }
  const b = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')

  const firstName = cleanLine(b.firstName, SUPPORT_LIMITS.CONTACT_NAME_CHARS)
  const lastName  = cleanLine(b.lastName,  SUPPORT_LIMITS.CONTACT_NAME_CHARS)
  const subject   = cleanLine(b.subject,   SUPPORT_LIMITS.CONTACT_SUBJECT_CHARS)
  const message   = cleanText(b.message).trim()
  if (!firstName || !lastName || !str(b.email).trim() || !subject || !message) {
    return { ok: false, error: 'Missing required fields.' }
  }
  const email = normalizeEmail(b.email)
  if (!email) return { ok: false, error: 'Invalid email address.' }
  if (email === SUPPORT_MAILBOX) return { ok: false, error: 'Invalid email address.' }
  if (message.length > SUPPORT_LIMITS.CONTACT_MESSAGE_CHARS) {
    return { ok: false, error: `Message is too long (max ${SUPPORT_LIMITS.CONTACT_MESSAGE_CHARS} characters).` }
  }
  const order = cleanLine(b.orderNumber, SUPPORT_LIMITS.ORDER_NUMBER_CHARS)
  const sid = isUuid(b.submissionId) ? (b.submissionId as string).toLowerCase() : null
  return { ok: true, value: { firstName, lastName, email, orderNumber: order || null, subject, message, submissionId: sid } }
}

// ── constant-time compare (machine-to-machine secret) ───────────────────────

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a), y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] ?? 0) ^ (y[i % (y.length || 1)] ?? 0)
  return diff === 0
}

// ── read models ──────────────────────────────────────────────────────────────

export type ThreadStatus = 'open' | 'closed'
export type ThreadFilter = 'open' | 'closed' | 'all'

export interface ThreadSummary {
  id:                  string
  customerEmail:       string
  customerName:        string | null
  subject:             string
  orderNumber:         string | null
  status:              ThreadStatus
  source:              'email' | 'contact_form'
  unreadCount:         number
  lastMessageAt:       string
  lastMessageDirection: 'inbound' | 'outbound'
  preview:             string
  attachmentCount:     number
}

export interface SupportMessageView {
  id:                 string
  direction:          'inbound' | 'outbound'
  channel:            'email' | 'contact_form'
  fromEmail:          string
  fromName:           string | null
  toEmail:            string
  subject:            string
  bodyText:           string
  attachments:        AttachmentMeta[]
  importNote:         string | null
  actorEmail:         string | null
  occurredAt:         string
}

export interface ThreadDetail extends Omit<ThreadSummary, 'preview' | 'attachmentCount'> {
  createdAt: string
  messages:  SupportMessageView[]
}

export interface ListThreadsOptions {
  status?:     ThreadFilter
  unreadOnly?: boolean
  q?:          string
  limit?:      number
  cursor?:     string | null
}

export interface ListThreadsResult {
  threads:    ThreadSummary[]
  nextCursor: string | null
  counts:     { open: number; closed: number; unread: number }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))

function mapSummary(r: any): ThreadSummary {
  return {
    id: r.id, customerEmail: r.customer_email, customerName: r.customer_name ?? null,
    subject: r.subject, orderNumber: r.order_number ?? null, status: r.status, source: r.source,
    unreadCount: Number(r.unread_count), lastMessageAt: iso(r.last_message_at),
    lastMessageDirection: r.last_message_direction,
    preview: r.preview ?? '', attachmentCount: Number(r.attachment_count ?? 0),
  }
}

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify([ts, id]), 'utf8').toString('base64url')
}
export function decodeCursor(c: unknown): { ts: string; id: string } | null {
  if (typeof c !== 'string' || !c || c.length > 200) return null
  try {
    const [ts, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))
    if (typeof ts !== 'string' || !isUuid(id) || !/^[0-9T:.+\- Z]+$/.test(ts) || Number.isNaN(Date.parse(ts))) return null
    return { ts, id }
  } catch { return null }
}

/** Escape LIKE metacharacters so a search for "50%_" is literal. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, m => `\\${m}`)

/** "Re: <subject>" without doubling an existing prefix; '' subject gets a neutral outgoing subject. */
export function replySubject(threadSubject: string): string {
  const s = cleanSubject(threadSubject)
  if (!s) return 'Re: Your message to KVRN Support'
  // Capped to the stored limit so the subject that is SENT is exactly the subject that is SAVED.
  return truncateChars(/^\s*re(?:\[\d+\])?\s*:/i.test(s) ? s : `Re: ${s}`, SUPPORT_LIMITS.SUBJECT_CHARS)
}

// ── service ──────────────────────────────────────────────────────────────────

type Sql = NeonQueryFunction<false, false>

/** SQL raises 'KVRN_SUPPORT|CODE|detail'. */
function mapSqlError(err: unknown): SupportError {
  const msg = String((err as any)?.message ?? err)
  const m = msg.match(/KVRN_SUPPORT\|([A-Z_]+)\|/)
  if (m) {
    const code = m[1]
    if (code === 'THREAD_NOT_FOUND') return new SupportError('not_found', 'Thread not found.', 404)
    if (code === 'RECIPIENT_MISMATCH') return new SupportError('invalid_request', 'Recipient does not match the thread.', 400)
    return new SupportError('invalid_request', 'Request rejected.', 400)
  }
  return new SupportError('storage_error', 'Support storage error.', 500)
}

export interface SendReplyInput {
  threadId:        string
  body:            string
  clientRequestId: string
  actorEmail:      string
}

export interface SendReplyResult {
  threadId:                   string
  messageId:                  string
  providerMessageId:          string | null
  internetMessageIdCaptured:  boolean
  duplicate:                  boolean
}

export function createSupportService(sql: Sql, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  async function callJson(text: string, params: unknown[]): Promise<any> {
    try {
      const rows = (await (sql as any).query(text, params)) as any[]
      return rows[0]?.r
    } catch (err) { throw mapSqlError(err) }
  }

  return {
    /** Store an inbound email. Idempotent. */
    async ingestInboundEmail(input: InboundEmailInput) {
      const payload = {
        provider: 'cloudflare_email',
        dedupe_key: input.dedupeKey,
        internet_message_id: input.internetMessageId,
        in_reply_to_ids: input.inReplyToIds,
        reference_ids: input.referenceIds,
        in_reply_to: input.inReplyTo,
        references_header: input.referencesHeader,
        customer_email: input.customerEmail,
        customer_name: input.customerName,
        from_email: input.fromEmail,
        from_name: input.fromName,
        to_email: input.toEmail,
        subject: input.subject,
        subject_key: input.subjectKey,
        body_text: input.bodyText,
        attachments: input.attachments,
        import_note: input.importNote,
        occurred_at: input.occurredAt,
        force_new_thread: false,
      }
      const r = await callJson('SELECT support_ingest_message($1::jsonb) AS r', [JSON.stringify(payload)])
      return {
        duplicate: !!r.duplicate, threadId: r.thread_id as string, messageId: r.message_id as string,
        threadCreated: !!r.thread_created, matchedBy: r.matched_by as string,
      }
    },

    /** Store a storefront contact-form submission as an inbound message in its own NEW thread. */
    async recordContactSubmission(c: ContactInput) {
      const fullName = cleanLine(`${c.firstName} ${c.lastName}`, SUPPORT_LIMITS.NAME_CHARS)
      const payload = {
        provider: 'contact_form',
        dedupe_key: c.submissionId ? `cf:${c.submissionId}` : null,
        internet_message_id: null,
        in_reply_to_ids: [], reference_ids: [],
        customer_email: c.email,
        customer_name: fullName,
        from_email: c.email,
        from_name: fullName,
        to_email: SUPPORT_MAILBOX,
        subject: c.subject,
        subject_key: subjectKey(c.subject),
        body_text: c.message,
        attachments: [],
        order_number: c.orderNumber,
        occurred_at: null,
        force_new_thread: true,
      }
      const r = await callJson('SELECT support_ingest_message($1::jsonb) AS r', [JSON.stringify(payload)])
      return { duplicate: !!r.duplicate, threadId: r.thread_id as string, messageId: r.message_id as string }
    },

    /** Contact-form volume over the last hour (abuse guard). */
    async contactRate(email: string): Promise<{ perEmail: number; global: number }> {
      try {
        const rows = (await (sql as any).query(
          `SELECT count(*) FILTER (WHERE from_email = $1)::int AS per_email, count(*)::int AS total
             FROM support_messages
            WHERE provider = 'contact_form' AND created_at > NOW() - INTERVAL '1 hour'`, [email])) as any[]
        return { perEmail: Number(rows[0]?.per_email ?? 0), global: Number(rows[0]?.total ?? 0) }
      } catch (err) { throw mapSqlError(err) }
    },

    async listThreads(o: ListThreadsOptions = {}): Promise<ListThreadsResult> {
      const status: ThreadFilter = o.status === 'open' || o.status === 'closed' ? o.status : 'all'
      const limit = Math.min(Math.max(Math.floor(o.limit ?? SUPPORT_LIMITS.LIST_DEFAULT), 1), SUPPORT_LIMITS.LIST_MAX)
      const where: string[] = []
      const params: unknown[] = []
      const add = (v: unknown) => { params.push(v); return `$${params.length}` }

      if (status !== 'all') where.push(`t.status = ${add(status)}`)
      if (o.unreadOnly) where.push('t.unread_count > 0')
      const q = cleanLine(o.q ?? '', SUPPORT_LIMITS.SEARCH_CHARS)
      if (q) {
        const p = add(`%${escapeLike(q)}%`)
        where.push(`(t.customer_email ILIKE ${p} ESCAPE '\\' OR t.customer_name ILIKE ${p} ESCAPE '\\'
                     OR t.subject ILIKE ${p} ESCAPE '\\' OR t.order_number ILIKE ${p} ESCAPE '\\')`)
      }
      const cur = decodeCursor(o.cursor)
      if (o.cursor && !cur) throw new SupportError('invalid_request', 'Invalid cursor.', 400)
      if (cur) {
        const ts = add(cur.ts), id = add(cur.id)
        where.push(`(t.last_message_at, t.id) < (${ts}::timestamptz, ${id}::uuid)`)
      }
      const lim = add(limit + 1)
      try {
        const rows = (await (sql as any).query(
          `SELECT t.id, t.customer_email, t.customer_name, t.subject, t.order_number, t.status, t.source,
                  t.unread_count, t.last_message_at, t.last_message_at::text AS last_message_at_raw,
                  t.last_message_direction, lm.preview, lm.attachment_count
             FROM support_threads t
             LEFT JOIN LATERAL (
               SELECT left(regexp_replace(m.body_text, '\\s+', ' ', 'g'), 160) AS preview,
                      jsonb_array_length(m.attachment_metadata) AS attachment_count
                 FROM support_messages m
                WHERE m.thread_id = t.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) lm ON TRUE
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY t.last_message_at DESC, t.id DESC
            LIMIT ${lim}`, params)) as any[]
        const page = rows.slice(0, limit)
        const last = page[page.length - 1]
        const countRows = (await (sql as any).query(
          `SELECT count(*) FILTER (WHERE status = 'open')::int AS open_n,
                  count(*) FILTER (WHERE status = 'closed')::int AS closed_n,
                  count(*) FILTER (WHERE unread_count > 0)::int AS unread_n
             FROM support_threads`, [])) as any[]
        return {
          threads: page.map(mapSummary),
          nextCursor: rows.length > limit && last ? encodeCursor(last.last_message_at_raw, last.id) : null,
          counts: {
            open: Number(countRows[0]?.open_n ?? 0), closed: Number(countRows[0]?.closed_n ?? 0),
            unread: Number(countRows[0]?.unread_n ?? 0),
          },
        }
      } catch (err) {
        if (err instanceof SupportError) throw err
        throw mapSqlError(err)
      }
    },

    async getThread(id: string): Promise<ThreadDetail | null> {
      if (!isUuid(id)) return null
      try {
        const t = (await (sql as any).query(
          `SELECT id, customer_email, customer_name, subject, order_number, status, source, unread_count,
                  last_message_at, last_message_direction, created_at
             FROM support_threads WHERE id = $1`, [id])) as any[]
        if (!t[0]) return null
        const ms = (await (sql as any).query(
          `SELECT id, direction, channel, from_email, from_name, to_email, subject, body_text,
                  attachment_metadata, import_note, actor_email, occurred_at
             FROM support_messages WHERE thread_id = $1 ORDER BY created_at, id`, [id])) as any[]
        const r = t[0]
        return {
          id: r.id, customerEmail: r.customer_email, customerName: r.customer_name ?? null, subject: r.subject,
          orderNumber: r.order_number ?? null, status: r.status, source: r.source,
          unreadCount: Number(r.unread_count), lastMessageAt: iso(r.last_message_at),
          lastMessageDirection: r.last_message_direction, createdAt: iso(r.created_at),
          messages: ms.map((m): SupportMessageView => ({
            id: m.id, direction: m.direction, channel: m.channel, fromEmail: m.from_email, fromName: m.from_name ?? null,
            toEmail: m.to_email, subject: m.subject, bodyText: m.body_text,
            attachments: sanitizeAttachmentMetadata(m.attachment_metadata), importNote: m.import_note ?? null,
            actorEmail: m.actor_email ?? null, occurredAt: iso(m.occurred_at),
          })),
        }
      } catch (err) { throw mapSqlError(err) }
    },

    /**
     * Clear the unread counter. With `seenMessageId` only what the admin actually saw is cleared: inbound
     * messages that arrived after that message stay unread. Returns whether the thread exists.
     */
    async markRead(id: string, seenMessageId?: string | null): Promise<{ found: boolean; cleared: boolean }> {
      if (!isUuid(id)) return { found: false, cleared: false }
      if (seenMessageId != null && !isUuid(seenMessageId)) throw new SupportError('invalid_request', 'Invalid message id.', 400)
      const r = await callJson('SELECT support_mark_thread_read($1::uuid, $2::uuid) AS r', [id, seenMessageId ?? null])
      return { found: !!r.found, cleared: !!r.cleared }
    },

    async setStatus(id: string, status: ThreadStatus, actorEmail: string): Promise<{ changed: boolean; status: ThreadStatus }> {
      if (!isUuid(id)) throw new SupportError('not_found', 'Thread not found.', 404)
      if (status !== 'open' && status !== 'closed') throw new SupportError('invalid_request', 'Invalid status.', 400)
      const r = await callJson('SELECT support_set_thread_status($1::uuid, $2, $3) AS r', [id, status, actorEmail])
      return { changed: !!r.changed, status: r.status }
    },

    /**
     * Send an admin reply and record it.
     *
     * ORDER OF EVENTS: validate → provider send → (best-effort) read back the RFC Message-ID →
     * store. A message is stored ONLY after the provider accepted it, and a provider failure
     * stores nothing. A retry with the same clientRequestId never sends twice: the provider call
     * carries an Idempotency-Key and the stored row is keyed on the same request id.
     */
    async sendReply(input: SendReplyInput, mailer: SupportMailer): Promise<SendReplyResult> {
      if (!isUuid(input.threadId)) throw new SupportError('not_found', 'Thread not found.', 404)
      if (!isUuid(input.clientRequestId)) throw new SupportError('invalid_request', 'A request id is required.', 400)
      const body = cleanText(input.body).trim()
      if (!body) throw new SupportError('empty_body', 'Reply cannot be empty.', 400)
      if (body.length > SUPPORT_LIMITS.REPLY_BODY_CHARS) {
        throw new SupportError('body_too_long', `Reply is too long (max ${SUPPORT_LIMITS.REPLY_BODY_CHARS} characters).`, 400)
      }
      const actor = normalizeEmail(input.actorEmail)
      if (!actor) throw new SupportError('invalid_request', 'Missing admin identity.', 401)
      const requestId = input.clientRequestId.toLowerCase()
      const dedupeKey = `out:${requestId}`

      // Thread + recipient: the ONLY recipient is the thread's customer.
      let thread: any, parent: any, prior: any, newest: any
      try {
        const t = (await (sql as any).query(
          `SELECT id, customer_email, subject FROM support_threads WHERE id = $1`, [input.threadId])) as any[]
        thread = t[0]
        if (!thread) throw new SupportError('not_found', 'Thread not found.', 404)
        // A retried request that already completed is returned as-is: nothing is sent again.
        const d = (await (sql as any).query(
          `SELECT id, thread_id, provider_message_id, internet_message_id FROM support_messages WHERE dedupe_key = $1`,
          [dedupeKey])) as any[]
        prior = d[0]
        const pm = (await (sql as any).query(
          `SELECT internet_message_id, references_header FROM support_messages
            WHERE thread_id = $1 AND internet_message_id IS NOT NULL
            ORDER BY created_at DESC, id DESC LIMIT 1`, [input.threadId])) as any[]
        parent = pm[0]
        const nw = (await (sql as any).query(
          `SELECT id FROM support_messages WHERE thread_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [input.threadId])) as any[]
        newest = nw[0]
      } catch (err) {
        if (err instanceof SupportError) throw err
        throw mapSqlError(err)
      }
      if (prior) {
        if (prior.thread_id !== input.threadId) {
          throw new SupportError('duplicate_conflict', 'This request id was already used for another thread.', 409)
        }
        return {
          threadId: input.threadId, messageId: prior.id, providerMessageId: prior.provider_message_id ?? null,
          internetMessageIdCaptured: !!prior.internet_message_id, duplicate: true,
        }
      }
      const customer: string = thread.customer_email
      if (customer === SUPPORT_MAILBOX) {
        throw new SupportError('self_recipient', 'This thread is addressed to the support mailbox itself; not sending.', 422)
      }

      // Threading headers from the most recent stored Message-ID.
      let inReplyTo: string | null = null
      let references: string | null = null
      if (parent?.internet_message_id) {
        const chain = [...parseMessageIds(parent.references_header), parent.internet_message_id as string]
        const uniq = chain.filter((v, i) => chain.indexOf(v) === i).slice(-SUPPORT_LIMITS.REPLY_REFERENCES_MAX)
        inReplyTo = bracketId(parent.internet_message_id)
        references = uniq.map(bracketId).join(' ')
      }
      const subject = replySubject(thread.subject)

      const sent = await mailer.send({
        to: customer, subject, text: body, inReplyTo, references,
        idempotencyKey: `support-reply-${requestId}`,
      })
      if (!sent.ok) {
        throw new SupportError(sent.code === 'network' ? 'provider_error' : sent.code, sent.message,
          sent.code === 'not_configured' ? 503 : 502)
      }

      // Best effort: a failed read-back must never make a successful send look failed.
      let internetId: string | null = null
      try {
        for (let attempt = 0; attempt < 2 && !internetId; attempt++) {
          if (attempt > 0) await sleep(600)
          internetId = normalizeMessageId(await mailer.retrieveMessageId(sent.providerMessageId))
        }
      } catch { internetId = null }

      const record = JSON.stringify({
        thread_id: input.threadId, to_email: customer, provider_message_id: sent.providerMessageId,
        internet_message_id: internetId, dedupe_key: dedupeKey,
        in_reply_to: inReplyTo, references_header: references,
        from_email: SUPPORT_MAILBOX, from_name: SUPPORT_FROM_NAME,
        subject, body_text: body, actor_email: actor,
        // what the admin had on screen when the reply started: later inbound messages stay unread
        seen_through_message_id: newest?.id ?? null,
      })
      let stored: any
      for (let attempt = 0; attempt < 2 && !stored; attempt++) {
        try {
          const rows = (await (sql as any).query('SELECT support_record_outbound($1::jsonb) AS r', [record])) as any[]
          stored = rows[0]?.r
        } catch (err) {
          const mapped = mapSqlError(err)
          if (mapped.code !== 'storage_error') throw mapped    // a deterministic rejection will not heal on retry
          if (attempt === 1) {
            throw new SupportError('sent_not_recorded',
              'The email WAS sent, but KVRN could not save it to the thread. Do not send it again; retry the same request to record it.',
              502, { providerMessageId: sent.providerMessageId })
          }
        }
      }
      return {
        threadId: input.threadId, messageId: stored.message_id, providerMessageId: sent.providerMessageId,
        internetMessageIdCaptured: !!internetId, duplicate: !!stored.duplicate,
      }
    },
  }
}

export type SupportService = ReturnType<typeof createSupportService>
