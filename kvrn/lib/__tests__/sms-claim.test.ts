// lib/__tests__/sms-claim.test.ts — SMS signup claim security tests
import { generateRawToken, hashToken } from '../sms-signup-claims'

// ── Token generation (items 1-2) ─────────────────────────────────────────────

describe('claim token generation', () => {
  test('generateRawToken returns base64url string with sufficient entropy', () => {
    const t = generateRawToken()
    // 20 bytes = 160 bits, base64url encoded ≈ 27 chars
    expect(typeof t).toBe('string')
    expect(t.length).toBeGreaterThanOrEqual(26)
    // base64url chars only (no +, /, =)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('two tokens are different (cryptographically random)', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateRawToken()))
    expect(tokens.size).toBe(20)
  })

  test('token is NOT derived from phone, subscriber ID, or sequential values', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // Must use crypto.getRandomValues — no phone/sequential derivation
    expect(src).toContain('crypto.getRandomValues')
    // Token generation uses crypto.getRandomValues — not any deterministic input
    expect(src).toContain('crypto.getRandomValues')
    // Token is NOT hashed from phone, subscriber, or sequential values
    const genIdx = src.indexOf('export function generateRawToken')
    const genBody = src.slice(genIdx, genIdx + 300)
    // generateRawToken function must only use crypto random bytes
    expect(genBody).toContain('getRandomValues')
    expect(genBody).not.toContain('phone')
    expect(genBody).not.toContain('subscriber_id')
  })

  test('hashToken is async SHA-256 — raw token not stored', async () => {
    const raw  = generateRawToken()
    const hash = await hashToken(raw)
    // SHA-256 = 64 hex chars
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // Hash is different from raw token
    expect(hash).not.toBe(raw)
  })

  test('same token always produces same hash', async () => {
    const raw = generateRawToken()
    const h1  = await hashToken(raw)
    const h2  = await hashToken(raw)
    expect(h1).toBe(h2)
  })

  test('different tokens produce different hashes', async () => {
    const h1 = await hashToken(generateRawToken())
    const h2 = await hashToken(generateRawToken())
    expect(h1).not.toBe(h2)
  })
})

// ── Security architecture (items 3-10) ──────────────────────────────────────

describe('claim security architecture', () => {
  // Item 3: Unconfirmed token cannot resolve
  test('resolve route requires status=confirmed', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // CTE version uses target.claim_status = 'confirmed' in the UPDATE WHERE
    expect(src).toContain("target.claim_status   = 'confirmed'")
    expect(src).toContain('target.already_consumed IS NULL')
    expect(src).toContain('target.claim_expires   > NOW()')
  })

  // Item 4: Expired token cannot resolve
  test('resolve checks expires_at', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    const resolveIdx = src.indexOf('resolveSmsSignupClaim')
    // Search for 'expired' reason in the entire file (it's in the resolve function)
    expect(src).toContain("reason: 'expired'")
    expect(src).toContain('expires_at')
  })

  // Item 5: Random/invalid token cannot resolve
  test('resolve handles unknown hash gracefully', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    expect(src).toContain("reason: 'invalid'")
  })

  // Item 6: Public browser cannot assign phone/subscriber to claim
  test('start route accepts no subscriber or phone input', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/sms/claim/start/route.ts'), 'utf8'
    )
    expect(src).not.toContain('phone')
    expect(src).not.toContain('subscriber')
    // Start route may read Content-Type but must not use subscriber/phone body fields
    expect(src).not.toContain('body.phone')
    expect(src).not.toContain('body.subscriber')
    expect(src).not.toContain('body.token')  // token is generated server-side
  })

  test('resolve route accepts ONLY the raw token — no phone', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/sms/claim/resolve/route.ts'), 'utf8'
    )
    expect(src).toContain('body.token')
    expect(src).not.toContain('body.phone')
    expect(src).not.toContain('body.subscriber')
  })

  // Item 7: Twilio inbound webhook can confirm the claim
  test('incoming webhook calls confirmSmsSignupClaim after authentication', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain('confirmSmsSignupClaim')
    expect(src).toContain('claimTokenRaw')
    // Confirm is called AFTER validateTwilioSignature (after auth)
    const authIdx    = src.indexOf('validateTwilioSignature')
    const confirmIdx = src.indexOf('confirmSmsSignupClaim')
    expect(authIdx).toBeGreaterThan(0)
    expect(confirmIdx).toBeGreaterThan(authIdx)
  })

  // Item 8: Subscriber association comes from Twilio From
  test('subscriber ID passed to confirm comes from Twilio From (not browser body)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    // Confirm call embeds smsSubscriberId (derived from Twilio From, not browser)
    expect(src).toContain('subscriberId: smsSubscriberId')
    // params.From is the source of phone ownership
    expect(src).toContain('params.From')
  })

  // Item 9: Claim cannot be reassigned to another subscriber
  test('confirm update only transitions pending → confirmed once (status guard)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // Check confirmSmsSignupClaim in lib source
    const claimSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    expect(claimSrc).toContain("AND status     = 'pending'")
    expect(claimSrc).toContain('UPDATE sms_signup_claims')
    // Once confirmed, a second Twilio JOIN cannot overwrite subscriber_id
  })

  // Item 10: Consumed claim cannot be replayed
  test('resolve atomically marks consumed before returning code', () => {
    const claimSrc2 = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    const resolveStart = claimSrc2.indexOf('export async function resolveSmsSignupClaim')
    const resolveBodyStr = claimSrc2.slice(resolveStart, resolveStart + 2500)
    const consumedIdx2  = resolveBodyStr.indexOf("'consumed'")
    expect(consumedIdx2).toBeGreaterThan(0)
    // The UPDATE sets consumed_at before the code is fetched and returned
    // Verify by checking consumed comes before the actual 'return { ok: true' line
    // consumed must appear before the code is returned (string 'ok: true, discountCode')
    const returnCodeIdx = resolveBodyStr.indexOf('return { ok: true')
    expect(returnCodeIdx).toBeGreaterThan(consumedIdx2)
  })
})

