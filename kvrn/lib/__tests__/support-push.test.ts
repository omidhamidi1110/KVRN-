// lib/__tests__/support-push.test.ts — the "KVRN SUPPORT ✉️" owner push, through the REAL ingest route
//
// Real PostgreSQL (local TEST_DATABASE_URL only), the real route handlers and the real owner-notifications
// module; only the Pushover transport is faked. Proves: a NEW inbound email pushes exactly once, a duplicate
// delivery never pushes, a push failure never changes the stored result, and the contact form / admin replies /
// status changes never push.

import crypto from 'crypto'
import { NextRequest } from 'next/server'
import PostalMime from 'postal-mime'
import { createSupportService } from '../support-inbox'
import type { SupportMailer } from '../support-email'
import { handleSupportEmail } from '../support-email-handler'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

const pushSend = jest.fn<Promise<any>, [any]>()
let configured = true
jest.mock('../pushover', () => ({
  isPushoverConfigured: () => configured,
  sendPushoverNotification: (n: any) => pushSend(n),
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__SP_SQL } }))
jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => ({ identity: { email: 'admin@kvrn.test' }, error: null }),
}))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL ? 'NOTE: support-push DB tests skipped — TEST_DATABASE_URL is not a local server.'
                   : 'NOTE: support-push DB tests skipped — TEST_DATABASE_URL absent.', () => { expect(true).toBe(true) })
}

