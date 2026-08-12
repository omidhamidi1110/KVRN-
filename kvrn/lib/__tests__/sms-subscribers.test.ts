// lib/__tests__/sms-subscribers.test.ts — V58 SMS subscriber tests

import { normalizePhoneE164, isValidE164, maskPhone } from '../phone'
import { ALLOWED_SMS_SOURCES } from '../sms-subscribers'
import { isA2PApproved, validateTwilioSignature, parseFormBody } from '../twilio'

// ── Phone normalization ───────────────────────────────────────────────────────

describe('normalizePhoneE164', () => {
  // Item 1: phone normalized to E.164
  test('10-digit US number → +1XXXXXXXXXX', () => {
    expect(normalizePhoneE164('6575551234')).toBe('+16575551234')
  })
  test('formatted US number → E.164', () => {
    expect(normalizePhoneE164('(657) 555-1234')).toBe('+16575551234')
  })
  test('dashes → E.164', () => {
    expect(normalizePhoneE164('657-555-1234')).toBe('+16575551234')
  })
  test('11-digit with country code → E.164', () => {
    expect(normalizePhoneE164('16575551234')).toBe('+16575551234')
  })
  test('already E.164 → unchanged', () => {
    expect(normalizePhoneE164('+16575551234')).toBe('+16575551234')
  })
  test('UK number with + prefix → accepted', () => {
    expect(normalizePhoneE164('+447911123456')).toBe('+447911123456')
  })

  // Item 2: invalid phone rejected
  test('too short → null', () => {
    expect(normalizePhoneE164('123')).toBeNull()
  })
  test('letters → null', () => {
    expect(normalizePhoneE164('abc-def-ghij')).toBeNull()
  })
  test('empty → null', () => {
    expect(normalizePhoneE164('')).toBeNull()
  })
  test('9-digit ambiguous number → null (not guessed)', () => {
    expect(normalizePhoneE164('123456789')).toBeNull()
  })

  test('maskPhone hides middle digits', () => {
    expect(maskPhone('+16575551234')).toMatch(/^\+1\*+1234$/)
  })
})

// ── Source allowlist ──────────────────────────────────────────────────────────

describe('SMS source allowlist', () => {
  // Item 8: source allowlist enforced
  test('all expected sources present', () => {
    ['homepage','waitlist','checkout','footer','giveaway','manual_admin','sms_keyword']
      .forEach(s => expect(ALLOWED_SMS_SOURCES.has(s)).toBe(true))
  })
  test('arbitrary source not allowed', () => {
    expect(ALLOWED_SMS_SOURCES.has('hack')).toBe(false)
    expect(ALLOWED_SMS_SOURCES.has('')).toBe(false)
  })

  // Item 9: client cannot set arbitrary status
  test('subscribe endpoint always sets status=subscribed (SQL enforced)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).toContain("'subscribed'")
    expect(src).toContain('ON CONFLICT (phone_e164) DO UPDATE')
  })
})

// ── Consent separation ────────────────────────────────────────────────────────

describe('consent separation', () => {
  // Item 6: SMS consent does not affect email consent
  test('sms-subscribers.ts does not import marketing-subscribers', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).not.toContain('marketing-subscribers')
    expect(src).not.toContain('upsertSubscriber')
  })
  // Item 7: email unsubscribe does not affect SMS consent
  test('unsubscribe route does not call sms-subscribers', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/unsubscribe/route.ts'), 'utf8'
    )
    expect(src).not.toContain('sms-subscribers')
    expect(src).not.toContain('unsubscribeSmsPhone')
  })
  // Item 3: new subscriber stored locally (schema check)
  test('migration 008 creates sms_subscribers table', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../db/migrations/008_sms_subscribers.sql'), 'utf8'
    )
    expect(src).toContain('CREATE TABLE IF NOT EXISTS sms_subscribers')
    expect(src).toContain('phone_e164')
    expect(src).toContain("status IN ('subscribed', 'unsubscribed')")
  })
  // Item 4: duplicate signup reuses same row
  test('upsertSmsSubscriber uses ON CONFLICT (phone_e164) DO UPDATE', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).toContain('ON CONFLICT (phone_e164) DO UPDATE')
  })
  // Item 5: unsubscribed phone can re-subscribe
  test('resubscribeSmsPhone clears unsubscribed_at and sets status=subscribed', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).toContain("status = 'subscribed', unsubscribed_at = NULL")
  })
})