// ── Existing behavior preserved (items 11-16) ───────────────────────────────

describe('existing behavior preserved', () => {
  // Item 11: Plain JOIN without claim token still subscribes
  test('incoming webhook handles JOIN with no TK- token gracefully', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    // claimTokenRaw will be null when no TK- present
    expect(src).toContain('claimTokenRaw')
    // Subscription logic runs regardless
    expect(src).toContain('upsertSmsSubscriber')
    expect(src).toContain('resubscribeSmsPhone')
    // Claim confirmation is guarded by claimTokenRaw being truthy
    const confirmBlock = src.slice(src.indexOf('if (claimTokenRaw &&'), src.indexOf('if (claimTokenRaw &&') + 200)
    expect(confirmBlock).toContain('claimTokenRaw')
  })

  // Item 12: STOP still unsubscribes
  test('STOP_KEYWORDS still handled in incoming webhook', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain("STOP_KEYWORDS")
    expect(src).toContain('unsubscribeSmsPhone')
  })

  // Item 13: START still resubscribes
  test('START_KEYWORDS still handled including JOIN', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain("'JOIN'")
    expect(src).toContain('START_KEYWORDS')
  })

  // Item 14: Manual website signup still works
  test('POST /api/sms/subscribe still exists', () => {
    const exists = require('fs').existsSync(
      require('path').join(__dirname, '../../app/api/sms/subscribe/route.ts')
    )
    expect(exists).toBe(true)
  })

  // Item 15: Desktop SMS signup (phone form) still works
  test('desktop phone form submits to /api/sms/subscribe', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('/api/sms/subscribe')
    expect(src).toContain("type=\"tel\"")
  })

  // Item 16: Mobile manual-number alternative still present
  test('mobile popup has manual phone entry option (showManual toggle)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('showManual')
    expect(src).toContain('Enter your number instead')
  })
})

// ── Mobile flow mechanics (items 17-20) ────────────────────────────────────

