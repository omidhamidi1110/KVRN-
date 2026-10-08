// lib/fraud-review.ts — Stripe Radar signals + the KVRN fulfillment-review HOLD.
//
// PRINCIPLES
//   * Stripe/Radar is the ONLY intelligence source. There is no KVRN fraud score and no KVRN
//     auto-decline. We read what Stripe actually supplies and show "Unknown" when it supplies nothing
//     (missing data is never zero and never "safe").
//   * A successful payment stays PAID. A hold is an ADDITIVE fulfillment gate: it changes no payment
//     status, total, inventory, financial event or reconciliation input. It is enforced in the DATABASE
//     (migration 031 triggers), so no caller can route around it; the checks in this app are an early,
//     friendlier refusal on top.
//   * Holds are created only when the RADAR_FULFILLMENT_HOLDS flag is ON (read at call time). With the
//     flag OFF this module may still RECORD what Stripe said (visibility), but never holds an order.
//   * Admin "Refresh" is a Stripe GET only. KVRN never approves/closes a Stripe Review through the API:
//     releasing the KVRN hold does NOT change Stripe, and the Admin says so plainly.
//
// SIGNALS ACTUALLY AVAILABLE (audited against the installed stripe@16 types, API 2024-06-20):
//   Charge.outcome            { type, reason, risk_level?, risk_score? (Radar for Fraud Teams only), seller_message, network_status }
//   Charge...card.checks      { cvc_check, address_line1_check, address_postal_code_check }
//   Charge...card             { country, funding, wallet, three_d_secure { result, result_reason, authentication_flow } }
//   Charge.billing_details / Charge.shipping — country only (to compare countries; never the address)
//   PaymentIntent.review / Review { id, open, reason, opened_reason, closed_reason, ip_address_location.country }
//   Radar.EarlyFraudWarning   { id, fraud_type, actionable, charge, payment_intent? }
// Events: review.opened, review.closed, radar.early_fraud_warning.created, charge.succeeded.
// NOT stored, ever: card number / last4 / fingerprint, IP address, e-mail, name, street address.
//
// This module is import-safe from client code (type-only imports plus pure helpers).

import type { NeonQueryFunction } from '@neondatabase/serverless'
import type Stripe from 'stripe'
import { isFeatureEnabled } from './feature-flags'
import { resolveStripeMode, type StripeMode } from './stripe-mode'

type Sql = NeonQueryFunction<false, false>

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

export type RiskLevel = 'normal' | 'elevated' | 'highest' | 'not_assessed' | 'unknown'
export type CheckResult = 'pass' | 'fail' | 'unavailable' | 'unchecked'
export type HoldState = 'none' | 'active' | 'released'

export const HOLD_REASONS = [
  'stripe_review_open', 'radar_manual_review', 'radar_elevated_risk', 'radar_highest_risk',
  'early_fraud_warning', 'confirmed_fraud',
] as const
export type HoldReason = (typeof HOLD_REASONS)[number]

/** Plain-language reason for each hold cause (never shows raw codes to the owner). */
export const HOLD_REASON_LABELS: Record<string, string> = {
  stripe_review_open:  'Stripe opened a review on this payment.',
  radar_manual_review: 'Radar flagged this payment for manual review.',
  radar_elevated_risk: 'Radar rated this payment as elevated risk.',
  radar_highest_risk:  'Radar rated this payment as highest risk.',
  early_fraud_warning: 'The card issuer sent an early fraud warning.',
  confirmed_fraud:     'Marked as confirmed fraud by an admin.',
}
export const holdReasonLabel = (code: string | null | undefined): string =>
  (code && HOLD_REASON_LABELS[code]) || 'Held for review.'

export const NOTE_MAX = 500

const CHECK_VALUES = new Set<string>(['pass', 'fail', 'unavailable', 'unchecked'])
const RISK_LEVELS  = new Set<string>(['normal', 'elevated', 'highest', 'not_assessed', 'unknown'])
const TOKEN_RE     = /^[a-z0-9_]{1,40}$/
const COUNTRY_RE   = /^[A-Z]{2}$/
const STRIPE_ID_RE = /^[a-z]+_[A-Za-z0-9]{6,80}$/

// ─────────────────────────────────────────────────────────────────────────────
// Pure normalisers (whitelist everything that reaches the database)
// ─────────────────────────────────────────────────────────────────────────────

const token = (v: unknown): string | null =>
  typeof v === 'string' && TOKEN_RE.test(v) ? v : null
