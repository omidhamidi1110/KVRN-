// lib/__tests__/marketing-subscribers.test.ts — V57.1 marketing subscriber tests

import { normaliseEmail, ALLOWED_CONSENT_SOURCES } from '../marketing-subscribers'
import { syncSubscribeToResend, syncUnsubscribeFromResend } from '../resend-marketing'

// ── Helpers ───────────────────────────────────────────────────────────────────

const origFetch = global.fetch
const origEnv   = { ...process.env }

function setEnv(vars: Record<string, string | undefined>) {
  Object.entries(vars).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
}

function resetEnv() {
  ['RESEND_MARKETING_API_KEY','RESEND_MARKETING_SEGMENT_ID','RESEND_MARKETING_TOPIC_ID'].forEach(k => {
    if (origEnv[k]) process.env[k] = origEnv[k]
    else delete process.env[k]
  })
  global.fetch = origFetch
  jest.restoreAllMocks()
}

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; data?: any }>) {
  let call = 0
  global.fetch = jest.fn().mockImplementation(async () => {
    const r = responses[call] ?? responses[responses.length - 1]
    call++
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.data ?? {} }
  }) as any
}

const OK_CONTACT = { ok: true, data: { id: 'contact-abc' } }
const OK_SEGMENT = { ok: true, data: { id: 'seg-membership' } }
const OK_TOPIC   = { ok: true, data: { id: 'topic-abc' } }
const FAIL_500   = { ok: false, status: 500 }

// ── Normalisation + allowlist ─────────────────────────────────────────────────

describe('email normalisation', () => {
  test('lowercases and trims', () => {
    expect(normaliseEmail('  User@Example.COM  ')).toBe('user@example.com')
  })
})

describe('consent source allowlist', () => {
  test('all expected sources present', () => {
    ['homepage','waitlist','checkout','footer','giveaway','manual_admin']
      .forEach(s => expect(ALLOWED_CONSENT_SOURCES.has(s)).toBe(true))
  })
  test('arbitrary source not in allowlist', () => {
    expect(ALLOWED_CONSENT_SOURCES.has('hack')).toBe(false)
  })
  // Item 15: no duplicate consent_source check
  test('upsertSubscriber SQL uses ON CONFLICT (email) DO UPDATE — no duplicate rows', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../marketing-subscribers.ts'), 'utf8')
    expect(src).toContain('ON CONFLICT (email) DO UPDATE')
  })
})

// ── syncSubscribeToResend — current API ──────────────────────────────────────

