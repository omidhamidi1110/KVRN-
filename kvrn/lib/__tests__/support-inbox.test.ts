// lib/__tests__/support-inbox.test.ts — Support inbox (migration 026): pure logic, source guards,
// the Email Worker handler and real MIME parsing. No database, no network.
//
//   PART A  normalization, thread-key rules, validation, HTML safety, attachment metadata
//   PART B  source guards (migration 026, wrangler/wrapper, UI safety, routes, secrets)
//   PART C  the Email Worker handler: forward / ingest / failure design / no PII in logs
//   PART D  real postal-mime parsing of a multipart message with an attachment
//
// DB-backed behaviour (idempotency, thread resolution, replies, routes) is in
// support-inbox-db.test.ts; admin-auth denial is in support-inbox-auth.test.ts.

import fs from 'fs'
import path from 'path'
import PostalMime from 'postal-mime'
import {
  SUPPORT_MAILBOX, SupportError, buildInboundEmailInput, cleanLine, cleanText, constantTimeEqual,
  decodeCursor, encodeCursor, escapeLike, htmlToText, normalizeEmail, normalizeMessageId,
  parseMessageIds, referenceCandidates, replySubject, sanitizeAttachmentMetadata, subjectKey,
  truncateChars, validateContactSubmission, SUPPORT_LIMITS,
} from '../support-inbox'
import {
  buildContactNotification, createResendSupportMailer, escapeHtml, sendContactNotification,
  SENDER_NOT_VERIFIED_MESSAGE, textToSafeHtml,
} from '../support-email'
import {
  handleSupportEmail, contentDigest, MAX_PARSE_BYTES, REJECT_MESSAGE, extractAddress, payloadFromParsed,
  type EmailMessageLike,
} from '../support-email-handler'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
// PART A — pure logic
// ─────────────────────────────────────────────────────────────────────────────
describe('A1. email normalization', () => {
  test.each([
    ['  Jane.Doe@Example.COM ', 'jane.doe@example.com'],
    ['<a@b.co>', 'a@b.co'],
    ['user+tag@gmail.com', 'user+tag@gmail.com'],          // plus-tags are NOT collapsed
    ['first.last@gmail.com', 'first.last@gmail.com'],      // dots are NOT collapsed
  ])('%j → %j', (raw, want) => expect(normalizeEmail(raw)).toBe(want))

  test.each([
    '', '   ', 'plain', 'a@b', 'a b@c.com', 'a@b.com, c@d.com', 'Name <a@b.com>', 'a@b.com;c@d.com',
    '<script>@x.com', 'a@@b.com', 'x'.repeat(250) + '@b.com', null, undefined, 42, {},
  ])('rejects %j', raw => expect(normalizeEmail(raw as any)).toBeNull())
})

describe('A2. subject normalization', () => {
  test.each([
    ['Re: Order question', 'order question'],
    ['RE: re: Re: Order question', 'order question'],
    ['Fwd: Fw: Order   question ', 'order question'],
    ['Aw: Bestellung', 'bestellung'],
    ['Re[2]: Hello', 'hello'],
    ['Re:Hello', 'hello'],
    ['Where is my order?', 'where is my order?'],
    ['Reorder request', 'reorder request'],              // "Re" without a colon is part of the word
    ['Resize: please', 'resize: please'],
  ])('%j → %j', (raw, want) => expect(subjectKey(raw)).toBe(want))

  test('empty / prefix-only subjects have an empty key (no fallback matching is attempted)', () => {
    expect(subjectKey('')).toBe('')
    expect(subjectKey('Re:')).toBe('')
    expect(subjectKey('   Fwd:   ')).toBe('')
    expect(subjectKey(undefined)).toBe('')
  })

  test('a header-injection attempt in a subject collapses to one line', () => {
    expect(cleanLine('Hi\r\nBcc: attacker@evil.com', 998)).toBe('Hi Bcc: attacker@evil.com')
  })

  test('replySubject never doubles Re: and never invents customer text', () => {
    expect(replySubject('Order question')).toBe('Re: Order question')
    expect(replySubject('Re: Order question')).toBe('Re: Order question')
    expect(replySubject('RE: x')).toBe('RE: x')
    expect(replySubject('')).toBe('Re: Your message to KVRN Support')
    expect(replySubject('Hi\r\nBcc: a@b.com')).toBe('Re: Hi Bcc: a@b.com')
    expect(replySubject('s'.repeat(998))).toHaveLength(998)          // sent subject == stored subject (<= 998)
    expect(replySubject('Re: ' + 's'.repeat(995))).toHaveLength(998)
  })
})

describe('A3. Message-ID handling', () => {
  test('normalizes to the lower-cased id without brackets', () => {
    expect(normalizeMessageId('<ABC.123@Mail.Example.com>')).toBe('abc.123@mail.example.com')
    expect(normalizeMessageId('  <a@b>  ')).toBe('a@b')
    expect(normalizeMessageId('')).toBeNull()
    expect(normalizeMessageId('<no-at-sign>')).toBeNull()
    expect(normalizeMessageId('<a@b> <c@d>')).toBe('a@b')                  // first token only
  })
  test('parseMessageIds reads every <id>, de-duplicated, in header order', () => {
    expect(parseMessageIds('<a@x> <b@x>\r\n <a@x>  <C@X>')).toEqual(['a@x', 'b@x', 'c@x'])
    expect(parseMessageIds('garbage')).toEqual([])
    expect(parseMessageIds(undefined)).toEqual([])
  })
  test('References candidates are most-recent-first and bounded', () => {
    expect(referenceCandidates('<a@x> <b@x> <c@x>')).toEqual(['c@x', 'b@x', 'a@x'])
    const many = Array.from({ length: 80 }, (_, i) => `<m${i}@x>`).join(' ')
    const c = referenceCandidates(many)
    expect(c).toHaveLength(SUPPORT_LIMITS.REFERENCE_IDS_MAX)
    expect(c[0]).toBe('m79@x')
  })
})

