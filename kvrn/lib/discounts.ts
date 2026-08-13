// lib/discounts.ts — KVRN Discount Engine (V58.3)
// Server-only. Never import in client components.
//
// Discount priority (deterministic, no stacking):
//   1. AUTOMATIC US $150+ free shipping — eligibility-based (not shippingCents==0)
//      Blocked whenever qualifiesForFreeShipping(country, subtotalCents) is true,
//      regardless of which shipping method the customer selects.
//   2. Manual shipping discount codes — reduce shippingCents directly
//   3. One merchandise/order discount (KVRN10, unique SMS code, other)
//
// Single-use code race: prevented via discount_claims table (SQL claim_discount fn).
// Redemption: finalized ONLY inside finalize_paid_order SQL (on confirmed payment).

import { sql } from './db'
import { getStripe } from './stripe-client'
import { qualifiesForFreeShipping } from './free-shipping'

// ── Types ──────────────────────────────────────────────────────────────────────

export type DiscountType = 'fixed_amount' | 'percentage' | 'shipping'

export interface Discount {
  id:                  string
  code:                string
  name:                string
  description:         string | null
  type:                DiscountType
  amountCents:         number | null
  percentageBps:       number | null
  active:              boolean
  singleUse:           boolean
  maxRedemptions:      number | null
  redemptionCount:     number
  minimumSubtotalCents: number | null
  allowedCountryCodes: string[] | null
  excludedCountryCodes: string[] | null
  subscriberId:        string | null
  systemManaged:       boolean
  stripeCouponId:      string | null
  startsAt:            string | null
  expiresAt:           string | null
  priority:            number
  createdBy:           string | null
  createdAt:           string
}

export type DiscountValidationResult =
  | { valid: true;  discount: Discount }
  | { valid: false; error: string; reason?: string }

export interface AppliedDiscount {
  code:               string
  type:               DiscountType
  amountCents:        number    // merchandse discount amount
  shippingAdjustmentCents: number  // how much shipping is reduced (0 for merchandise codes)
  discountId:         string
  stripeCouponId:     string | null
}

// ── Code normalisation ─────────────────────────────────────────────────────────

export function normalizeDiscountCode(raw: string): string {
  return raw.trim().toUpperCase()
}

// ── SMS code generation ───────────────────────────────────────────────────────

const SMS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  // no 0/O/1/I
const SMS_CODE_LENGTH   = 6

export function generateSmsDiscountCode(): string {
  const bytes = new Uint8Array(SMS_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes).map(b => SMS_CODE_ALPHABET[b % SMS_CODE_ALPHABET.length])
  return `KVRN-${chars.join('')}`
}

// ── DB row → Discount ─────────────────────────────────────────────────────────

function rowToDiscount(r: any): Discount {
  return {
    id:                  r.id,
    code:                r.code,
    name:                r.name,
    description:         r.description         ?? null,
    type:                r.type,
    amountCents:         r.amount_cents         !== null ? Number(r.amount_cents)    : null,
    percentageBps:       r.percentage_bps       !== null ? Number(r.percentage_bps)  : null,
    active:              Boolean(r.active),
    singleUse:           Boolean(r.single_use),
    maxRedemptions:      r.max_redemptions      !== null ? Number(r.max_redemptions)  : null,
    redemptionCount:     Number(r.redemption_count ?? 0),
    minimumSubtotalCents: r.minimum_subtotal_cents !== null ? Number(r.minimum_subtotal_cents) : null,
    allowedCountryCodes:  r.allowed_country_codes  ?? null,
    excludedCountryCodes: r.excluded_country_codes ?? null,
    subscriberId:        r.subscriber_id   ?? null,
    systemManaged:       Boolean(r.system_managed),
    stripeCouponId:      r.stripe_coupon_id ?? null,
    startsAt:            r.starts_at        ?? null,
    expiresAt:           r.expires_at       ?? null,
    priority:            Number(r.priority ?? 10),
    createdBy:           r.created_by       ?? null,
    createdAt:           r.created_at,
  }
}

export async function getDiscountByCode(rawCode: string): Promise<Discount | null> {
  const code = normalizeDiscountCode(rawCode)
  const rows = await sql`SELECT * FROM discounts WHERE code = ${code} LIMIT 1`
  const r = (rows as any[])[0]
  return r ? rowToDiscount(r) : null
}

// ── Discount validation ───────────────────────────────────────────────────────