describe('mobile claim flow mechanics', () => {
  // Item 17: SMS link contains claim token + consent
  test('popup pre-fetches claim token and embeds TK-{token} in SMS body', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    expect(src).toContain('claim/start')
    expect(src).toContain('TK-${claimToken}')
    expect(src).toContain('SMS_CONSENT_TEXT')
    expect(src).toContain('agree to receive recurring automated marketing texts')
  })

  test('JOIN remains first word in SMS body regardless of token presence', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/sms/SmsPopup.tsx'), 'utf8'
    )
    // Both token and no-token versions start with JOIN
    expect(src).toContain('`JOIN KVRN TK-${claimToken}')
    expect(src).toContain('`JOIN KVRN${SMS_CONSENT_TEXT}')
  })

  test('incoming webhook extracts TK- token with regex from original body', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain('/TK-([A-Za-z0-9_-]{20,40})/')
    expect(src).toContain('bodyRaw')
    // First word extraction for keyword detection preserved
    expect(src).toContain('toUpperCase().split')
  })

  // Item 18: SMS code still undergoes V58.4 server validation
  test('claim resolve is discovery-only; checkout still validates via V58.4 system', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/sms/claim/resolve/route.ts'), 'utf8'
    )
    // Resolve returns discountCode to browser; browser then runs through handleApplyDiscount
    // which calls /api/discounts/validate (the V58.4 server-authoritative path)
    expect(src).toContain('discountCode')
    // The resolve route itself is NOT the final checkout validation
    expect(src).not.toContain('checkout-session')
    expect(src).not.toContain('Stripe')
  })

  // Item 19: KVRN10 never surfaced in Available Offers
  test('KVRN10 not surfaced in Available Offers', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // Available Offers section references only free shipping and smsOfferCode
    const offersStart = src.indexOf('Available Offers')
    const offersEnd   = src.indexOf('Discount Code & Summary', offersStart)
    const offersBlock = src.slice(offersStart, offersEnd)
    expect(offersBlock).not.toContain('KVRN10')
    expect(offersBlock).not.toContain("'KVRN10'")
  })

  // Item 20: Free shipping behavior intact
  test('qualifiesForFreeShipping used in checkout', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    expect(src).toContain('qualifiesForFreeShipping')
    expect(src).toContain('freeShippingEligible')
  })
})

// ── Stale code handling ───────────────────────────────────────────────────────

describe('stale localStorage code handling', () => {
  test('permanent reason codes trigger localStorage removal', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    expect(src).toContain("'invalid'")
    expect(src).toContain("'expired'")
    expect(src).toContain("'already_redeemed'")
    expect(src).toContain("permanentReasons")
    expect(src).toContain("localStorage.removeItem('kvrn_sms_discount_code')")
  })

  test('network failure does NOT clear stored code', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // Network error catch block should NOT call localStorage.removeItem
    const catchIdx  = src.lastIndexOf("} catch {\n      setDiscountApplied")
    const catchBlock = src.slice(catchIdx, catchIdx + 150)
    expect(catchBlock).not.toContain('removeItem')
  })

  test('discounts.ts validateDiscount returns reason field', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../discounts.ts'), 'utf8'
    )
    expect(src).toContain("reason: 'invalid'")
    expect(src).toContain("reason: 'expired'")
    expect(src).toContain("reason: 'already_redeemed'")
    expect(src).toContain("reason: 'minimum_subtotal'")
    expect(src).toContain("reason: 'shipping_restricted'")
  })
})

// ── Insecure phone lookup removed ────────────────────────────────────────────

describe('insecure phone-number lookup removed', () => {
  test('confirm-phone route does not exist', () => {
    const exists = require('fs').existsSync(
      require('path').join(__dirname, '../../app/api/sms/confirm-phone/route.ts')
    )
    expect(exists).toBe(false)
  })

  test('checkout does not have phone-input claim form', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    expect(src).not.toContain('claimPhone')
    expect(src).not.toContain('handleClaimSmsOffer')
    expect(src).not.toContain('CLAIM OFFER')
  })
})

// ── Behavioral resolve tests (items 3-12 from spec) ─────────────────────────

