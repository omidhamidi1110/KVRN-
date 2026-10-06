// lib/__tests__/support-inbox-db.test.ts — Support inbox against REAL PostgreSQL (migration 026)
//
// Runs only against a LOCAL server named by TEST_DATABASE_URL (see helpers/fi-pg.ts, which
// refuses non-local hosts and creates/drops a throwaway database). It applies migrations 001–026
// from the repo and exercises the real SQL functions, the real service and the real route handlers.
// No Gmail / Resend / Cloudflare network call is made: the mailer is a fake and fetch is stubbed.
//
//   D1  inbound idempotency (incl. real concurrent delivery)
//   D2  thread resolution: In-Reply-To, References, conservative fallback, safe new thread
//   D3  contact form threads
//   D4  integrity: immutable messages, thread identity, CHECKs, timestamps
//   D5  outbound recording, audit, status, read
//   D6  list / search / pagination / thread read
//   D7  admin reply orchestration (provider success / failure / retry / unrecorded)
//   D8  route handlers (admin auth, ingest secret, contact form)
//   D9  end to end: raw MIME → Email Worker handler → ingest route → admin reply → customer reply threads
//   D10 nothing outside the support tables changed

import crypto from 'crypto'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
import PostalMime from 'postal-mime'
import {
  SupportError, buildInboundEmailInput, createSupportService, type SupportService,
} from '../support-inbox'
import type { OutboundSupportEmail, SupportMailer, SupportSendOutcome } from '../support-email'
import { handleSupportEmail } from '../support-email-handler'
import { HAVE_DB, TEST_DB_URL, createFiDb, pgConfig, type FiDb } from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    const a = (global as any).__ADMIN
    return a === null
      ? { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
      : { identity: { email: a ?? 'admin@kvrn.test' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__SUP_SQL } }))
jest.mock('@/lib/support-email', () => ({
  ...jest.requireActual('@/lib/support-email'),
  getSupportMailer: () => (global as any).__MAILER,
}))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: 026 DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: 026 real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => { expect(true).toBe(true) })
}

let F: FiDb
let pgFail = ''
const q = (t: string, p: unknown[] = []) => F.q(t, p)
const needDb = () => { if (pgFail) throw new Error('DB setup failed: ' + pgFail) }
const PID = process.pid

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_sup')
    ;(global as any).__SUP_SQL = F.sql
    ;(global as any).__ADMIN = undefined
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })

// ── helpers ──────────────────────────────────────────────────────────────────
let seq = 0
const svc = (): SupportService => createSupportService(F.sql, { sleep: async () => {} })
const sha = () => crypto.createHash('sha256').update(`d${++seq}-${PID}`).digest('hex')
const mid = () => `<m${++seq}.${PID}@mail.example>`
const emailFor = (tag: string) => `${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}-${PID}@example.com`

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, envelopeFrom: 'x@y.example', envelopeTo: 'support@kvrn.shop', dedupeDigest: sha(),
    subject: 'Hello', messageId: mid(), fromEmail: 'cust@example.com', fromName: 'Cust', text: 'Hi there', ...over,
  }
}
const ingest = (over: Record<string, unknown> = {}) => svc().ingestInboundEmail(buildInboundEmailInput(payload(over)))
const thread = async (id: string) => (await q('SELECT * FROM support_threads WHERE id=$1', [id]))[0]
const msgs = (id: string) => q('SELECT * FROM support_messages WHERE thread_id=$1 ORDER BY created_at, id', [id])
const audit = (action: string, id: string) =>
  q('SELECT * FROM admin_audit_logs WHERE action=$1 AND resource_id=$2 ORDER BY created_at', [action, id])

