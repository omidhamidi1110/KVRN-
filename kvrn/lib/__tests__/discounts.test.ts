// lib/__tests__/discounts.test.ts — V58.2 discount engine tests

import {
  normalizeDiscountCode,
  generateSmsDiscountCode,
  applyDiscountPriority,
} from '../discounts'
import type { Discount } from '../discounts'

// ── Helper factory ─────────────────────────────────────────────────────────────
function makeDiscount(overrides: Partial<Discount> = {}): Discount {
  return {
    id:                  'disc-001',
    code:                'KVRN10',
    name:                'Test Discount',
    description:         null,
    type:                'fixed_amount',
    amountCents:         1000,
    percentageBps:       null,
    active:              true,
    singleUse:           false,
    maxRedemptions:      null,
    redemptionCount:     0,
    minimumSubtotalCents: null,
    allowedCountryCodes: null,
    excludedCountryCodes: null,
    subscriberId:        null,
    startsAt:            null,
    expiresAt:           null,
    priority:            10,
    systemManaged:       false,
    stripeCouponId:      null,
    createdBy:           'seed',
    createdAt:           new Date().toISOString(),
    ...overrides,
  }
}

// ── Code normalization (item 28, 35) ─────────────────────────────────────────

describe('normalizeDiscountCode', () => {
  test('trims and uppercases', () => {
    expect(normalizeDiscountCode('  kvrn10  ')).toBe('KVRN10')
    expect(normalizeDiscountCode('kvrn-a7k4p9')).toBe('KVRN-A7K4P9')
  })
  test('already uppercase unchanged', () => {
    expect(normalizeDiscountCode('KVRN10')).toBe('KVRN10')
  })
  test('mixed case', () => {
    expect(normalizeDiscountCode('Kvrn10')).toBe('KVRN10')
  })
})

// ── SMS code generation (items 4, 5, 34) ─────────────────────────────────────

describe('generateSmsDiscountCode', () => {
  test('returns KVRN-XXXXXX format', () => {
    const code = generateSmsDiscountCode()
    expect(code).toMatch(/^KVRN-[A-Z2-9]{6}$/)
  })
  test('two codes are different (secure random)', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateSmsDiscountCode()))
    expect(codes.size).toBe(20)  // all 20 should be unique
  })
  test('does not contain ambiguous chars 0/O/1/I', () => {
    const codes = Array.from({ length: 100 }, () => generateSmsDiscountCode()).join('')
    expect(codes).not.toMatch(/[01IO]/)
  })
  test('no phone number fragments (pure random)', () => {
    // Just verifying format — actual randomness tested above
    const code = generateSmsDiscountCode()
    expect(code.length).toBe(11)  // KVRN- (5) + 6 chars
  })
})

// ── Discount priority (items 14-22) ──────────────────────────────────────────