describe('A4. text safety and bounds', () => {
  test('NUL / C0 controls are stripped (PostgreSQL cannot store NUL), tab and newline kept', () => {
    expect(cleanText('a\u0000b\u0001c\td\r\ne')).toBe('abc\td\ne')
  })
  test('truncation never splits a surrogate pair', () => {
    const s = 'ab😀cd'                       // 😀 is 2 UTF-16 units at index 2..3
    expect(truncateChars(s, 3)).toBe('ab')
    expect(truncateChars(s, 4)).toBe('ab😀')
    expect(truncateChars('abc', 10)).toBe('abc')
  })
  test('htmlToText drops scripts/styles/tags and decodes entities; output is text', () => {
    const t = htmlToText('<style>p{}</style><p>Hello&nbsp;<b>world</b> &amp; &lt;team&gt;</p><script>alert(1)</script><br>Bye&#33; &#x41;')
    expect(t).toBe('Hello world & <team>\n\nBye! A')
    expect(htmlToText('<img src=x onerror=alert(1)>')).toBe('')
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toContain('• one')
    expect(htmlToText('&#0;&#xD800;&#99999999;')).toBe('')
  })
  test('htmlToText: literal "<" is text, markup noise is dropped, unclosed script swallows the rest', () => {
    expect(htmlToText('a < b and c > d')).toBe('a < b and c > d')
    expect(htmlToText('1 <3 2 &lt; 4')).toBe('1 <3 2 < 4')
    expect(htmlToText('<!DOCTYPE html><html><head><title>T</title></head><body>Hi</body></html>')).toBe('Hi')
    expect(htmlToText('before<script>never closed alert(1) after')).toBe('before')
    expect(htmlToText('<STYLE>p{}</STYLE>Up<BR>per')).toBe('Up\nper')
    expect(htmlToText('x<!-- hidden <b>comment</b> -->y')).toBe('xy')
  })
  test('htmlToText runs in LINEAR time on hostile input (CPU-DoS guard)', () => {
    const n = SUPPORT_LIMITS.INBOUND_HTML_CHARS
    const hostile: Record<string, string> = {
      lt:        '<'.repeat(n),
      ltSpace:   '< '.repeat(n / 2),
      li:        '<li '.repeat(n / 4),
      comment:   '<!--'.repeat(n / 4),
      script:    '<script>'.repeat(n / 8),
      scriptX:   '<script>x</script'.repeat(n / 17),
      nested:    '<a'.repeat(n / 2) + '>',
      spaces:    ' '.repeat(n) + 'x',
      amp:       '&#'.repeat(n / 2),
      oneBigTag: '<' + 'a'.repeat(n) + '>',
      oversize:  '<p>x</p>'.repeat(200_000),               // 1.6M chars: truncated before any scan
    }
    for (const [name, html] of Object.entries(hostile)) {
      const t0 = Date.now()
      htmlToText(html)
      expect([name, Date.now() - t0 < 1000]).toEqual([name, true])
    }
  })
  test('htmlToText reads at most INBOUND_HTML_CHARS of HTML', () => {
    const t = htmlToText('a'.repeat(SUPPORT_LIMITS.INBOUND_HTML_CHARS + 5000))
    expect(t).toHaveLength(SUPPORT_LIMITS.INBOUND_HTML_CHARS)
  })
  test('escapeLike makes search wildcards literal', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\')
  })
  test('cursor round-trips and rejects junk', () => {
    const id = '6f1c2a3e-1111-4222-8333-444455556666'
    const c = encodeCursor('2026-10-05 12:00:00.123456+00', id)
    expect(decodeCursor(c)).toEqual({ ts: '2026-10-05 12:00:00.123456+00', id })
    expect(decodeCursor('not-a-cursor')).toBeNull()
    expect(decodeCursor(Buffer.from(JSON.stringify(['x; DROP TABLE', id])).toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from(JSON.stringify(['2026-10-05', 'nope'])).toString('base64url'))).toBeNull()
    expect(decodeCursor(undefined)).toBeNull()
  })
  test('constantTimeEqual', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual('', 'x')).toBe(false)
  })
})

describe('A5. attachment metadata only', () => {
  test('keeps filename / mime / size / disposition; drops everything else, including content', () => {
    const out = sanitizeAttachmentMetadata([
      { filename: 'receipt.pdf', mimeType: 'Application/PDF', size: 1234.9, disposition: 'attachment',
        content: new Uint8Array([1, 2, 3]), contentBase64: 'AAAA', secret: 'x' },
      { filename: null, mimeType: '', size: -5, disposition: 'form-data' },
      'junk', null,
    ])
    expect(out).toEqual([
      { filename: 'receipt.pdf', mimeType: 'application/pdf', size: 1234, disposition: 'attachment' },
      { filename: null, mimeType: 'application/octet-stream', size: null, disposition: null },
    ])
    expect(JSON.stringify(out)).not.toMatch(/content|secret|AAAA/)
  })
  test('bounded', () => {
    expect(sanitizeAttachmentMetadata(Array.from({ length: 500 }, () => ({ mimeType: 'a/b' })))).toHaveLength(100)
    expect(sanitizeAttachmentMetadata('nope')).toEqual([])
  })
})

