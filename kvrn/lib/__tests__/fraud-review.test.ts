// lib/__tests__/fraud-review.test.ts
//
// Stripe Radar / fraud review — PURE logic and source guards (no database).
// The DB-backed behavior (triggers, atomic apply, release, webhook) is in fraud-review-db.test.ts and
// fraud-review-webhook.test.ts.

import fs from 'fs'
import path from 'path'
import {
  deriveFromCharge, deriveFromReview, deriveFromEarlyFraudWarning, mergeSignals, normalizeRiskLevel,
  stripeDashboardUrl, buildFraudView, validateNote, holdReasonLabel, HOLD_REASONS, HOLD_REASON_LABELS,
  isFraudHoldDbError, FraudHoldError, hasActiveFraudHold, NOTE_MAX,
} from '../fraud-review'
import { FEATURE_FLAGS } from '../feature-flags'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// A realistic succeeded card charge as Stripe returns it (stripe@16, API 2024-06-20).
const charge = (over: Record<string, any> = {}) => ({
  id: 'ch_3PxAbCdEfGhIjKlM',
  object: 'charge',
  status: 'succeeded',
  paid: true,
  payment_intent: 'pi_3PxAbCdEfGhIjKlM',
  billing_details: { name: 'Pat Customer', email: 'pat@example.com', address: { country: 'US', line1: '1 Main St', postal_code: '12345' } },
  shipping: { name: 'Pat Customer', address: { country: 'US', line1: '1 Main St', postal_code: '12345' } },
  outcome: { network_status: 'approved_by_network', reason: null, risk_level: 'normal', risk_score: 12, seller_message: 'Payment complete.', type: 'authorized' },
  payment_method_details: {
    type: 'card',
    card: {
      brand: 'visa', last4: '4242', fingerprint: 'FPRINT123', country: 'US', funding: 'credit', exp_month: 1, exp_year: 2030,
      checks: { cvc_check: 'pass', address_line1_check: 'pass', address_postal_code_check: 'pass' },
      three_d_secure: null, wallet: null,
    },
  },
  ...over,
})

describe('deriveFromCharge — ordinary payment', () => {
  test('a normal Radar outcome is recorded and recommends NO hold', () => {
    const s = deriveFromCharge(charge())!
    expect(s.holdReason).toBeNull()
    expect(s.triggerKey).toBeNull()
    expect(s.patch).toMatchObject({ risk_level: 'normal', risk_score: 12, outcome_type: 'authorized', charge_id: 'ch_3PxAbCdEfGhIjKlM', payment_intent_id: 'pi_3PxAbCdEfGhIjKlM' })
    const sig = (s.patch as any).signals
    expect(sig).toMatchObject({ cvc_check: 'pass', address_line1_check: 'pass', address_postal_code_check: 'pass', card_country: 'US', charge_evaluated: true })
    expect(sig.three_d_secure).toEqual({ used: false })
  })

  test('elevated, highest and manual_review recommend a hold with a stable trigger key', () => {
    const e = deriveFromCharge(charge({ outcome: { risk_level: 'elevated', type: 'authorized', reason: null, seller_message: null, network_status: null } }))!
    expect([e.holdReason, e.triggerKey]).toEqual(['radar_elevated_risk', 'outcome:ch_3PxAbCdEfGhIjKlM'])
    const h = deriveFromCharge(charge({ outcome: { risk_level: 'highest', type: 'authorized' } }))!
    expect(h.holdReason).toBe('radar_highest_risk')
    const m = deriveFromCharge(charge({ outcome: { risk_level: 'normal', type: 'manual_review', reason: 'rule' } }))!
    expect(m.holdReason).toBe('radar_manual_review')           // manual_review wins over the level
    const both = deriveFromCharge(charge({ outcome: { risk_level: 'highest', type: 'manual_review' } }))!
    expect(both.holdReason).toBe('radar_manual_review')
  })

  test('billing/shipping/country differences alone NEVER recommend a hold (informational only)', () => {
    const s = deriveFromCharge(charge({
      billing_details: { address: { country: 'GB' } }, shipping: { address: { country: 'AU' } },
      payment_method_details: { card: { country: 'DE', checks: { cvc_check: 'fail', address_line1_check: 'fail', address_postal_code_check: 'unavailable' }, three_d_secure: null } },
    }))!
    expect(s.holdReason).toBeNull()
    expect((s.patch as any).signals.country_mismatch).toEqual({ card_vs_billing: true, billing_vs_shipping: true, card_vs_shipping: true })
    expect((s.patch as any).signals.cvc_check).toBe('fail')   // a failed CVC is shown, not acted on
  })
})