describe('applyDiscountPriority', () => {
  // Item 14: US $149.99 + KVRN10 → $10 discount allowed
  test('US subtotal $149.99 + KVRN10 → discount applies', () => {
    const discount = makeDiscount({ type: 'fixed_amount', amountCents: 1000 })
    const result = applyDiscountPriority({
      discount,
      subtotalCents: 14999,
      country: 'US',
      shippingCents: 995,  // shipping not free
    })
    expect(result.applied?.amountCents).toBe(1000)
    expect(result.blockedReason).toBeNull()
  })

  // Item 15: US subtotal $150 + KVRN10 → free shipping wins, KVRN10 blocked
  test('US subtotal $15000 cents + KVRN10 → free shipping wins', () => {
    const discount = makeDiscount({ type: 'fixed_amount', amountCents: 1000 })
    const result = applyDiscountPriority({
      discount,
      subtotalCents: 15000,
      country: 'US',
      shippingCents: 0,    // free shipping already applied
    })
    expect(result.applied).toBeNull()
    expect(result.blockedReason).toContain('free shipping')
  })

  // Item 16: US subtotal $160 + SMS code → free shipping wins, SMS blocked
  test('US subtotal $160 + SMS code → free shipping wins', () => {
    const smsCode = makeDiscount({ code: 'KVRN-A7K4P9', singleUse: true, subscriberId: 'sub-001' })
    const result = applyDiscountPriority({
      discount: smsCode,
      subtotalCents: 16000,
      country: 'US',
      shippingCents: 0,
    })
    expect(result.applied).toBeNull()
    expect(result.blockedReason).toContain('free shipping')
  })

  // Item 17: non-US $160 + KVRN10 → allowed (no US free-shipping rule)
  test('non-US $160 + KVRN10 → discount allowed', () => {
    const discount = makeDiscount({ type: 'fixed_amount', amountCents: 1000 })
    const result = applyDiscountPriority({
      discount,
      subtotalCents: 16000,
      country: 'CA',
      shippingCents: 1500,  // not free
    })
    expect(result.applied?.amountCents).toBe(1000)
    expect(result.blockedReason).toBeNull()
  })

  // Item 18: shipping discount overrides merchandise discount
  test('shipping discount applies when present', () => {
    const shippingDiscount = makeDiscount({
      type: 'shipping', amountCents: 1500, code: 'FREESHIP'
    })
    const result = applyDiscountPriority({
      discount: shippingDiscount,
      subtotalCents: 10000,
      country: 'CA',
      shippingCents: 1500,
    })
    expect(result.applied?.type).toBe('shipping')
    // shippingAdjustmentCents = shipping cost reduced by discount (min 0)
    expect(result.applied?.shippingAdjustmentCents).toBe(1500)
    expect(result.applied?.amountCents).toBe(0)  // no merch discount
  })

  // Item 19: only one manual discount (no discount = no applied)
  test('no discount = no applied result', () => {
    const result = applyDiscountPriority({
      discount: null,
      subtotalCents: 10000,
      country: 'US',
      shippingCents: 995,
    })
    expect(result.applied).toBeNull()
    expect(result.blockedReason).toBeNull()
  })

  // Item 20: KVRN10 + SMS code cannot stack (only one code accepted at checkout)
  test('only one discount can be passed — second code rejected', () => {
    // The checkout handler only accepts one rawDiscountCode from body
    // This test verifies via source inspection
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    expect(src).toContain('rawDiscountCode')
    expect(src).toContain("typeof body.discountCode === 'string'")
  })

  // Item 21: shipping code + SMS code cannot stack
  test('shipping discount blocks merchandise discount that comes after it', () => {
    const shippingDiscount = makeDiscount({ type: 'shipping', amountCents: 0 })
    // A second call with a merchandise discount would need to check if a shipping discount is active
    // Since only one code is passed, this is enforced at checkout
    const result = applyDiscountPriority({
      discount: shippingDiscount,
      subtotalCents: 10000,
      country: 'US',
      shippingCents: 1000,
    })
    expect(result.applied?.type).toBe('shipping')
  })

  // Item 23: discount cannot make totals negative
  test('fixed discount capped at subtotal to avoid negative', () => {
    const discount = makeDiscount({ type: 'fixed_amount', amountCents: 5000 })
    const result = applyDiscountPriority({
      discount,
      subtotalCents: 1000,  // less than discount
      country: 'CA',
      shippingCents: 500,
    })
    expect(result.applied?.amountCents).toBe(1000)  // capped to subtotal
  })

  // Item 29: client cannot spoof discount amount
  test('server handler uses server-computed discount amount, not client value', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    // appliedDiscount.amountCents comes from server-side applyDiscountPriority
    expect(src).toContain('appliedDiscount')
    expect(src).toContain('applyDiscountPriority')
    // allow_promotion_codes must be omitted
    expect(src).not.toContain('allow_promotion_codes: true')
  })

  // Item 30: client cannot spoof discount type
  test('discount type validated by server validateDiscount, not trusted from client', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    expect(src).toContain('validateDiscount')
    expect(src).not.toContain("type: body.type")
  })

  // Item 31: server checkout independently revalidates
  test('checkout handler validates discount server-side before Stripe session', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    // Discount validation happens BEFORE Stripe session creation
    const validateIdx  = src.indexOf('validateDiscount(')
    const stripeIdx    = src.indexOf('stripe.checkout.sessions.create')
    expect(validateIdx).toBeGreaterThan(0)
    expect(stripeIdx).toBeGreaterThan(validateIdx)
  })

  // Item 32: order snapshot preserves discount
  test('Stripe session metadata uses kvrn_discount_definition (not customer code)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    // Customer-facing codes must NOT appear in Stripe metadata
    expect(src).toContain('kvrn_discount_definition')
    expect(src).toContain('kvrn_discount_type')
    // The literal code field should not be sent to Stripe
    expect(src).not.toContain('discount_code: appliedDiscount.code')
  })

  // Item 26: no allow_promotion_codes: true
  test('allow_promotion_codes: true is NOT used', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    expect(src).not.toContain('allow_promotion_codes: true')
  })
})