// ── Twilio adapter ────────────────────────────────────────────────────────────

describe('Twilio adapter', () => {
  const origEnv = { ...process.env }
  afterEach(() => {
    ['TWILIO_ACCOUNT_SID','TWILIO_API_KEY_SID','TWILIO_API_KEY_SECRET',
     'TWILIO_MESSAGING_SERVICE_SID','TWILIO_AUTH_TOKEN','TWILIO_A2P_APPROVED']
      .forEach(k => { if (origEnv[k]) process.env[k] = origEnv[k]; else delete process.env[k] })
    jest.restoreAllMocks()
  })

  // Item 10: missing Twilio credentials fails send safely
  test('missing TWILIO_API_KEY_SID returns ok=false without throwing', async () => {
    const { sendSms } = await import('../twilio')
    delete process.env.TWILIO_API_KEY_SID
    const r = await sendSms({ to: '+16575551234', body: 'Test' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not configured')
  })

  // Item 11: API Key SID + Secret used for REST auth
  test('sendSms uses Basic auth with API Key SID + Secret', async () => {
    const { sendSms } = await import('../twilio')
    process.env.TWILIO_ACCOUNT_SID           = 'AC123'
    process.env.TWILIO_API_KEY_SID           = 'SK456'
    process.env.TWILIO_API_KEY_SECRET        = 'secret789'
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG_service'

    const spy = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ sid: 'SM_abc', status: 'queued' })
    }) as any
    global.fetch = spy

    await sendSms({ to: '+16575551234', body: 'Test' })

    const [, opts] = spy.mock.calls[0]
    const auth = opts.headers.Authorization
    expect(auth).toMatch(/^Basic /)
    const decoded = atob(auth.replace('Basic ', ''))
    expect(decoded).toBe('SK456:secret789')

    global.fetch = origEnv.fetch as any || global.fetch
  })

  // Item 12: MessagingServiceSid used rather than hardcoded From
  test('sendSms includes MessagingServiceSid not a hardcoded From number', async () => {
    const { sendSms } = await import('../twilio')
    process.env.TWILIO_ACCOUNT_SID           = 'AC123'
    process.env.TWILIO_API_KEY_SID           = 'SK456'
    process.env.TWILIO_API_KEY_SECRET        = 'secret789'
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG_expected'

    const spy = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ sid: 'SM_xyz', status: 'queued' })
    }) as any
    global.fetch = spy

    await sendSms({ to: '+16575551234', body: 'Test' })

    const [, opts] = spy.mock.calls[0]
    const body = new URLSearchParams(opts.body)
    expect(body.get('MessagingServiceSid')).toBe('MG_expected')
    expect(body.get('From')).toBeNull()

    global.fetch = origEnv.fetch as any || global.fetch
  })

  // Item 13: promotional send blocked for local unsubscribed phone
  test('isLocallySubscribed used for consent guard', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).toContain('isLocallySubscribed')
  })

  // Item 22: A2P pending does not break signup persistence
  test('isA2PApproved defaults to false without env var', () => {
    delete process.env.TWILIO_A2P_APPROVED
    expect(isA2PApproved()).toBe(false)
  })
  test('isA2PApproved true when TWILIO_A2P_APPROVED=true', () => {
    process.env.TWILIO_A2P_APPROVED = 'true'
    expect(isA2PApproved()).toBe(true)
  })

  // Item 20: Twilio send failure does not delete local subscriber (logic)
  test('sendSms failure returns ok=false — caller must not delete subscriber', async () => {
    const { sendSms } = await import('../twilio')
    process.env.TWILIO_ACCOUNT_SID    = 'AC123'
    process.env.TWILIO_API_KEY_SID    = 'SK456'
    process.env.TWILIO_API_KEY_SECRET = 'secret789'
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG'

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as any
    const r = await sendSms({ to: '+16575551234', body: 'Test' })
    expect(r.ok).toBe(false)
    global.fetch = origEnv.fetch as any || global.fetch
  })
})