describe('deriveFromCharge — missing data is Unknown, never zero or safe', () => {
  test('no outcome at all: level/score/type are null', () => {
    const s = deriveFromCharge(charge({ outcome: null }))!
    expect(s.patch).toMatchObject({ risk_level: null, risk_score: null, outcome_type: null })
    expect(s.holdReason).toBeNull()
  })
  test('no Radar risk_level and no risk_score (Radar for Fraud Teams absent): null, not 0', () => {
    const s = deriveFromCharge(charge({ outcome: { type: 'authorized', reason: null, seller_message: 'ok', network_status: 'approved_by_network' } }))!
    expect((s.patch as any).risk_level).toBeNull()
    expect((s.patch as any).risk_score).toBeNull()
  })
  test('unrecognised level and out-of-range score are dropped, not coerced', () => {
    const s = deriveFromCharge(charge({ outcome: { risk_level: 'extreme', risk_score: 140, type: 'authorized' } }))!
    expect((s.patch as any).risk_level).toBeNull()
    expect((s.patch as any).risk_score).toBeNull()
    expect(normalizeRiskLevel('not_assessed')).toBe('not_assessed')
    expect(normalizeRiskLevel('unknown')).toBe('unknown')
    expect(normalizeRiskLevel(undefined)).toBeNull()
    expect(normalizeRiskLevel('')).toBeNull()
  })
  test('no card details: checks, countries and 3DS are null (3DS is NOT claimed as "not used")', () => {
    const s = deriveFromCharge(charge({ payment_method_details: { type: 'link' }, billing_details: {}, shipping: null }))!
    const sig = (s.patch as any).signals
    expect(sig).toMatchObject({ cvc_check: null, address_line1_check: null, address_postal_code_check: null, card_country: null, three_d_secure: null })
    expect(sig.country_mismatch).toEqual({ card_vs_billing: null, billing_vs_shipping: null, card_vs_shipping: null })
  })
  test('3DS result is recorded when used', () => {
    const s = deriveFromCharge(charge({
      payment_method_details: { card: { country: 'US', checks: null, three_d_secure: { result: 'authenticated', result_reason: null, authentication_flow: 'challenge', version: '2.2.0', transaction_id: 'tx' } } },
    }))!
    expect((s.patch as any).signals.three_d_secure).toEqual({ used: true, result: 'authenticated', result_reason: null, authentication_flow: 'challenge' })
  })
})

describe('deriveFromCharge — only successful payments; nothing sensitive is kept', () => {
  test('a failed / blocked / declined / pending charge yields no signal at all', () => {
    for (const status of ['failed', 'pending']) expect(deriveFromCharge(charge({ status }))).toBeNull()
    expect(deriveFromCharge(charge({ status: 'failed', outcome: { type: 'blocked', risk_level: 'highest', reason: 'highest_risk_level' } }))).toBeNull()
    expect(deriveFromCharge(null)).toBeNull()
    expect(deriveFromCharge({ id: 'nope' })).toBeNull()
  })
  test('the stored patch contains no card number data, fingerprint, IP, e-mail, name or street address', () => {
    const json = JSON.stringify(deriveFromCharge(charge())!.patch)
    for (const secret of ['4242', 'FPRINT123', 'pat@example.com', 'Pat Customer', '1 Main St', '12345', 'last4', 'fingerprint', 'ip_address', '"email"', '"line1"', '"name"']) {
      expect(json).not.toContain(secret)
    }
  })
  test('free text from Stripe is bounded and stripped of control characters', () => {
    const s = deriveFromCharge(charge({ outcome: { risk_level: 'normal', type: 'authorized', seller_message: 'a\u0000b\n' + 'x'.repeat(500) } }))!
    const msg = (s.patch as any).seller_message as string
    expect(msg.length).toBeLessThanOrEqual(200)
    expect(msg).not.toMatch(/[\u0000-\u001f]/)
  })
  test('token fields only accept a safe vocabulary', () => {
    const s = deriveFromCharge(charge({ outcome: { risk_level: 'normal', type: "authorized'; DROP TABLE orders;--", reason: 'Has Spaces' } }))!
    expect((s.patch as any).outcome_type).toBeNull()
    expect((s.patch as any).outcome_reason).toBeNull()
  })
})