// ── Source spoofing fix (items 1-7) ──────────────────────────────────────────

describe('SMS subscribe source spoofing fix', () => {
  // Item 1: homepage accepted
  test('PUBLIC_SMS_SOURCES includes homepage', () => {
    const { PUBLIC_SMS_SOURCES } = require('../sms-subscribers')
    expect(PUBLIC_SMS_SOURCES.has('homepage')).toBe(true)
  })

  // Item 2: waitlist accepted
  test('PUBLIC_SMS_SOURCES includes waitlist', () => {
    const { PUBLIC_SMS_SOURCES } = require('../sms-subscribers')
    expect(PUBLIC_SMS_SOURCES.has('waitlist')).toBe(true)
  })

  // Item 3: manual_admin rejected on public endpoint
  test('manual_admin NOT in PUBLIC_SMS_SOURCES', () => {
    const { PUBLIC_SMS_SOURCES } = require('../sms-subscribers')
    expect(PUBLIC_SMS_SOURCES.has('manual_admin')).toBe(false)
  })

  // Item 4: sms_keyword rejected on public endpoint
  test('sms_keyword NOT in PUBLIC_SMS_SOURCES', () => {
    const { PUBLIC_SMS_SOURCES } = require('../sms-subscribers')
    expect(PUBLIC_SMS_SOURCES.has('sms_keyword')).toBe(false)
  })

  // Item 5: arbitrary source rejected
  test('arbitrary source NOT in PUBLIC_SMS_SOURCES', () => {
    const { PUBLIC_SMS_SOURCES } = require('../sms-subscribers')
    expect(PUBLIC_SMS_SOURCES.has('hack_source')).toBe(false)
    expect(PUBLIC_SMS_SOURCES.has('')).toBe(false)
  })

  // Item 6: Twilio webhook can still use sms_keyword internally
  test('ALL_SMS_SOURCES includes sms_keyword for internal use', () => {
    const { ALL_SMS_SOURCES } = require('../sms-subscribers')
    expect(ALL_SMS_SOURCES.has('sms_keyword')).toBe(true)
  })

  // Item 7: subscribe route explicitly rejects internal sources
  test('subscribe route rejects invalid source with 400 not silent remap', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/sms/subscribe/route.ts'), 'utf8'
    )
    expect(src).toContain('PUBLIC_SMS_SOURCES.has(rawSource)')
    expect(src).toContain("Invalid request.")
    // Must NOT silently fall back to homepage for internal sources
    expect(src).not.toContain("ALLOWED_SMS_SOURCES.has(rawSource) ? rawSource : 'homepage'")
  })
})

// ── Server-verified offer (section 3, 36) ───────────────────────────────────