let F: FiDb
let setupFail = ''
beforeAll(async () => {
  if (!HAVE_DB) return
  try { F = await createFiDb('kvrn_sp'); (global as any).__SP_SQL = F.sql }
  catch (e: any) { setupFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })
const need = () => { if (setupFail) throw new Error('DB setup failed: ' + setupFail) }

const SECRET = 'push-test-secret-value'
const PID = process.pid
let seq = 0
const sha = () => crypto.createHash('sha256').update(`sp${++seq}-${PID}`).digest('hex')
const mid = () => `<sp${++seq}.${PID}@mail.example>`
const emailFor = (t: string) => `${t}-${PID}@example.com`
const body = (over: Record<string, unknown> = {}) => ({
  v: 1, envelopeFrom: 'x@y.example', envelopeTo: 'support@kvrn.shop', dedupeDigest: sha(), subject: 'Where is my order',
  messageId: mid(), fromEmail: emailFor('cust'), fromName: 'Cora Customer', text: 'Hello, my full address is 1 Secret Lane', ...over,
})
const ING = () => require('../../app/api/internal/support-email-ingest/route')
const post = (b: unknown) => ING().POST(new NextRequest('http://localhost/api/internal/support-email-ingest', {
  method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` } }))
const countMsgs = async () => Number((await F.q('SELECT count(*) AS n FROM support_messages'))[0].n)
const supportPushes = () => pushSend.mock.calls.filter(c => c[0].title === 'KVRN SUPPORT ✉️')

beforeEach(() => {
  configured = true
  pushSend.mockReset(); pushSend.mockResolvedValue({ outcome: 'sent' })
  process.env.SUPPORT_EMAIL_INGEST_SECRET = SECRET
  process.env.SITE_URL = 'https://kvrn.shop'
  ;(global as any).__SP_SQL = F?.sql
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { jest.restoreAllMocks(); delete process.env.SUPPORT_EMAIL_INGEST_SECRET })

describeDB('support email push', () => {
  test('a NEW inbound email: stored, duplicate=false, exactly one KVRN SUPPORT push, normal route result', async () => {
    need()
    const before = await countMsgs()
    const res = await post(body())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, duplicate: false, threadCreated: true, matchedBy: 'new' })
    expect(await countMsgs()).toBe(before + 1)
    expect(supportPushes()).toHaveLength(1)
    const n = pushSend.mock.calls[0][0]
    expect(n).toMatchObject({ title: 'KVRN SUPPORT ✉️', url: 'https://kvrn.shop/admin/support', urlTitle: 'Open KVRN Admin' })
    expect(n.message).toBe(['New customer email', 'From: Cora Customer', 'Subject: Where is my order', 'Open Admin → Support'].join('\n'))
  })

  test('a repeated / retried delivery of the same message never pushes again', async () => {
    need()
    const b = body({ subject: 'Retry me' })
    expect((await (await post(b)).json()).duplicate).toBe(false)
    for (let i = 0; i < 4; i++) {
      const r = await (await post({ ...b, dedupeDigest: sha() })).json()      // same Message-ID, even with a different digest
      expect(r.duplicate).toBe(true)
    }
    expect(supportPushes()).toHaveLength(1)
    // without a Message-ID the content digest dedupes the same way
    pushSend.mockClear()
    const noId = body({ messageId: undefined, subject: 'No id' })
    expect((await (await post(noId)).json()).duplicate).toBe(false)
    expect((await (await post(noId)).json()).duplicate).toBe(true)
    expect(supportPushes()).toHaveLength(1)
  })

  test('a follow-up reply from the same customer (a new message) does push; each message once', async () => {
    need()
    const email = emailFor('followup')
    const a = body({ fromEmail: email, subject: 'Order question' })
    await post(a)
    const r = await (await post(body({ fromEmail: email, subject: 'Re: Order question', inReplyTo: a.messageId }))).json()
    expect(r).toMatchObject({ duplicate: false, threadCreated: false, matchedBy: 'in_reply_to' })
    expect(supportPushes()).toHaveLength(2)
  })

  test('Pushover failing, timing out or throwing never changes the result: stored, 200, nothing escapes', async () => {
    need()
    for (const behaviour of [
      () => pushSend.mockResolvedValue({ outcome: 'failed', reason: 'timeout' }),
      () => pushSend.mockResolvedValue({ outcome: 'failed', reason: 'http_500' }),
      () => pushSend.mockRejectedValue(new Error('transport exploded')),
    ]) {
      behaviour()
      const before = await countMsgs()
      const res = await post(body({ subject: 'Push is down' }))
      expect(res.status).toBe(200)
      expect((await res.json()).duplicate).toBe(false)
      expect(await countMsgs()).toBe(before + 1)
    }
  })

  test('Pushover not configured: ingest unaffected, no push attempted', async () => {
    need()
    configured = false
    const before = await countMsgs()
    expect((await post(body())).status).toBe(200)
    expect(await countMsgs()).toBe(before + 1)
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('a rejected / unauthorized / invalid ingest never pushes and stores nothing', async () => {
    need()
    const before = await countMsgs()
    expect((await post(body({ envelopeTo: 'orders@kvrn.shop' }))).status).toBe(422)
    expect((await post(body({ fromEmail: 'nope', envelopeFrom: '' }))).status).toBe(422)
    const unauth = await ING().POST(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(body()),
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' } }))
    expect(unauth.status).toBe(401)
    expect(await countMsgs()).toBe(before)
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('a storage failure returns the generic 500 (the Worker retries) and does not push', async () => {
    need()
    ;(global as any).__SP_SQL = Object.assign(async () => { throw new Error('connection refused') },
      { query: async () => { throw new Error('connection refused') } })
    const res = await post(body())
    expect(res.status).toBe(500)
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('PRIVACY: no body, attachment, full address, header or secret reaches the push (display name only)', async () => {
    need()
    const cust = emailFor('privacy')
    await post(body({
      fromEmail: cust, fromName: 'Pat <pat.private@example.net>', subject: `Help from ${cust} https://phish.example/x`,
      text: 'MY-SECRET-BODY-TEXT card 4111 1111 1111 1111, 99 Hidden Street',
      attachments: [{ filename: 'passport-scan.pdf', mimeType: 'application/pdf', disposition: 'attachment', size: 1234 }],
      references: '<r1@x.example>', importNote: 'internal note',
    }))
    expect(supportPushes()).toHaveLength(1)
    const sent = JSON.stringify(pushSend.mock.calls[0][0])
    for (const leak of ['MY-SECRET-BODY-TEXT', '4111', 'Hidden Street', 'passport-scan', 'pdf', cust, 'pat.private', 'example.net',
      'phish', 'r1@x.example', 'internal note', SECRET, 'PUSHOVER_', 'Bearer']) {
      expect([leak, sent.includes(leak)]).toEqual([leak, false])
    }
    const logged = (console.error as jest.Mock).mock.calls.flat().join(' ')
    expect(logged).not.toMatch(/MY-SECRET|passport|privacy-\d+@example/)
  })

  test('the storefront CONTACT FORM never sends a KVRN SUPPORT push (and is still stored)', async () => {
    need()
    const realFetch = global.fetch
    global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as any
    try {
      const before = await countMsgs()
      const CONTACT = require('../../app/api/contact/route')
      const res = await CONTACT.POST(new NextRequest('http://localhost/api/contact', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName: 'Cora', lastName: 'Form', email: emailFor('form'), orderNumber: '', subject: 'Return', message: 'Please help', submissionId: crypto.randomUUID() }) }))
      expect(res.status).toBe(200)
      expect(await countMsgs()).toBe(before + 1)
      expect(pushSend).not.toHaveBeenCalled()
      for (const c of (global.fetch as jest.Mock).mock.calls) expect(String(c[0])).not.toMatch(/pushover/)
    } finally { global.fetch = realFetch }
  })

  test('admin replies, thread reads and status changes never push', async () => {
    need()
    const email = emailFor('adminops')
    const ingested = await (await post(body({ fromEmail: email, subject: 'Ops test' }))).json()
    expect(supportPushes()).toHaveLength(1)
    pushSend.mockClear()
    const fm: SupportMailer = {
      async send() { return { ok: true, providerMessageId: `re_${++seq}` } },
      async retrieveMessageId() { return null },
    }
    const svc = createSupportService(F.sql, { sleep: async () => {} })
    const threadId = (await svc.listThreads({ q: email })).threads[0].id
    await svc.sendReply({ threadId, body: 'We are on it', clientRequestId: crypto.randomUUID(), actorEmail: 'admin@kvrn.test' }, fm)
    await svc.markRead(threadId)
    await svc.setStatus(threadId, 'closed', 'admin@kvrn.test')
    await svc.setStatus(threadId, 'open', 'admin@kvrn.test')
    expect(ingested.duplicate).toBe(false)
    expect(pushSend).not.toHaveBeenCalled()
  })

  test('END TO END: raw MIME → Email Worker handler → ingest route → one push; an SMTP retry of the same mail adds none', async () => {
    need()
    const email = emailFor('e2e')
    const raw = [`From: "Eve End" <${email}>`, 'To: support@kvrn.shop', 'Subject: E2E subject', `Message-ID: <e2e.${PID}@mail.example>`,
      'Date: Tue, 06 Oct 2026 10:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Body text must stay private', ''].join('\r\n')
    const bytes = new TextEncoder().encode(raw)
    const deliver = () => handleSupportEmail({
      from: email, to: 'support@kvrn.shop', headers: new Headers(), rawSize: bytes.length,
      raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }),
      async forward() { return {} }, setReject() {},
    }, { SUPPORT_FORWARD_TO: 'owner@example.org', SUPPORT_EMAIL_INGEST_SECRET: SECRET }, {
      parseMime: r => PostalMime.parse(r) as any,
      ingest: req => ING().POST(new NextRequest(req.url, { method: 'POST', body: req.body as any, headers: req.headers, duplex: 'half' } as any)),
    })
    expect(await deliver()).toMatchObject({ outcome: 'handled', forwarded: true, ingested: true })
    expect(await deliver()).toMatchObject({ outcome: 'handled', ingested: true })           // Cloudflare / SMTP redelivery
    expect(supportPushes()).toHaveLength(1)
    expect(pushSend.mock.calls[0][0].message).toContain('From: Eve End')
    expect(JSON.stringify(pushSend.mock.calls[0][0])).not.toMatch(/Body text must stay private|e2e-\d+@example/)
  })
})