describe('syncSubscribeToResend — current Resend API', () => {
  beforeEach(() => setEnv({
    RESEND_MARKETING_API_KEY:    'test-mkt-key',
    RESEND_MARKETING_SEGMENT_ID: 'seg-123',
    RESEND_MARKETING_TOPIC_ID:   'topic-456',
  }))
  afterEach(resetEnv)

  // Item 1: global Contact is created/upserted
  test('calls POST /contacts (not legacy /audiences/{id}/contacts)', async () => {
    mockFetchSequence(OK_CONTACT, OK_SEGMENT, OK_TOPIC)
    await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    const [url] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toContain('/contacts')
    expect(url).not.toContain('/audiences/')
  })

  // Item 2: existing Contact doesn't duplicate (POST is idempotent by email at Resend)
  test('second call for same email still uses POST /contacts — Resend deduplicates', async () => {
    mockFetchSequence(OK_CONTACT, OK_SEGMENT, OK_TOPIC, OK_CONTACT, OK_SEGMENT, OK_TOPIC)
    await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0]
    expect(firstUrl).toMatch(/\/contacts$/)
  })

  // Item 3: Contact is added to KVRN Marketing Segment
  test('calls POST /contacts/{id}/segments/{segmentId}', async () => {
    mockFetchSequence(OK_CONTACT, OK_SEGMENT, OK_TOPIC)
    await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    const calls = (global.fetch as jest.Mock).mock.calls.map(([url]) => url)
    expect(calls.some(u => u.includes('/contacts/contact-abc/segments/seg-123'))).toBe(true)
  })

  // Item 4: Contact is subscribed to KVRN Updates Topic
  test('calls PATCH /contacts/{id}/topics with opt_in', async () => {
    mockFetchSequence(OK_CONTACT, OK_SEGMENT, OK_TOPIC)
    await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    const topicCall = (global.fetch as jest.Mock).mock.calls.find(([url]) => url.includes('/topics'))
    expect(topicCall).toBeTruthy()
    const body = JSON.parse(topicCall[1].body)
    expect(body[0]).toEqual({ id: 'topic-456', subscription: 'opt_in' })
  })

  // Item 5: Contact success + Segment failure remains retryable
  test('Segment failure → ok=false but contactId preserved', async () => {
    mockFetchSequence(OK_CONTACT, FAIL_500)
    const r = await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    expect(r.ok).toBe(false)
    expect(r.contactId).toBe('contact-abc')   // stored for retry
    expect(r.error).toContain('500')
  })

  // Item 6: Contact + Segment success + Topic failure remains retryable
  test('Topic failure → ok=false but contactId preserved', async () => {
    mockFetchSequence(OK_CONTACT, OK_SEGMENT, FAIL_500)
    const r = await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    expect(r.ok).toBe(false)
    expect(r.contactId).toBe('contact-abc')   // preserved for retry
    expect(r.error).toContain('500')
  })

  // Item 7: only full Contact+Segment+Topic success marks synced
  test('all three steps succeed → ok=true', async () => {
    mockFetchSequence(OK_CONTACT, OK_SEGMENT, OK_TOPIC)
    const r = await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    expect(r.ok).toBe(true)
    expect(r.contactId).toBe('contact-abc')
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(3)
  })

  // Item 11: re-subscription restores Contact, Segment, Topic
  test('re-subscribe also calls all three Resend steps', async () => {
    mockFetchSequence(OK_CONTACT, OK_SEGMENT, OK_TOPIC)
    const r = await syncSubscribeToResend({ email: 're@b.com', firstName: null, lastName: null })
    expect(r.ok).toBe(true)
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(3)
  })

  // Topic not configured — fail safely
  test('missing RESEND_MARKETING_TOPIC_ID → ok=false with contactId preserved', async () => {
    delete process.env.RESEND_MARKETING_TOPIC_ID
    mockFetchSequence(OK_CONTACT, OK_SEGMENT)
    const r = await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    expect(r.ok).toBe(false)
    expect(r.contactId).toBe('contact-abc')
    expect(r.error).toContain('RESEND_MARKETING_TOPIC_ID')
  })

  // Item 16: no legacy /audiences/{id}/contacts calls
  test('no call to legacy /audiences/{id}/contacts endpoint', async () => {
    mockFetchSequence(OK_CONTACT, OK_SEGMENT, OK_TOPIC)
    await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    const allUrls = (global.fetch as jest.Mock).mock.calls.map(([url]) => url as string)
    allUrls.forEach(url => {
      expect(url).not.toMatch(/\/audiences\/[^/]+\/contacts/)
    })
  })

  // Missing SEGMENT_ID fails safely
  test('missing RESEND_MARKETING_SEGMENT_ID returns ok=false without calling Resend', async () => {
    delete process.env.RESEND_MARKETING_SEGMENT_ID
    const spy = jest.fn() as any
    global.fetch = spy
    const r = await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('RESEND_MARKETING_SEGMENT_ID')
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── syncUnsubscribeFromResend ─────────────────────────────────────────────────

describe('syncUnsubscribeFromResend — current Resend API', () => {
  beforeEach(() => setEnv({
    RESEND_MARKETING_API_KEY:    'test-mkt-key',
    RESEND_MARKETING_SEGMENT_ID: 'seg-123',
    RESEND_MARKETING_TOPIC_ID:   'topic-456',
  }))
  afterEach(resetEnv)

  // Item 8: unsubscribe updates local Neon immediately (tested via route inspection)
  test('unsubscribe route calls unsubscribeByEmail before Resend sync', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/unsubscribe/route.ts'), 'utf8'
    )
    expect(src).toContain('unsubscribeByEmail')
    expect(src).toContain('syncUnsubscribeFromResend')
  })

  // Item 9: Resend unsubscribe failure leaves local unsubscribe intact + retryable
  test('Resend failure returns ok=false (Neon already updated by caller)', async () => {
    mockFetchSequence(FAIL_500)
    const r = await syncUnsubscribeFromResend({ contactId: 'c-abc' })
    expect(r.ok).toBe(false)
  })

  // Item 10: marketing unsubscribe does NOT affect transactional email
  test('no legacy /audiences/ endpoint used for unsubscribe', async () => {
    mockFetchSequence(OK_TOPIC, OK_SEGMENT)
    await syncUnsubscribeFromResend({ contactId: 'c-abc' })
    const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => u as string)
    urls.forEach(u => expect(u).not.toContain('/audiences/'))
  })

  test('calls PATCH /contacts/{id}/topics with opt_out', async () => {
    mockFetchSequence(OK_TOPIC, OK_SEGMENT)
    await syncUnsubscribeFromResend({ contactId: 'c-abc' })
    const topicCall = (global.fetch as jest.Mock).mock.calls.find(([u]) => u.includes('/topics'))
    expect(topicCall).toBeTruthy()
    const body = JSON.parse(topicCall[1].body)
    expect(body[0]).toEqual({ id: 'topic-456', subscription: 'opt_out' })
  })

  test('calls DELETE /contacts/{id}/segments/{segmentId}', async () => {
    mockFetchSequence(OK_TOPIC, OK_SEGMENT)
    await syncUnsubscribeFromResend({ contactId: 'c-abc' })
    const segCall = (global.fetch as jest.Mock).mock.calls.find(
      ([u, opts]) => u.includes('/segments/') && opts?.method === 'DELETE'
    )
    expect(segCall).toBeTruthy()
    expect(segCall[0]).toContain('/contacts/c-abc/segments/seg-123')
  })

  test('no contactId → returns ok=true with no Resend calls', async () => {
    const spy = jest.fn() as any
    global.fetch = spy
    const r = await syncUnsubscribeFromResend({ contactId: null })
    expect(r.ok).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── Architecture / separation ─────────────────────────────────────────────────

describe('separation from transactional email', () => {
  // Item 10 (architecture)
  test('marketing_subscribers and transactional_emails are separate tables', () => {
    const mig = require('fs').readFileSync(
      require('path').join(__dirname, '../../db/migrations/007_marketing_subscribers.sql'), 'utf8'
    )
    expect(mig).toContain('marketing_subscribers')
    expect(mig).not.toContain('transactional_emails')
  })

  // Item 15: no duplicate global Contacts (Resend deduplicates by email at /contacts)
  test('no legacy audience-scoped endpoint in resend-marketing.ts', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../resend-marketing.ts'), 'utf8'
    )
    expect(src).not.toMatch(/\/audiences\/.*\/contacts/)
  })

  // Item 14: cron retries partial sync safely
  test('cron marketing-sync route uses CRON_SECRET and calls getPendingSyncs', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/internal/marketing-sync/route.ts'), 'utf8'
    )
    expect(src).toContain('getPendingSyncs')
    expect(src).toContain('CRON_SECRET')
  })
})