export async function validateDiscount(
  rawCode:      string,
  opts: {
    subtotalCents: number
    country:       string
  }
): Promise<DiscountValidationResult> {
  const code = normalizeDiscountCode(rawCode)
  const now  = new Date()

  const rows = await sql`SELECT * FROM discounts WHERE code = ${code} LIMIT 1`
  const r    = (rows as any[])[0]

  if (!r) return { valid: false, error: "That code isn't valid.", reason: 'invalid' }
  const d = rowToDiscount(r)

  if (!d.active)    return { valid: false, error: "That code isn't valid.", reason: 'invalid' }
  if (d.startsAt  && new Date(d.startsAt)  > now) return { valid: false, error: "That code isn't valid yet.", reason: 'invalid' }
  if (d.expiresAt && new Date(d.expiresAt) < now) return { valid: false, error: 'That code has expired.', reason: 'expired' }

  // Check redemption capacity (before claims — preview only)
  const effectiveMax = d.maxRedemptions ?? (d.singleUse ? 1 : null)
  if (effectiveMax !== null && d.redemptionCount >= effectiveMax) {
    return { valid: false, error: 'That code has already been used.', reason: 'already_redeemed' }
  }

  if (d.minimumSubtotalCents !== null && opts.subtotalCents < d.minimumSubtotalCents) {
    const min = (d.minimumSubtotalCents / 100).toFixed(2)
    return { valid: false, error: `This code requires a minimum subtotal of $${min}.`, reason: 'minimum_subtotal' }
  }

  const country = opts.country.toUpperCase()
  if (d.allowedCountryCodes?.length && !d.allowedCountryCodes.includes(country)) {
    return { valid: false, error: "That code isn't valid for your shipping destination.", reason: 'shipping_restricted' }
  }
  if (d.excludedCountryCodes?.length && d.excludedCountryCodes.includes(country)) {
    return { valid: false, error: "That code isn't valid for your shipping destination.", reason: 'shipping_restricted' }
  }

  return { valid: true, discount: d }
}

// ── Discount priority enforcement ─────────────────────────────────────────────
//
// KVRN RULE: US $150+ free shipping blocks ALL merchandise/order discounts,
// even if the customer selects Express. Eligibility is based on country + subtotal,
// NOT on whether shippingCents === 0. This prevents bypass via Express selection.

export function applyDiscountPriority(opts: {
  discount:       Discount | null
  subtotalCents:  number
  country:        string
  shippingCents:  number   // authoritative shipping cost (before any shipping discount)
}): { applied: AppliedDiscount | null; blockedReason: string | null } {
  const { discount, subtotalCents, country, shippingCents } = opts

  if (!discount) return { applied: null, blockedReason: null }

  // US $150+ eligibility blocks all order/merchandise discounts
  // (even if customer picks Express — the automatic benefit still takes priority)
  const freeShippingEligible = qualifiesForFreeShipping(country, subtotalCents)

  // Shipping discount codes — highest manual priority
  if (discount.type === 'shipping') {
    if (freeShippingEligible) {
      return {
        applied: null,
        blockedReason: 'This order already qualifies for free shipping. Discounts cannot be combined.',
      }
    }
    // Calculate actual shipping reduction
    const shippingReduction = computeShippingReduction(discount, shippingCents)
    return {
      applied: {
        code:               discount.code,
        type:               'shipping',
        amountCents:        0,                  // no merchandise discount
        shippingAdjustmentCents: shippingReduction,
        discountId:         discount.id,
        stripeCouponId:     null,               // shipping discount modifies shippingCents directly
      },
      blockedReason: null,
    }
  }

  // Merchandise/order discounts — blocked by US free-shipping eligibility
  if (freeShippingEligible) {
    return {
      applied: null,
      blockedReason: 'This order already qualifies for free shipping. Discounts cannot be combined.',
    }
  }

  // Compute merchandise discount amount
  let amountCents: number
  if (discount.type === 'fixed_amount') {
    amountCents = Math.min(discount.amountCents ?? 0, subtotalCents)
  } else {
    amountCents = Math.round(subtotalCents * (discount.percentageBps ?? 0) / 10000)
  }
  amountCents = Math.max(0, amountCents)

  return {
    applied: {
      code:               discount.code,
      type:               discount.type,
      amountCents,
      shippingAdjustmentCents: 0,
      discountId:         discount.id,
      stripeCouponId:     discount.stripeCouponId,
    },
    blockedReason: null,
  }
}