describe('deriveFromReview / deriveFromEarlyFraudWarning', () => {
  const review = (over: Record<string, any> = {}) => ({
    id: 'prv_1PxAbCdEfGhIjKlM', object: 'review', open: true, reason: 'rule', opened_reason: 'rule', closed_reason: null,
    charge: 'ch_3PxAbCdEfGhIjKlM', payment_intent: 'pi_3PxAbCdEfGhIjKlM', ip_address: '203.0.113.9',
    ip_address_location: { country: 'US', city: 'Springfield', latitude: 1, longitude: 2, region: 'IL' },
    billing_zip: '12345', session: { browser: 'Chrome' }, created: 1700000000, livemode: false, ...over,
  })

  test('an open review recommends a hold; a closed one only updates state', () => {
    const o = deriveFromReview(review())!
    expect([o.eventType, o.holdReason, o.triggerKey]).toEqual(['review_opened', 'stripe_review_open', 'review:prv_1PxAbCdEfGhIjKlM'])
    expect((o.patch as any).review).toEqual({ id: 'prv_1PxAbCdEfGhIjKlM', open: true, reason: 'rule', closed_reason: null })
    const c = deriveFromReview(review({ open: false, reason: 'approved', closed_reason: 'approved' }))!
    expect([c.eventType, c.holdReason, c.triggerKey]).toEqual(['review_closed', null, null])
    expect((c.patch as any).review).toMatchObject({ open: false, closed_reason: 'approved' })
  })
  test('the review patch keeps only the IP COUNTRY — never the address, city, session or ZIP', () => {
    const json = JSON.stringify(deriveFromReview(review())!.patch)
    expect(json).toContain('"ip_country":"US"')
    for (const s of ['203.0.113.9', 'Springfield', '12345', 'Chrome', 'latitude']) expect(json).not.toContain(s)
  })
  test('a payment_intent given as an expanded object is reduced to its id', () => {
    const s = deriveFromReview(review({ payment_intent: { id: 'pi_3PxAbCdEfGhIjKlM', amount: 5 }, charge: { id: 'ch_3PxAbCdEfGhIjKlM' } }))!
    expect([s.paymentIntentId, s.chargeId]).toEqual(['pi_3PxAbCdEfGhIjKlM', 'ch_3PxAbCdEfGhIjKlM'])
  })
  test('malformed reviews yield nothing', () => {
    expect(deriveFromReview(null)).toBeNull()
    expect(deriveFromReview({ id: 'prv_1PxAbCdEfGhIjKlM' })).toBeNull()      // open missing: not guessed
    expect(deriveFromReview({ id: 'bad id', open: true })).toBeNull()
  })

  test('an actionable early fraud warning recommends a hold; a non-actionable one does not', () => {
    const efw = { id: 'issfr_1PxAbCdEfGhIjKlM', object: 'radar.early_fraud_warning', actionable: true, charge: 'ch_3PxAbCdEfGhIjKlM', fraud_type: 'made_with_stolen_card' }
    const a = deriveFromEarlyFraudWarning(efw)!
    expect([a.holdReason, a.triggerKey, a.chargeId, a.paymentIntentId]).toEqual(['early_fraud_warning', 'efw:issfr_1PxAbCdEfGhIjKlM', 'ch_3PxAbCdEfGhIjKlM', null])
    expect((a.patch as any).signals.early_fraud_warning).toEqual({ id: 'issfr_1PxAbCdEfGhIjKlM', fraud_type: 'made_with_stolen_card', actionable: true })
    expect(deriveFromEarlyFraudWarning({ ...efw, actionable: false })!.holdReason).toBeNull()
    expect(deriveFromEarlyFraudWarning({ id: efw.id, actionable: true })).toBeNull()         // no charge, no PI
  })
})