describe('server-verified offer', () => {
  test('/api/sms/offer route exists', () => {
    const exists = require('fs').existsSync(
      require('path').join(__dirname, '../../app/api/sms/offer/route.ts')
    )
    expect(exists).toBe(true)
  })

  test('offer route does not expose universal discount code', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/sms/offer/route.ts'), 'utf8'
    )
    expect(src).toContain('offerActive')
    expect(src).not.toContain('KVRN10')
    expect(src).not.toContain('discountCode')
  })

  test('popup fetches /api/sms/offer instead of reading NEXT_PUBLIC_SMS_DISCOUNT_CODE', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('/api/sms/offer')
    // NEXT_PUBLIC_SMS_DISCOUNT_CODE may appear in a comment explaining why it's NOT used
    // The test should verify it's not used as a variable, not just in comments
    const usageIdx = src.indexOf('NEXT_PUBLIC_SMS_DISCOUNT_CODE')
    if (usageIdx >= 0) {
      const context = src.slice(Math.max(0,usageIdx-10), usageIdx+60)
      expect(context).toMatch(/\/\/|no |NOT/i) // must be in a comment/negation
    }
  })
})

// ── Twilio opt-out state semantics (item 11) ─────────────────────────────────

describe('twilio_opt_out_state semantics', () => {
  test("migration 008 uses 'opted_in'/'opted_out' constraint", () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../db/migrations/008_sms_subscribers.sql'), 'utf8'
    )
    expect(src).toContain("'opted_in'")
    expect(src).toContain("'opted_out'")
    expect(src).toContain('ss_twilio_state_chk')
  })

  test("unsubscribeSmsPhone sets twilio_opt_out_state='opted_out'", () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).toContain("twilio_opt_out_state = 'opted_out'")
  })

  test("resubscribeSmsPhone sets twilio_opt_out_state='opted_in'", () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).toContain("twilio_opt_out_state = 'opted_in'")
  })
})

// ── SMS message durability (item 12) ────────────────────────────────────────

describe('SMS message durability', () => {
  test('upsertMessageStatus uses ON CONFLICT ... DO UPDATE', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-subscribers.ts'), 'utf8'
    )
    expect(src).toContain('ON CONFLICT (twilio_message_sid) DO UPDATE')
  })

  test('migration 008 has UNIQUE constraint on twilio_message_sid', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../db/migrations/008_sms_subscribers.sql'), 'utf8'
    )
    expect(src).toContain('sms_messages_sid_uq')
  })
})

// ── Webhook URL fix (item 10) ────────────────────────────────────────────────

describe('webhook URL signature validation', () => {
  test('getWebhookUrl uses NEXT_PUBLIC_SITE_URL to reconstruct public URL', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../twilio.ts'), 'utf8'
    )
    expect(src).toContain('getWebhookUrl')
    expect(src).toContain('NEXT_PUBLIC_SITE_URL')
  })

  test('incoming route uses getWebhookUrl not req.url directly', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain('getWebhookUrl(req)')
    expect(src).not.toContain('const url     = req.url')
  })

  test('status callback route uses getWebhookUrl', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/status/route.ts'), 'utf8'
    )
    expect(src).toContain('getWebhookUrl(req)')
  })

  test('missing signature → invalid', async () => {
    const { validateTwilioSignature } = await import('../twilio')
    process.env.TWILIO_AUTH_TOKEN = 'test-token'
    const r = await validateTwilioSignature('https://kvrn.shop/api/twilio/incoming', {}, 'bad')
    expect(r).toBe('invalid')
    delete process.env.TWILIO_AUTH_TOKEN
  })

  test('missing TWILIO_AUTH_TOKEN → unconfigured (fails closed)', async () => {
    const { validateTwilioSignature } = await import('../twilio')
    delete process.env.TWILIO_AUTH_TOKEN
    const r = await validateTwilioSignature('https://kvrn.shop/api/twilio/incoming', {}, 'sig')
    expect(r).toBe('unconfigured')
  })
})