describe('A6. inbound payload validation (buildInboundEmailInput)', () => {
  const digest = 'a'.repeat(64)
  const base = (over: Record<string, unknown> = {}) => ({
    v: 1, envelopeFrom: 'bounce@mailer.example', envelopeTo: 'support@kvrn.shop', dedupeDigest: digest,
    subject: 'Re: Order question', messageId: '<M1@Mail.Example>', inReplyTo: '<p1@kvrn>', references: '<r1@x> <p1@kvrn>',
    date: 'Mon, 05 Oct 2026 10:00:00 +0000', fromEmail: 'Jane@Example.com', fromName: 'Jane Doe', text: 'Hello', ...over,
  })

  test('normalizes everything and builds the dedupe key from the Message-ID', () => {
    const i = buildInboundEmailInput(base())
    expect(i).toMatchObject({
      dedupeKey: 'mid:m1@mail.example', internetMessageId: 'm1@mail.example',
      customerEmail: 'jane@example.com', fromName: 'Jane Doe', toEmail: SUPPORT_MAILBOX,
      subject: 'Re: Order question', subjectKey: 'order question', bodyText: 'Hello',
      inReplyToIds: ['p1@kvrn'], referenceIds: ['p1@kvrn', 'r1@x'], occurredAt: '2026-10-05T10:00:00.000Z',
    })
  })
  test('no Message-ID → content-digest dedupe key; the Message-ID is NOT invented', () => {
    const i = buildInboundEmailInput(base({ messageId: undefined }))
    expect(i.internetMessageId).toBeNull()
    expect(i.dedupeKey).toBe(`sha256:${digest}`)
  })
  test('missing subject stays empty, missing/invalid date stays null', () => {
    const i = buildInboundEmailInput(base({ subject: undefined, date: 'not a date' }))
    expect(i.subject).toBe('')
    expect(i.subjectKey).toBe('')
    expect(i.occurredAt).toBeNull()
  })
  test('sender: From header wins; envelope sender is the fallback; neither → refused', () => {
    expect(buildInboundEmailInput(base({ fromEmail: undefined })).customerEmail).toBe('bounce@mailer.example')
    expect(() => buildInboundEmailInput(base({ fromEmail: 'garbage', envelopeFrom: '' }))).toThrow(SupportError)
  })
  test('only the support mailbox is accepted', () => {
    for (const to of ['orders@kvrn.shop', 'someone@example.com', '', undefined, 'support@kvrn.shop.evil.com']) {
      expect(() => buildInboundEmailInput(base({ envelopeTo: to }))).toThrow(/Not the support mailbox/)
    }
    expect(buildInboundEmailInput(base({ envelopeTo: 'Support@KVRN.shop' })).toEmail).toBe(SUPPORT_MAILBOX)
  })
  test('rejects bad version, bad digest, non-object', () => {
    expect(() => buildInboundEmailInput(base({ v: 2 }))).toThrow(SupportError)
    expect(() => buildInboundEmailInput(base({ dedupeDigest: 'short' }))).toThrow(SupportError)
    expect(() => buildInboundEmailInput(null)).toThrow(SupportError)
    expect(() => buildInboundEmailInput('x')).toThrow(SupportError)
  })
  test('HTML-only mail is reduced to text; raw HTML is never kept', () => {
    const i = buildInboundEmailInput(base({ text: '', html: '<p>Hi <b>there</b></p><script>x()</script>' }))
    expect(i.bodyText).toBe('Hi there')
    expect(JSON.stringify(i)).not.toMatch(/<p>|<script|<b>/)
  })
  test('oversize body is truncated with an explicit note (no silent loss)', () => {
    const i = buildInboundEmailInput(base({ text: 'x'.repeat(SUPPORT_LIMITS.INBOUND_BODY_CHARS + 500) }))
    expect(i.bodyText).toHaveLength(SUPPORT_LIMITS.INBOUND_BODY_CHARS)
    expect(i.importNote).toMatch(/truncated.*forwarded mailbox/i)
  })
  test('a Date header that Postgres cannot hold (or that is implausible) is dropped, never fatal', () => {
    for (const date of ['Fri, 01 Jan 20000 00:00:00 +0000', 'Mon, 01 Jan 1800 00:00:00 +0000', '2099-01-01T00:00:00Z', 'garbage', '']) {
      expect(buildInboundEmailInput(base({ date })).occurredAt).toBeNull()
    }
    expect(buildInboundEmailInput(base({ date: new Date(Date.now() - 3600_000).toISOString() })).occurredAt).not.toBeNull()
  })
  test('HTML-only body over the HTML cap is truncated with a note', () => {
    const i = buildInboundEmailInput(base({ text: '', html: '<p>' + 'y'.repeat(SUPPORT_LIMITS.INBOUND_HTML_CHARS + 10) + '</p>' }))
    expect(i.bodyText.length).toBeLessThanOrEqual(SUPPORT_LIMITS.INBOUND_HTML_CHARS)
    expect(i.importNote).toMatch(/HTML body truncated/)
  })
  test('attachments become metadata only', () => {
    const i = buildInboundEmailInput(base({ attachments: [{ filename: 'a.png', mimeType: 'image/png', size: 10, disposition: 'inline', content: 'AAAA' }] }))
    expect(i.attachments).toEqual([{ filename: 'a.png', mimeType: 'image/png', size: 10, disposition: 'inline' }])
  })
  test('NUL bytes and CRLF in fields cannot reach the database', () => {
    const i = buildInboundEmailInput(base({ text: 'a\u0000b', subject: 'x\r\ny', fromName: 'N\u0000ame' }))
    expect(i.bodyText).toBe('ab')
    expect(i.subject).toBe('x y')
    expect(i.fromName).toBe('N ame')
  })
})

describe('A7. contact-form validation', () => {
  const ok = { firstName: ' Ada ', lastName: 'Lovelace', email: 'Ada@Example.com', orderNumber: 'KVRN-001000', subject: 'Order enquiry', message: ' Hi\r\nthere ' }
  test('valid → normalized', () => {
    const v = validateContactSubmission(ok)
    expect(v).toEqual({ ok: true, value: {
      firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', orderNumber: 'KVRN-001000',
      subject: 'Order enquiry', message: 'Hi\nthere', submissionId: null } })
  })
  test.each([
    [{ ...ok, firstName: '' }], [{ ...ok, lastName: '  ' }], [{ ...ok, email: '' }], [{ ...ok, subject: '' }],
    [{ ...ok, message: '   ' }], [null], ['x'], [{}],
  ])('missing fields → refused: %j', body => expect(validateContactSubmission(body)).toMatchObject({ ok: false }))
  test('invalid email and loop address refused', () => {
    expect(validateContactSubmission({ ...ok, email: 'nope' })).toEqual({ ok: false, error: 'Invalid email address.' })
    expect(validateContactSubmission({ ...ok, email: 'support@kvrn.shop' })).toEqual({ ok: false, error: 'Invalid email address.' })
  })
  test('over-long message refused; optional order number may be absent; submissionId must be a UUID', () => {
    expect(validateContactSubmission({ ...ok, message: 'x'.repeat(SUPPORT_LIMITS.CONTACT_MESSAGE_CHARS + 1) })).toMatchObject({ ok: false })
    expect(validateContactSubmission({ ...ok, orderNumber: undefined })).toMatchObject({ ok: true, value: { orderNumber: null } })
    const id = '6f1c2a3e-1111-4222-8333-444455556666'
    expect(validateContactSubmission({ ...ok, submissionId: id.toUpperCase() })).toMatchObject({ value: { submissionId: id } })
    expect(validateContactSubmission({ ...ok, submissionId: 'abc' })).toMatchObject({ value: { submissionId: null } })
  })
})

describe('A8. HTML injection: user content is escaped before it enters any email HTML', () => {
  const evil = { firstName: '<img src=x onerror=alert(1)>', lastName: '"><script>x()</script>', email: 'a@b.co',
                 orderNumber: '<b>1</b>', subject: 'Hi <u>there</u>', message: 'line1\n<script>alert(1)</script> & more' }
  test('buildContactNotification escapes every customer-supplied field', () => {
    const n = buildContactNotification(evil)
    expect(n.html).not.toMatch(/<script|<img|<u>|<b>1/)
    expect(n.html).toContain('&lt;script&gt;')
    expect(n.html).toContain('line1<br>')
    expect(n.subject).not.toMatch(/[\r\n]/)
  })
  test('textToSafeHtml / escapeHtml', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
    expect(textToSafeHtml('<b>x</b>\ny')).not.toMatch(/<b>/)
  })
})

describe('A9. owner notification is fail-open and configuration-driven', () => {
  const c = { firstName: 'A', lastName: 'B', email: 'a@b.co', orderNumber: null, subject: 'S', message: 'M' }
  test('no destination → skipped (no network call); no key → skipped', async () => {
    const f = jest.fn()
    expect(await sendContactNotification(c, { fetchImpl: f as any, forwardTo: '', apiKey: 'k' })).toBe('skipped_no_destination')
    expect(await sendContactNotification(c, { fetchImpl: f as any, forwardTo: 'not-an-email', apiKey: 'k' })).toBe('skipped_no_destination')
    expect(await sendContactNotification(c, { fetchImpl: f as any, forwardTo: 'owner@example.com', apiKey: '' })).toBe('skipped_no_key')
    expect(f).not.toHaveBeenCalled()
  })
  test('sent to the configured destination only; provider failure or throw never propagates', async () => {
    const f = jest.fn(async () => ({ ok: true }) as any)
    expect(await sendContactNotification(c, { fetchImpl: f as any, forwardTo: 'Owner@Example.com', apiKey: 'k' })).toBe('sent')
    const sent = JSON.parse((f.mock.calls[0] as any)[1].body)
    expect(sent.to).toEqual(['owner@example.com'])
    expect(sent.reply_to).toBe('a@b.co')
    expect(await sendContactNotification(c, { fetchImpl: (async () => ({ ok: false })) as any, forwardTo: 'o@e.co', apiKey: 'k' })).toBe('failed')
    expect(await sendContactNotification(c, { fetchImpl: (async () => { throw new Error('net') }) as any, forwardTo: 'o@e.co', apiKey: 'k' })).toBe('failed')
  })
})