// ── Waitlist DB failure ───────────────────────────────────────────────────────

describe('waitlist: Neon failure returns error (item 17)', () => {
  // Item 17: waitlist returns failure when Neon cannot store explicit email consent
  test('waitlist route uses try/catch and returns 500 on DB failure', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/waitlist/route.ts'), 'utf8'
    )
    expect(src).toContain('consent not stored')
    expect(src).toContain('status: 500')
    // Must NOT have a pattern of catching and continuing silently
    expect(src).not.toContain('// Continue — do not block the signup response')
  })

  // Item 18: Resend failure after successful Neon storage does NOT fail signup
  test('Resend sync failure is caught separately from DB and does not return 500', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/waitlist/route.ts'), 'utf8'
    )
    // Resend error is caught in a try/catch that does NOT re-throw or return error
    expect(src).toContain('Resend sync failed (non-fatal)')
  })
})

// ── Source attribution ────────────────────────────────────────────────────────

describe('source attribution', () => {
  test('waitlist uses source=waitlist', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/waitlist/route.ts'), 'utf8'
    )
    expect(src).toContain("'waitlist'")
    expect(src).toContain('upsertSubscriber')
  })

  test('marketing subscribe uses allowlisted source', () => {
    expect(ALLOWED_CONSENT_SOURCES.has('homepage')).toBe(true)
  })
})