function computeShippingReduction(discount: Discount, shippingCents: number): number {
  // amount_cents = null for shipping type means FREE shipping
  if (discount.amountCents === null || discount.amountCents === 0) {
    return shippingCents  // free shipping
  }
  if (discount.type === 'shipping') {
    if (discount.percentageBps !== null) {
      return Math.round(shippingCents * discount.percentageBps / 10000)
    }
    return Math.min(discount.amountCents, shippingCents)
  }
  return 0
}



// ── Stripe coupon definition — shared coupon keyed by discount terms ──────────
// All KVRN codes with identical terms share one Stripe coupon.
// Concurrency: DB-leader pattern — the INSERT winner creates the Stripe coupon,
// then updates the row. Followers wait briefly and re-read.
// NULL-safe uniqueness via COALESCE index (see migration 009).

export async function getOrCreateStripeCouponForTerms(opts: {
  type:           DiscountType
  amountCents?:   number | null
  percentageBps?: number | null
}): Promise<string | null> {
  const { type, amountCents, percentageBps } = opts
  if (type === 'shipping') return null

  const kind = type  // 'fixed_amount' or 'percentage'

  // Deterministic Stripe idempotency key — safe to retry without creating duplicate coupons.
  // Derived from normalized coupon terms only (no customer-specific codes).
  const stripeIdempotencyKey = `kvrn-coupon-${kind}-usd-${amountCents ?? 'null'}-${percentageBps ?? 'null'}`

  // Stable DB lookup (includes created_at for stale-detection in follower path)
  const lookupSql = sql`
    SELECT id, stripe_coupon_id, created_at FROM stripe_coupon_definitions
    WHERE kind = ${kind}
      AND currency = 'usd'
      AND COALESCE(amount_cents, -1)   = COALESCE(${amountCents ?? null}::integer, -1)
      AND COALESCE(percentage_bps, -1) = COALESCE(${percentageBps ?? null}::integer, -1)
    LIMIT 1
  `

  // Helper: create Stripe coupon and persist mapping as leader
  const createAsLeader = async (rowId: string): Promise<string | null> => {
    const definitionKey = kind === 'fixed_amount'
      ? `fixed_usd_${amountCents}`
      : `pct_${percentageBps}`

    let stripe: any
    try { stripe = getStripe() } catch (initErr: any) {
      // getStripe() threw (misconfigured key etc.); clean up this leader's pending row
      // so subsequent attempts can retry immediately rather than waiting 60 s for stale recovery
      try {
        await sql`
          DELETE FROM stripe_coupon_definitions
          WHERE id = ${rowId} AND stripe_coupon_id = 'pending'
        `
      } catch {}
      console.error('[discounts] Stripe client init failed; pending coupon row removed:', initErr?.message?.slice(0, 60))
      return null
    }

    let couponId: string | null = null
    try {
      // Deterministic idempotency key protects against crash-then-retry creating duplicate Stripe coupons
      const stripeOpts = { idempotencyKey: stripeIdempotencyKey }
      const coupon = kind === 'fixed_amount'
        ? await stripe.coupons.create({
            amount_off:  amountCents!,
            currency:    'usd',
            duration:    'once',
            name:        `KVRN-${definitionKey}`,
            metadata:    { kvrn_discount_definition: definitionKey },
          }, stripeOpts)
        : await stripe.coupons.create({
            percent_off: (percentageBps! / 100),
            duration:    'once',
            name:        `KVRN-${definitionKey}`,
            metadata:    { kvrn_discount_definition: definitionKey },
          }, stripeOpts)
      couponId = coupon.id
    } catch (err: any) {
      console.error('[discounts] Stripe coupon creation failed:', err?.message?.slice(0, 80))
      // Remove pending row so next attempt can try again
      try { await sql`DELETE FROM stripe_coupon_definitions WHERE id = ${rowId}` } catch {}
      return null
    }

    try {
      await sql`UPDATE stripe_coupon_definitions SET stripe_coupon_id = ${couponId!} WHERE id = ${rowId}`
    } catch (err: any) {
      console.error('[discounts] Failed to persist Stripe coupon mapping:', err?.message?.slice(0, 60))
      // Coupon was created in Stripe; still usable even if DB update failed
    }
    return couponId
  }

  // ── 1. Fast-path read ──────────────────────────────────────────────────────
  const existing = (await lookupSql) as any[]
  if (existing[0]?.stripe_coupon_id && existing[0].stripe_coupon_id !== 'pending') {
    return existing[0].stripe_coupon_id
  }

  // ── 2. DB-leader: try to insert with 'pending' sentinel ───────────────────
  const inserted = await sql`
    INSERT INTO stripe_coupon_definitions (kind, currency, amount_cents, percentage_bps, stripe_coupon_id)
    VALUES (${kind}, 'usd', ${amountCents ?? null}, ${percentageBps ?? null}, 'pending')
    ON CONFLICT (kind, currency, COALESCE(amount_cents,-1), COALESCE(percentage_bps,-1))
    DO NOTHING
    RETURNING id
  ` as any[]

  if (inserted.length > 0) {
    // ── WE ARE THE LEADER ─────────────────────────────────────────────────
    return createAsLeader(inserted[0].id)
  }

  // ── 3. Follower: wait for leader, with stale-pending recovery ─────────────
  const STALE_PENDING_MS = 60_000  // 60 seconds; leader is assumed dead after this

  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 150 * (attempt + 1)))
    const row = ((await lookupSql) as any[])[0]

    if (!row) break  // Row vanished entirely; restart from scratch on next call

    if (row.stripe_coupon_id !== 'pending') {
      return row.stripe_coupon_id  // Leader succeeded
    }

    // Still pending — check if leader is stale (died before completing)
    const rowAgeMs = Date.now() - new Date(row.created_at).getTime()
    if (rowAgeMs > STALE_PENDING_MS) {
      // ── STALE RECOVERY: delete the dead leader's pending row ────────────
      // Multiple concurrent workers may attempt this; only one can delete the specific row.
      const deleted = await sql`
        DELETE FROM stripe_coupon_definitions
        WHERE id = ${row.id}
          AND stripe_coupon_id = 'pending'
          AND created_at < NOW() - INTERVAL '60 seconds'
        RETURNING id
      ` as any[]

      if (deleted.length > 0) {
        // We removed the stale row; try to become the new leader
        const reinserted = await sql`
          INSERT INTO stripe_coupon_definitions (kind, currency, amount_cents, percentage_bps, stripe_coupon_id)
          VALUES (${kind}, 'usd', ${amountCents ?? null}, ${percentageBps ?? null}, 'pending')
          ON CONFLICT (kind, currency, COALESCE(amount_cents,-1), COALESCE(percentage_bps,-1))
          DO NOTHING
          RETURNING id
        ` as any[]

        if (reinserted.length > 0) {
          // ── WE TOOK OVER FROM THE STALE LEADER ─────────────────────────
          return createAsLeader(reinserted[0].id)
        }
        // Another concurrent worker beat us to leadership; continue polling
      }
      // else: concurrent stale-recovery already removed and re-inserted; continue polling
    }
  }

  // Coupon resolution timed out; checkout will abort for merchandise discounts (fail-closed)
  console.error('[discounts] Stripe coupon resolution timed out for terms:', {
    kind, amountCents, percentageBps,
  })
  return null
}