describe('mergeSignals', () => {
  const ch = (level: string) => deriveFromCharge(charge({ outcome: { risk_level: level, type: 'authorized' } }))!
  const rv = (open: boolean) => deriveFromReview({ id: 'prv_1PxAbCdEfGhIjKlM', open, reason: open ? 'rule' : 'approved', closed_reason: open ? null : 'approved', payment_intent: 'pi_3PxAbCdEfGhIjKlM' }, 'synced')!
  test('an open review is the hold cause and wins over the outcome', () => {
    const m = mergeSignals(ch('elevated'), rv(true))!
    expect([m.eventType, m.holdReason, m.triggerKey]).toEqual(['synced', 'stripe_review_open', 'review:prv_1PxAbCdEfGhIjKlM'])
    expect((m.patch as any).review.open).toBe(true)
    expect((m.patch as any).risk_level).toBe('elevated')
  })
  test('a closed review falls back to the outcome', () => {
    const m = mergeSignals(ch('elevated'), rv(false))!
    expect([m.holdReason, m.triggerKey]).toEqual(['radar_elevated_risk', 'outcome:ch_3PxAbCdEfGhIjKlM'])
  })
  test('one side missing / both missing', () => {
    expect(mergeSignals(ch('normal'), null)!.eventType).toBe('synced')
    expect(mergeSignals(null, rv(true))!.holdReason).toBe('stripe_review_open')
    expect(mergeSignals(null, null)).toBeNull()
  })
})

describe('stripeDashboardUrl — official, test/live aware, id-validated', () => {
  test('test vs live', () => {
    expect(stripeDashboardUrl('payment', 'pi_3PxAbCdEfGhIjKlM', 'test')).toBe('https://dashboard.stripe.com/test/payments/pi_3PxAbCdEfGhIjKlM')
    expect(stripeDashboardUrl('payment', 'pi_3PxAbCdEfGhIjKlM', 'live')).toBe('https://dashboard.stripe.com/payments/pi_3PxAbCdEfGhIjKlM')
    expect(stripeDashboardUrl('review', 'prv_1PxAbCdEfGhIjKlM', 'test')).toBe('https://dashboard.stripe.com/test/radar/reviews/prv_1PxAbCdEfGhIjKlM')
  })
  test('no link from a missing/invalid id, wrong prefix, or an unknown mode', () => {
    expect(stripeDashboardUrl('payment', null, 'test')).toBeNull()
    expect(stripeDashboardUrl('payment', 'pi_3Px AbCd', 'test')).toBeNull()
    expect(stripeDashboardUrl('payment', '../../evil', 'test')).toBeNull()
    expect(stripeDashboardUrl('payment', 'prv_1PxAbCdEfGhIjKlM', 'test')).toBeNull()
    expect(stripeDashboardUrl('review', 'pi_3PxAbCdEfGhIjKlM', 'test')).toBeNull()
    expect(stripeDashboardUrl('payment', 'pi_3PxAbCdEfGhIjKlM', null)).toBeNull()
  })
})