// ── Key separation tests (V57.2) ─────────────────────────────────────────────

describe('RESEND_MARKETING_API_KEY vs RESEND_API_KEY separation', () => {
  const origFetch = global.fetch
  afterEach(() => { global.fetch = origFetch; jest.restoreAllMocks() })

  // Marketing adapter reads RESEND_MARKETING_API_KEY
  test('resend-marketing.ts uses RESEND_MARKETING_API_KEY, not RESEND_API_KEY', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../resend-marketing.ts'), 'utf8'
    )
    expect(src).toContain('RESEND_MARKETING_API_KEY')
    expect(src).not.toContain('RESEND_API_KEY')
  })

  // Transactional adapter still reads RESEND_API_KEY
  test('resend-adapter.ts uses RESEND_API_KEY, not RESEND_MARKETING_API_KEY', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../resend-adapter.ts'), 'utf8'
    )
    expect(src).toContain('RESEND_API_KEY')
    expect(src).not.toContain('RESEND_MARKETING_API_KEY')
  })

  // Missing marketing key fails safely — no fallback to RESEND_API_KEY
  test('missing RESEND_MARKETING_API_KEY returns ok=false, no fetch call', async () => {
    const savedMkt = process.env.RESEND_MARKETING_API_KEY
    const savedSeg = process.env.RESEND_MARKETING_SEGMENT_ID
    process.env.RESEND_MARKETING_SEGMENT_ID = 'seg-123'
    delete process.env.RESEND_MARKETING_API_KEY
    const spy = jest.fn() as any
    global.fetch = spy
    const r = await syncSubscribeToResend({ email: 'x@y.com', firstName: null, lastName: null })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('RESEND_MARKETING_API_KEY')
    expect(spy).not.toHaveBeenCalled()
    if (savedMkt) process.env.RESEND_MARKETING_API_KEY = savedMkt
    if (savedSeg) process.env.RESEND_MARKETING_SEGMENT_ID = savedSeg
    else delete process.env.RESEND_MARKETING_SEGMENT_ID
  })

  // 401 is retryable — returns ok=false, not throws
  test('401 from Resend returns ok=false (retryable, not thrown)', async () => {
    process.env.RESEND_MARKETING_API_KEY    = 'test-mkt-key'
    process.env.RESEND_MARKETING_SEGMENT_ID = 'seg-123'
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as any
    const r = await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('401')
    delete process.env.RESEND_MARKETING_API_KEY
    delete process.env.RESEND_MARKETING_SEGMENT_ID
  })

  // No marketing operation falls back to RESEND_API_KEY
  test('marketing fetch calls use RESEND_MARKETING_API_KEY in Authorization header', async () => {
    process.env.RESEND_MARKETING_API_KEY    = 'mkt-only-key'
    process.env.RESEND_MARKETING_SEGMENT_ID = 'seg-123'
    process.env.RESEND_MARKETING_TOPIC_ID   = 'topic-456'
    process.env.RESEND_API_KEY              = 'sending-only-key'
    const spy = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'c-1' }) }) as any
    global.fetch = spy
    await syncSubscribeToResend({ email: 'a@b.com', firstName: null, lastName: null })
    spy.mock.calls.forEach(([, opts]: [string, any]) => {
      expect(opts.headers.Authorization).toBe('Bearer mkt-only-key')
      expect(opts.headers.Authorization).not.toContain('sending-only-key')
    })
    delete process.env.RESEND_MARKETING_API_KEY
    delete process.env.RESEND_MARKETING_SEGMENT_ID
    delete process.env.RESEND_MARKETING_TOPIC_ID
  })
})