const country = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const u = v.trim().toUpperCase()
  return COUNTRY_RE.test(u) ? u : null
}
const checkValue = (v: unknown): CheckResult | null =>
  typeof v === 'string' && CHECK_VALUES.has(v) ? (v as CheckResult) : null
const stripeId = (v: unknown): string | null => {
  const id = typeof v === 'string' ? v : (v && typeof v === 'object' && typeof (v as any).id === 'string' ? (v as any).id : null)
  return id && STRIPE_ID_RE.test(id) ? id : null
}

/** Unknown / absent / unrecognised => null. A recognised Stripe value is passed through. */
export function normalizeRiskLevel(v: unknown): RiskLevel | null {
  return typeof v === 'string' && RISK_LEVELS.has(v) ? (v as RiskLevel) : null
}

function sellerMessage(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  return s || null
}

// ─────────────────────────────────────────────────────────────────────────────
// Deriving a signal from a Stripe object
// ─────────────────────────────────────────────────────────────────────────────

export type FraudEventType = 'review_opened' | 'review_closed' | 'early_fraud_warning' | 'charge_outcome' | 'synced'

export interface FraudSignal {
  eventType:   FraudEventType
  /** Whitelisted patch passed to fraud_review_apply_signal(). */
  patch:       Record<string, unknown>
  /** Non-null = this signal recommends a hold. */
  holdReason:  HoldReason | null
  triggerKey:  string | null
  paymentIntentId: string | null
  chargeId:    string | null
  reviewId:    string | null
}

/**
 * Charge -> signal. Only a SUCCEEDED charge is considered (a blocked / declined / failed payment never
 * becomes an order, and nothing here can make it one). Every value is whitelisted; anything Stripe did
 * not supply stays null = Unknown.
 */
export function deriveFromCharge(charge: unknown): FraudSignal | null {
  const c = charge as any
  if (!c || typeof c !== 'object') return null
  const chargeId = stripeId(c.id)
  if (!chargeId || c.status !== 'succeeded') return null

  const outcome = c.outcome && typeof c.outcome === 'object' ? c.outcome : null
  const riskLevel = outcome ? normalizeRiskLevel(outcome.risk_level) : null
  const rawScore = outcome?.risk_score
  const riskScore = typeof rawScore === 'number' && Number.isInteger(rawScore) && rawScore >= 0 && rawScore <= 100 ? rawScore : null
  const outcomeType = outcome ? token(outcome.type) : null

  const card = c.payment_method_details?.card && typeof c.payment_method_details.card === 'object'
    ? c.payment_method_details.card : null
  const checks = card?.checks && typeof card.checks === 'object' ? card.checks : null
  const tds = card?.three_d_secure && typeof card.three_d_secure === 'object' ? card.three_d_secure : null

  const cardCountry     = card ? country(card.country) : null
  const billingCountry  = country(c.billing_details?.address?.country)
  const shippingCountry = country(c.shipping?.address?.country)
  const differs = (a: string | null, b: string | null): boolean | null => (a && b ? a !== b : null)

  const signals: Record<string, unknown> = {
    charge_evaluated: true,
    cvc_check:                 checks ? checkValue(checks.cvc_check) : null,
    address_line1_check:       checks ? checkValue(checks.address_line1_check) : null,
    address_postal_code_check: checks ? checkValue(checks.address_postal_code_check) : null,
    card_country:     cardCountry,
    billing_country:  billingCountry,
    shipping_country: shippingCountry,
    card_funding:     card ? token(card.funding) : null,
    wallet_type:      card?.wallet && typeof card.wallet === 'object' ? token(card.wallet.type) : null,
    // card present + no 3DS object = 3DS was not used; no card details at all = unknown.
    three_d_secure:   card
      ? (tds ? { used: true, result: token(tds.result), result_reason: token(tds.result_reason), authentication_flow: token(tds.authentication_flow) }
             : { used: false })
      : null,
    network_status:   outcome ? token(outcome.network_status) : null,
    // Informational only. These NEVER decline or hold anything by themselves.
    country_mismatch: {
      card_vs_billing:     differs(cardCountry, billingCountry),
      billing_vs_shipping: differs(billingCountry, shippingCountry),
      card_vs_shipping:    differs(cardCountry, shippingCountry),
    },
  }

  let holdReason: HoldReason | null = null
  if (outcomeType === 'manual_review') holdReason = 'radar_manual_review'
  else if (riskLevel === 'highest')    holdReason = 'radar_highest_risk'
  else if (riskLevel === 'elevated')   holdReason = 'radar_elevated_risk'

  const paymentIntentId = stripeId(c.payment_intent)
  return {
    eventType: 'charge_outcome',
    patch: {
      payment_intent_id: paymentIntentId,
      charge_id:         chargeId,
      risk_level:        riskLevel,
      risk_score:        riskScore,
      outcome_type:      outcomeType,
      outcome_reason:    outcome ? token(outcome.reason) : null,
      seller_message:    outcome ? sellerMessage(outcome.seller_message) : null,
      signals,
    },
    holdReason,
    triggerKey: holdReason ? `outcome:${chargeId}` : null,
    paymentIntentId,
    chargeId,
    reviewId: null,
  }
}