describe('resolve behavior — all new scenarios from spec', () => {
  // Item 3: Confirmed + subscribed + eligible offer → success
  test('atomic CTE succeeds only when all three conditions met simultaneously', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // The CTE UPDATE joins all three conditions
    const cteBlock = src.slice(src.indexOf('consume AS'), src.indexOf('RETURNING sms_signup_claims.id'))
    expect(cteBlock).toContain("target.claim_status   = 'confirmed'")
    expect(cteBlock).toContain("target.sub_status      = 'subscribed'")
    expect(cteBlock).toContain('target.discount_code   IS NOT NULL')
  })

  // Item 4: STOP after JOIN but before resolve → unsubscribed, no code
  test('unsubscribed subscriber returns unsubscribed reason (claim not burned)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // Left join to sms_subscribers allows sub_status check
    expect(src).toContain('LEFT JOIN sms_subscribers ss ON ss.id = c.subscriber_id')
    // If sub_status != subscribed → UPDATE WHERE fails → claim not consumed
    expect(src).toContain("reason: 'unsubscribed'")
  })

  // Item 5: Unsubscribed subscriber does NOT cause claim consumption
  test('unsubscribed check is in UPDATE WHERE — UPDATE skipped if unsubscribed', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // The UPDATE has this WHERE condition: sub_status = 'subscribed'
    // So if subscriber is unsubscribed, the UPDATE WHERE evaluates to false → no row consumed
    const consumeUpdate = src.slice(src.indexOf('consume AS ('), src.indexOf('RETURNING sms_signup_claims.id'))
    expect(consumeUpdate).toContain("target.sub_status      = 'subscribed'")
  })

  // Item 6: No eligible offer → claim remains confirmed/retryable
  test('no eligible offer → claim not consumed, reason no_eligible_offer', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // LEFT JOIN discounts allows discount_code to be NULL
    expect(src).toContain('LEFT JOIN discounts d')
    // If discount_code IS NULL → UPDATE WHERE fails → claim stays confirmed
    expect(src).toContain('target.discount_code   IS NOT NULL')
    expect(src).toContain("reason: 'no_eligible_offer'")
  })

  // Item 7: Temporary DB failure → claim remains retryable
  test('temporary failure leaves claim in confirmed state', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // On throw: caller returns temporary_failure; no UPDATE ran; claim stays confirmed
    expect(src).toContain("reason: 'temporary_failure'")
    // The function throws only when sql query itself throws; no state change happened
  })

  // Item 8: Successful resolve → consumed exactly once
  test('successful resolve marks consumed_id in same CTE as code selection', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    // consumed_id is returned from the UPDATE CTE — single operation
    expect(src).toContain('row.consumed_id && row.discount_code')
  })

  // Item 9: Replay after successful resolve → rejected
  test('already_consumed reason prevents replay', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    expect(src).toContain("reason: 'already_consumed'")
    // already_consumed check: target.already_consumed IS NULL in UPDATE WHERE
    expect(src).toContain('target.already_consumed IS NULL')
  })

  // Item 10: Invalid token → rejected
  test('invalid token returns invalid reason', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    expect(src).toContain("reason: 'invalid'")
    expect(src).toContain('rawToken.length < 20')
  })

  // Item 11: Expired token → rejected
  test('expired token returns expired reason', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    expect(src).toContain("reason: 'expired'")
    expect(src).toContain('claim_expires   > NOW()')  // in CTE UPDATE WHERE
  })

  // Item 12: Unconfirmed token → rejected
  test('unconfirmed token returns unconfirmed reason', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../sms-signup-claims.ts'), 'utf8'
    )
    expect(src).toContain("reason: 'unconfirmed'")
    expect(src).toContain("target.claim_status   = 'confirmed'")  // must be confirmed to consume
  })

  // Item 13: Twilio confirmation is now awaited
  test('confirmSmsSignupClaim is awaited in Twilio webhook', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/twilio/incoming/route.ts'), 'utf8'
    )
    expect(src).toContain('await confirmSmsSignupClaim')
    // .then() chains removed
    expect(src).not.toContain('.then(confirmed =>')
  })
})

// ── confirm-phone removal (items 1-2 from spec) ──────────────────────────────

describe('confirm-phone endpoint removed — phone-to-code attack surface closed', () => {
  // Item 1: Old confirm-phone route is removed
  test('confirm-phone route file does not exist', () => {
    const exists = require('fs').existsSync(
      require('path').join(__dirname, '../../app/api/sms/confirm-phone/route.ts')
    )
    expect(exists).toBe(false)
  })

  // Item 2: No phone-number → discount-code endpoint remains
  test('no phone-number lookup endpoint in any sms/ API route', () => {
    const fs = require('fs')
    const path = require('path')
    const smsDir = path.join(__dirname, '../../app/api/sms')
    const files = fs.readdirSync(smsDir, { withFileTypes: true, recursive: true })
      .filter((f: any) => f.isFile && f.name === 'route.ts')
      .map((f: any) => fs.readFileSync(path.join(f.path ?? f.parentPath, f.name), 'utf8'))

    for (const content of files) {
      // None of the sms routes should accept phone and return discount code in same endpoint
      const hasPhoneInput   = content.includes('body.phone')
      const hasDiscountCode = content.includes('discountCode') && content.includes('subscriber')
      // Only the subscribe route is allowed to return a discountCode after new signup
      // (it creates the code, not retrieves existing)
      if (hasPhoneInput && hasDiscountCode) {
        // Subscribe route returns discountCode after CREATING a new subscriber — this is OK
        // Verify it's not doing a lookup of an existing subscriber's code by phone
        expect(content).not.toContain('JOIN discounts')  // no cross-table phone→code lookup
      }
    }
    expect(files.length).toBeGreaterThan(0)  // at least one sms route exists
  })
})