describe('A10. Resend support mailer', () => {
  const msg = { to: 'cust@example.com', subject: 'Re: Hi', text: 'Hello <b>', inReplyTo: '<p@x>', references: '<a@x> <p@x>', idempotencyKey: 'support-reply-1' }
  const resp = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json }) as any

  test('sends FROM support@kvrn.shop with Reply-To, threading headers, text + escaped html, idempotency key', async () => {
    const f = jest.fn(async () => resp(200, { id: 're_123' }))
    const out = await createResendSupportMailer('key', { fetchImpl: f as any }).send(msg)
    expect(out).toEqual({ ok: true, providerMessageId: 're_123' })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer key', 'Idempotency-Key': 'support-reply-1' })
    const b = JSON.parse(init.body)
    expect(b).toMatchObject({
      from: 'KVRN Support <support@kvrn.shop>', reply_to: 'support@kvrn.shop', to: ['cust@example.com'],
      subject: 'Re: Hi', text: 'Hello <b>', headers: { 'In-Reply-To': '<p@x>', References: '<a@x> <p@x>' },
    })
    expect(b.html).toContain('Hello &lt;b&gt;')
    expect(b.html).not.toContain('<b>')
  })
  test('no parent → no threading headers', async () => {
    const f = jest.fn(async () => resp(200, { id: 're_1' }))
    await createResendSupportMailer('k', { fetchImpl: f as any }).send({ ...msg, inReplyTo: null, references: null })
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).headers).toBeUndefined()
  })
  test('unverified sender → a specific, actionable failure (never a silent fallback sender)', async () => {
    const f = jest.fn(async () => resp(403, { name: 'validation_error', message: 'The kvrn.shop domain is not verified.' }))
    const out = await createResendSupportMailer('k', { fetchImpl: f as any }).send(msg)
    expect(out).toEqual({ ok: false, code: 'sender_not_verified', message: SENDER_NOT_VERIFIED_MESSAGE })
    expect(f).toHaveBeenCalledTimes(1)
    expect(SENDER_NOT_VERIFIED_MESSAGE).toMatch(/verify the kvrn\.shop domain/)
  })
  test('other failures: bad key, 5xx, network, unreadable body, missing id — never ok', async () => {
    const mk = (f: any) => createResendSupportMailer('k', { fetchImpl: f }).send(msg)
    expect(await mk(async () => resp(401, { message: 'API key is invalid' }))).toMatchObject({ ok: false, code: 'provider_error' })
    expect(await mk(async () => resp(500, {}))).toMatchObject({ ok: false, code: 'provider_error' })
    expect(await mk(async () => { throw new Error('boom') })).toMatchObject({ ok: false, code: 'network' })
    expect(await mk(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad') } }))).toMatchObject({ ok: false })
    expect(await mk(async () => resp(200, {}))).toMatchObject({ ok: false, code: 'provider_error' })
  })
  test('retrieveMessageId returns the RFC Message-ID or null, never throws', async () => {
    const m = (f: any) => createResendSupportMailer('k', { fetchImpl: f })
    expect(await m(async () => resp(200, { message_id: '<abc@email.amazonses.com>' })).retrieveMessageId('re_1')).toBe('<abc@email.amazonses.com>')
    expect(await m(async () => resp(404, {})).retrieveMessageId('re_1')).toBeNull()
    expect(await m(async () => resp(200, {})).retrieveMessageId('re_1')).toBeNull()
    expect(await m(async () => { throw new Error('x') }).retrieveMessageId('re_1')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PART B — source guards
// ─────────────────────────────────────────────────────────────────────────────
describe('B. source guards', () => {
  const mig = read('db/migrations/026_support_inbox.sql')
  const migFiles = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => /^\d+_/.test(f)).sort()

  test('026 is the next migration after 025 and is named as specified', () => {
    const i = migFiles.indexOf('026_support_inbox.sql')
    expect(i).toBeGreaterThan(0)
    expect(migFiles[i - 1]).toBe('025_preshipment_refund_cancellation.sql')
  })
  test('026 is transactional and idempotent', () => {
    expect(mig).toMatch(/^BEGIN;/m)
    expect(mig).toMatch(/^COMMIT;/m)
    for (const m of mig.matchAll(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/g)) throw new Error('non-idempotent index: ' + m[0])
    for (const m of mig.matchAll(/CREATE TABLE (?!IF NOT EXISTS)/g)) throw new Error('non-idempotent table: ' + m[0])
    expect(mig).not.toMatch(/\bCREATE FUNCTION\b/)       // CREATE OR REPLACE only
  })
  test('026 touches no pre-existing table except an INSERT into admin_audit_logs', () => {
    expect(mig).not.toMatch(/\b(?:ALTER|DROP)\s+TABLE\b/i)
    expect(mig).not.toMatch(/\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(?:orders|order_|payments|product_|inventory_|refund|stripe_)/i)
    expect(mig).toMatch(/INSERT INTO admin_audit_logs/)
  })
  test('026 data model: tables, constraints, uniqueness, immutability', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS support_threads/)
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS support_messages/)
    expect(mig).toMatch(/thread_id\s+UUID\s+NOT NULL REFERENCES support_threads\(id\) ON DELETE RESTRICT/)
    expect(mig).toMatch(/UNIQUE INDEX IF NOT EXISTS sm_internet_message_id_uq[\s\S]*WHERE internet_message_id IS NOT NULL/)
    expect(mig).toMatch(/UNIQUE INDEX IF NOT EXISTS sm_provider_message_id_uq/)
    expect(mig).toMatch(/UNIQUE INDEX IF NOT EXISTS sm_dedupe_key_uq/)
    expect(mig).toMatch(/BEFORE UPDATE OR DELETE ON support_messages/)
    expect(mig).toMatch(/BEFORE TRUNCATE ON support_messages/)
    expect(mig).toMatch(/attachment_metadata\s+JSONB\s+NOT NULL DEFAULT '\[\]'/)
    expect(mig).not.toMatch(/\bBYTEA\b/i)                // attachment binary is never stored
    expect(mig).toMatch(/unread_count\s+INTEGER\s+NOT NULL DEFAULT 0/)
    expect(mig).toMatch(/unread_count >= 0/)
    expect(mig.replace(/--.*$/gm, '')).not.toMatch(/password|secret|api_key|token/i)   // no credential columns
  })
  test('audit payloads carry no body and no customer address', () => {
    const audits = [...mig.matchAll(/INSERT INTO admin_audit_logs[\s\S]*?\);/g)].map(m => m[0])
    expect(audits.length).toBe(2)
    for (const a of audits) {
      // body_text may appear ONLY as a character count; the customer address and subject never appear
      expect(a.replace(/char_length\(p->>'body_text'\)/g, '')).not.toMatch(/body_text|customer_email|to_email|subject/)
    }
  })

  test('migrations 001-025 are untouched: this batch adds only 026', () => {
    expect(migFiles.filter(f => Number(f.slice(0, 3)) > 25)).toEqual(['026_support_inbox.sql'])
  })

  test('wrapper keeps fetch + scheduled and adds email()', () => {
    const w = read('cloudflare-cron-wrapper.js')
    expect(w).toMatch(/fetch:\s*openNextWorker\.fetch/)
    expect(w).toMatch(/async scheduled\(event, env, ctx\)/)
    expect(w).toMatch(/async email\(message, env, ctx\)/)
    expect(w).toMatch(/handleSupportEmail\(message, env/)
    expect(w).toMatch(/ingest: \(req\) => openNextWorker\.fetch\(req, env, ctx\)/)
    expect(w).not.toMatch(/fetch\(\s*['"`]https?:\/\/(?:www\.)?kvrn\.shop/)    // no public self-fetch
    // cron behaviour unchanged
    for (const p of ['transactional-email-retry', 'marketing-sync', 'stripe-fee-reconcile']) expect(w).toContain(p)
  })
  test('the private forwarding destination and secrets are NOT hardcoded anywhere in source', () => {
    const files = ['cloudflare-cron-wrapper.js', 'wrangler.toml', 'lib/support-inbox.ts', 'lib/support-email.ts',
      'lib/support-email-handler.ts', 'app/api/contact/route.ts', 'app/api/internal/support-email-ingest/route.ts',
      'app/admin/support/SupportInboxClient.tsx', 'db/migrations/026_support_inbox.sql', '.env.example']
    for (const f of files) {
      const t = read(f)
      expect(t).not.toMatch(/thekvrn@gmail\.com/i)
      expect(t).not.toMatch(/@gmail\.com/i)
      expect(t).not.toMatch(/\bre_[A-Za-z0-9]{20,}/)           // Resend key shape
    }
    expect(read('lib/support-email-handler.ts')).toMatch(/env\.SUPPORT_FORWARD_TO/)
  })
  test('wrangler.toml documents the new runtime config without values', () => {
    const t = read('wrangler.toml')
    expect(t).toMatch(/SUPPORT_FORWARD_TO/)
    expect(t).toMatch(/SUPPORT_EMAIL_INGEST_SECRET/)
    expect(t).not.toMatch(/^\s*SUPPORT_EMAIL_INGEST_SECRET\s*=/m)
    expect(t).not.toMatch(/^\s*SUPPORT_FORWARD_TO\s*=/m)
  })
  test('.env.example lists the new names with empty values', () => {
    const t = read('.env.example')
    expect(t).toMatch(/^SUPPORT_EMAIL_INGEST_SECRET=$/m)
    expect(t).toMatch(/^SUPPORT_FORWARD_TO=$/m)
  })

  test('admin support routes all use requireAdmin; the ingest route does not', () => {
    const admin = ['threads/route.ts', 'threads/[id]/route.ts', 'threads/[id]/read/route.ts',
      'threads/[id]/status/route.ts', 'threads/[id]/reply/route.ts']
    for (const r of admin) {
      const t = read(`app/api/admin/support/${r}`)
      expect(t).toMatch(/import \{ requireAdmin \} from '@\/lib\/admin-auth'/)
      expect(t).toMatch(/await requireAdmin\(req\)/)
      // auth runs before anything else touches the request body or the database
      expect(t.indexOf('requireAdmin(req)')).toBeLessThan(t.search(/req\.json\(\)|createSupportService\(/))
    }
    const ing = read('app/api/internal/support-email-ingest/route.ts')
    expect(ing).not.toMatch(/requireAdmin/)
    expect(ing).toMatch(/SUPPORT_EMAIL_INGEST_SECRET/)
    expect(ing).toMatch(/constantTimeEqual/)
    expect(ing).toMatch(/export async function POST/)
    expect(ing).not.toMatch(/export async function (?:GET|PUT|PATCH|DELETE)/)
  })
  test('no support file logs addresses, subjects or bodies', () => {
    // Static text is fine; the dynamic arguments of every console call must not be message data.
    const dynamic = (line: string) => line
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")                                  // drop '…' literals
      .replace(/`[^`]*`/g, m => [...m.matchAll(/\$\{([^}]*)\}/g)].map(x => x[1]).join(' '))   // keep ${…} of templates
    for (const f of ['lib/support-inbox.ts', 'lib/support-email.ts', 'lib/support-email-handler.ts',
      'app/api/contact/route.ts', 'app/api/internal/support-email-ingest/route.ts',
      'app/api/admin/support/threads/route.ts', 'app/api/admin/support/threads/[id]/route.ts',
      'app/api/admin/support/threads/[id]/read/route.ts', 'app/api/admin/support/threads/[id]/status/route.ts',
      'app/api/admin/support/threads/[id]/reply/route.ts']) {
      for (const line of read(f).split('\n').filter(l => /console\.(log|error|warn|info)\(/.test(l))) {
        expect(dynamic(line)).not.toMatch(/\b(email|body|subject|payload|input|raw|req|text|html|to|from|customer\w*|secret|message|msg|c)\b\s*[.,)\]}]/)
      }
    }
  })
  test('the Support UI renders plain text only', () => {
    const ui = read('app/admin/support/SupportInboxClient.tsx')
    expect(ui).not.toMatch(/dangerouslySetInnerHTML/)
    expect(ui).not.toMatch(/innerHTML/)
    expect(ui).toMatch(/whitespace-pre-wrap/)
    expect(ui).toMatch(/in the forwarded mailbox/)
    expect(ui).toMatch(/support@kvrn\.shop/)
    expect(ui).toMatch(/sendingRef\.current/)          // double-submit guard
    expect(ui).toMatch(/Mark closed/)
    expect(ui).toMatch(/Reopen/)
  })
  test('AdminShell links to /admin/support', () => {
    const t = read('components/admin/AdminShell.tsx')
    expect(t).toMatch(/label: 'Support',\s*href: '\/admin\/support'/)
  })
  test('contact route: no TODO stub, persists before succeeding, never returns the forward address', () => {
    const t = read('app/api/contact/route.ts')
    expect(t).not.toMatch(/TODO/)
    expect(t.indexOf('recordContactSubmission')).toBeLessThan(t.indexOf("success: true"))
    expect(t).not.toMatch(/process\.env\.SUPPORT_FORWARD_TO/)   // read inside lib/support-email only
    expect(t).toMatch(/success: false[\s\S]*status: 500/)
  })
  test('package.json and package-lock.json agree on postal-mime', () => {
    const pkg = JSON.parse(read('package.json'))
    const lock = JSON.parse(read('package-lock.json'))
    expect(pkg.dependencies['postal-mime']).toMatch(/^\^4\./)
    expect(lock.packages[''].dependencies['postal-mime']).toBe(pkg.dependencies['postal-mime'])
    expect(lock.packages['node_modules/postal-mime'].version).toMatch(/^4\./)
  })
  test('financial / checkout / SMS / GA4 code is not touched by the support modules', () => {
    for (const f of ['lib/support-inbox.ts', 'lib/support-email.ts', 'lib/support-email-handler.ts']) {
      expect(read(f)).not.toMatch(/from '(?:\.\/|@\/lib\/)(?:financ|checkout|inventory|returns|admin-orders|stripe|twilio|sms|ga4)/i)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PART C — the Email Worker handler
// ─────────────────────────────────────────────────────────────────────────────
interface Fake {
  m: EmailMessageLike
  forwards: { to: string; headers?: Headers }[]
  rejects: string[]
  rawRead: () => boolean
}

function fakeMessage(rawText: string, over: { to?: string; from?: string; rawSize?: number; forwardThrows?: boolean; headers?: Record<string, string>; rawThrows?: boolean } = {}): Fake {
  const bytes = new TextEncoder().encode(rawText)
  const forwards: Fake['forwards'] = []
  const rejects: string[] = []
  let read = false
  const raw = over.rawThrows
    ? new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('stream broke')) } })
    : new ReadableStream<Uint8Array>({ pull(c) { read = true; c.enqueue(bytes); c.close() } }, { highWaterMark: 0 })
  const m: EmailMessageLike = {
    from: over.from ?? 'bounce@mailer.example',
    to: over.to ?? 'support@kvrn.shop',
    headers: new Headers(over.headers ?? { subject: 'Hello', 'message-id': '<hdr1@x>', from: 'Jane <jane@example.com>' }),
    raw, rawSize: over.rawSize ?? bytes.length,
    async forward(to, headers) { if (over.forwardThrows) throw new Error('forward failed'); forwards.push({ to, headers }); return {} },
    setReject(r) { rejects.push(r) },
  }
  return { m, forwards, rejects, rawRead: () => read }
}

const SIMPLE_MIME = [
  'From: Jane Doe <jane@example.com>', 'To: support@kvrn.shop', 'Subject: Order question',
  'Message-ID: <abc123@mail.example.com>', 'Date: Mon, 05 Oct 2026 10:00:00 +0000',
  'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Where is my order?', '',
].join('\r\n')

function mkDeps(over: Partial<{ ingestStatus: number | (() => number); ingestThrows: boolean; parse: any }> = {}) {
  const logs: string[] = []
  const ingestCalls: { url: string; auth: string | null; body: any }[] = []
  let n = 0
  return {
    logs, ingestCalls,
    deps: {
      parseMime: over.parse ?? ((raw: ArrayBuffer) => PostalMime.parse(raw) as any),
      async ingest(req: Request) {
        n++
        ingestCalls.push({ url: req.url, auth: req.headers.get('authorization'), body: JSON.parse(await req.text()) })
        if (over.ingestThrows) throw new Error('worker down')
        const st = typeof over.ingestStatus === 'function' ? over.ingestStatus() : (over.ingestStatus ?? 200)
        return new Response('{}', { status: st })
      },
      log: { info: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
    },
    calls: () => n,
  }
}
const ENV = { SUPPORT_FORWARD_TO: 'owner-private@example.org', SUPPORT_EMAIL_INGEST_SECRET: 'sekret-value' }

describe('C. Email Worker handler', () => {
  test('forwards the FULL original message AND stores a database copy', async () => {
    const f = fakeMessage(SIMPLE_MIME); const d = mkDeps()
    const out = await handleSupportEmail(f.m, ENV, d.deps)
    expect(out).toEqual({ outcome: 'handled', forwarded: true, ingested: true })
    expect(f.forwards).toHaveLength(1)
    expect(f.forwards[0].to).toBe('owner-private@example.org')
    expect([...f.forwards[0].headers!.keys()].every(k => k.startsWith('x-'))).toBe(true)   // Cloudflare drops non-X- headers
    expect(f.rejects).toEqual([])
    const call = d.ingestCalls[0]
    expect(call.url).toBe('https://internal/api/internal/support-email-ingest')
    expect(call.auth).toBe('Bearer sekret-value')
    expect(call.body).toMatchObject({
      v: 1, envelopeTo: 'support@kvrn.shop', fromEmail: 'jane@example.com', fromName: 'Jane Doe',
      subject: 'Order question', messageId: '<abc123@mail.example.com>', text: 'Where is my order?\n',
    })
    expect(call.body.dedupeDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the forward destination comes from runtime config only', async () => {
    const f = fakeMessage(SIMPLE_MIME); const d = mkDeps()
    await handleSupportEmail(f.m, { ...ENV, SUPPORT_FORWARD_TO: 'someone-else@example.net' }, d.deps)
    expect(f.forwards[0].to).toBe('someone-else@example.net')
  })

  test('forward ok + ingest failing (500s, retried once) → still handled: the email is safe in the owner mailbox', async () => {
    const f = fakeMessage(SIMPLE_MIME); const d = mkDeps({ ingestStatus: 500 })
    const out = await handleSupportEmail(f.m, ENV, d.deps)
    expect(out).toEqual({ outcome: 'handled', forwarded: true, ingested: false })
    expect(d.calls()).toBe(2)
    expect(f.rejects).toEqual([])
  })
  test('ingest transient failure then success → ingested (retry is safe because ingest is idempotent)', async () => {
    const f = fakeMessage(SIMPLE_MIME); let k = 0
    const d = mkDeps({ ingestStatus: () => (k++ === 0 ? 503 : 200) })
    expect(await handleSupportEmail(f.m, ENV, d.deps)).toMatchObject({ forwarded: true, ingested: true })
    expect(d.calls()).toBe(2)
  })
  test('a 4xx from ingest is not retried', async () => {
    const f = fakeMessage(SIMPLE_MIME); const d = mkDeps({ ingestStatus: 422 })
    expect(await handleSupportEmail(f.m, ENV, d.deps)).toMatchObject({ outcome: 'handled', forwarded: true, ingested: false })
    expect(d.calls()).toBe(1)
  })
  test('forward failing + ingest ok → handled: the email is safe in Admin → Support', async () => {
    const f = fakeMessage(SIMPLE_MIME, { forwardThrows: true }); const d = mkDeps()
    expect(await handleSupportEmail(f.m, ENV, d.deps)).toEqual({ outcome: 'handled', forwarded: false, ingested: true })
    expect(f.rejects).toEqual([])
  })
  test('BOTH failing → the sender is told (permanent reject), never a silent success', async () => {
    const f = fakeMessage(SIMPLE_MIME, { forwardThrows: true }); const d = mkDeps({ ingestThrows: true })
    const out = await handleSupportEmail(f.m, ENV, d.deps)
    expect(out).toEqual({ outcome: 'rejected', forwarded: false, ingested: false })
    expect(f.rejects).toEqual([REJECT_MESSAGE])
    expect(REJECT_MESSAGE).not.toMatch(/owner|gmail|SUPPORT_FORWARD/i)
  })
  test('SUPPORT_FORWARD_TO unset → no forward attempted; database copy still stored', async () => {
    const f = fakeMessage(SIMPLE_MIME); const d = mkDeps()
    const out = await handleSupportEmail(f.m, { SUPPORT_EMAIL_INGEST_SECRET: 's' }, d.deps)
    expect(out).toEqual({ outcome: 'handled', forwarded: false, ingested: true })
    expect(f.forwards).toHaveLength(0)
  })
  test('ingest secret unset → no request is made (fails closed); forward still happens', async () => {
    const f = fakeMessage(SIMPLE_MIME); const d = mkDeps()
    const out = await handleSupportEmail(f.m, { SUPPORT_FORWARD_TO: 'o@e.co' }, d.deps)
    expect(out).toEqual({ outcome: 'handled', forwarded: true, ingested: false })
    expect(d.calls()).toBe(0)
  })
  test('nothing configured at all → rejected rather than silently dropped', async () => {
    const f = fakeMessage(SIMPLE_MIME); const d = mkDeps()
    expect(await handleSupportEmail(f.m, {}, d.deps)).toMatchObject({ outcome: 'rejected' })
    expect(f.rejects).toHaveLength(1)
  })
  test('MIME parse failure does not block forwarding; a headers-only copy is stored with a note', async () => {
    const f = fakeMessage(SIMPLE_MIME); const d = mkDeps({ parse: async () => { throw new Error('bad mime') } })
    const out = await handleSupportEmail(f.m, ENV, d.deps)
    expect(out).toEqual({ outcome: 'handled', forwarded: true, ingested: true })
    expect(f.forwards).toHaveLength(1)
    const b = d.ingestCalls[0].body
    expect(b.importNote).toMatch(/could not be parsed.*forwarded mailbox/i)
    expect(b).toMatchObject({ subject: 'Hello', messageId: '<hdr1@x>', fromEmail: 'jane@example.com', fromName: 'Jane' })
    expect(b.text).toBeUndefined()
    expect(b.dedupeDigest).toMatch(/^[0-9a-f]{64}$/)
  })
  test('oversize message: raw is NOT read, forwarding still happens, a headers-only stub is stored', async () => {
    const f = fakeMessage(SIMPLE_MIME, { rawSize: MAX_PARSE_BYTES + 1 }); const d = mkDeps()
    const out = await handleSupportEmail(f.m, ENV, d.deps)
    expect(out).toEqual({ outcome: 'handled', forwarded: true, ingested: true })
    expect(f.rawRead()).toBe(false)
    expect(d.ingestCalls[0].body.importNote).toMatch(/too large to import/i)
  })
  test('unreadable raw stream: forward still happens, headers-only copy stored', async () => {
    const f = fakeMessage(SIMPLE_MIME, { rawThrows: true }); const d = mkDeps()
    expect(await handleSupportEmail(f.m, ENV, d.deps)).toEqual({ outcome: 'handled', forwarded: true, ingested: true })
    expect(d.ingestCalls[0].body.importNote).toMatch(/could not be read/i)
  })
  test('only support@kvrn.shop is a support inbox: any other recipient is refused, not forwarded or stored', async () => {
    for (const to of ['orders@kvrn.shop', 'random@kvrn.shop', 'support@kvrn.shop.evil.test']) {
      const f = fakeMessage(SIMPLE_MIME, { to }); const d = mkDeps()
      expect(await handleSupportEmail(f.m, ENV, d.deps)).toEqual({ outcome: 'ignored_recipient', forwarded: false, ingested: false })
      expect(f.forwards).toHaveLength(0)
      expect(d.calls()).toBe(0)
      expect(f.rejects).toEqual(['Unknown recipient.'])
    }
    // case-insensitive match on the real mailbox
    const f = fakeMessage(SIMPLE_MIME, { to: 'Support@KVRN.shop' }); const d = mkDeps()
    expect(await handleSupportEmail(f.m, ENV, d.deps)).toMatchObject({ outcome: 'handled' })
  })
  test('logs carry outcome codes only: no address, subject, body or secret', async () => {
    const scenarios = [
      () => ({ f: fakeMessage(SIMPLE_MIME), d: mkDeps() }),
      () => ({ f: fakeMessage(SIMPLE_MIME, { forwardThrows: true }), d: mkDeps({ ingestThrows: true }) }),
      () => ({ f: fakeMessage(SIMPLE_MIME), d: mkDeps({ ingestStatus: 500 }) }),
      () => ({ f: fakeMessage(SIMPLE_MIME), d: mkDeps({ parse: async () => { throw new Error('jane@example.com leaked') } }) }),
      () => ({ f: fakeMessage(SIMPLE_MIME, { to: 'other@kvrn.shop' }), d: mkDeps() }),
    ]
    for (const mk of scenarios) {
      const { f, d } = mk()
      await handleSupportEmail(f.m, ENV, d.deps)
      const all = d.logs.join('\n')
      expect(all).not.toMatch(/jane|example\.com|example\.org|owner-private|Order question|Where is my order|sekret|support@kvrn\.shop|other@/i)
    }
  })
  test('an unsupported attachment never causes a rejection', async () => {
    const mime = [
      'From: a@b.co', 'To: support@kvrn.shop', 'Subject: files', 'Message-ID: <att1@x>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'see attached', '--B',
      'Content-Type: application/x-weird-binary; name="blob.xyz"', 'Content-Disposition: attachment; filename="blob.xyz"',
      'Content-Transfer-Encoding: base64', '', 'AAECAwQFBgcICQ==', '--B--', '',
    ].join('\r\n')
    const f = fakeMessage(mime); const d = mkDeps()
    expect(await handleSupportEmail(f.m, ENV, d.deps)).toMatchObject({ outcome: 'handled', forwarded: true, ingested: true })
    expect(d.ingestCalls[0].body.attachments).toEqual([{ filename: 'blob.xyz', mimeType: 'application/x-weird-binary', disposition: 'attachment', size: 10 }])
  })
  test('extractAddress', () => {
    expect(extractAddress('"Jane D" <j@x.co>')).toEqual({ name: 'Jane D', address: 'j@x.co' })
    expect(extractAddress('j@x.co')).toEqual({ name: '', address: 'j@x.co' })
    expect(extractAddress(null)).toEqual({ name: '', address: '' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PART D — real MIME through postal-mime into the validated input
// ─────────────────────────────────────────────────────────────────────────────
describe('D. real MIME parsing → inbound input', () => {
  const PDF_B64 = Buffer.from('%PDF-1.4 fake pdf content that must never be stored').toString('base64')
  const mime = [
    'From: "Jane Doe" <Jane@Example.com>', 'To: KVRN Support <support@kvrn.shop>',
    'Subject: =?UTF-8?B?UmU6IEJlc3RlbGx1bmcg4oCTIGRhbmtl?=',
    'Message-ID: <Reply-1@Mail.Example.com>', 'In-Reply-To: <out-1@email.amazonses.com>',
    'References: <first@x> <out-1@email.amazonses.com>', 'Date: Mon, 05 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="OUTER"', '',
    '--OUTER', 'Content-Type: multipart/alternative; boundary="ALT"', '',
    '--ALT', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'Gr=C3=BC=C3=9Fe, thanks!', '--ALT', 'Content-Type: text/html; charset=utf-8', '',
    '<p>Gr&uuml;&szlig;e, <script>alert(1)</script>thanks!</p>', '--ALT--', '--OUTER',
    'Content-Type: application/pdf; name="receipt.pdf"', 'Content-Disposition: attachment; filename="receipt.pdf"',
    'Content-Transfer-Encoding: base64', '', PDF_B64, '--OUTER--', '',
  ].join('\r\n')

  test('multipart/alternative + attachment: text kept, HTML dropped, attachment metadata only', async () => {
    const parsed = await PostalMime.parse(new TextEncoder().encode(mime))
    const payload = payloadFromParsed(parsed as any, { from: 'bounce@m.example', to: 'support@kvrn.shop', rawSize: mime.length }, 'b'.repeat(64))
    const json = JSON.stringify(payload)
    expect(json).not.toContain(PDF_B64.slice(0, 20))             // no attachment content in the payload
    expect(json).not.toMatch(/fake pdf content/)
    expect(payload.html).toBeUndefined()                         // text exists, so HTML is not even sent
    const input = buildInboundEmailInput(JSON.parse(json))
    expect(input.subject).toBe('Re: Bestellung – danke')
    expect(input.subjectKey).toBe('bestellung – danke')
    expect(input.customerEmail).toBe('jane@example.com')
    expect(input.customerName).toBe('Jane Doe')
    expect(input.internetMessageId).toBe('reply-1@mail.example.com')
    expect(input.inReplyToIds).toEqual(['out-1@email.amazonses.com'])
    expect(input.referenceIds).toEqual(['out-1@email.amazonses.com', 'first@x'])
    expect(input.bodyText.trim()).toBe('Grüße, thanks!')
    expect(input.attachments).toEqual([{ filename: 'receipt.pdf', mimeType: 'application/pdf', disposition: 'attachment', size: expect.any(Number) }])
    expect(input.attachments[0].size).toBeGreaterThan(10)
    expect(JSON.stringify(input)).not.toMatch(/<script|alert\(1\)/)
  })

  test('HTML-only message is converted to text by the service; the script never survives', async () => {
    const m = ['From: a@b.co', 'To: support@kvrn.shop', 'Subject: html only', 'Message-ID: <h1@x>', 'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8', '', '<div>Hello <b>you</b><script>steal()</script></div>', ''].join('\r\n')
    const parsed = await PostalMime.parse(new TextEncoder().encode(m))
    const payload = payloadFromParsed(parsed as any, { from: 'a@b.co', to: 'support@kvrn.shop', rawSize: m.length }, 'c'.repeat(64))
    expect(payload.html).toBeTruthy()
    const input = buildInboundEmailInput(JSON.parse(JSON.stringify(payload)))
    expect(input.bodyText).toBe('Hello you')
  })
})

describe('contentDigest (dedupe fallback for mail without a Message-ID)', () => {
  const raw = (received: string) => ['Received: ' + received, 'From: a@b.co', 'To: support@kvrn.shop', 'Subject: No id', 'Date: Mon, 5 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Same words every time', ''].join('\r\n')
  test('is stable across SMTP retries (different Received hops) and changes with the content', async () => {
    const a = await PostalMime.parse(new TextEncoder().encode(raw('from hop1')))
    const b = await PostalMime.parse(new TextEncoder().encode(raw('from hop2 later')))
    const c = await PostalMime.parse(new TextEncoder().encode(raw('from hop1').replace('Same words', 'Other words')))
    const m = { from: 'a@b.co' }
    const da = await contentDigest(a as any, m), db = await contentDigest(b as any, m), dc = await contentDigest(c as any, m)
    expect(da).toMatch(/^[0-9a-f]{64}$/)
    expect(db).toBe(da)
    expect(dc).not.toBe(da)
  })
})

describe('rev2 hardening guards', () => {
  const root = path.join(__dirname, '..', '..')
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
  const stripSqlComments = (s: string) => s.replace(/--.*$/gm, '')

  test('migration: BOTH header lookups are restricted to a thread of the same customer', () => {
    const sql = stripSqlComments(read('db/migrations/026_support_inbox.sql'))
    const joins = sql.match(/JOIN support_threads\s+t ON t\.id = m\.thread_id AND t\.customer_email = v_cust/g) ?? []
    expect(joins).toHaveLength(2)                                     // In-Reply-To and References
    // no header lookup anywhere reads internet_message_id without that join
    const lookups = sql.split('JOIN support_messages m ON m.internet_message_id = r.id').slice(1)
    expect(lookups).toHaveLength(2)
    for (const l of lookups) expect(l.slice(0, 200)).toMatch(/customer_email = v_cust/)
  })

  test('UI no longer presents cross-sender header attachment as a normal case', () => {
    const ui = read('app/admin/support/SupportInboxClient.tsx')
    expect(ui).not.toMatch(/different address than this conversation/)
    expect(ui).not.toMatch(/m\.fromEmail !== thread\.customerEmail/)
  })

  test('runbook: no instruction to merge SPF records; Resend DNS follows the dashboard; live gates documented', () => {
    const rb = read('docs/SUPPORT-INBOX-RUNBOOK.md')
    expect(rb).not.toMatch(/merge SPF into one TXT/i)
    expect(rb).not.toMatch(/customers reply from other mailboxes\) and flagged/)
    expect(rb).toMatch(/exactly the records the Resend dashboard shows/i)
    expect(rb).toMatch(/send\.kvrn\.shop/)
    expect(rb).toMatch(/Do \*\*not\*\* merge Resend's SPF into the root SPF record unless/)
    expect(rb).toMatch(/Do not overwrite or delete existing\s+records blindly|do not overwrite or delete existing\s+records blindly/i)
    expect(rb).toMatch(/Live gates/)
    expect(rb).toMatch(/Forwarding after reading `message\.raw`/)
    expect(rb).toMatch(/Resend's delivered RFC Message-ID/)
    expect(rb).toMatch(/No manual thread merge/)
  })
})