interface FakeMailerOpts { fail?: SupportSendOutcome; noMessageId?: boolean; throwOnRetrieve?: boolean }
function fakeMailer(o: FakeMailerOpts = {}) {
  const sent: OutboundSupportEmail[] = []
  const byKey = new Map<string, string>()
  let calls = 0
  const mailer: SupportMailer = {
    async send(m) {
      calls++
      if (o.fail) return o.fail
      let id = byKey.get(m.idempotencyKey)               // Resend: same Idempotency-Key → same email
      if (!id) { id = `re_${++seq}_${PID}`; byKey.set(m.idempotencyKey, id); sent.push(m) }
      return { ok: true, providerMessageId: id }
    },
    async retrieveMessageId(id) {
      if (o.throwOnRetrieve) throw new Error('retrieve failed')
      return o.noMessageId ? null : `<${id}@email.amazonses.com>`
    },
  }
  return { mailer, sent, calls: () => calls }
}
const uuid = () => crypto.randomUUID()

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D1. inbound idempotency', () => {
  test('a new email creates a thread + message; unread = 1', async () => {
    needDb()
    const email = emailFor('d1a')
    const r = await ingest({ fromEmail: email, fromName: 'Dee One', subject: 'Order question', text: 'Where is it?' })
    expect(r).toMatchObject({ duplicate: false, threadCreated: true, matchedBy: 'new' })
    const t = await thread(r.threadId)
    expect(t).toMatchObject({ customer_email: email, customer_name: 'Dee One', subject: 'Order question',
      subject_key: 'order question', status: 'open', source: 'email', unread_count: 1, last_message_direction: 'inbound' })
    const [m] = await msgs(r.threadId)
    expect(m).toMatchObject({ direction: 'inbound', channel: 'email', provider: 'cloudflare_email', from_email: email,
      to_email: 'support@kvrn.shop', body_text: 'Where is it?', actor_email: null })
  })

  test('the same Message-ID delivered again is a no-op: one message, unread not incremented', async () => {
    needDb()
    const p = payload({ fromEmail: emailFor('d1b'), messageId: '<Dup.One@Mail.Example>' })
    const a = await svc().ingestInboundEmail(buildInboundEmailInput(p))
    const b = await svc().ingestInboundEmail(buildInboundEmailInput({ ...p, dedupeDigest: sha() }))      // even with a different digest
    const c = await svc().ingestInboundEmail(buildInboundEmailInput({ ...p, messageId: 'dup.one@mail.example', dedupeDigest: sha() }))  // case / brackets
    expect(a.duplicate).toBe(false)
    expect([b.duplicate, c.duplicate]).toEqual([true, true])
    expect([b.threadId, c.threadId]).toEqual([a.threadId, a.threadId])
    expect([b.messageId, c.messageId]).toEqual([a.messageId, a.messageId])
    expect(await msgs(a.threadId)).toHaveLength(1)
    expect((await thread(a.threadId)).unread_count).toBe(1)
  })

  test('no Message-ID: the raw-content digest dedupes; internet_message_id stays NULL (never invented)', async () => {
    needDb()
    const digest = sha()
    const p = payload({ fromEmail: emailFor('d1c'), messageId: undefined, dedupeDigest: digest })
    const a = await svc().ingestInboundEmail(buildInboundEmailInput(p))
    const b = await svc().ingestInboundEmail(buildInboundEmailInput(p))
    expect([a.duplicate, b.duplicate]).toEqual([false, true])
    const ms = await msgs(a.threadId)
    expect(ms).toHaveLength(1)
    expect(ms[0].internet_message_id).toBeNull()
    expect(ms[0].dedupe_key).toBe(`sha256:${digest}`)
  })

  test('six simultaneous deliveries of the same email (separate connections) create exactly one message', async () => {
    needDb()
    const input = buildInboundEmailInput(payload({ fromEmail: emailFor('d1d'), messageId: '<race.1@mail.example>' }))
    const json = JSON.stringify({
      provider: 'cloudflare_email', dedupe_key: input.dedupeKey, internet_message_id: input.internetMessageId,
      in_reply_to_ids: [], reference_ids: [], customer_email: input.customerEmail, customer_name: input.customerName,
      from_email: input.fromEmail, from_name: input.fromName, to_email: input.toEmail, subject: input.subject,
      subject_key: input.subjectKey, body_text: input.bodyText, attachments: [], force_new_thread: false,
    })
    const { isLocal: _l, ...cfg } = pgConfig(`kvrn_sup_${PID}`)
    const clients = await Promise.all(Array.from({ length: 6 }, async () => { const c = new Client(cfg); await c.connect(); return c }))
    try {
      const rs = await Promise.all(clients.map(c => c.query('SELECT support_ingest_message($1::jsonb) AS r', [json])))
      const out = rs.map(r => r.rows[0].r)
      expect(out.filter((o: any) => o.duplicate === false)).toHaveLength(1)
      expect(new Set(out.map((o: any) => o.thread_id)).size).toBe(1)
      expect(await msgs(out[0].thread_id)).toHaveLength(1)
      expect((await thread(out[0].thread_id)).unread_count).toBe(1)
    } finally { await Promise.all(clients.map(c => c.end())) }
  })

  test('simultaneous FIRST messages from one customer do not each create their own thread (same subject)', async () => {
    needDb()
    const email = emailFor('d1e')
    const inputs = [0, 1, 2].map(() => buildInboundEmailInput(payload({ fromEmail: email, subject: 'Same issue' })))
    const { isLocal: _l, ...cfg } = pgConfig(`kvrn_sup_${PID}`)
    const clients = await Promise.all(inputs.map(async () => { const c = new Client(cfg); await c.connect(); return c }))
    try {
      const rs = await Promise.all(inputs.map((i, k) => clients[k].query('SELECT support_ingest_message($1::jsonb) AS r', [JSON.stringify({
        provider: 'cloudflare_email', dedupe_key: i.dedupeKey, internet_message_id: i.internetMessageId,
        in_reply_to_ids: [], reference_ids: [], customer_email: i.customerEmail, from_email: i.fromEmail,
        to_email: i.toEmail, subject: i.subject, subject_key: i.subjectKey, body_text: i.bodyText, attachments: [],
      })])))
      const ids = new Set(rs.map(r => r.rows[0].r.thread_id))
      expect(ids.size).toBe(1)                                       // serialized per customer → later ones match by subject
      expect((await thread([...ids][0] as string)).unread_count).toBe(3)
    } finally { await Promise.all(clients.map(c => c.end())) }
  })

  test('SQL refuses an email with no dedupe key and a bad provider', async () => {
    needDb()
    const base = { customer_email: 'a@b.co', from_email: 'a@b.co', to_email: 'support@kvrn.shop', subject: '', subject_key: '', body_text: '' }
    expect(await F.err(`SELECT support_ingest_message($1::jsonb)`, [JSON.stringify({ ...base, provider: 'cloudflare_email' })])).toMatch(/DEDUPE_KEY_REQUIRED/)
    expect(await F.err(`SELECT support_ingest_message($1::jsonb)`, [JSON.stringify({ ...base, provider: 'resend', dedupe_key: 'x' })])).toMatch(/INVALID_PROVIDER/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D2. thread resolution', () => {
  async function outbound(threadId: string, customer: string, over: Record<string, unknown> = {}) {
    const r = await q(`SELECT support_record_outbound($1::jsonb) AS r`, [JSON.stringify({
      thread_id: threadId, to_email: customer, provider_message_id: `re_${++seq}_${PID}`,
      internet_message_id: `out${seq}.${PID}@email.amazonses.com`, dedupe_key: `out:${uuid()}`,
      from_email: 'support@kvrn.shop', from_name: 'KVRN Support', subject: 'Re: x', body_text: 'reply', actor_email: 'admin@kvrn.test', ...over,
    })])
    return r[0].r
  }
  const midOf = async (messageId: string) => (await q('SELECT internet_message_id AS m FROM support_messages WHERE id=$1', [messageId]))[0].m as string

  test('In-Reply-To: a customer reply joins the thread of the message it answers (and beats a same-subject thread)', async () => {
    needDb()
    const email = emailFor('d2a')
    const a = await ingest({ fromEmail: email, subject: 'Topic A' })
    const o = await outbound(a.threadId, email)
    // a second OPEN thread with the very subject the reply will carry — must lose to the header
    const decoy = await ingest({ fromEmail: email, subject: 'Unrelated', messageId: mid() })
    await q(`UPDATE support_threads SET subject_key='topic a' WHERE id=$1`, [decoy.threadId]).catch(() => {})   // identity is immutable → this must fail
    const outId = await midOf(o.message_id)
    const r = await ingest({ fromEmail: email, subject: 'Re: Topic A', inReplyTo: `<${outId}>` })
    expect(r).toMatchObject({ duplicate: false, threadCreated: false, matchedBy: 'in_reply_to', threadId: a.threadId })
    expect(await msgs(a.threadId)).toHaveLength(3)
  })

  test('References: used when In-Reply-To is absent/unknown; most recent id wins', async () => {
    needDb()
    const email = emailFor('d2b')
    const a = await ingest({ fromEmail: email, subject: 'Refs A' })
    const b = await ingest({ fromEmail: email, subject: 'Refs B totally different' })
    const [ma, mb] = [await midOf(a.messageId), await midOf(b.messageId)]
    const r1 = await ingest({ fromEmail: email, subject: 'whatever', inReplyTo: '<unknown@x>', references: `<${ma}> <unknown2@x>` })
    expect([r1.matchedBy, r1.threadId]).toEqual(['references', a.threadId])
    const r2 = await ingest({ fromEmail: email, subject: 'whatever', references: `<${ma}> <${mb}>` })      // closest ancestor is last
    expect([r2.matchedBy, r2.threadId]).toEqual(['references', b.threadId])
  })

  test('THREAD INJECTION: a different sender quoting a thread\'s Message-ID cannot join it — it gets its own thread and is not discarded', async () => {
    needDb()
    const victim = emailFor('d2c-victim'), attacker = emailFor('d2c-attacker')
    const a = await ingest({ fromEmail: victim, subject: 'Private order issue', text: 'my order details' })
    const victimMid = `<${await midOf(a.messageId)}>`
    await q(`UPDATE support_threads SET unread_count = 0 WHERE id=$1`, [a.threadId])         // the admin has read it
    const before = await thread(a.threadId)

    for (const hdr of [{ inReplyTo: victimMid }, { references: `<unrelated@x.example> ${victimMid}` },
                       { inReplyTo: victimMid, references: victimMid, subject: 'Re: Private order issue' }]) {
      const r = await ingest({ fromEmail: attacker, subject: 'Re: Private order issue', text: 'injected', ...hdr })
      expect(r.duplicate).toBe(false)                                  // stored, not discarded
      expect(r.threadId).not.toBe(a.threadId)                          // but never in the victim's conversation
      expect(r.threadCreated === true || r.matchedBy === 'subject').toBe(true)
      expect((await thread(r.threadId)).customer_email).toBe(attacker)
    }
    // the victim's thread is untouched: same messages, still read, same pointers
    expect(await msgs(a.threadId)).toHaveLength(1)
    const after = await thread(a.threadId)
    expect([after.unread_count, after.status, after.last_message_at.getTime()]).toEqual([0, 'open', before.last_message_at.getTime()])
    // and an admin reply on the attacker's own thread goes only to the attacker, never the victim
    const fm = fakeMailer()
    const attackerThread = (await svc().listThreads({ q: attacker })).threads[0]
    await svc().sendReply({ threadId: attackerThread.id, body: 'hello', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test' }, fm.mailer)
    expect(fm.sent.map(m => m.to)).toEqual([attacker])
  })

  test('the legitimate case is unchanged: the SAME sender replying (any casing) still joins by In-Reply-To / References', async () => {
    needDb()
    const email = emailFor('d2c-same')
    const a = await ingest({ fromEmail: email, subject: 'Same sender' })
    const r1 = await ingest({ fromEmail: email.toUpperCase(), subject: 'unrelated words', inReplyTo: `<${await midOf(a.messageId)}>` })
    const r2 = await ingest({ fromEmail: email, subject: 'other', references: `<${await midOf(a.messageId)}>` })
    expect([r1.matchedBy, r1.threadId]).toEqual(['in_reply_to', a.threadId])
    expect([r2.matchedBy, r2.threadId]).toEqual(['references', a.threadId])
  })

  test('with several headers, a matching thread of THIS sender wins over another customer\'s thread listed first', async () => {
    needDb()
    const mine = await ingest({ fromEmail: emailFor('d2c-mine'), subject: 'Mine' })
    const other = await ingest({ fromEmail: emailFor('d2c-theirs'), subject: 'Theirs' })
    const r = await ingest({ fromEmail: emailFor('d2c-mine'), subject: 'Re: x',
      inReplyTo: `<${await midOf(other.messageId)}> <${await midOf(mine.messageId)}>` })
    expect([r.matchedBy, r.threadId]).toEqual(['in_reply_to', mine.threadId])
  })

  test('a header match reopens a closed thread and counts as unread', async () => {
    needDb()
    const email = emailFor('d2d')
    const a = await ingest({ fromEmail: email, subject: 'Closed topic' })
    await svc().markRead(a.threadId)
    await svc().setStatus(a.threadId, 'closed', 'admin@kvrn.test')
    const r = await ingest({ fromEmail: email, subject: 'Re: Closed topic', inReplyTo: `<${await midOf(a.messageId)}>` })
    expect(r.threadId).toBe(a.threadId)
    expect(await thread(a.threadId)).toMatchObject({ status: 'open', unread_count: 1 })
  })

  test('FALLBACK: same customer + same normalized subject + open + recent → same thread', async () => {
    needDb()
    const email = emailFor('d2e')
    const a = await ingest({ fromEmail: email, subject: 'Where is my order' })
    const b = await ingest({ fromEmail: email, subject: 'RE: Re: where is my  order' })
    expect([b.matchedBy, b.threadId, b.threadCreated]).toEqual(['subject', a.threadId, false])
  })

  test.each([
    ['different customer', (e: string) => ({ fromEmail: emailFor('d2f-x'), subject: 'Same subject' })],
    ['different subject', (e: string) => ({ fromEmail: e, subject: 'Another subject entirely' })],
    ['empty subject', (e: string) => ({ fromEmail: e, subject: '' })],
    ['prefix-only subject', (e: string) => ({ fromEmail: e, subject: 'Re:' })],
  ])('SAFE NEW THREAD: %s', async (_name, mk) => {
    needDb()
    const email = emailFor('d2f')
    const a = await ingest({ fromEmail: email, subject: 'Same subject' })
    const r = await ingest(mk(email))
    expect([r.matchedBy, r.threadCreated]).toEqual(['new', true])
    expect(r.threadId).not.toBe(a.threadId)
  })

  test('SAFE NEW THREAD: a closed or stale (>14 days) thread is never matched by subject', async () => {
    needDb()
    const e1 = emailFor('d2g1'), e2 = emailFor('d2g2')
    const closed = await ingest({ fromEmail: e1, subject: 'Closed same' })
    await svc().setStatus(closed.threadId, 'closed', 'admin@kvrn.test')
    expect((await ingest({ fromEmail: e1, subject: 'Closed same' })).threadCreated).toBe(true)
    const stale = await ingest({ fromEmail: e2, subject: 'Stale same' })
    await q(`UPDATE support_threads SET last_message_at = NOW() - INTERVAL '15 days' WHERE id=$1`, [stale.threadId])
    expect((await ingest({ fromEmail: e2, subject: 'Stale same' })).threadCreated).toBe(true)
  })

  test('SAFE NEW THREAD: two open candidates are ambiguous → a new thread, no guess', async () => {
    needDb()
    const email = emailFor('d2h')
    const a = await ingest({ fromEmail: email, subject: 'Dup subject' })
    // make a SECOND open thread with the same key (a contact form always opens its own thread)
    const form = await svc().recordContactSubmission({ firstName: 'D', lastName: 'H', email, orderNumber: null, subject: 'Dup subject', message: 'second', submissionId: null })
    expect(form.threadId).not.toBe(a.threadId)
    const r = await ingest({ fromEmail: email, subject: 'Re: Dup subject' })
    expect([r.matchedBy, r.threadCreated]).toEqual(['new', true])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D3. contact-form threads', () => {
  const form = (over: Record<string, unknown> = {}) => ({
    firstName: 'Ada', lastName: 'Lovelace', email: emailFor('d3'), orderNumber: 'KVRN-001000',
    subject: 'Order enquiry', message: 'Please help', submissionId: null as string | null, ...over,
  })
  test('creates its own thread: source contact_form, name, order number, inbound message, unread 1', async () => {
    needDb()
    const r = await svc().recordContactSubmission(form({ email: emailFor('d3a') }))
    expect(r.duplicate).toBe(false)
    expect(await thread(r.threadId)).toMatchObject({ source: 'contact_form', customer_name: 'Ada Lovelace', order_number: 'KVRN-001000',
      subject: 'Order enquiry', unread_count: 1, status: 'open', last_message_direction: 'inbound' })
    expect(await msgs(r.threadId)).toMatchObject([{ direction: 'inbound', channel: 'contact_form', provider: 'contact_form',
      body_text: 'Please help', from_name: 'Ada Lovelace', to_email: 'support@kvrn.shop', internet_message_id: null }])
  })
  test('NEVER attaches to an existing email thread, even for the same customer and subject', async () => {
    needDb()
    const email = emailFor('d3b')
    const a = await ingest({ fromEmail: email, subject: 'Order enquiry' })
    const r = await svc().recordContactSubmission(form({ email }))
    expect(r.threadId).not.toBe(a.threadId)
    expect(await msgs(a.threadId)).toHaveLength(1)                   // the form could not inject into someone else's conversation
  })
  test('the same submission id is idempotent (double click / retry)', async () => {
    needDb()
    const sid = uuid()
    const a = await svc().recordContactSubmission(form({ email: emailFor('d3c'), submissionId: sid }))
    const b = await svc().recordContactSubmission(form({ email: emailFor('d3c'), submissionId: sid }))
    expect([a.duplicate, b.duplicate, b.threadId]).toEqual([false, true, a.threadId])
    expect(await msgs(a.threadId)).toHaveLength(1)
  })
  test('contactRate counts the last hour per email and globally', async () => {
    needDb()
    const email = emailFor('d3d')
    const before = await svc().contactRate(email)
    for (let i = 0; i < 3; i++) await svc().recordContactSubmission(form({ email }))
    const after = await svc().contactRate(email)
    expect([after.perEmail - before.perEmail, after.global - before.global]).toEqual([3, 3])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D4. integrity', () => {
  test('support_messages is immutable: UPDATE, DELETE and TRUNCATE are refused', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d4a') })
    expect(await F.err(`UPDATE support_messages SET body_text='edited' WHERE id=$1`, [a.messageId])).toMatch(/MESSAGE_IMMUTABLE/)
    expect(await F.err(`DELETE FROM support_messages WHERE id=$1`, [a.messageId])).toMatch(/MESSAGE_IMMUTABLE/)
    expect(await F.err(`TRUNCATE support_messages`)).toMatch(/MESSAGE_IMMUTABLE/)
    expect((await msgs(a.threadId))[0].body_text).toBe('Hi there')
  })
  test('threads are never deleted; identity fields are fixed; status/read/pointers may change', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d4b'), subject: 'Fixed', fromName: undefined })
    expect(await F.err(`DELETE FROM support_threads WHERE id=$1`, [a.threadId])).toMatch(/THREAD_UNDELETABLE/)
    expect(await F.err(`TRUNCATE support_threads CASCADE`)).toMatch(/THREAD_UNDELETABLE|MESSAGE_IMMUTABLE/)
    for (const set of [`customer_email='x@y.co'`, `subject='changed'`, `subject_key='changed'`, `source='contact_form'`, `created_at=NOW()`, `customer_name='Renamed'`]) {
      const e = await F.err(`UPDATE support_threads SET ${set} WHERE id=$1`, [a.threadId])
      // customer_name starts NULL for this thread, so learning one is allowed; every other identity change is not
      if (set.startsWith('customer_name')) expect(e).toBe('')
      else expect(e).toMatch(/THREAD_IDENTITY_IMMUTABLE|check constraint/)
    }
    expect(await F.err(`UPDATE support_threads SET customer_name='Second' WHERE id=$1`, [a.threadId])).toMatch(/THREAD_IDENTITY_IMMUTABLE/)
    expect(await F.err(`UPDATE support_threads SET status='closed', unread_count=0 WHERE id=$1`, [a.threadId])).toBe('')
  })
  test('FK RESTRICT: a thread with messages cannot be removed even by a direct DELETE of the FK target', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d4c') })
    expect(await F.err(`DELETE FROM support_threads WHERE id=$1`, [a.threadId])).not.toBe('')
    expect(await msgs(a.threadId)).toHaveLength(1)
  })
  test('CHECK constraints: bad status/source/direction/unread, invalid email, outbound without provider id', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d4d') })
    expect(await F.err(`UPDATE support_threads SET status='bogus' WHERE id=$1`, [a.threadId])).toMatch(/st_status_chk/)
    expect(await F.err(`UPDATE support_threads SET unread_count=-1 WHERE id=$1`, [a.threadId])).toMatch(/st_unread_chk/)
    expect(await F.err(`INSERT INTO support_threads (customer_email,subject,subject_key,source,last_message_at,last_message_direction)
                        VALUES ('Not An Email','s','s','email',NOW(),'inbound')`)).toMatch(/st_email_chk/)
    expect(await F.err(`INSERT INTO support_threads (customer_email,subject,subject_key,source,last_message_at,last_message_direction)
                        VALUES ('UPPER@EXAMPLE.COM','s','s','email',NOW(),'inbound')`)).toMatch(/st_email_chk/)   // stored lower-case only
    expect(await F.err(`INSERT INTO support_messages (thread_id,direction,channel,provider,from_email,to_email,subject,body_text,occurred_at)
                        VALUES ($1,'outbound','email','resend','support@kvrn.shop','a@b.co','s','text',NOW())`, [a.threadId])).toMatch(/sm_outbound_chk/)
    expect(await F.err(`INSERT INTO support_messages (thread_id,direction,channel,provider,from_email,to_email,subject,body_text,occurred_at)
                        VALUES ($1,'inbound','email','resend','a@b.co','support@kvrn.shop','s','t',NOW())`, [a.threadId])).toMatch(/sm_combo_chk/)
    expect(await F.err(`INSERT INTO support_messages (thread_id,direction,channel,provider,from_email,to_email,subject,body_text,occurred_at,attachment_metadata)
                        VALUES ($1,'inbound','email','cloudflare_email','a@b.co','support@kvrn.shop','s','t',NOW(),'{"a":1}')`, [a.threadId])).toMatch(/sm_attachments_chk/)
  })
  test('internet_message_id and (provider, provider_message_id) are unique where present', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d4e'), messageId: '<uniq.1@mail.example>' })
    expect(await F.err(`INSERT INTO support_messages (thread_id,direction,channel,provider,internet_message_id,from_email,to_email,subject,body_text,occurred_at)
                        VALUES ($1,'inbound','email','cloudflare_email','uniq.1@mail.example','a@b.co','support@kvrn.shop','s','t',NOW())`, [a.threadId])).toMatch(/sm_internet_message_id_uq/)
  })
  test('timestamps: a future Date header is clamped; a stale/forged Date never reorders the conversation or hides an unread reply', async () => {
    needDb()
    const email = emailFor('d4f')
    const fut = await ingest({ fromEmail: email, subject: 'Future', date: '2099-01-01T00:00:00Z' })
    expect(new Date((await msgs(fut.threadId))[0].occurred_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
    const base = await ingest({ fromEmail: email, subject: 'Order of events' })
    const t1 = new Date((await thread(base.threadId)).last_message_at).getTime()
    await new Promise(r => setTimeout(r, 15))
    const old = await ingest({ fromEmail: email, subject: 'Re: Order of events', date: '2020-01-01T00:00:00Z' })
    expect(old.threadId).toBe(base.threadId)
    // arrival time drives the inbox: the thread moved FORWARD even though the sender's Date is years old
    expect(new Date((await thread(base.threadId)).last_message_at).getTime()).toBeGreaterThan(t1)
    const ms = await msgs(base.threadId)
    expect(ms.map(m => new Date(m.occurred_at).getUTCFullYear())).toEqual([new Date().getUTCFullYear(), 2020])   // order = arrival; occurred_at = sender's claim
    expect((await thread(base.threadId)).unread_count).toBe(2)
  })
  test('only attachment METADATA is stored, never content', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d4g'),
      attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 5, disposition: 'attachment', content: 'SECRETBYTES', data: 'x' }] })
    const [m] = await msgs(a.threadId)
    expect(m.attachment_metadata).toEqual([{ filename: 'a.pdf', mimeType: 'application/pdf', size: 5, disposition: 'attachment' }])
    expect(JSON.stringify(m)).not.toContain('SECRETBYTES')
  })
  test('NUL bytes in a body are stripped before storage (PostgreSQL cannot hold them)', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d4h'), text: 'a\u0000b' })
    expect((await msgs(a.threadId))[0].body_text).toBe('ab')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D5. outbound recording, status, read', () => {
  const rec = (over: Record<string, unknown>) => q(`SELECT support_record_outbound($1::jsonb) AS r`, [JSON.stringify({
    provider_message_id: `re_${++seq}_${PID}`, dedupe_key: `out:${uuid()}`, from_email: 'support@kvrn.shop',
    from_name: 'KVRN Support', subject: 'Re: x', body_text: 'reply body', actor_email: 'admin@kvrn.test', ...over })]).then(r => r[0].r)

  test('records an outbound message, zeroes unread, moves last-message pointers, writes an audit row with no body/PII', async () => {
    needDb()
    const email = emailFor('d5a')
    const a = await ingest({ fromEmail: email })
    const r = await rec({ thread_id: a.threadId, to_email: email, internet_message_id: `o1.${PID}@email.amazonses.com`, body_text: 'SECRET REPLY TEXT' })
    expect(r.duplicate).toBe(false)
    expect(await thread(a.threadId)).toMatchObject({ unread_count: 0, last_message_direction: 'outbound' })
    const [, out] = await msgs(a.threadId)
    expect(out).toMatchObject({ direction: 'outbound', provider: 'resend', from_email: 'support@kvrn.shop', to_email: email, actor_email: 'admin@kvrn.test' })
    const [au] = await audit('support_reply_sent', a.threadId)
    expect(au).toMatchObject({ actor_email: 'admin@kvrn.test', resource: 'support_thread' })
    expect(au.payload).toMatchObject({ message_id: r.message_id, internet_message_id_captured: true, body_chars: 17 })
    expect(JSON.stringify(au)).not.toMatch(/SECRET REPLY TEXT|d5a/)
  })
  test('refuses a recipient that is not the thread customer, an unknown thread, and a missing provider id/actor', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d5b') })
    expect(await F.err(`SELECT support_record_outbound($1::jsonb)`, [JSON.stringify({ thread_id: a.threadId, to_email: 'attacker@evil.com', provider_message_id: 're_x', from_email: 'support@kvrn.shop', subject: 's', body_text: 't', actor_email: 'a@b.co' })])).toMatch(/RECIPIENT_MISMATCH/)
    expect(await F.err(`SELECT support_record_outbound($1::jsonb)`, [JSON.stringify({ thread_id: uuid(), to_email: 'a@b.co', provider_message_id: 're_x', from_email: 'support@kvrn.shop', subject: 's', body_text: 't', actor_email: 'a@b.co' })])).toMatch(/THREAD_NOT_FOUND/)
    expect(await F.err(`SELECT support_record_outbound($1::jsonb)`, [JSON.stringify({ thread_id: a.threadId, to_email: emailFor('d5b'), from_email: 'support@kvrn.shop', subject: 's', body_text: 't', actor_email: 'a@b.co' })])).toMatch(/PROVIDER_ID_REQUIRED/)
    expect(await F.err(`SELECT support_record_outbound($1::jsonb)`, [JSON.stringify({ thread_id: a.threadId, to_email: emailFor('d5b'), provider_message_id: 're_y', from_email: 'support@kvrn.shop', subject: 's', body_text: 't' })])).toMatch(/ACTOR_REQUIRED/)
    expect(await msgs(a.threadId)).toHaveLength(1)
  })
  test('idempotent on dedupe key AND on provider message id', async () => {
    needDb()
    const email = emailFor('d5c'); const a = await ingest({ fromEmail: email })
    const key = `out:${uuid()}`, pm = `re_same_${seq}_${PID}`
    const first = await rec({ thread_id: a.threadId, to_email: email, dedupe_key: key, provider_message_id: pm })
    const again = await rec({ thread_id: a.threadId, to_email: email, dedupe_key: key, provider_message_id: pm })
    const sameProvider = await rec({ thread_id: a.threadId, to_email: email, provider_message_id: pm })
    expect([first.duplicate, again.duplicate, sameProvider.duplicate]).toEqual([false, true, true])
    expect(await audit('support_reply_sent', a.threadId)).toHaveLength(1)
    expect((await msgs(a.threadId)).filter(m => m.direction === 'outbound')).toHaveLength(1)
  })
  test('close / reopen are audited once per real change; a no-op writes nothing', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d5d') })
    expect(await svc().setStatus(a.threadId, 'closed', 'admin@kvrn.test')).toEqual({ changed: true, status: 'closed' })
    expect(await svc().setStatus(a.threadId, 'closed', 'admin@kvrn.test')).toEqual({ changed: false, status: 'closed' })
    expect(await svc().setStatus(a.threadId, 'open', 'admin@kvrn.test')).toEqual({ changed: true, status: 'open' })
    expect((await audit('support_thread_closed', a.threadId)).map(r => r.payload)).toEqual([{ from: 'open', to: 'closed' }])
    expect((await audit('support_thread_reopened', a.threadId)).map(r => r.payload)).toEqual([{ from: 'closed', to: 'open' }])
    await expect(svc().setStatus(uuid(), 'closed', 'a@b.co')).rejects.toMatchObject({ code: 'not_found', status: 404 })
    await expect(svc().setStatus(a.threadId, 'deleted' as any, 'a@b.co')).rejects.toMatchObject({ status: 400 })
    await expect(svc().setStatus('nope', 'open', 'a@b.co')).rejects.toMatchObject({ status: 404 })
  })
  test('markRead clears the counter; unknown thread reported', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d5e') })
    expect(await svc().markRead(a.threadId)).toEqual({ found: true, cleared: true })
    expect(await svc().markRead(a.threadId)).toEqual({ found: true, cleared: false })
    expect(await svc().markRead(uuid())).toEqual({ found: false, cleared: false })
    expect(await svc().markRead('nope')).toEqual({ found: false, cleared: false })
    expect((await thread(a.threadId)).unread_count).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D6. list / search / pagination / thread read', () => {
  test('filters, counts, search (literal wildcards), preview and ordering', async () => {
    needDb()
    const tag = `lst${PID}`
    const mk = (n: string, over: Record<string, unknown> = {}) =>
      ingest({ fromEmail: emailFor(`${tag}${n}`), fromName: `Lister ${n}`, subject: `${tag} subject ${n}`, text: `body for ${n}   with   spaces`, ...over })
    const a = await mk('a'), b = await mk('b'), c = await mk('c')
    await svc().markRead(b.threadId)
    await svc().setStatus(c.threadId, 'closed', 'admin@kvrn.test')
    const ids = (r: any) => r.threads.map((t: any) => t.id)

    const open = await svc().listThreads({ status: 'open', q: tag })
    expect(new Set(ids(open))).toEqual(new Set([a.threadId, b.threadId]))
    const closed = await svc().listThreads({ status: 'closed', q: tag })
    expect(ids(closed)).toEqual([c.threadId])
    const unread = await svc().listThreads({ status: 'all', unreadOnly: true, q: tag })
    expect(new Set(ids(unread))).toEqual(new Set([a.threadId, c.threadId]))   // c is closed but still unread
    expect(ids(await svc().listThreads({ q: tag }))).toHaveLength(3)
    expect(open.counts.open).toBeGreaterThanOrEqual(2)
    expect(open.counts.closed).toBeGreaterThanOrEqual(1)

    const first = (await svc().listThreads({ q: `Lister a` })).threads.find(t => t.id === a.threadId)!
    expect(first).toMatchObject({ customerName: 'Lister a', subject: `${tag} subject a`, unreadCount: 1, status: 'open',
      source: 'email', preview: 'body for a with spaces', attachmentCount: 0, lastMessageDirection: 'inbound' })
    expect(ids(await svc().listThreads({ q: emailFor(`${tag}b`).toUpperCase() }))).toEqual([b.threadId])   // email, case-insensitive
    expect(ids(await svc().listThreads({ q: `subject c` }))).toContain(c.threadId)

    // LIKE wildcards are literal
    expect((await svc().listThreads({ q: '%' })).threads.every(t => /%/.test(`${t.customerEmail}${t.customerName}${t.subject}${t.orderNumber}`))).toBe(true)
    expect((await svc().listThreads({ q: `${tag}_` })).threads).toHaveLength(0)
  })

  test('order number from the contact form is searchable', async () => {
    needDb()
    const on = `KV-${PID}-77`
    const r = await svc().recordContactSubmission({ firstName: 'O', lastName: 'N', email: emailFor('d6on'), orderNumber: on, subject: 'S', message: 'm', submissionId: null })
    expect((await svc().listThreads({ q: on.toLowerCase() })).threads.map(t => t.id)).toEqual([r.threadId])
  })

  test('keyset pagination is stable with identical timestamps: no duplicates, no gaps, bounded pages, bad cursor 400', async () => {
    needDb()
    const tag = `pg${PID}`
    const made: string[] = []
    for (let i = 0; i < 7; i++) {
      made.push((await ingest({ fromEmail: emailFor(`${tag}${i}`), subject: `${tag} page` })).threadId)
    }
    // identical sort keys: only the id tiebreak keeps the pages stable
    await q(`UPDATE support_threads SET last_message_at = '2026-01-01T00:00:00.123456Z' WHERE id = ANY($1::uuid[])`, [made])
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const r = await svc().listThreads({ q: tag, limit: 3, cursor })
      expect(r.threads.length).toBeLessThanOrEqual(3)
      seen.push(...r.threads.map(t => t.id)); cursor = r.nextCursor; pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(7)
    expect(new Set(seen)).toEqual(new Set(made))
    await expect(svc().listThreads({ cursor: 'garbage' })).rejects.toMatchObject({ status: 400 })
    expect((await svc().listThreads({ limit: 100000 })).threads.length).toBeLessThanOrEqual(100)
  })

  test('getThread: messages in arrival order, attachment metadata only, unknown / malformed ids → null', async () => {
    needDb()
    const email = emailFor('d6g')
    const d1 = new Date(Date.now() - 2 * 86_400_000).toISOString(), d2 = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const a = await ingest({ fromEmail: email, subject: 'Chrono', date: d1,
      attachments: [{ filename: 'x.png', mimeType: 'image/png', size: 9, disposition: 'inline' }] })
    const b = await ingest({ fromEmail: email, subject: 'Re: Chrono', date: d2 })        // an EARLIER claimed date, arrives later
    expect(b.threadId).toBe(a.threadId)
    const t = await svc().getThread(a.threadId)
    expect(t!.messages.map(m => m.occurredAt)).toEqual([d1, d2])                          // arrival order, not claimed-date order
    expect(t!.messages[0].attachments).toEqual([{ filename: 'x.png', mimeType: 'image/png', size: 9, disposition: 'inline' }])
    expect(t).toMatchObject({ customerEmail: email, status: 'open' })
    expect(await svc().getThread(uuid())).toBeNull()
    expect(await svc().getThread('not-a-uuid')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D7. admin reply orchestration', () => {
  test('provider success: sent FROM support@ TO the customer only; stored after acceptance; Message-ID captured; audit written', async () => {
    needDb()
    const email = emailFor('d7a')
    const a = await ingest({ fromEmail: email, subject: 'Need help', text: 'help me' })
    const fm = fakeMailer()
    const rid = uuid()
    const r = await svc().sendReply({ threadId: a.threadId, body: '  Happy to help.\r\nThanks  ', clientRequestId: rid, actorEmail: 'Admin@KVRN.test' }, fm.mailer)
    expect(r).toMatchObject({ threadId: a.threadId, duplicate: false, internetMessageIdCaptured: true })
    expect(fm.sent).toHaveLength(1)
    expect(fm.sent[0]).toMatchObject({ to: email, subject: 'Re: Need help', text: 'Happy to help.\nThanks', idempotencyKey: `support-reply-${rid}` })
    const inbound = (await msgs(a.threadId))[0]
    expect(fm.sent[0].inReplyTo).toBe(`<${inbound.internet_message_id}>`)            // threads under the customer's message
    expect(fm.sent[0].references).toBe(`<${inbound.internet_message_id}>`)
    const out = (await msgs(a.threadId)).find(m => m.direction === 'outbound')!
    expect(out).toMatchObject({ from_email: 'support@kvrn.shop', from_name: 'KVRN Support', to_email: email, body_text: 'Happy to help.\nThanks',
      actor_email: 'admin@kvrn.test', provider: 'resend', provider_message_id: r.providerMessageId })
    expect(out.internet_message_id).toBe(`${r.providerMessageId}@email.amazonses.com`)
    expect(await thread(a.threadId)).toMatchObject({ unread_count: 0, last_message_direction: 'outbound' })
    expect(await audit('support_reply_sent', a.threadId)).toHaveLength(1)
  })

  test('the customer\'s reply to OUR message (via the captured Message-ID) lands in the same thread', async () => {
    needDb()
    const email = emailFor('d7b')
    const a = await ingest({ fromEmail: email, subject: 'Return?' })
    const fm = fakeMailer()
    const r = await svc().sendReply({ threadId: a.threadId, body: 'Sure', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test' }, fm.mailer)
    const outMid = (await msgs(a.threadId)).find(m => m.direction === 'outbound')!.internet_message_id
    const back = await ingest({ fromEmail: email, subject: 'Something else entirely', inReplyTo: `<${outMid}>` })
    expect([back.matchedBy, back.threadId]).toEqual(['in_reply_to', a.threadId])
    // and our NEXT reply threads under the customer's latest message, with a growing References chain
    const fm2 = fakeMailer()
    await svc().sendReply({ threadId: a.threadId, body: 'Follow up', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test' }, fm2.mailer)
    const latest = (await msgs(a.threadId)).filter(m => m.direction === 'inbound').pop()!.internet_message_id
    expect(fm2.sent[0].inReplyTo).toBe(`<${latest}>`)
    expect(fm2.sent[0].references!.split(' ')).toEqual(expect.arrayContaining([`<${latest}>`]))
    expect(r.providerMessageId).toBeTruthy()
  })

  test('provider FAILURE: nothing is stored, nothing audited, thread unchanged, a clear error', async () => {
    needDb()
    const email = emailFor('d7c')
    const a = await ingest({ fromEmail: email })
    const before = await thread(a.threadId)
    for (const fail of [
      { ok: false, code: 'provider_error', message: 'Email provider returned HTTP 500. Nothing was sent.' },
      { ok: false, code: 'network', message: 'Could not reach the email provider. Nothing was sent.' },
      { ok: false, code: 'sender_not_verified', message: 'verify kvrn.shop' },
      { ok: false, code: 'not_configured', message: 'not configured' },
    ] as SupportSendOutcome[]) {
      const fm = fakeMailer({ fail })
      await expect(svc().sendReply({ threadId: a.threadId, body: 'x', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test' }, fm.mailer))
        .rejects.toMatchObject({ status: (fail as any).code === 'not_configured' ? 503 : 502 })
    }
    expect(await msgs(a.threadId)).toHaveLength(1)
    expect(await audit('support_reply_sent', a.threadId)).toHaveLength(0)
    const after = await thread(a.threadId)
    expect([after.unread_count, after.last_message_direction]).toEqual([before.unread_count, before.last_message_direction])
  })

  test('unverified sender surfaces the exact fix and stores nothing', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d7d') })
    const { SENDER_NOT_VERIFIED_MESSAGE } = jest.requireActual('../support-email')
    const fm = fakeMailer({ fail: { ok: false, code: 'sender_not_verified', message: SENDER_NOT_VERIFIED_MESSAGE } })
    const err = await svc().sendReply({ threadId: a.threadId, body: 'x', clientRequestId: uuid(), actorEmail: 'a@b.co' }, fm.mailer).catch(e => e)
    expect(err).toBeInstanceOf(SupportError)
    expect([err.code, err.status]).toEqual(['sender_not_verified', 502])
    expect(err.message).toMatch(/verify the kvrn\.shop domain/)
    expect(await msgs(a.threadId)).toHaveLength(1)
  })

  test('Message-ID read-back failing (null or throwing) never makes a successful send look failed', async () => {
    needDb()
    for (const opts of [{ noMessageId: true }, { throwOnRetrieve: true }]) {
      const email = emailFor(`d7e${Object.keys(opts)[0]}`)
      const a = await ingest({ fromEmail: email })
      const fm = fakeMailer(opts)
      const r = await svc().sendReply({ threadId: a.threadId, body: 'ok', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test' }, fm.mailer)
      expect(r.internetMessageIdCaptured).toBe(false)
      const out = (await msgs(a.threadId)).find(m => m.direction === 'outbound')!
      expect([out.provider_message_id, out.internet_message_id]).toEqual([r.providerMessageId, null])
      // …and the customer's reply still threads, by the conservative subject fallback
      const back = await ingest({ fromEmail: email, subject: 'Re: Hello' })
      expect([back.matchedBy, back.threadId]).toEqual(['subject', a.threadId])
    }
  })

  test('the same clientRequestId never sends twice; it is bound to its thread', async () => {
    needDb()
    const email = emailFor('d7f'); const a = await ingest({ fromEmail: email }); const other = await ingest({ fromEmail: emailFor('d7f2') })
    const fm = fakeMailer(); const rid = uuid()
    const one = await svc().sendReply({ threadId: a.threadId, body: 'once', clientRequestId: rid, actorEmail: 'admin@kvrn.test' }, fm.mailer)
    const two = await svc().sendReply({ threadId: a.threadId, body: 'once', clientRequestId: rid, actorEmail: 'admin@kvrn.test' }, fm.mailer)
    expect([one.duplicate, two.duplicate, two.messageId]).toEqual([false, true, one.messageId])
    expect(fm.calls()).toBe(1)
    await expect(svc().sendReply({ threadId: other.threadId, body: 'once', clientRequestId: rid, actorEmail: 'admin@kvrn.test' }, fm.mailer))
      .rejects.toMatchObject({ code: 'duplicate_conflict', status: 409 })
    expect(fm.calls()).toBe(1)
    expect((await msgs(a.threadId)).filter(m => m.direction === 'outbound')).toHaveLength(1)
  })

  test('validation: empty, whitespace, over-long, missing/invalid request id, unknown thread, no identity → nothing sent', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d7g') })
    const fm = fakeMailer()
    const go = (o: Record<string, unknown>) => svc().sendReply({ threadId: a.threadId, body: 'ok', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test', ...o } as any, fm.mailer)
    await expect(go({ body: '' })).rejects.toMatchObject({ code: 'empty_body', status: 400 })
    await expect(go({ body: ' \n\t ' })).rejects.toMatchObject({ code: 'empty_body' })
    await expect(go({ body: 'x'.repeat(20_001) })).rejects.toMatchObject({ code: 'body_too_long' })
    await expect(go({ clientRequestId: '' })).rejects.toMatchObject({ status: 400 })
    await expect(go({ clientRequestId: 'not-a-uuid' })).rejects.toMatchObject({ status: 400 })
    await expect(go({ threadId: uuid() })).rejects.toMatchObject({ status: 404 })
    await expect(go({ threadId: 'nope' })).rejects.toMatchObject({ status: 404 })
    await expect(go({ actorEmail: '' })).rejects.toMatchObject({ status: 401 })
    expect(fm.calls()).toBe(0)
  })

  test('a thread addressed to the support mailbox itself is refused (mail-loop guard)', async () => {
    needDb()
    const a = await ingest({ fromEmail: 'support@kvrn.shop', subject: 'loop' })
    const fm = fakeMailer()
    await expect(svc().sendReply({ threadId: a.threadId, body: 'x', clientRequestId: uuid(), actorEmail: 'a@b.co' }, fm.mailer))
      .rejects.toMatchObject({ code: 'self_recipient', status: 422 })
    expect(fm.calls()).toBe(0)
  })

  test('SENT BUT NOT RECORDED: reported loudly with the provider id; retrying the SAME request records it without a second email', async () => {
    needDb()
    const email = emailFor('d7h'); const a = await ingest({ fromEmail: email })
    const fm = fakeMailer(); const rid = uuid()
    let failRecord = true
    const flaky: any = Object.assign((...x: any[]) => (F.sql as any)(...x), {
      query: async (t: string, p: unknown[]) => {
        if (failRecord && /support_record_outbound/.test(t)) throw new Error('connection reset by peer')
        return F.sql.query(t, p)
      } })
    const input = { threadId: a.threadId, body: 'important', clientRequestId: rid, actorEmail: 'admin@kvrn.test' }
    const err = await createSupportService(flaky, { sleep: async () => {} }).sendReply(input, fm.mailer).catch(e => e)
    expect([err.code, err.status]).toEqual(['sent_not_recorded', 502])
    expect(err.message).toMatch(/WAS sent/)
    expect(err.extra?.providerMessageId).toMatch(/^re_/)
    expect((await msgs(a.threadId)).filter(m => m.direction === 'outbound')).toHaveLength(0)
    failRecord = false
    const ok = await svc().sendReply(input, fm.mailer)                  // same request id, same body
    expect(ok.providerMessageId).toBe(err.extra.providerMessageId)       // provider idempotency returned the same email
    expect(fm.sent).toHaveLength(1)                                      // ONE email actually went out
    expect((await msgs(a.threadId)).filter(m => m.direction === 'outbound')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D8. route handlers', () => {
  const j = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
  const out = async (res: Response) => ({ status: res.status, body: await res.json() })

  beforeEach(() => { (global as any).__ADMIN = undefined; (global as any).__SUP_SQL = F?.sql; (global as any).__MAILER = fakeMailer().mailer })
  afterAll(() => { delete process.env.SUPPORT_EMAIL_INGEST_SECRET; delete process.env.SUPPORT_FORWARD_TO; delete process.env.RESEND_API_KEY })

  test('every admin support route is DENIED without admin auth and touches nothing', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d8a') })
    const fm = fakeMailer(); ;(global as any).__MAILER = fm.mailer
    ;(global as any).__ADMIN = null
    const L = require('../../app/api/admin/support/threads/route')
    const T = require('../../app/api/admin/support/threads/[id]/route')
    const R = require('../../app/api/admin/support/threads/[id]/read/route')
    const S = require('../../app/api/admin/support/threads/[id]/status/route')
    const P = require('../../app/api/admin/support/threads/[id]/reply/route')
    const id = a.threadId
    expect((await L.GET(j('/api/admin/support/threads', 'GET'))).status).toBe(401)
    expect((await T.GET(j(`/x`, 'GET'), ctx(id))).status).toBe(401)
    expect((await R.POST(j(`/x`, 'POST'), ctx(id))).status).toBe(401)
    expect((await S.POST(j(`/x`, 'POST', { status: 'closed' }), ctx(id))).status).toBe(401)
    expect((await P.POST(j(`/x`, 'POST', { body: 'hi', clientRequestId: uuid() }), ctx(id))).status).toBe(401)
    expect(fm.calls()).toBe(0)
    expect(await thread(id)).toMatchObject({ status: 'open', unread_count: 1 })
    expect(await msgs(id)).toHaveLength(1)
  })

  test('list / get / read / status / reply as admin; reply cannot choose recipient, sender or subject', async () => {
    needDb()
    const email = emailFor('d8b'); const a = await ingest({ fromEmail: email, subject: 'Route test', fromName: 'Route Tester' })
    const L = require('../../app/api/admin/support/threads/route')
    const T = require('../../app/api/admin/support/threads/[id]/route')
    const R = require('../../app/api/admin/support/threads/[id]/read/route')
    const S = require('../../app/api/admin/support/threads/[id]/status/route')
    const P = require('../../app/api/admin/support/threads/[id]/reply/route')
    const fm = fakeMailer(); ;(global as any).__MAILER = fm.mailer
    ;(global as any).__ADMIN = 'ops@kvrn.test'

    const list = await out(await L.GET(j(`/api/admin/support/threads?status=open&q=${encodeURIComponent('Route Tester')}`, 'GET')))
    expect(list.status).toBe(200)
    expect(list.body.threads.map((t: any) => t.id)).toContain(a.threadId)
    expect((await out(await L.GET(j('/api/admin/support/threads?cursor=junk', 'GET')))).status).toBe(400)

    const got = await out(await T.GET(j('/x', 'GET'), ctx(a.threadId)))
    expect(got.status).toBe(200)
    expect(got.body.thread.messages).toHaveLength(1)
    expect((await out(await T.GET(j('/x', 'GET'), ctx(uuid())))).status).toBe(404)
    expect((await out(await T.GET(j('/x', 'GET'), ctx('bad')))).status).toBe(404)

    expect((await out(await R.POST(j('/x', 'POST'), ctx(a.threadId)))).body).toEqual({ ok: true, cleared: true })
    expect((await out(await R.POST(j('/x', 'POST'), ctx(uuid())))).status).toBe(404)

    expect((await out(await S.POST(j('/x', 'POST', { status: 'bogus' }), ctx(a.threadId)))).status).toBe(400)
    expect((await out(await S.POST(j('/x', 'POST', {}), ctx(a.threadId)))).status).toBe(400)
    expect((await out(await S.POST(j('/x', 'POST', { status: 'closed' }), ctx(a.threadId)))).body).toMatchObject({ ok: true, changed: true, status: 'closed' })
    expect((await audit('support_thread_closed', a.threadId))[0].actor_email).toBe('ops@kvrn.test')

    const rid = uuid()
    const ok = await out(await P.POST(j('/x', 'POST', {
      body: 'Hello from admin', clientRequestId: rid,
      to: 'attacker@evil.com', from: 'ceo@evil.com', subject: 'phish', recipient: 'attacker@evil.com' }), ctx(a.threadId)))
    expect(ok.status).toBe(200)
    expect(fm.sent[0]).toMatchObject({ to: email, subject: 'Re: Route test' })
    expect(JSON.stringify(fm.sent[0])).not.toMatch(/attacker|phish|ceo@evil/)
    expect((await out(await P.POST(j('/x', 'POST', { body: 'Hello from admin', clientRequestId: rid }), ctx(a.threadId)))).body.duplicate).toBe(true)
    expect(fm.calls()).toBe(1)
    expect((await out(await P.POST(j('/x', 'POST', { clientRequestId: uuid() }), ctx(a.threadId)))).status).toBe(400)
    expect((await out(await P.POST(j('/x', 'POST', { body: '   ', clientRequestId: uuid() }), ctx(a.threadId)))).status).toBe(400)
    expect((await out(await P.POST(j('/x', 'POST', { body: 'x', clientRequestId: 'bad' }), ctx(a.threadId)))).status).toBe(400)
    expect((await audit('support_reply_sent', a.threadId))[0].actor_email).toBe('ops@kvrn.test')
  })

  test('reply route: provider failure → HTTP 502 with the reason; nothing stored', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d8c') })
    ;(global as any).__MAILER = fakeMailer({ fail: { ok: false, code: 'sender_not_verified', message: 'Resend refused; verify the kvrn.shop domain' } }).mailer
    const P = require('../../app/api/admin/support/threads/[id]/reply/route')
    const r = await out(await P.POST(j('/x', 'POST', { body: 'hi', clientRequestId: uuid() }), ctx(a.threadId)))
    expect([r.status, r.body.code]).toEqual([502, 'sender_not_verified'])
    expect(r.body.ok).toBeUndefined()
    expect(await msgs(a.threadId)).toHaveLength(1)
  })

  test('with no RESEND_API_KEY the real mailer fails closed (503) and stores nothing', async () => {
    needDb()
    const a = await ingest({ fromEmail: emailFor('d8c2') })
    delete process.env.RESEND_API_KEY
    ;(global as any).__MAILER = jest.requireActual('../support-email').getSupportMailer()
    const P = require('../../app/api/admin/support/threads/[id]/reply/route')
    const r = await out(await P.POST(j('/x', 'POST', { body: 'hi', clientRequestId: uuid() }), ctx(a.threadId)))
    expect([r.status, r.body.code]).toEqual([503, 'not_configured'])
    expect(await msgs(a.threadId)).toHaveLength(1)
  })

  const ING = () => require('../../app/api/internal/support-email-ingest/route')
  const ingBody = (over: Record<string, unknown> = {}) => payload({ fromEmail: emailFor('d8ing'), ...over })

  test('ingest route: unconfigured → 503; missing / wrong / near-miss secret → 401 and NOTHING is stored', async () => {
    needDb()
    const count = async () => Number((await q('SELECT count(*) AS n FROM support_messages'))[0].n)
    const before = await count()
    delete process.env.SUPPORT_EMAIL_INGEST_SECRET
    expect((await ING().POST(j('/api/internal/support-email-ingest', 'POST', ingBody(), { authorization: 'Bearer x' }))).status).toBe(503)
    process.env.SUPPORT_EMAIL_INGEST_SECRET = 'right-secret-value'
    for (const h of [{}, { authorization: 'Bearer wrong' }, { authorization: 'right-secret-value' }, { authorization: 'Bearer right-secret-valu' },
      { authorization: 'Bearer right-secret-value2' }, { authorization: 'Basic cmlnaHQ6' }]) {
      expect((await ING().POST(j('/api/internal/support-email-ingest', 'POST', ingBody(), h as any))).status).toBe(401)
    }
    expect(await count()).toBe(before)
  })

  test('ingest route: valid → stored; repeat → duplicate; independent of admin auth; generic errors', async () => {
    needDb()
    process.env.SUPPORT_EMAIL_INGEST_SECRET = 'right-secret-value'
    ;(global as any).__ADMIN = null                                    // the route must not depend on admin auth
    const auth = { authorization: 'Bearer right-secret-value' }
    const b = ingBody({ subject: 'Ingest route' })
    const r1 = await out(await ING().POST(j('/api/internal/support-email-ingest', 'POST', b, auth)))
    expect([r1.status, r1.body]).toEqual([200, { ok: true, duplicate: false, threadCreated: true, matchedBy: 'new' }])
    const r2 = await out(await ING().POST(j('/api/internal/support-email-ingest', 'POST', b, auth)))
    expect([r2.status, r2.body.duplicate]).toEqual([200, true])
    expect((await ING().POST(new NextRequest('http://localhost/x', { method: 'POST', body: '{not json', headers: auth }))).status).toBe(400)
    const wrong = await out(await ING().POST(j('/x', 'POST', ingBody({ envelopeTo: 'orders@kvrn.shop' }), auth)))
    expect([wrong.status, wrong.body.code]).toEqual([422, 'wrong_recipient'])
    expect((await ING().POST(j('/x', 'POST', ingBody({ fromEmail: 'nope', envelopeFrom: '' }), auth))).status).toBe(422)
    expect((await ING().POST(j('/x', 'POST', ingBody({ text: 'x'.repeat(2_100_000) }), auth))).status).toBe(413)
    expect(ING().GET).toBeUndefined()
    expect(ING().PUT).toBeUndefined()
  })

  test('ingest route: a storage failure returns a generic 500 (so the Worker retries) with no internals', async () => {
    needDb()
    process.env.SUPPORT_EMAIL_INGEST_SECRET = 'right-secret-value'
    ;(global as any).__SUP_SQL = Object.assign(async () => { throw new Error('password authentication failed for user x') },
      { query: async () => { throw new Error('password authentication failed for user x') } })
    const r = await out(await ING().POST(j('/x', 'POST', ingBody(), { authorization: 'Bearer right-secret-value' })))
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toMatch(/password|postgres|user x/i)
  })

  // ── contact form ──────────────────────────────────────────────────────────
  const CONTACT = () => require('../../app/api/contact/route')
  const form = (over: Record<string, unknown> = {}) => ({
    firstName: 'Cora', lastName: 'Contact', email: emailFor('d8form'), orderNumber: '', subject: 'Return request',
    message: 'I would like to return my order', ...over })
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch; delete process.env.SUPPORT_FORWARD_TO; delete process.env.RESEND_API_KEY })

  test('contact form: the message is PERSISTED and appears in Admin → Support immediately', async () => {
    needDb()
    const email = emailFor('d8form1')
    const res = await out(await CONTACT().POST(j('/api/contact', 'POST', form({ email, orderNumber: 'KVRN-009999' }))))
    expect([res.status, res.body]).toEqual([200, { success: true }])
    const L = require('../../app/api/admin/support/threads/route')
    const list = await out(await L.GET(j(`/api/admin/support/threads?q=${encodeURIComponent(email)}`, 'GET')))
    expect(list.body.threads).toHaveLength(1)
    expect(list.body.threads[0]).toMatchObject({ source: 'contact_form', customerName: 'Cora Contact', orderNumber: 'KVRN-009999',
      subject: 'Return request', unreadCount: 1, preview: 'I would like to return my order' })
  })

  test('contact form: PERSISTENCE FAILURE → failure response, never { success: true }, and no owner notification', async () => {
    needDb()
    process.env.SUPPORT_FORWARD_TO = 'owner@example.org'; process.env.RESEND_API_KEY = 're_test'
    const fetchSpy = jest.fn(async () => ({ ok: true }) as any); global.fetch = fetchSpy as any
    ;(global as any).__SUP_SQL = Object.assign(async () => { throw new Error('db down') }, { query: async () => { throw new Error('db down') } })
    const res = await out(await CONTACT().POST(j('/api/contact', 'POST', form())))
    expect(res.status).toBe(500)
    expect(res.body.success).toBe(false)
    expect(JSON.stringify(res.body)).not.toMatch(/db down|owner@example/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('contact form: validation failures are 400 and store nothing', async () => {
    needDb()
    const count = async () => Number((await q('SELECT count(*) AS n FROM support_messages'))[0].n)
    const before = await count()
    for (const bad of [form({ firstName: '' }), form({ email: 'nope' }), form({ message: '' }), form({ subject: '' }),
      form({ email: 'support@kvrn.shop' }), form({ message: 'x'.repeat(5001) })]) {
      const r = await out(await CONTACT().POST(j('/api/contact', 'POST', bad)))
      expect([r.status, r.body.success]).toEqual([400, false])
    }
    expect((await out(await CONTACT().POST(new NextRequest('http://localhost/api/contact', { method: 'POST', body: '{bad' })))).status).toBe(400)
    expect(await count()).toBe(before)
    expect((await CONTACT().GET()).status).toBe(405)
  })

  test('contact form: owner notification goes to SUPPORT_FORWARD_TO (server-side), escapes HTML, is never exposed to the browser', async () => {
    needDb()
    process.env.SUPPORT_FORWARD_TO = 'owner-private@example.org'; process.env.RESEND_API_KEY = 're_test'
    const fetchSpy = jest.fn(async () => ({ ok: true }) as any); global.fetch = fetchSpy as any
    const res = await CONTACT().POST(j('/api/contact', 'POST', form({ email: emailFor('d8form2'), firstName: '<b>Hax</b>', message: '<script>alert(1)</script>' })))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).not.toMatch(/owner-private|example\.org/)
    expect(res.headers.get('x-forwarded-to')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as any
    expect(url).toBe('https://api.resend.com/emails')
    const sent = JSON.parse(init.body)
    expect(sent.to).toEqual(['owner-private@example.org'])
    expect(sent.html).not.toMatch(/<script|<b>Hax/)
    expect(sent.html).toContain('&lt;script&gt;')
  })

  test('contact form: owner notification is fail-open (provider error / throw → still success, message stored)', async () => {
    needDb()
    process.env.SUPPORT_FORWARD_TO = 'owner@example.org'; process.env.RESEND_API_KEY = 're_test'
    for (const f of [async () => ({ ok: false, status: 500 }), async () => { throw new Error('network') }]) {
      global.fetch = jest.fn(f as any) as any
      const email = emailFor(`d8form3${seq++}`)
      const res = await out(await CONTACT().POST(j('/api/contact', 'POST', form({ email }))))
      expect([res.status, res.body.success]).toEqual([200, true])
      expect((await svc().listThreads({ q: email })).threads).toHaveLength(1)
    }
  })

  test('contact form: a duplicate submission id succeeds without a second thread or a second notification', async () => {
    needDb()
    process.env.SUPPORT_FORWARD_TO = 'owner@example.org'; process.env.RESEND_API_KEY = 're_test'
    const fetchSpy = jest.fn(async () => ({ ok: true }) as any); global.fetch = fetchSpy as any
    const email = emailFor('d8form4'); const sid = uuid()
    for (let i = 0; i < 2; i++) expect((await CONTACT().POST(j('/api/contact', 'POST', form({ email, submissionId: sid })))).status).toBe(200)
    expect((await svc().listThreads({ q: email })).threads).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('contact form: no SUPPORT_FORWARD_TO → no email attempt, still stored and successful', async () => {
    needDb()
    const fetchSpy = jest.fn(); global.fetch = fetchSpy as any
    const email = emailFor('d8form5')
    expect((await CONTACT().POST(j('/api/contact', 'POST', form({ email })))).status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await svc().listThreads({ q: email })).threads).toHaveLength(1)
  })

  test('contact form: abuse guard — the 6th message from one address within an hour is refused (429) and not stored', async () => {
    needDb()
    const email = emailFor('d8rate')
    for (let i = 0; i < 5; i++) expect((await CONTACT().POST(j('/api/contact', 'POST', form({ email, message: `m${i}` })))).status).toBe(200)
    const r = await out(await CONTACT().POST(j('/api/contact', 'POST', form({ email, message: 'm6' }))))
    expect([r.status, r.body.success]).toEqual([429, false])
    expect((await q(`SELECT count(*)::int AS n FROM support_messages WHERE from_email=$1`, [email]))[0].n).toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D9. end to end: raw MIME → Email Worker handler → ingest route → admin reply → customer reply', () => {
  const email = () => emailFor('d9')
  const mime = (o: { subject: string; messageId: string; inReplyTo?: string; refs?: string; body: string; attachment?: boolean }) => [
    `From: "Eve Customer" <${email()}>`, 'To: support@kvrn.shop', `Subject: ${o.subject}`, `Message-ID: ${o.messageId}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []), ...(o.refs ? [`References: ${o.refs}`] : []),
    'Date: Mon, 05 Oct 2026 10:00:00 +0000', 'MIME-Version: 1.0',
    ...(o.attachment
      ? ['Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain; charset=utf-8', '', o.body, '--B',
         'Content-Type: image/png; name="photo.png"', 'Content-Disposition: attachment; filename="photo.png"', 'Content-Transfer-Encoding: base64', '',
         Buffer.from('PNGBINARYDATA').toString('base64'), '--B--', '']
      : ['Content-Type: text/plain; charset=utf-8', '', o.body, '']),
  ].join('\r\n')

  async function deliver(raw: string) {
    const bytes = new TextEncoder().encode(raw)
    const forwards: string[] = []; const rejects: string[] = []
    const ING = require('../../app/api/internal/support-email-ingest/route')
    const outcome = await handleSupportEmail({
      from: 'bounce@m.example', to: 'support@kvrn.shop', headers: new Headers(), rawSize: bytes.length,
      raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }),
      async forward(to) { forwards.push(to); return {} }, setReject(r) { rejects.push(r) },
    }, { SUPPORT_FORWARD_TO: 'owner@example.org', SUPPORT_EMAIL_INGEST_SECRET: 'e2e-secret' }, {
      parseMime: raw => PostalMime.parse(raw) as any,
      ingest: req => ING.POST(new NextRequest(req.url, { method: 'POST', body: req.body as any, headers: req.headers, duplex: 'half' } as any)),
    })
    return { outcome, forwards, rejects }
  }

  test('the whole conversation stays in one thread, with attachment metadata only', async () => {
    needDb()
    process.env.SUPPORT_EMAIL_INGEST_SECRET = 'e2e-secret'
    ;(global as any).__SUP_SQL = F.sql; ;(global as any).__ADMIN = undefined
    // 1. customer emails support@ (with an attachment)
    const m1 = `<cust.1.${PID}@mail.example>`
    const d1 = await deliver(mime({ subject: 'Wrong size', messageId: m1, body: 'I received the wrong size', attachment: true }))
    expect(d1.outcome).toEqual({ outcome: 'handled', forwarded: true, ingested: true })
    expect(d1.forwards).toEqual(['owner@example.org'])
    const [t] = (await svc().listThreads({ q: email() })).threads
    expect(t).toMatchObject({ customerName: 'Eve Customer', subject: 'Wrong size', unreadCount: 1, attachmentCount: 1, source: 'email' })
    const detail = await svc().getThread(t.id)
    expect(detail!.messages[0].attachments).toEqual([{ filename: 'photo.png', mimeType: 'image/png', size: 13, disposition: 'attachment' }])
    expect(JSON.stringify(await q('SELECT * FROM support_messages WHERE thread_id=$1', [t.id]))).not.toMatch(/PNGBINARYDATA|UE5HQklOQVJZREFUQQ/)

    // 2. redelivery of the same email changes nothing
    await deliver(mime({ subject: 'Wrong size', messageId: m1, body: 'I received the wrong size', attachment: true }))
    expect(await msgs(t.id)).toHaveLength(1)

    // 3. the admin replies; the system captures the outbound Message-ID
    const fm = fakeMailer()
    await svc().sendReply({ threadId: t.id, body: 'Sorry about that — we will send the right size.', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test' }, fm.mailer)
    expect(fm.sent[0]).toMatchObject({ to: email(), inReplyTo: m1.toLowerCase() })
    const ours = (await msgs(t.id)).find(m => m.direction === 'outbound')!.internet_message_id

    // 4. the customer replies from their mail client (In-Reply-To = our message) with a changed subject
    const d4 = await deliver(mime({ subject: 'Re: Wrong size (photo)', messageId: `<cust.2.${PID}@mail.example>`, inReplyTo: `<${ours}>`, refs: `${m1} <${ours}>`, body: 'Thank you!' }))
    expect(d4.outcome.outcome).toBe('handled')
    const final = await svc().getThread(t.id)
    expect(final!.messages.map(m => [m.direction, m.bodyText.trim().slice(0, 12)])).toEqual([
      ['inbound', 'I received t'], ['outbound', 'Sorry about '], ['inbound', 'Thank you!']])
    expect(final).toMatchObject({ unreadCount: 1, lastMessageDirection: 'inbound' })
    expect((await svc().listThreads({ q: email() })).threads).toHaveLength(1)        // still ONE conversation
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D10. nothing outside the support tables changed', () => {
  test('orders / payments / inventory / FIFO / refund / cancellation tables are untouched by the whole suite', async () => {
    needDb()
    for (const t of ['orders', 'order_items', 'order_refunds', 'order_cancellations', 'product_variants',
      'inventory_cost_layers', 'inventory_layer_consumptions', 'inventory_movements', 'stripe_events']) {
      const n = await q(`SELECT count(*)::int AS n FROM ${t}`).catch(() => [{ n: 0 }])
      expect([t, n[0].n]).toEqual([t, 0])
    }
    const audits = await q(`SELECT DISTINCT action FROM admin_audit_logs ORDER BY 1`)
    expect(audits.map(r => r.action).sort()).toEqual(['support_reply_sent', 'support_thread_closed', 'support_thread_reopened'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describeDB('D11. review hardening', () => {
  test('same Message-ID from two DIFFERENT senders: both stored; the second without the id and with a note; redeliveries stay duplicates', async () => {
    needDb()
    const shared = `<weak.${++seq}.${PID}@localhost>`
    const a = await ingest({ fromEmail: emailFor('d11a1'), messageId: shared, subject: 'Weak mailer A' })
    const pB = payload({ fromEmail: emailFor('d11a2'), messageId: shared, subject: 'Weak mailer B' })
    const b = await svc().ingestInboundEmail(buildInboundEmailInput(pB))
    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(false)
    expect(b.threadId).not.toBe(a.threadId)
    const [mb] = await msgs(b.threadId)
    expect(mb.internet_message_id).toBeNull()
    expect(String(mb.import_note)).toMatch(/already used by a different sender/)
    // redelivery of B (same sender) is a duplicate, not a third message
    const b2 = await svc().ingestInboundEmail(buildInboundEmailInput({ ...pB, dedupeDigest: sha() }))
    expect(b2.duplicate).toBe(true)
    expect(b2.messageId).toBe(b.messageId)
    // and a header match to the shared id still goes to the ORIGINAL owner of it
    const [ma] = await msgs(a.threadId)
    expect(ma.internet_message_id).toBe(shared.toLowerCase().replace(/^<|>$/g, ''))      // stored normalized (no brackets)
  })

  test('an out-of-range Date reaching SQL is stored (arrival time) and never makes the message unstorable', async () => {
    needDb()
    const input = buildInboundEmailInput(payload({ fromEmail: emailFor('d11b') }))
    const r = await (F.sql as any).query('SELECT support_ingest_message($1::jsonb) AS r',
      [JSON.stringify({ ...JSON.parse(JSON.stringify(
        // build the SQL payload through the service path, then poison the date
        await captureSqlPayload(input))), occurred_at: '999999-13-45 25:61:61' })])
    expect(r[0].r.duplicate).toBe(false)
    const [m] = await msgs(r[0].r.thread_id)
    expect(Math.abs(new Date(m.occurred_at).getTime() - Date.now())).toBeLessThan(60_000)
  })

  test('markRead with a seen message id leaves LATER customer messages unread; without it everything clears', async () => {
    needDb()
    const email = emailFor('d11c')
    const a = await ingest({ fromEmail: email, subject: 'Seen test' })
    const b = await ingest({ fromEmail: email, subject: 'Seen test', messageId: mid() })
    expect(b.threadId).toBe(a.threadId)
    expect((await thread(a.threadId)).unread_count).toBe(2)
    expect(await svc().markRead(a.threadId, a.messageId)).toEqual({ found: true, cleared: true })
    expect((await thread(a.threadId)).unread_count).toBe(1)                    // B arrived after what the admin saw
    expect(await svc().markRead(a.threadId, b.messageId)).toEqual({ found: true, cleared: true })
    expect((await thread(a.threadId)).unread_count).toBe(0)
    expect(await svc().markRead(a.threadId, b.messageId)).toEqual({ found: true, cleared: false })
    await expect(svc().markRead(a.threadId, 'not-a-uuid')).rejects.toMatchObject({ status: 400 })
  })

  test('a customer message that arrives WHILE a reply is being sent stays unread', async () => {
    needDb()
    const email = emailFor('d11d')
    const a = await ingest({ fromEmail: email, subject: 'Mid-send' })
    const inner = fakeMailer()
    const mailer: SupportMailer = {
      async send(m) {
        // the customer writes again while the admin's reply is in flight
        await ingest({ fromEmail: email, subject: 'Mid-send', messageId: mid(), text: 'one more thing' })
        return inner.mailer.send(m)
      },
      retrieveMessageId: inner.mailer.retrieveMessageId,
    }
    await svc().sendReply({ threadId: a.threadId, body: 'On it', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test' }, mailer)
    const t = await thread(a.threadId)
    expect(t.unread_count).toBe(1)                                             // the new customer message was NOT silently marked read
    expect((await msgs(a.threadId)).map(m => m.direction).sort()).toEqual(['inbound', 'inbound', 'outbound'])
  })

  test('contact form: the longest allowed first + last name is stored (no CHECK failure)', async () => {
    needDb()
    const r = await svc().recordContactSubmission({
      firstName: 'A'.repeat(100), lastName: 'B'.repeat(100), email: emailFor('d11e'), orderNumber: null,
      subject: 'Long name', message: 'hello', submissionId: null,
    })
    expect(r.duplicate).toBe(false)
    expect((await thread(r.threadId)).customer_name.length).toBeLessThanOrEqual(200)   // capped to the column limit, never rejected
  })

  test('replying to a thread with a ~998-char subject records (sent subject == stored subject, <= 998)', async () => {
    needDb()
    const longSubject = 'S'.repeat(990)
    const a = await ingest({ fromEmail: emailFor('d11f'), subject: longSubject })
    const fm = fakeMailer()
    await svc().sendReply({ threadId: a.threadId, body: 'ok', clientRequestId: uuid(), actorEmail: 'admin@kvrn.test' }, fm.mailer)
    const o = (await msgs(a.threadId)).find(m => m.direction === 'outbound')!
    expect(o.subject.length).toBeLessThanOrEqual(998)
    expect(fm.sent[0].subject).toBe(o.subject)
  })

  describe('routes', () => {
    const j = (url: string, method: string, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
      new NextRequest(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers })
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
    beforeEach(() => { (global as any).__ADMIN = 'ops@kvrn.test'; (global as any).__SUP_SQL = F?.sql; (global as any).__MAILER = fakeMailer().mailer })
    afterAll(() => { (global as any).__ADMIN = undefined })

    test('read route: seenMessageId clears only what was seen; an invalid id is 400 and changes nothing', async () => {
      needDb()
      const email = emailFor('d11g')
      const a = await ingest({ fromEmail: email, subject: 'Route seen' })
      const b = await ingest({ fromEmail: email, subject: 'Route seen', messageId: mid() })
      const R = require('../../app/api/admin/support/threads/[id]/read/route')
      const bad = await R.POST(j('/x', 'POST', { seenMessageId: 'nope' }), ctx(a.threadId))
      expect(bad.status).toBe(400)
      expect((await thread(a.threadId)).unread_count).toBe(2)
      const ok = await R.POST(j('/x', 'POST', { seenMessageId: a.messageId }), ctx(a.threadId))
      expect(ok.status).toBe(200)
      expect((await thread(a.threadId)).unread_count).toBe(1)
      expect((await R.POST(j('/x', 'POST', { seenMessageId: b.messageId }), ctx(a.threadId))).status).toBe(200)
      expect((await thread(a.threadId)).unread_count).toBe(0)
    })

    test('status and reply routes require a JSON content-type (415) and do nothing otherwise', async () => {
      needDb()
      const a = await ingest({ fromEmail: emailFor('d11h') })
      const fm = fakeMailer(); ;(global as any).__MAILER = fm.mailer
      const S = require('../../app/api/admin/support/threads/[id]/status/route')
      const P = require('../../app/api/admin/support/threads/[id]/reply/route')
      const plain = { 'content-type': 'text/plain' }
      expect((await S.POST(j('/x', 'POST', { status: 'closed' }, plain), ctx(a.threadId))).status).toBe(415)
      expect((await P.POST(j('/x', 'POST', { body: 'hi', clientRequestId: uuid() }, plain), ctx(a.threadId))).status).toBe(415)
      expect(fm.calls()).toBe(0)
      expect(await thread(a.threadId)).toMatchObject({ status: 'open' })
      expect(await msgs(a.threadId)).toHaveLength(1)
    })
  })
})

/** The jsonb the service sends to support_ingest_message, captured without touching a table. */
async function captureSqlPayload(input: ReturnType<typeof buildInboundEmailInput>): Promise<Record<string, unknown>> {
  let captured: any
  const spy: any = {
    query: async (text: string, params: unknown[]) => {
      captured = JSON.parse(String(params[0]))
      return [{ r: { duplicate: true, thread_id: uuid(), message_id: uuid(), thread_created: false, matched_by: 'duplicate' } }]
    },
  }
  await createSupportService(spy, { sleep: async () => {} }).ingestInboundEmail(input)
  return captured
}