/** Review object -> signal. An OPEN review recommends a hold; a closed one only updates the state. */
export function deriveFromReview(review: unknown, eventType?: 'review_opened' | 'review_closed' | 'synced'): FraudSignal | null {
  const r = review as any
  if (!r || typeof r !== 'object') return null
  const id = stripeId(r.id)
  if (!id || typeof r.open !== 'boolean') return null
  const open: boolean = r.open
  const closedReason = token(r.closed_reason)
  const ipCountry = country(r.ip_address_location?.country)
  const paymentIntentId = stripeId(r.payment_intent)
  const chargeId = stripeId(r.charge)
  return {
    eventType: eventType ?? (open ? 'review_opened' : 'review_closed'),
    patch: {
      payment_intent_id: paymentIntentId,
      charge_id:         chargeId,
      review: { id, open, reason: token(r.reason), closed_reason: closedReason },
      signals: {
        review_opened_reason: token(r.opened_reason),
        ...(ipCountry ? { ip_country: ipCountry } : {}),
      },
    },
    holdReason: open ? 'stripe_review_open' : null,
    triggerKey: open ? `review:${id}` : null,
    paymentIntentId,
    chargeId,
    reviewId: id,
  }
}

/** Early fraud warning -> signal. An actionable warning recommends a hold. */
export function deriveFromEarlyFraudWarning(efw: unknown): FraudSignal | null {
  const e = efw as any
  if (!e || typeof e !== 'object') return null
  const id = stripeId(e.id)
  if (!id) return null
  const actionable = e.actionable === true
  const paymentIntentId = stripeId(e.payment_intent)
  const chargeId = stripeId(e.charge)
  if (!paymentIntentId && !chargeId) return null
  return {
    eventType: 'early_fraud_warning',
    patch: {
      payment_intent_id: paymentIntentId,
      charge_id:         chargeId,
      signals: { early_fraud_warning: { id, fraud_type: token(e.fraud_type), actionable } },
    },
    holdReason: actionable ? 'early_fraud_warning' : null,
    triggerKey: actionable ? `efw:${id}` : null,
    paymentIntentId,
    chargeId,
    reviewId: null,
  }
}

/**
 * Merge a charge signal and a review signal read from the SAME payment (a refresh / order-creation
 * lookup). The review wins as the hold cause when it is open; otherwise the charge outcome decides.
 */
export function mergeSignals(charge: FraudSignal | null, review: FraudSignal | null): FraudSignal | null {
  if (!charge && !review) return null
  if (!review) return { ...charge!, eventType: 'synced' }
  if (!charge) return { ...review, eventType: 'synced' }
  const useReview = review.holdReason !== null
  return {
    eventType: 'synced',
    patch: {
      ...charge.patch,
      payment_intent_id: charge.paymentIntentId ?? review.paymentIntentId,
      review: (review.patch as any).review,
      signals: { ...(charge.patch as any).signals, ...(review.patch as any).signals },
    },
    holdReason: useReview ? review.holdReason : charge.holdReason,
    triggerKey: useReview ? review.triggerKey : charge.triggerKey,
    paymentIntentId: charge.paymentIntentId ?? review.paymentIntentId,
    chargeId: charge.chargeId,
    reviewId: review.reviewId,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe dashboard references (links only; no credentials)
// ─────────────────────────────────────────────────────────────────────────────

/** Test/live-aware official Stripe dashboard URL, or null if the id is malformed or the mode is invalid. */
export function stripeDashboardUrl(kind: 'payment' | 'review', id: string | null | undefined, mode: StripeMode | null): string | null {
  if (!id || !mode || !STRIPE_ID_RE.test(id)) return null
  const prefix = kind === 'payment' ? 'pi_' : 'prv_'
  if (!id.startsWith(prefix)) return null
  const base = mode === 'test' ? 'https://dashboard.stripe.com/test' : 'https://dashboard.stripe.com'
  return kind === 'payment' ? `${base}/payments/${id}` : `${base}/radar/reviews/${id}`
}

/** The configured mode, or null if STRIPE_MODE is invalid (so no link is built from a guess). */
export function safeStripeMode(): StripeMode | null {
  try { return resolveStripeMode() } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export const FRAUD_ERRORS: Record<string, { status: number; message: string }> = {
  ORDER_REQUIRED:  { status: 400, message: 'Invalid order.' },
  ACTOR_REQUIRED:  { status: 400, message: 'An admin identity is required.' },
  ACTOR_INVALID:   { status: 400, message: 'The admin identity is invalid.' },
  NOTE_INVALID:    { status: 400, message: `The note must be ${NOTE_MAX} characters or fewer and contain no control characters.` },
  ORDER_NOT_FOUND: { status: 404, message: 'Order not found.' },
}

export class FraudReviewError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message) }
}