// ── Discount claim (race prevention) ──────────────────────────────────────────

export async function claimDiscount(opts: {
  discountId:    string
  reservationId: string
  expiresAt:     Date
}): Promise<'claimed' | 'idempotent' | 'unlimited' | 'conflict' | 'exhausted'> {
  const rows = await sql`
    SELECT claim_discount(
      ${opts.discountId}::uuid,
      ${opts.reservationId}::uuid,
      ${opts.expiresAt.toISOString()}::timestamptz
    ) AS result
  `
  return ((rows as any[])[0]?.result ?? 'exhausted') as any
}

export async function releaseDiscountClaim(reservationId: string): Promise<void> {
  await sql`SELECT release_discount_claim(${reservationId}::uuid)`
}

// ── SMS discount code lifecycle ────────────────────────────────────────────────

export async function upsertSmsDiscountCode(opts: {
  subscriberId: string
  phoneE164:    string
}): Promise<string | null> {
  const amountCents = Number(process.env.SMS_SIGNUP_DISCOUNT_AMOUNT_CENTS ?? 1000)

  // Check for existing code
  const existing = await sql`
    SELECT d.id, d.code, d.redemption_count
    FROM discounts d
    WHERE d.subscriber_id = ${opts.subscriberId}
      AND d.type = 'fixed_amount'
      AND d.single_use = TRUE
      AND d.system_managed = TRUE
    ORDER BY d.created_at
    LIMIT 1
  `
  const ex = (existing as any[])[0]
  if (ex) {
    if (Number(ex.redemption_count) >= 1) return null  // lifetime reward already redeemed
    return ex.code as string  // return existing unused code
  }

  // Generate new code with collision retry
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateSmsDiscountCode()
    try {
      await sql`
        INSERT INTO discounts (
          code, name, description, type, amount_cents,
          active, single_use, max_redemptions,
          subscriber_id, system_managed, priority, created_by
        ) VALUES (
          ${code}, ${'SMS Signup Reward'},
          ${'$10 off for SMS signup. Single use. System generated.'},
          'fixed_amount', ${amountCents},
          TRUE, TRUE, 1,
          ${opts.subscriberId}, TRUE, 10, 'sms_signup'
        )
      `
      return code
    } catch (err: any) {
      if (err?.message?.includes('unique') || err?.message?.includes('duplicate')) continue
      throw err
    }
  }
  throw new Error('Could not generate unique SMS discount code after 5 attempts.')
}

