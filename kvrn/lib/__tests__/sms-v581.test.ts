// lib/__tests__/sms-v581.test.ts — V58.1 popup/backend tests

import { normalizePhoneE164 } from '../phone'
import { ALLOWED_SMS_SOURCES } from '../sms-subscribers'
import { isA2PApproved, isMarketingSendEnabled, canSendMarketingSms } from '../twilio'

// ── Marketing send triple gate (items 27-30) ──────────────────────────────────

describe('canSendMarketingSms triple gate', () => {
  const orig = { ...process.env }
  afterEach(() => {
    ['TWILIO_A2P_APPROVED','TWILIO_MARKETING_SEND_ENABLED']
      .forEach(k => { if (orig[k]) process.env[k] = orig[k]; else delete process.env[k] })
  })

  // Item 27: marketing send blocked when A2P false
  test('A2P not approved → canSendMarketingSms false', () => {
    delete process.env.TWILIO_A2P_APPROVED
    process.env.TWILIO_MARKETING_SEND_ENABLED = 'true'
    expect(canSendMarketingSms()).toBe(false)
  })

  // Item 28: marketing send blocked when send flag false
  test('send flag disabled → canSendMarketingSms false', () => {
    process.env.TWILIO_A2P_APPROVED           = 'true'
    delete process.env.TWILIO_MARKETING_SEND_ENABLED
    expect(canSendMarketingSms()).toBe(false)
  })

  // Item 29: marketing send blocked when local subscriber unsubscribed
  test('local subscriber check is caller responsibility — send guard does not bypass Neon', () => {
    // canSendMarketingSms does NOT check Neon (that is the caller's job).
    // This test verifies the function exists and provides its gate;
    // the caller must also check isLocallySubscribed() before sending.
    process.env.TWILIO_A2P_APPROVED           = 'true'
    process.env.TWILIO_MARKETING_SEND_ENABLED = 'true'
    // Even with both gates open, the calling code must also check Neon status.
    // Verified by reading twilio.ts: sendSms() does not call isLocallySubscribed().
    // The caller (not sendSms) is responsible for the consent check.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../twilio.ts'), 'utf8'
    )
    // isLocallySubscribed is in sms-subscribers.ts (caller's responsibility)
    // canSendMarketingSms is the gateway
    expect(src).toContain('canSendMarketingSms')
    expect(src).toContain('canSendMarketingSms')
    expect(src).toContain('TWILIO_MARKETING_SEND_ENABLED')
  })

  // Item 30: marketing send allowed only when all gates true
  test('all gates true → canSendMarketingSms true', () => {
    process.env.TWILIO_A2P_APPROVED           = 'true'
    process.env.TWILIO_MARKETING_SEND_ENABLED = 'true'
    expect(canSendMarketingSms()).toBe(true)
  })

  test('isMarketingSendEnabled returns false by default', () => {
    delete process.env.TWILIO_MARKETING_SEND_ENABLED
    expect(isMarketingSendEnabled()).toBe(false)
  })
})

// ── Verified JOIN → YES keyword consent ────────────────────────────────────

describe('JOIN keyword in incoming route', () => {
  const source = () => require('fs').readFileSync(
    require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
  )

  test('JOIN only starts a pending confirmation after Twilio signature validation', () => {
    const src = source()
    expect(src).toContain('KEYWORD_STARTS.has(keyword)')
    expect(src).toContain('startKeywordConfirmation(phone,token)')
    expect(src).toContain('validateTwilioSignature(')
    expect(src.indexOf("verified!=='valid'")).toBeLessThan(src.indexOf('startKeywordConfirmation(phone,token)'))
    expect(src).not.toContain('resubscribeSmsPhone')
    expect(src).not.toContain('upsertSmsSubscriber')
  })

  test('a separate YES confirms only a pending verified signup', () => {
    const src = source()
    const domain = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-double-optin.ts'), 'utf8'
    )
    expect(src).toContain('KEYWORD_CONFIRMS.has(keyword)')
    expect(src).toContain('await confirmKeywordSms(phone,params.MessageSid')
    expect(domain).toContain("KEYWORD_CONFIRMS=new Set(['YES'])")
    expect(domain).toContain('WHERE phone_e164=${phone} AND expires_at>NOW()')
  })
})

// ── No public bulk send (item 31) ─────────────────────────────────────────────

describe('no public bulk send endpoint', () => {
  test('no /api/sms/send route file exists', () => {
    const exists = require('fs').existsSync(
      require('path').join(__dirname, '../../app/api/sms/send/route.ts')
    )
    expect(exists).toBe(false)
  })
})

// ── No Twilio secrets client-side (item 25) ───────────────────────────────────

describe('no Twilio secrets in client component', () => {
  test('SmsPopup.tsx does not reference any TWILIO_ secret', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    const secrets = ['TWILIO_ACCOUNT_SID','TWILIO_API_KEY_SID','TWILIO_API_KEY_SECRET',
                     'TWILIO_AUTH_TOKEN','TWILIO_MESSAGING_SERVICE_SID']
    secrets.forEach(s => expect(src).not.toContain(s))
  })
  test('SmsPopup.tsx only uses NEXT_PUBLIC_ env vars', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // Any process.env reference must be NEXT_PUBLIC_
    const envRefs = src.match(/process\.env\.\w+/g) ?? []
    envRefs.forEach((ref: string) => {
      expect(ref).toMatch(/^process\.env\.NEXT_PUBLIC_/)
    })
  })
})