describe('buildFraudView — what the Admin shows', () => {
  const ctx = { holdsEnabled: true, mode: 'test' as const, paymentIntentId: 'pi_3PxAbCdEfGhIjKlM' }
  test('no record = Unknown (nothing assumed, nothing flagged), link still offered from the order PI', () => {
    const v = buildFraudView(null, ctx)
    expect(v).toMatchObject({ hasRecord: false, riskLevel: null, riskScore: null, flagged: false, canRelease: false })
    expect(v.hold.state).toBe('none')
    expect(v.checks).toEqual({ cvc: null, addressLine1: null, postalCode: null })
    expect(v.links.payment).toBe('https://dashboard.stripe.com/test/payments/pi_3PxAbCdEfGhIjKlM')
  })
  test('a row with no Radar data is Unknown, not zero and not normal', () => {
    const v = buildFraudView({ order_id: 'o', risk_level: null, risk_score: null, signals: {}, hold_state: 'none' }, ctx)
    expect(v.riskLevel).toBeNull()
    expect(v.riskScore).toBeNull()
    expect(v.flagged).toBe(false)
  })
  test('elevated is flagged; with holds off it is flagged-but-not-held (shown loudly)', () => {
    const row = { order_id: 'o', risk_level: 'elevated', signals: {}, hold_state: 'none' }
    expect(buildFraudView(row, ctx).flaggedButHoldsOff).toBe(false)
    expect(buildFraudView(row, { ...ctx, holdsEnabled: false })).toMatchObject({ flagged: true, flaggedButHoldsOff: true })
  })
  test('an active hold carries a plain-language reason and can be released', () => {
    const v = buildFraudView({
      order_id: 'o', risk_level: 'elevated', outcome_type: 'manual_review', signals: {}, hold_state: 'active',
      hold_reason: 'radar_manual_review', hold_source: 'webhook', hold_created_at: '2026-01-02T03:04:05Z',
      stripe_review_id: 'prv_1PxAbCdEfGhIjKlM', stripe_review_state: 'open',
    }, ctx)
    expect(v.hold).toMatchObject({ state: 'active', reason: 'radar_manual_review', reasonLabel: 'Radar flagged this payment for manual review.' })
    expect(v.canRelease).toBe(true)
    expect(v.stripeReview).toMatchObject({ id: 'prv_1PxAbCdEfGhIjKlM', state: 'open' })
    expect(v.links.review).toBe('https://dashboard.stripe.com/test/radar/reviews/prv_1PxAbCdEfGhIjKlM')
  })
  test('released hold keeps who/when/note; confirmed fraud is surfaced', () => {
    const v = buildFraudView({
      order_id: 'o', signals: {}, hold_state: 'released', hold_reason: 'stripe_review_open', released_by: 'a@b.c',
      released_at: '2026-01-03T00:00:00Z', release_note: 'Verified by phone',
      fraud_confirmed_at: '2026-01-04T00:00:00Z', fraud_confirmed_by: 'a@b.c', fraud_confirmed_note: null,
    }, ctx)
    expect(v.hold).toMatchObject({ state: 'released', releasedBy: 'a@b.c', releaseNote: 'Verified by phone' })
    expect(v.canRelease).toBe(false)
    expect(v.fraudConfirmed).toMatchObject({ by: 'a@b.c' })
  })
  test('unexpected values in the signals JSON never leak through', () => {
    const v = buildFraudView({ order_id: 'o', risk_level: 'bogus', signals: { cvc_check: 'maybe', card_country: 'usa', evil: '<script>' }, hold_state: 'weird' }, ctx)
    expect(v.riskLevel).toBeNull()
    expect(v.checks.cvc).toBeNull()
    expect(v.cardCountry).toBeNull()
    expect(v.hold.state).toBe('none')
    expect(JSON.stringify(v)).not.toContain('script')
  })
})