// ── Offer status ──────────────────────────────────────────────────────────────
// offerActive=true only when SMS_SIGNUP_DISCOUNT_AMOUNT_CENTS is exactly 1000 ($10 USD)

export async function isSmsOfferActive(): Promise<{ active: boolean; amountCents: number }> {
  const amountStr = process.env.SMS_SIGNUP_DISCOUNT_AMOUNT_CENTS
  if (!amountStr) return { active: false, amountCents: 0 }
  const amountCents = Number(amountStr)
  // Only advertise "$10 OFF" when configured amount is exactly $10
  if (amountCents !== 1000) return { active: false, amountCents }
  try {
    await sql`SELECT 1 FROM discounts LIMIT 1`
    return { active: true, amountCents }
  } catch {
    return { active: false, amountCents: 0 }
  }
}


export function validateDiscountPatchInput(data: Partial<CreateDiscountInput>): { ok: true } | { ok: false; error: string } {
  // Allowlist: only mutable admin fields; never allow id, code, redemption_count, subscriber_id, system_managed
  const fullData: CreateDiscountInput = {
    code:                 data.code ?? 'PLACEHOLDER',  // not mutated by PATCH
    name:                 data.name ?? 'placeholder',
    type:                 data.type ?? 'fixed_amount',
    amountCents:          data.amountCents,
    percentageBps:        data.percentageBps,
    description:          data.description,
    active:               data.active,
    singleUse:            data.singleUse,
    maxRedemptions:       data.maxRedemptions,
    minimumSubtotalCents: data.minimumSubtotalCents,
    allowedCountryCodes:  data.allowedCountryCodes,
    excludedCountryCodes: data.excludedCountryCodes,
    startsAt:             data.startsAt,
    expiresAt:            data.expiresAt,
  }
  // Validate only non-placeholder fields
  if (data.name !== undefined) {
    if (!data.name || data.name.length > 120) return { ok: false, error: 'Name must be 1-120 chars.' }
  }
  if (data.type !== undefined) {
    if (!['fixed_amount','percentage','shipping'].includes(data.type!)) {
      return { ok: false, error: 'Type must be fixed_amount, percentage, or shipping.' }
    }
  }
  if (data.amountCents !== undefined && data.amountCents !== null) {
    if (!Number.isInteger(data.amountCents) || data.amountCents <= 0 || data.amountCents > 100_000) {
      return { ok: false, error: 'Amount must be 1–100,000 cents.' }
    }
  }
  if (data.percentageBps !== undefined && data.percentageBps !== null) {
    if (!Number.isInteger(data.percentageBps) || data.percentageBps <= 0 || data.percentageBps > 10000) {
      return { ok: false, error: 'Percentage must be 1–10000 basis points.' }
    }
  }
  if (data.maxRedemptions !== undefined && data.maxRedemptions !== null) {
    if (!Number.isInteger(data.maxRedemptions) || data.maxRedemptions <= 0) {
      return { ok: false, error: 'Max redemptions must be a positive integer.' }
    }
  }
  if (data.minimumSubtotalCents !== undefined && data.minimumSubtotalCents !== null) {
    if (!Number.isInteger(data.minimumSubtotalCents) || data.minimumSubtotalCents < 0) {
      return { ok: false, error: 'Minimum subtotal must be >= 0 cents.' }
    }
  }
  if (data.allowedCountryCodes?.length) {
    const bad = data.allowedCountryCodes.filter((cc: string) => !ALLOWED_COUNTRIES.has(cc.toUpperCase()))
    if (bad.length) return { ok: false, error: `Invalid country codes: ${bad.join(', ')}` }
  }
  if (data.excludedCountryCodes?.length) {
    const bad = data.excludedCountryCodes.filter((cc: string) => !ALLOWED_COUNTRIES.has(cc.toUpperCase()))
    if (bad.length) return { ok: false, error: `Invalid country codes: ${bad.join(', ')}` }
  }
  if (data.startsAt && data.expiresAt && new Date(data.startsAt) >= new Date(data.expiresAt)) {
    return { ok: false, error: 'expires_at must be after starts_at.' }
  }
  return { ok: true }
}