/** The order is on an active fraud hold; fulfillment is refused. Always HTTP 409. */
export class FraudHoldError extends FraudReviewError {
  constructor() {
    super('FRAUD_HOLD_ACTIVE', 409,
      'This order is on a fraud review hold. Review it and release the hold before fulfilling it.')
  }
}

/** True for the database refusal raised by the 031 triggers. */
export function isFraudHoldDbError(err: unknown): boolean {
  return /KVRN_FRAUD_HOLD\|FRAUD_HOLD_ACTIVE/.test(String((err as any)?.message ?? ''))
}

function mapFraudDbError(err: unknown): never {
  if (isFraudHoldDbError(err)) throw new FraudHoldError()
  const m = /KVRN_FRAUD\|([A-Z_]+)/.exec(String((err as any)?.message ?? ''))
  if (m) {
    const known = FRAUD_ERRORS[m[1]]
    if (known) throw new FraudReviewError(m[1], known.status, known.message)
  }
  throw err
}

/** Trim and bound an optional note. */
export function validateNote(raw: unknown): { ok: true; note: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, note: null }
  if (typeof raw !== 'string') return { ok: false, error: 'The note must be text.' }
  const note = raw.trim()
  if (note.length > NOTE_MAX) return { ok: false, error: `The note must be ${NOTE_MAX} characters or fewer.` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(note)) return { ok: false, error: 'The note contains control characters.' }
  return { ok: true, note: note || null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hold lookup (contract with affiliate-portal payout gating)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is there an ACTIVE fraud fulfillment hold on this order? Used as an early refusal in the Admin order
 * service and exported for affiliate payout gating. If migration 031 has not been applied yet
 * (table missing) there can be no hold, so this returns false rather than breaking fulfillment.
 */
export async function hasActiveFraudHold(sql: Sql, orderId: string): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT 1 AS held FROM order_fraud_reviews WHERE order_id = ${orderId}::uuid AND hold_state = 'active' LIMIT 1`
    return (rows as any[]).length > 0
  } catch (err: any) {
    if (err?.code === '42P01' || /order_fraud_reviews.*does not exist/i.test(String(err?.message ?? ''))) return false
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The Admin view model (read side)
// ─────────────────────────────────────────────────────────────────────────────

export interface FraudView {
  /** false = nothing recorded for this order (Unknown, never "safe"). */
  hasRecord:    boolean
  riskLevel:    RiskLevel | null
  riskScore:    number | null
  outcomeType:  string | null
  outcomeReason: string | null
  sellerMessage: string | null
  checks:       { cvc: CheckResult | null; addressLine1: CheckResult | null; postalCode: CheckResult | null }
  cardCountry:  string | null
  billingCountry: string | null
  shippingCountry: string | null
  ipCountry:    string | null
  cardFunding:  string | null
  walletType:   string | null
  threeDSecure: { used: boolean; result: string | null; reason: string | null } | null
  countryMismatch: { cardVsBilling: boolean | null; billingVsShipping: boolean | null; cardVsShipping: boolean | null }
  stripeReview: { id: string; state: 'open' | 'closed'; reason: string | null; closedReason: string | null } | null
  earlyFraudWarning: { id: string; fraudType: string | null; actionable: boolean } | null
  /** Stripe's own signals recommend a review (independent of whether KVRN holds are switched on). */
  flagged:      boolean
  hold: {
    state: HoldState; reason: string | null; reasonLabel: string | null; source: string | null
    since: string | null; releasedBy: string | null; releasedAt: string | null; releaseNote: string | null
  }
  fraudConfirmed: { by: string; at: string; note: string | null } | null
  lastSyncedAt: string | null
  /** A short code when the last Stripe lookup failed. */
  syncError:    string | null
  holdsEnabled: boolean
  /** Flagged by Stripe, no hold, because holds are switched off: shown loudly so it is not mistaken for "fine". */
  flaggedButHoldsOff: boolean
  canRelease:   boolean
  links:        { payment: string | null; review: string | null }
  events:       FraudEventView[]
}

export interface FraudEventView {
  id: string; type: string; actor: string; source: string; createdAt: string
  detail: Record<string, unknown>
}

const iso = (v: unknown): string | null => (v ? new Date(v as any).toISOString() : null)

/** Pure: DB row (snake_case, or null) + context -> the object the Admin renders. */
export function buildFraudView(
  row: Record<string, any> | null,
  ctx: { holdsEnabled: boolean; mode: StripeMode | null; paymentIntentId: string | null; events?: FraudEventView[] },
): FraudView {
  const sig: Record<string, any> = (row?.signals && typeof row.signals === 'object') ? row.signals : {}
  const riskLevel = row ? normalizeRiskLevel(row.risk_level) : null
  const efw = sig.early_fraud_warning && typeof sig.early_fraud_warning === 'object'
    ? { id: String(sig.early_fraud_warning.id), fraudType: sig.early_fraud_warning.fraud_type ?? null, actionable: sig.early_fraud_warning.actionable === true }
    : null
  const reviewState = row?.stripe_review_state === 'open' || row?.stripe_review_state === 'closed' ? row.stripe_review_state : null
  const stripeReview = row?.stripe_review_id && reviewState
    ? { id: row.stripe_review_id, state: reviewState as 'open' | 'closed', reason: row.stripe_review_reason ?? null, closedReason: row.stripe_review_closed_reason ?? null }
    : null
  const holdState: HoldState = row?.hold_state === 'active' || row?.hold_state === 'released' ? row.hold_state : 'none'
  const flagged = !!row && (
    stripeReview?.state === 'open' ||
    row.outcome_type === 'manual_review' ||
    riskLevel === 'elevated' || riskLevel === 'highest' ||
    efw?.actionable === true)
  const mm = sig.country_mismatch && typeof sig.country_mismatch === 'object' ? sig.country_mismatch : {}
  const tds = sig.three_d_secure && typeof sig.three_d_secure === 'object'
    ? { used: sig.three_d_secure.used === true, result: sig.three_d_secure.result ?? null, reason: sig.three_d_secure.result_reason ?? null }
    : null
  const pi = row?.payment_intent_id ?? ctx.paymentIntentId
  return {
    hasRecord: !!row,
    riskLevel,
    riskScore: row && typeof row.risk_score === 'number' ? row.risk_score : null,
    outcomeType: row?.outcome_type ?? null,
    outcomeReason: row?.outcome_reason ?? null,
    sellerMessage: row?.seller_message ?? null,
    checks: {
      cvc: checkValue(sig.cvc_check), addressLine1: checkValue(sig.address_line1_check), postalCode: checkValue(sig.address_postal_code_check),
    },
    cardCountry: country(sig.card_country), billingCountry: country(sig.billing_country),
    shippingCountry: country(sig.shipping_country), ipCountry: country(sig.ip_country),
    cardFunding: token(sig.card_funding), walletType: token(sig.wallet_type),
    threeDSecure: tds,
    countryMismatch: {
      cardVsBilling: typeof mm.card_vs_billing === 'boolean' ? mm.card_vs_billing : null,
      billingVsShipping: typeof mm.billing_vs_shipping === 'boolean' ? mm.billing_vs_shipping : null,
      cardVsShipping: typeof mm.card_vs_shipping === 'boolean' ? mm.card_vs_shipping : null,
    },
    stripeReview,
    earlyFraudWarning: efw,
    flagged,
    hold: {
      state: holdState,
      reason: row?.hold_reason ?? null,
      reasonLabel: row?.hold_reason ? holdReasonLabel(row.hold_reason) : null,
      source: row?.hold_source ?? null,
      since: iso(row?.hold_created_at),
      releasedBy: row?.released_by ?? null,
      releasedAt: iso(row?.released_at),
      releaseNote: row?.release_note ?? null,
    },
    fraudConfirmed: row?.fraud_confirmed_at
      ? { by: row.fraud_confirmed_by, at: iso(row.fraud_confirmed_at)!, note: row.fraud_confirmed_note ?? null }
      : null,
    lastSyncedAt: iso(row?.last_synced_at),
    syncError: row?.sync_error ?? null,
    holdsEnabled: ctx.holdsEnabled,
    flaggedButHoldsOff: flagged && holdState === 'none' && !ctx.holdsEnabled,
    canRelease: holdState === 'active',
    links: {
      payment: stripeDashboardUrl('payment', pi, ctx.mode),
      review: stripeDashboardUrl('review', stripeReview?.id ?? null, ctx.mode),
    },
    events: ctx.events ?? [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyResult {
  outcome: 'applied' | 'duplicate' | 'order_not_found'
  hold?: string
  holdState?: string
  changed?: boolean
}

export type IngestResult =
  | { outcome: 'applied' | 'duplicate'; hold?: string; orderId: string }
  | { outcome: 'parked' | 'ignored'; reason?: string }

export type StripeLike = Pick<Stripe, 'paymentIntents'> & Partial<Pick<Stripe, 'reviews' | 'charges'>>

export interface RefreshResult {
  ok:   boolean
  /** Safe, owner-readable reason when ok=false. */
  message?: string
  code?: string
  hold?: string
}

export interface FraudDeps {
  /** Read at call time. Defaults to the RADAR_FULFILLMENT_HOLDS flag. */
  holdsEnabled?: () => boolean
  now?: () => Date
}

export function createFraudReviewService(sql: Sql, deps: FraudDeps = {}) {
  const holdsEnabled = deps.holdsEnabled ?? (() => isFeatureEnabled('RADAR_FULFILLMENT_HOLDS'))
  const now = deps.now ?? (() => new Date())

  async function findOrderId(ref: { paymentIntentId?: string | null; chargeId?: string | null }): Promise<string | null> {
    if (ref.paymentIntentId) {
      const rows = await sql`SELECT id FROM orders WHERE stripe_payment_intent_id = ${ref.paymentIntentId} LIMIT 1`
      if (rows[0]) return (rows[0] as any).id
    }
    if (ref.chargeId) {
      const rows = await sql`SELECT id FROM orders WHERE stripe_charge_id = ${ref.chargeId} LIMIT 1`
      if (rows[0]) return (rows[0] as any).id
    }
    return null
  }

  async function apply(
    orderId: string, signal: FraudSignal,
    ctx: { source: 'webhook' | 'order_created' | 'refresh'; actor: string; stripeEventId: string | null; eventAt: Date | null },
  ): Promise<ApplyResult> {
    const rows = await sql`
      SELECT fraud_review_apply_signal(
        ${orderId}::uuid, ${signal.eventType}, ${JSON.stringify(signal.patch)}::jsonb,
        ${signal.holdReason}, ${signal.triggerKey}, ${holdsEnabled()}::boolean,
        ${ctx.source}, ${ctx.actor}, ${ctx.stripeEventId}, ${ctx.eventAt ? ctx.eventAt.toISOString() : null}::timestamptz
      ) AS r`
    const r = (rows[0] as any).r
    return { outcome: r.outcome, hold: r.hold, holdState: r.hold_state, changed: r.changed }
  }

  /** Read PaymentIntent (+ latest charge + review) and apply what it says. Never changes Stripe. */
  async function syncFromPaymentIntent(
    orderId: string, stripe: StripeLike, paymentIntentId: string,
    ctx: { source: 'order_created' | 'refresh'; actor: string },
  ): Promise<RefreshResult> {
    // Stripe event times have 1-second resolution, so compare at 1-second resolution: floor our own clock.
    // The state we read is at least this fresh, so a later-delivered older event is correctly ignored.
    const startedAt = new Date(Math.floor(now().getTime() / 1000) * 1000)
    let pi: any
    try {
      pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge', 'review'] })
    } catch {
      await recordFailure(orderId, 'STRIPE_UNAVAILABLE', ctx)
      return { ok: false, code: 'STRIPE_UNAVAILABLE', message: 'Stripe could not be reached. Try again shortly.' }
    }
    const charge = pi?.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null
    let reviewObj: any = pi?.review && typeof pi.review === 'object' ? pi.review : null
    if (!reviewObj && typeof pi?.review === 'string' && stripe.reviews) {
      try { reviewObj = await stripe.reviews.retrieve(pi.review) } catch { /* keep Unknown for the review */ }
    }
    const chargeSignal = charge ? deriveFromCharge(charge) : null
    const reviewSignal = reviewObj ? deriveFromReview(reviewObj, 'synced') : null
    const merged = mergeSignals(chargeSignal, reviewSignal)
    if (!merged) {
      await recordFailure(orderId, charge ? 'CHARGE_NOT_SUCCEEDED' : 'NO_CHARGE_DATA', ctx)
      return { ok: false, code: charge ? 'CHARGE_NOT_SUCCEEDED' : 'NO_CHARGE_DATA',
               message: 'Stripe has no successful charge data for this payment yet.' }
    }
    merged.patch.payment_intent_id = paymentIntentId
    const res = await apply(orderId, merged, { source: ctx.source, actor: ctx.actor, stripeEventId: null, eventAt: startedAt })
    return { ok: true, hold: res.hold }
  }

  async function recordFailure(orderId: string, code: string, ctx: { source: string; actor: string }) {
    try {
      await sql`SELECT fraud_review_record_sync_failure(${orderId}::uuid, ${code}, ${ctx.source}, ${ctx.actor}) AS r`
    } catch { /* recording a failure must never throw into the caller */ }
  }

  return {
    holdsEnabled,

    /** Row + recent events as the Admin view model. */
    async getView(orderId: string): Promise<FraudView | null> {
      const orders = await sql`SELECT id, stripe_payment_intent_id FROM orders WHERE id = ${orderId}::uuid`
      if (!orders[0]) return null
      const rows = await sql`SELECT * FROM order_fraud_reviews WHERE order_id = ${orderId}::uuid`
      const evs = await sql`
        SELECT id, event_type, actor, source, created_at, detail FROM order_fraud_events
        WHERE order_id = ${orderId}::uuid ORDER BY created_at DESC, id DESC LIMIT 25`
      const events: FraudEventView[] = (evs as any[]).map(e => ({
        id: e.id, type: e.event_type, actor: e.actor, source: e.source,
        createdAt: new Date(e.created_at).toISOString(), detail: (e.detail && typeof e.detail === 'object') ? e.detail : {},
      }))
      return buildFraudView((rows[0] as any) ?? null, {
        holdsEnabled: holdsEnabled(), mode: safeStripeMode(),
        paymentIntentId: (orders[0] as any).stripe_payment_intent_id ?? null, events,
      })
    },

    /**
     * Ingest one verified Stripe event. Idempotent: a redelivered event is a no-op. Never creates or
     * changes an order, a payment status, an inventory movement or a financial record.
     */
    async ingestStripeEvent(event: { id: string; type: string; created?: number; data: { object: unknown } },
                            opts: { getStripe?: () => StripeLike } = {}): Promise<IngestResult> {
      const eventAt = typeof event.created === 'number' ? new Date(event.created * 1000) : null
      let signal: FraudSignal | null = null
      if (event.type === 'review.opened' || event.type === 'review.closed') {
        signal = deriveFromReview(event.data.object, event.type === 'review.opened' ? 'review_opened' : 'review_closed')
      } else if (event.type === 'charge.succeeded') {
        signal = deriveFromCharge(event.data.object)
      } else if (event.type === 'radar.early_fraud_warning.created') {
        signal = deriveFromEarlyFraudWarning(event.data.object)
        // An EFW names a charge; its payment intent is optional on the event. Resolve it from Stripe (GET)
        // so the order can be matched; if that is impossible the signal is parked by charge id.
        if (signal && !signal.paymentIntentId && signal.chargeId && opts.getStripe) {
          try {
            const ch: any = await opts.getStripe().charges?.retrieve(signal.chargeId)
            const pi = stripeId(ch?.payment_intent)
            if (pi) {
              signal.paymentIntentId = pi
              ;(signal.patch as any).payment_intent_id = pi
            }
          } catch { /* parked by charge id below */ }
        }
      } else {
        return { outcome: 'ignored', reason: 'unsupported_event' }
      }
      if (!signal) return { outcome: 'ignored', reason: 'unusable_object' }

      const orderId = await findOrderId({ paymentIntentId: signal.paymentIntentId, chargeId: signal.chargeId })
      if (!orderId) {
        // charge.succeeded is high volume and the order-creation lookup covers it; park only the rare ones.
        if (event.type === 'charge.succeeded') return { outcome: 'ignored', reason: 'no_order' }
        await sql`
          SELECT fraud_review_record_unmatched(
            ${signal.paymentIntentId}, ${signal.chargeId}, ${signal.eventType}, ${event.id}, ${signal.reviewId},
            ${JSON.stringify({
              patch: signal.patch, hold_reason: signal.holdReason, trigger_key: signal.triggerKey,
              event_at: eventAt ? eventAt.toISOString() : null,
            })}::jsonb) AS r`
        return { outcome: 'parked' }
      }
      const res = await apply(orderId, signal, { source: 'webhook', actor: 'stripe:webhook', stripeEventId: event.id, eventAt })
      if (res.outcome === 'order_not_found') return { outcome: 'ignored', reason: 'no_order' }
      return { outcome: res.outcome as 'applied' | 'duplicate', hold: res.hold, orderId }
    },

    /**
     * Called once an order exists (webhook, flag ON): replay any review signal that arrived early, then read
     * Stripe once for the charge outcome. NEVER throws: a failure leaves the risk state Unknown + retryable.
     */
    async ingestForNewOrder(args: { orderId: string; paymentIntentId: string | null; getStripe: () => StripeLike }): Promise<void> {
      try {
        await sql`SELECT fraud_review_apply_pending(${args.orderId}::uuid, ${holdsEnabled()}::boolean) AS r`
      } catch (err: any) {
        console.error('[FRAUD] pending replay failed (non-fatal):', String(err?.message ?? '').slice(0, 80))
      }
      try {
        const existing = await sql`SELECT signals FROM order_fraud_reviews WHERE order_id = ${args.orderId}::uuid`
        if ((existing[0] as any)?.signals?.charge_evaluated === true) return          // already read: replay is a no-op
        if (!args.paymentIntentId) { await recordFailure(args.orderId, 'NO_PAYMENT_INTENT', { source: 'order_created', actor: 'system' }); return }
        let stripe: StripeLike
        try { stripe = args.getStripe() } catch {
          await recordFailure(args.orderId, 'STRIPE_NOT_CONFIGURED', { source: 'order_created', actor: 'system' }); return
        }
        await syncFromPaymentIntent(args.orderId, stripe, args.paymentIntentId, { source: 'order_created', actor: 'system' })
      } catch (err: any) {
        console.error('[FRAUD] order-creation sync failed (non-fatal):', String(err?.message ?? '').slice(0, 80))
        await recordFailure(args.orderId, 'INTERNAL_ERROR', { source: 'order_created', actor: 'system' })
      }
    },

    /** Admin "Refresh from Stripe": GET-only; safe when Stripe is unavailable. */
    async refreshFromStripe(orderId: string, actor: string, getStripe: () => StripeLike): Promise<RefreshResult> {
      const rows = await sql`SELECT stripe_payment_intent_id AS pi FROM orders WHERE id = ${orderId}::uuid`
      if (!rows[0]) return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Order not found.' }
      const pi = (rows[0] as any).pi as string | null
      if (!pi) return { ok: false, code: 'NO_PAYMENT_INTENT', message: 'This order has no Stripe payment to look up.' }
      let stripe: StripeLike
      try { stripe = getStripe() } catch {
        return { ok: false, code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured on this server.' }
      }
      return syncFromPaymentIntent(orderId, stripe, pi, { source: 'refresh', actor })
    },

    /** Explicit, audited release. Allowed regardless of the feature flag. Does NOT change Stripe. */
    async releaseHold(orderId: string, actor: string, note: string | null): Promise<'released' | 'not_held' | 'already_released'> {
      try {
        const rows = await sql`SELECT fraud_hold_release(${orderId}::uuid, ${actor}, ${note}) AS r`
        return (rows[0] as any).r.outcome
      } catch (e) { return mapFraudDbError(e) }
    },

    /** Record confirmed fraud (audited). The refund/cancel itself stays in the EXISTING flow. */
    async markConfirmedFraud(orderId: string, actor: string, note: string | null): Promise<{ outcome: 'confirmed' | 'already_confirmed'; hold?: string }> {
      try {
        const rows = await sql`SELECT fraud_mark_confirmed(${orderId}::uuid, ${actor}, ${note}, ${holdsEnabled()}::boolean) AS r`
        const r = (rows[0] as any).r
        return { outcome: r.outcome, hold: r.hold }
      } catch (e) { return mapFraudDbError(e) }
    },

    /** Compact per-order fraud summary for the Orders list (one query). */
    async summariesForOrders(orderIds: string[]): Promise<Map<string, { hold: HoldState; flagged: boolean; syncError: boolean }>> {
      const out = new Map<string, { hold: HoldState; flagged: boolean; syncError: boolean }>()
      if (orderIds.length === 0) return out
      let rows: any[]
      try {
        rows = await sql`
          SELECT order_id, hold_state, risk_level, outcome_type, stripe_review_id, stripe_review_state, signals, sync_error
          FROM order_fraud_reviews WHERE order_id = ANY(${orderIds}::uuid[])` as any[]
      } catch (err: any) {
        if (err?.code === '42P01') return out         // migration 031 not applied yet
        throw err
      }
      for (const r of rows) {
        const v = buildFraudView(r, { holdsEnabled: holdsEnabled(), mode: null, paymentIntentId: null })
        out.set(r.order_id, { hold: v.hold.state, flagged: v.flagged, syncError: !!r.sync_error })
      }
      return out
    },
  }
}

export type FraudReviewService = ReturnType<typeof createFraudReviewService>