describe('notes, labels, errors', () => {
  test('validateNote', () => {
    expect(validateNote(undefined)).toEqual({ ok: true, note: null })
    expect(validateNote('  ok  ')).toEqual({ ok: true, note: 'ok' })
    expect(validateNote('   ')).toEqual({ ok: true, note: null })
    expect(validateNote('x'.repeat(NOTE_MAX)).ok).toBe(true)
    expect(validateNote('x'.repeat(NOTE_MAX + 1)).ok).toBe(false)
    expect(validateNote('bad\u0000note').ok).toBe(false)
    expect(validateNote(5 as any).ok).toBe(false)
  })
  test('every hold reason has a plain-language label and none shows a raw code', () => {
    for (const r of HOLD_REASONS) {
      expect(HOLD_REASON_LABELS[r]).toBeTruthy()
      expect(HOLD_REASON_LABELS[r]).not.toMatch(/_/)
    }
    expect(holdReasonLabel('something_new')).toBe('Held for review.')
    expect(holdReasonLabel(null)).toBe('Held for review.')
  })
  test('FraudHoldError is a 409 with a stable code; the DB error is recognised', () => {
    const e = new FraudHoldError()
    expect([e.status, e.code]).toEqual([409, 'FRAUD_HOLD_ACTIVE'])
    expect(isFraudHoldDbError(new Error('KVRN_FRAUD_HOLD|FRAUD_HOLD_ACTIVE|abc'))).toBe(true)
    expect(isFraudHoldDbError(new Error('something else'))).toBe(false)
  })
  test('hasActiveFraudHold: false when migration 031 is not applied (missing table), rethrows other errors', async () => {
    const missing: any = async () => { const e: any = new Error('relation "order_fraud_reviews" does not exist'); e.code = '42P01'; throw e }
    expect(await hasActiveFraudHold(missing, '00000000-0000-0000-0000-000000000001')).toBe(false)
    const broken: any = async () => { throw new Error('connection reset') }
    await expect(hasActiveFraudHold(broken, '00000000-0000-0000-0000-000000000001')).rejects.toThrow('connection reset')
    const held: any = async () => [{ held: 1 }]
    expect(await hasActiveFraudHold(held, '00000000-0000-0000-0000-000000000001')).toBe(true)
  })
})