// ── Admin CRUD ─────────────────────────────────────────────────────────────────

export async function listDiscounts(): Promise<Discount[]> {
  const rows = await sql`SELECT * FROM discounts ORDER BY system_managed, created_at DESC`
  return (rows as any[]).map(rowToDiscount)
}

const ALLOWED_COUNTRIES = new Set([
  'US','CA','GB','AU','DE','FR','JP','IT','ES','NL','SE','NO','DK','CH','AT',
  'BE','PT','NZ','IE','SG','AE','SA','QA','KW','HK','MX','BR','AR','ZA','IN',
])

function isValidCountry(c: string): boolean {
  return ALLOWED_COUNTRIES.has(c.toUpperCase())
}

export interface CreateDiscountInput {
  code:                 string
  name:                 string
  description?:         string | null
  type:                 DiscountType
  amountCents?:         number | null
  percentageBps?:       number | null
  active?:              boolean
  singleUse?:           boolean
  maxRedemptions?:      number | null
  minimumSubtotalCents?: number | null
  allowedCountryCodes?: string[] | null
  excludedCountryCodes?: string[] | null
  startsAt?:            string | null
  expiresAt?:           string | null
}

export function validateDiscountInput(data: CreateDiscountInput): { ok: true } | { ok: false; error: string } {
  const code = normalizeDiscountCode(data.code ?? '')
  if (!code || code.length > 32 || !/^[A-Z0-9\-]+$/.test(code)) {
    return { ok: false, error: 'Code must be 1-32 uppercase alphanumeric characters.' }
  }
  if (!data.name || data.name.length > 120) return { ok: false, error: 'Name is required (max 120 chars).' }
  if (!['fixed_amount','percentage','shipping'].includes(data.type)) {
    return { ok: false, error: 'Type must be fixed_amount, percentage, or shipping.' }
  }
  if (data.type === 'fixed_amount') {
    if (!data.amountCents || data.amountCents <= 0 || data.amountCents > 100_000) {
      return { ok: false, error: 'Fixed amount must be 1–100,000 cents.' }
    }
  }
  if (data.type === 'percentage') {
    if (!data.percentageBps || data.percentageBps <= 0 || data.percentageBps > 10000) {
      return { ok: false, error: 'Percentage must be 1–10000 basis points (1–100%).' }
    }
  }
  if (data.maxRedemptions !== undefined && data.maxRedemptions !== null) {
    if (!Number.isInteger(data.maxRedemptions) || data.maxRedemptions <= 0 || !isFinite(data.maxRedemptions)) {
      return { ok: false, error: 'Max redemptions must be a positive integer.' }
    }
  }
  if (data.minimumSubtotalCents !== undefined && data.minimumSubtotalCents !== null) {
    if (!Number.isInteger(data.minimumSubtotalCents) || data.minimumSubtotalCents < 0 || !isFinite(data.minimumSubtotalCents)) {
      return { ok: false, error: 'Minimum subtotal must be a non-negative integer (cents).' }
    }
  }
  if (data.allowedCountryCodes?.length) {
    const bad = data.allowedCountryCodes.filter(c => !isValidCountry(c))
    if (bad.length) return { ok: false, error: `Invalid country codes: ${bad.join(', ')}` }
  }
  if (data.excludedCountryCodes?.length) {
    const bad = data.excludedCountryCodes.filter(c => !isValidCountry(c))
    if (bad.length) return { ok: false, error: `Invalid country codes: ${bad.join(', ')}` }
  }
  if (data.startsAt && data.expiresAt && new Date(data.startsAt) >= new Date(data.expiresAt)) {
    return { ok: false, error: 'expires_at must be after starts_at.' }
  }
  return { ok: true }
}