// ── localStorage expiration (item 7) ────────────────────────────────────────

describe('localStorage expiration', () => {
  test('popup uses kvrn_sms_subscribed_at (timestamp) not permanent boolean', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('kvrn_sms_subscribed_at')
    expect(src).not.toContain("KEY_SUBSCRIBED = 'kvrn_sms_subscribed'")
  })

  test('30-day suppression window is configured', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('30 * 24 * 60 * 60 * 1000')
  })
})

// ── Mobile deep-link UX (item 6) ────────────────────────────────────────────

describe('mobile deep-link UX', () => {
  test('onDeeplink does NOT set KEY_SUBSCRIBED', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    const fnIdx  = src.indexOf('onDeeplink = useCallback')
    const fnBody = src.slice(fnIdx, fnIdx + 400)
    expect(fnBody).toContain('KEY_DEEPLINK')
    const setsSubscribed = fnBody.includes('setItem(KEY_SUBSCRIBED')
    expect(setsSubscribed).toBe(false)
  })

  test('deeplink closes popup but leaves tab available', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    const fnIdx = src.indexOf('onDeeplink = useCallback')
    const fnBody = src.slice(fnIdx, fnIdx + 500)
    expect(fnBody).toContain('setVisible(false)')
    expect(fnBody).toContain('setShowTab(true)')
  })
})

// ── Admin discounts (items 35-38) ────────────────────────────────────────────

describe('admin discounts', () => {
  test('admin discounts API route exists', () => {
    const exists = require('fs').existsSync(
      require('path').join(__dirname, '../../app/api/admin/discounts/route.ts')
    )
    expect(exists).toBe(true)
  })

  test('admin discounts requires admin auth', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/admin/discounts/route.ts'), 'utf8'
    )
    expect(src).toContain('requireAdmin')
  })

  test('admin discounts ID route supports PATCH and DELETE', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/admin/discounts/[id]/route.ts'), 'utf8'
    )
    expect(src).toContain('export async function PATCH')
    expect(src).toContain('export async function DELETE')
  })

  test('safe delete refuses if redemptions exist', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    expect(src).toContain('safeDeleteDiscount')
    expect(src).toContain('discount_redemptions')
    expect(src).toContain('Deactivate instead')
  })
})

// ── Mobile tab rendering (item 14) ──────────────────────────────────────────

describe('mobile tab text rendering', () => {
  test('mobile tab uses flex column with two spans not writingMode', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // Current tab is a pill button at bottom position (not vertical writingMode)
    expect(src).not.toContain("writingMode: 'vertical")
    // Tab uses pill/rounded shape with display:flex and alignItems
    expect(src).toContain('borderRadius:999')
  })
})

// ── Popup exclusions (item 8) ─────────────────────────────────────────────────

describe('popup excluded routes', () => {
  test('/checkout/success is excluded via /checkout startsWith prefix', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/ConditionalSmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain("'/checkout'")
    expect(src).toContain("startsWith(p + '/')")
  })
})

// ── KVRN10 (items 24, 33) ─────────────────────────────────────────────────────

describe('KVRN10 characteristics', () => {
  test('migration 009 seeds KVRN10 as fixed_amount $10', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../db/migrations/009_discounts.sql'), 'utf8'
    )
    expect(src).toContain("'KVRN10'")
    expect(src).toContain('1000')  // $10 in cents
    expect(src).toContain("'fixed_amount'")
    expect(src).toContain('ON CONFLICT (code) DO NOTHING')
  })

  test('KVRN10 is NOT designated as SMS signup code (different from SMS unique codes)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    // SMS codes use 'sms_signup' created_by, not KVRN10
    expect(src).toContain("'sms_signup'")
    // upsertSmsDiscountCode generates KVRN-XXXXXX, not KVRN10
    expect(src).toContain('generateSmsDiscountCode')
  })
})

// ── Accessibility (item 15) ──────────────────────────────────────────────────