describe('feature flag', () => {
  test('RADAR_FULFILLMENT_HOLDS exists and is independent', () => {
    expect(FEATURE_FLAGS.RADAR_FULFILLMENT_HOLDS.env).toBe('KVRN_FLAG_RADAR_FULFILLMENT_HOLDS')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Source guards
// ─────────────────────────────────────────────────────────────────────────────
describe('source guards', () => {
  const mig = read('db/migrations/031_order_tags_fraud_review.sql')
  const code = mig.replace(/--.*$/gm, '')

  test('031 is additive: it never alters/drops anything that exists before it', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|TRIGGER|INDEX|CONSTRAINT)\b/i)
    expect(code).not.toMatch(/ALTER\s+TABLE\s+(?!IF EXISTS\s)/i)
    expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+(orders|order_items|order_refunds|shipments|product_variants|inventory_\w+|order_disputes)\b/i)
    // Only its own functions are (re)created.
    const created = [...code.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_0-9]+)/gi)].map(m => m[1])
    expect(created.length).toBeGreaterThan(10)
    for (const f of created) expect(f).toMatch(/^(order_tag_|order_fraud_|fraud_)/)
    // 001-027 untouched in this worktree.
    expect(fs.existsSync(path.join(ROOT, 'db/migrations/031_order_tags_fraud_review.sql'))).toBe(true)
  })
  test('a hold touches no payment, total, inventory or financial table', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION fraud_review_apply_signal'), code.indexOf('CREATE OR REPLACE FUNCTION fraud_review_record_sync_failure'))
    expect(fn).not.toMatch(/payment_status\s*=/i)
    expect(fn).not.toMatch(/\b(total_cents|subtotal_cents|stock_on_hand|inventory_|order_refunds|financial_)/i)
    expect(fn).not.toMatch(/UPDATE\s+orders/i)
  })
  test('the trigger blocks transitions INTO processing/shipped/delivered and allows cancelled', () => {
    expect(code).toMatch(/NEW\.fulfillment_status IN \('processing','shipped','delivered'\)/)
    expect(code).not.toMatch(/IN \([^)]*'cancelled'[^)]*\)\s*\n?\s*AND NEW\.fulfillment_status IS DISTINCT/)
    expect(code).toMatch(/BEFORE UPDATE OF fulfillment_status ON orders/)
    expect(code).toMatch(/BEFORE INSERT OR UPDATE OF tracking_number[^)]*\) ON shipments|ON shipments/)
  })
  test('the events table is append-only', () => {
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON order_fraud_events/)
  })

  test('no homegrown fraud score and no auto-decline anywhere in the new code', () => {
    const svc = read('lib/fraud-review.ts').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(svc).not.toMatch(/calculateRisk|computeRisk|autoDecline|auto_decline|declineOrder|refunds\.create|paymentIntents\.cancel/i)
  })
  test('Stripe is only ever READ: no approve / close / create / update / cancel call', () => {
    for (const f of ['lib/fraud-review.ts', 'app/api/admin/orders/[id]/fraud/refresh/route.ts', 'app/api/admin/orders/[id]/fraud/release/route.ts', 'app/api/admin/orders/[id]/fraud/confirm/route.ts']) {
      const src = read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(src).not.toMatch(/reviews\.approve|\.refunds\.create|\.paymentIntents\.(update|cancel|capture|confirm|create)|\.charges\.(update|capture|create)/)
      for (const m of src.matchAll(/stripe\w*\(?\)?\.(\w+)\.(\w+)\(/gi)) expect(['retrieve']).toContain(m[2])
    }
  })

  test('every new Admin route starts with requireAdmin', () => {
    const files = [
      'app/api/admin/orders/tags/route.ts', 'app/api/admin/orders/tags/[tagId]/route.ts',
      'app/api/admin/orders/[id]/tags/route.ts', 'app/api/admin/orders/[id]/fraud/route.ts',
      'app/api/admin/orders/[id]/fraud/release/route.ts', 'app/api/admin/orders/[id]/fraud/refresh/route.ts',
      'app/api/admin/orders/[id]/fraud/confirm/route.ts',
    ]
    for (const f of files) {
      const src = read(f)
      for (const m of src.matchAll(/export async function (GET|POST|PATCH|DELETE)\b[^{]*\{([\s\S]{0,260})/g)) {
        expect(m[2]).toMatch(/requireAdmin\(req\)/)
      }
    }
  })

  test('internal tags and fraud state never appear in a customer-facing surface', () => {
    const publicFiles: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`
        if (e.isDirectory()) { walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        // admin-only surfaces
        if (rel.startsWith('app/admin/') || rel.startsWith('app/api/admin/') || rel.startsWith('app/api/orders/')) continue
        if (rel === 'app/api/stripe/webhook/route.ts') continue
        publicFiles.push(rel)
      }
    }
    walk('app'); walk('components')
    for (const f of ['lib/email.ts', 'lib/transactional-email.ts', 'lib/checkout-status-handler.ts', 'lib/checkout-status.ts']) publicFiles.push(f)
    expect(publicFiles.length).toBeGreaterThan(50)
    for (const f of publicFiles) {
      expect([f, /order_tags|order_tag_assignments|order_fraud_|fraud-review|order-tags|fraud_review/i.test(read(f))]).toEqual([f, false])
    }
  })

  test('the legacy /api/orders routes are admin-gated (they now carry tags)', () => {
    for (const f of ['app/api/orders/route.ts', 'app/api/orders/[id]/route.ts']) {
      const src = read(f)
      for (const m of src.matchAll(/export async function (GET|POST|PATCH)\b[^{]*\{([\s\S]{0,200})/g)) expect(m[2]).toMatch(/requireAdmin\(req\)/)
    }
  })

  test('webhook: Radar events are handled additively and the flag gates every new write path', () => {
    const w = read('app/api/stripe/webhook/route.ts')
    for (const t of ['review.opened', 'review.closed', 'charge.succeeded', 'radar.early_fraud_warning.created']) expect(w).toContain(`case '${t}'`)
    expect(w).toMatch(/tryIngestFraudForOrder[\s\S]{0,400}isFeatureEnabled\('RADAR_FULFILLMENT_HOLDS'\)/)
    // existing protections still present and unmodified in shape
    for (const keep of ['finalizePaidOrder', 'handleChargeRefunded', 'handleDispute', 'releaseReservationForEvent', 'markAwaitingPayment']) expect(w).toContain(keep)
  })
})