export async function createDiscount(data: CreateDiscountInput & { createdBy?: string }): Promise<Discount> {
  const code = normalizeDiscountCode(data.code)
  const rows = await sql`
    INSERT INTO discounts (
      code, name, description, type, amount_cents, percentage_bps,
      active, single_use, max_redemptions, minimum_subtotal_cents,
      allowed_country_codes, excluded_country_codes,
      starts_at, expires_at, priority, created_by, system_managed
    ) VALUES (
      ${code}, ${data.name}, ${data.description ?? null}, ${data.type},
      ${data.amountCents ?? null}, ${data.percentageBps ?? null},
      ${data.active ?? true}, ${data.singleUse ?? false},
      ${data.maxRedemptions ?? null}, ${data.minimumSubtotalCents ?? null},
      ${data.allowedCountryCodes ?? null}, ${data.excludedCountryCodes ?? null},
      ${data.startsAt ?? null}, ${data.expiresAt ?? null},
      10, ${data.createdBy ?? 'admin'}, FALSE
    )
    RETURNING *
  `
  return rowToDiscount((rows as any[])[0])
}

export async function updateDiscount(id: string, data: Partial<{
  name: string; description: string | null; active: boolean
  maxRedemptions: number | null; minimumSubtotalCents: number | null
  allowedCountryCodes: string[] | null; excludedCountryCodes: string[] | null
  startsAt: string | null; expiresAt: string | null
  amountCents: number | null; percentageBps: number | null
}>): Promise<Discount | null> {
  // Verify not system-managed before allowing edit
  const check = await sql`SELECT system_managed FROM discounts WHERE id = ${id}`
  if ((check as any[])[0]?.system_managed) {
    throw new Error('System-managed discounts cannot be edited through Admin API.')
  }
  const rows = await sql`
    UPDATE discounts
    SET
      name                  = COALESCE(${data.name ?? null}, name),
      description           = CASE WHEN ${data.description !== undefined} THEN ${data.description ?? null} ELSE description END,
      active                = COALESCE(${data.active ?? null}, active),
      max_redemptions       = CASE WHEN ${'maxRedemptions' in data} THEN ${data.maxRedemptions ?? null} ELSE max_redemptions END,
      minimum_subtotal_cents = CASE WHEN ${'minimumSubtotalCents' in data} THEN ${data.minimumSubtotalCents ?? null} ELSE minimum_subtotal_cents END,
      amount_cents          = COALESCE(${data.amountCents ?? null}, amount_cents),
      percentage_bps        = COALESCE(${data.percentageBps ?? null}, percentage_bps),
      starts_at             = CASE WHEN ${'startsAt' in data} THEN ${data.startsAt ?? null} ELSE starts_at END,
      expires_at            = CASE WHEN ${'expiresAt' in data} THEN ${data.expiresAt ?? null} ELSE expires_at END,
      updated_at            = NOW()
    WHERE id = ${id}
    RETURNING *
  `
  const r = (rows as any[])[0]
  return r ? rowToDiscount(r) : null
}

export async function safeDeleteDiscount(id: string): Promise<{ deleted: boolean; reason?: string }> {
  const check = await sql`SELECT system_managed, redemption_count FROM discounts WHERE id = ${id}`
  const row = (check as any[])[0]
  if (row?.system_managed) return { deleted: false, reason: 'System-managed SMS reward codes cannot be deleted.' }
  const redemptions = await sql`SELECT 1 FROM discount_redemptions WHERE discount_id = ${id} LIMIT 1`
  if ((redemptions as any[]).length > 0) {
    return { deleted: false, reason: 'Discount has redemption history. Deactivate instead.' }
  }
  const activeClaims = await sql`
    SELECT 1 FROM discount_claims WHERE discount_id = ${id}
      AND finalized_at IS NULL AND released_at IS NULL LIMIT 1
  `
  if ((activeClaims as any[]).length > 0) {
    return { deleted: false, reason: 'Discount has active claims. Deactivate instead.' }
  }
  await sql`DELETE FROM discounts WHERE id = ${id}`
  return { deleted: true }
}