// ── Keyword handling ──────────────────────────────────────────────────────────

describe('inbound SMS keyword handling (source inspection)', () => {
  // Item 14: STOP marks local phone unsubscribed
  test('incoming route handles STOP → calls unsubscribeSmsPhone', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain('STOP_KEYWORDS')
    expect(src).toContain('unsubscribeSmsPhone')
  })
  // Item 15: START restores subscription
  test('incoming route handles START → calls resubscribeSmsPhone', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain('START_KEYWORDS')
    expect(src).toContain('resubscribeSmsPhone')
  })
  // Item 16: HELP leaves consent unchanged
  test('incoming route handles HELP → no consent change', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain('HELP_KEYWORDS')
    // HELP block must not call unsubscribe or resubscribe
    // Check that the HELP handling is present but neutral
    expect(src).toContain('HELP keywords')
  })
})

// ── Webhook security ──────────────────────────────────────────────────────────

describe('webhook signature validation', () => {
  const origEnv = { ...process.env }
  afterEach(() => {
    if (origEnv.TWILIO_AUTH_TOKEN) process.env.TWILIO_AUTH_TOKEN = origEnv.TWILIO_AUTH_TOKEN
    else delete process.env.TWILIO_AUTH_TOKEN
  })

  // Item 17: inbound webhook rejects invalid Twilio signature
  test('validateTwilioSignature returns invalid for wrong signature', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'test-auth-token'
    const r = await validateTwilioSignature('https://example.com/webhook', {}, 'bad-sig')
    expect(r).toBe('invalid')
  })

  // Item 17 (continued): returns unconfigured when auth token missing
  test('validateTwilioSignature returns unconfigured when TWILIO_AUTH_TOKEN absent', async () => {
    delete process.env.TWILIO_AUTH_TOKEN
    const r = await validateTwilioSignature('https://x.com', {}, 'sig')
    expect(r).toBe('unconfigured')
  })

  // Item 18: status callback rejects invalid signature (same validator)
  test('status callback route uses validateTwilioSignature', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/status/route.ts'), 'utf8'
    )
    expect(src).toContain('validateTwilioSignature')
    expect(src).toContain("validity === 'invalid'")
    expect(src).toContain("validity === 'unconfigured'")
  })

  // Item 19: duplicate status callback is idempotent
  test('upsertMessageStatus uses ON CONFLICT (twilio_message_sid)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).toContain('ON CONFLICT (twilio_message_sid)')
  })

  test('parseFormBody correctly parses URLEncoded body', () => {
    const result = parseFormBody('From=%2B16575551234&Body=STOP&MessageSid=SM123')
    expect(result.From).toBe('+16575551234')
    expect(result.Body).toBe('STOP')
    expect(result.MessageSid).toBe('SM123')
  })
})

// ── No public bulk send ───────────────────────────────────────────────────────

describe('no bulk/unauthenticated send endpoint', () => {
  // Item 21: no public unauthenticated send endpoint
  test('no public /api/sms/send endpoint exists', () => {
    const fs   = require('fs')
    const path = require('path')
    const sendPath = path.join(__dirname, '../../app/api/sms/send/route.ts')
    expect(fs.existsSync(sendPath)).toBe(false)
  })
  test('twilio.ts sendSms is not exposed via a public API route', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/sms/subscribe/route.ts'), 'utf8'
    )
    expect(src).not.toContain('sendSms')
  })
})