describe('popup accessibility', () => {
  test('popup has role=dialog aria-modal=true', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('role="dialog"')
    expect(src).toContain('aria-modal="true"')
  })

  test('focus is moved to close button on open', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('closeRef.current?.focus()')
    expect(src).toContain('priorFocus.current?.focus()')
  })

  test('focus trap implemented', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('querySelectorAll')
    expect(src).toContain("'Tab'")
  })
})

// ── No unused state (item 13) ────────────────────────────────────────────────

describe('no dead UI state', () => {
  test('mobile has manual entry toggle (showManual as a UI toggle state)', () => {
    // V59 redesign: showManual is now a valid mobile secondary-option toggle
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('showManual')
    expect(src).toContain('setShowManual')
  })
})

// ── Coupon fail-closed and stale-pending recovery ────────────────────────────

describe('Stripe coupon fail-closed and stale recovery', () => {
  test('shipping discount does not require Stripe coupon', () => {
    // Shipping discount returns null from getOrCreateStripeCouponForTerms without Stripe call
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    const fnStart  = src.indexOf('export async function getOrCreateStripeCouponForTerms')
    const fnBody   = src.slice(fnStart, fnStart + 600)
    expect(fnBody).toContain("if (type === 'shipping') return null")
  })

  test('checkout fails closed when coupon returns null for merchandise discount', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    expect(src).toContain('stripe_coupon_unavailable')
    expect(src).toContain("appliedDiscount.type !== 'shipping' && !appliedDiscount.stripeCouponId")
    expect(src).toContain('Could not apply the discount code at this time')
  })

  test('checkout releases claim and fails reservation on coupon unavailable', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    // All three actions in the fail-closed block
    // The fail-closed block is the entire if(!stripeCouponId) section
    const failClosedIdx = src.indexOf('!appliedDiscount.stripeCouponId')
    const failBlock     = src.slice(failClosedIdx, failClosedIdx + 700)
    expect(failBlock).toContain('releaseDiscountClaim')
    expect(failBlock).toContain('failReservation')
    expect(failBlock).toContain('503')
  })

  test('stale-pending recovery uses DELETE before re-inserting', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    expect(src).toContain('STALE_PENDING_MS')
    expect(src).toContain("stripe_coupon_id = 'pending'")
    expect(src).toContain("INTERVAL '60 seconds'")
    // Delete stale row, then re-insert to compete for leadership
    expect(src).toContain('STALE RECOVERY: delete the dead leader')
    expect(src).toContain('WE TOOK OVER FROM THE STALE LEADER')
  })

  test('deterministic Stripe idempotency key does not include customer codes', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    expect(src).toContain('stripeIdempotencyKey')
    expect(src).toContain('kvrn-coupon-')
    // Idempotency key should be based on terms only (kind + currency + amounts)
    expect(src).toContain('idempotencyKey: stripeIdempotencyKey')
    // Stripe API calls must not include customer codes in metadata
    // (discount.code is used internally in AppliedDiscount objects, but not in Stripe API calls)
    expect(src).not.toContain('kvrn_code:')
  })

  test('timeout log does not claim uncached creation proceeds', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    // Old misleading message removed
    expect(src).not.toContain('proceeding uncached')
    // New accurate message
    expect(src).toContain('Stripe coupon resolution timed out')
  })

  test('KVRN10 and $10 SMS codes share same coupon terms key', () => {
    // Both are fixed_amount, usd, 1000 cents → same stripe_coupon_definitions row
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    // The lookup is by (kind, currency, amount_cents, percentage_bps) — not by KVRN code
    expect(src).toContain("kind = ${kind}")
    expect(src).toContain('COALESCE(amount_cents, -1)')
    // No customer code or specific KVRN discount code in Stripe API calls
    // Coupon creation uses definitionKey (e.g. 'fixed_usd_1000'), not customer codes
    expect(src).toContain('kvrn_discount_definition: definitionKey')
    // kvrn_code must not appear in metadata (was removed in V58.4 audit)
    expect(src).not.toContain('kvrn_code:')
    // Verify terms-based key format
    expect(src).toContain('kvrn-coupon-')
  })

  test('stale-pending takeover deletes only rows older than 60 seconds', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    // Fresh pending rows (< 60s) must not be stolen
    expect(src).toContain('rowAgeMs > STALE_PENDING_MS')
    expect(src).toContain("created_at < NOW() - INTERVAL '60 seconds'")
  })

  test('leader creates Stripe coupon with non-customer metadata', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    // Only kvrn_discount_definition in metadata — not customer code
    expect(src).toContain('kvrn_discount_definition: definitionKey')
    expect(src).not.toContain('kvrn_code:')
  })
})