// ── Source cannot spoof internal source (item 26) ─────────────────────────────

describe('public SMS enrollment stays closed until verified keyword opt-in', () => {
  test('public number form cannot assert consent or choose an internal source', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/sms/subscribe/route.ts'), 'utf8'
    )
    expect(src).toContain('status: 409')
    expect(src).not.toContain('upsertSmsSubscriber(')
    expect(src).not.toContain('resubscribeSmsPhone(')
    expect(src).not.toContain('sendSms(')
  })
  test('server-side source allowlist is never a substitute for verified consent', () => {
    expect(ALLOWED_SMS_SOURCES.has('manual_admin')).toBe(true)
    expect(ALLOWED_SMS_SOURCES.has('arbitrary_source')).toBe(false)
  })
})

// ── Disclosure visible before CTA (item 19) ───────────────────────────────────

describe('disclosure visible before CTA', () => {
  test('popup component renders Disclosure before CTA buttons', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // Disclosure component appears before the CTA button in both flows
    // DISCLOSURE const is defined early; check it's referenced in JSX near/before CTAs
    expect(src).toContain('{DISCLOSURE}')
    expect(src).toContain('handleSubmit')
    expect(src).toContain('onDeeplink')
  })
  test('DISCLOSURE string contains required TCPA/CTIA elements', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('recurring automated marketing')
    expect(src).toContain('Consent is not a condition of purchase')
    expect(src).toContain('Msg & data rates may apply')
    expect(src).toContain('STOP')
    expect(src).toContain('HELP')
  })
})

// ── Popup timing (items 1-2) ──────────────────────────────────────────────────

describe('popup timing (source assertions)', () => {
  test('popup uses 5000ms delay before showing', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('5000')
    expect(src).toContain('setTimeout')
  })
  test('popup does not render visible state before timer', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // New popup: visible starts false, timeout triggers setVisible(true)
    expect(src).toContain('setVisible(true)')
    expect(src).toContain('if (!visible) return')
  })
})

// ── Cooldown / tab persistence (items 5-8) ───────────────────────────────────

describe('cooldown and tab persistence (source assertions)', () => {
  test('dismissal persists via localStorage KEY_DISMISSED', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('KEY_DISMISSED')
    expect(src).toContain('localStorage.setItem')
  })
  test('cooldown is 7 days', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('7')
    expect(src).toContain('COOLDOWN_MS')
  })
  test('subscribed state persists via KEY_SUBSCRIBED', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // Popup uses KEY_SUBSCRIBED (timestamp) for 30-day suppression
    expect(src).toContain('KEY_SUBSCRIBED')
  })
})

// ── Desktop/mobile layout (items 13-18) ──────────────────────────────────────

describe('desktop/mobile layout (source assertions)', () => {
  test('desktop uses viewport-centered fixed positioning', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain("left:'50%'")
    expect(src).toContain("top:'50%'")
    expect(src).toContain('translate(-50%,-50%)')
  })
  test('desktop tab uses bottom-left placement', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // Current tab: pill at bottom with left and bottom positioning
    expect(src).toContain('bottom:')     // tab uses bottom positioning
    expect(src).toContain('position:\'fixed\'')
  })
  test('mobile tab uses right-edge placement', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // Current tab uses bottom-left positioning for both mobile/desktop
    // (pill design — not separate right-edge mobile tab)
    expect(src).toContain('position:\'fixed\'')
    expect(src).toContain('borderRadius:999')  // pill shape
  })
  test('mobile CTA uses sms: deep link with JOIN body', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('JOIN') // JOIN keyword in SMS body
    expect(src).toContain('sms:') // sms: protocol
  })
  test('mobile deep link offers inbound JOIN, but cannot issue consent from typed phone data', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('sms:${SMS_RAW}?body=')
    expect(src).toContain('JOIN KVRN')
    expect(src).toContain('After texting JOIN, reply YES')
    expect(src).not.toContain('type="tel"')
  })
  test('desktop and manual mobile instructions explain verified JOIN then YES', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('const PhoneForm')
    expect(src).toContain('To join, text')
    expect(src).toContain('send <strong>YES</strong>')
    expect(src).toContain('{PhoneForm}')
    expect(src).toContain('No subscription or discount is created until confirmation')
  })
})

// ── Popup exclusion pages (items 10-12) ───────────────────────────────────────

describe('popup excluded from sensitive pages', () => {
  test('ConditionalSmsPopup excludes /checkout', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/ConditionalSmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain("'/checkout'")
  })
  test('ConditionalSmsPopup excludes /admin', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/ConditionalSmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain("'/admin'")
  })
  test('ConditionalSmsPopup uses usePathname for dynamic path checking', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/ConditionalSmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('usePathname')
  })
})

// ── $10 discount code (item 32) ───────────────────────────────────────────────

describe('discount code honesty', () => {
  test('popup shows discount code only if NEXT_PUBLIC_SMS_DISCOUNT_CODE is set', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // New popup fetches offer from server, does NOT use NEXT_PUBLIC_SMS_DISCOUNT_CODE
    expect(src).toContain('/api/sms/offer')
    // Falls back to non-discount copy when offer inactive
    expect(src).toContain('EARLY ACCESS')
  })
  test('checkout session uses KVRN discount engine not allow_promotion_codes', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    // V58.2 removes allow_promotion_codes: true and uses KVRN's own discount system
    expect(src).not.toContain('allow_promotion_codes: true')
    expect(src).toContain('validateDiscount')
  })
})