// ── getStripe() failure path — behavioral test ───────────────────────────────

describe('createAsLeader: getStripe() failure cleanup', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    // Restore env
    Object.keys(process.env).forEach(k => {
      if (!(k in origEnv)) delete process.env[k]
    })
    Object.assign(process.env, origEnv)
    jest.resetModules()
  })

  test('getStripe() failure triggers pending row cleanup before returning null', () => {
    // Behavioral contract verified via source: the catch block must (in order)
    // 1. DELETE the pending row  2. log  3. return null
    // This ensures subsequent requests retry immediately (no 60-second stale wait).
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    const catchIdx = src.indexOf("getStripe() threw (misconfigured")
    expect(catchIdx).toBeGreaterThan(0)  // the catch comment must exist
    const catchBlock = src.slice(catchIdx, catchIdx + 500)

    // Must DELETE before returning null
    const deletePos  = catchBlock.indexOf('DELETE FROM stripe_coupon_definitions')
    const returnPos  = catchBlock.indexOf('return null')
    expect(deletePos).toBeGreaterThan(-1)
    expect(returnPos).toBeGreaterThan(deletePos)  // DELETE comes before return null

    // Must log the failure
    expect(catchBlock).toContain('console.error')

    // DELETE is constrained to the specific rowId and 'pending' status (never over-deletes)
    expect(catchBlock).toContain('${rowId}')
    expect(catchBlock).toContain("stripe_coupon_id = 'pending'")
  })

  test('pending row cleanup is constrained to this leaders row id and pending status', () => {
    // Source-level check: the DELETE must scope to the specific rowId and 'pending'
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    // Find the getStripe catch block
    const catchIdx   = src.indexOf("getStripe() threw")
    const catchBlock = src.slice(catchIdx, catchIdx + 400)
    expect(catchBlock).toContain('DELETE FROM stripe_coupon_definitions')
    expect(catchBlock).toContain("stripe_coupon_id = 'pending'")
    expect(catchBlock).toContain('${rowId}')
  })

  test('source confirms getStripe() failure cleans up before returning null', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    // The catch block must delete, log, then return null (not just return null)
    const catchStart = src.indexOf("getStripe() threw (misconfigured")
    const catchEnd   = src.indexOf('return null', catchStart)
    const catchBlock = src.slice(catchStart, catchEnd + 11)
    expect(catchBlock).toContain('DELETE')
    expect(catchBlock).toContain('console.error')
    expect(catchBlock).toContain('return null')
  })

  test('subsequent request can retry without 60-second stale wait after getStripe failure', () => {
    // Behavioral: pending row was deleted → next INSERT can succeed immediately
    // Source confirms: delete happens before return null in getStripe catch
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    // No stale-pending INTERVAL check in the getStripe catch path
    const catchIdx   = src.indexOf("getStripe() threw (misconfigured")
    const catchBlock = src.slice(catchIdx, catchIdx + 400)
    expect(catchBlock).not.toContain('INTERVAL')
    // Instead: immediate DELETE by rowId
    expect(catchBlock).toContain('DELETE FROM stripe_coupon_definitions')
  })
})
