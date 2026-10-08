// lib/i18n/currency-policy.ts — which currencies a customer may SEE and which they may PAY in.
//
// DISPLAYABLE ≠ PAYABLE, and neither is "Intl can format it".
//
//   displayable  USD, plus any enabled currency that has a fresh, Admin-configured rate
//                (lib/i18n/fx.ts). Shown as an estimate: "≈ €220".
//   payable      the card is charged in this currency. Today ONLY USD. A currency is payable
//                only when it is listed in PAYABLE_AUDIT_PASSED below, which is a code-level
//                statement that EVERY downstream path was proven (see CURRENCY_BLOCKERS) —
//                it is NOT a setting an Admin can toggle, and the MULTI_CURRENCY_CHECKOUT flag
//                cannot add to it. The flag can only ever be a second key on a currency that
//                already passed the audit.
//
// This module is the single place the storefront, checkout and Admin read that decision from.

import { isCurrencyCode, CURRENCIES, type CurrencyCode } from '../currency'
import { usableRate, fxStatus, type FxConfig } from './fx'

/** Currencies whose full checkout → webhook → order → refund → dispute → fee → reporting path is proven. */
export const PAYABLE_AUDIT_PASSED: readonly CurrencyCode[] = ['USD']

export interface CurrencyBlocker {
  id: string
  /** Where the USD-only assumption lives (file / SQL function), so it can be found and fixed. */
  where: string
  /** Exactly why a non-USD charge cannot be accepted safely. */
  reason: string
  /** The work that would remove the blocker. */
  work: string
}

/**
 * Why no non-USD currency is payable. Each item was verified in this tree; none can be fixed
 * without changing frozen financial SQL or the financial formulas, which this batch forbids.
 */
export const CURRENCY_BLOCKERS: readonly CurrencyBlocker[] = [
  {
    id: 'order_finalize',
    where: 'finalize_paid_order() (migrations 002/022, frozen)',
    reason: 'Raises KVRN_RESERVATION|CURRENCY_MISMATCH for any session currency other than usd and compares amount_total to a USD-cent reservation total. A paid non-USD session would be reported as a payment exception, not an order.',
    work: 'A new finalize path that accepts a presentment currency and stores presentment_currency / presentment_total_cents / fx_rate next to the USD base amounts.',
  },
  {
    id: 'reservation',
    where: 'reserve_inventory() (migration 002, frozen)',
    reason: 'Rejects any product whose currency is not usd and snapshots USD unit prices into the reservation.',
    work: 'Reservation snapshots carrying a presentment currency and per-line converted amounts that sum exactly to the Stripe total.',
  },
  {
    id: 'refunds_disputes_fees',
    where: 'app/api/stripe/webhook/route.ts, lib/refunds.ts, lib/disputes.ts, lib/financials.ts',
    reason: 'Refund, dispute and balance-transaction rows store Stripe\'s currency, but every Admin aggregate (SUM(amount_cents), refundRevenueCents, dispute loss, Stripe fee) adds the cents together with no currency filter. A foreign-currency refund would be subtracted from USD revenue as if it were USD cents. Stripe fees come from the balance transaction (settlement currency) and are stored without a currency column.',
    work: 'Base-currency (USD) amounts recorded beside the presentment amounts for every refund/dispute/fee, reports reading only the base columns, and a reconciliation view that proves presentment and base totals agree.',
  },
  {
    id: 'reporting_currency',
    where: 'Admin financials (lib/financials.ts, lib/financial-calculator.ts, lib/analytics.ts)',
    reason: 'There is no defined reporting/base currency; every figure is implicitly USD cents.',
    work: 'Declare USD the reporting currency in the financial layer and convert nothing silently.',
  },
  {
    id: 'discounts',
    where: 'lib/discounts.ts, stripe_coupon_definitions',
    reason: 'Fixed-amount Stripe coupons are created in usd only, and a coupon cannot discount a non-USD session.',
    work: 'Per-currency coupon definitions or percentage-only coupons for presentment sessions.',
  },
  {
    id: 'shipping',
    where: 'lib/shippo.ts, lib/checkout-session-handler.ts',
    reason: 'Shippo rates are filtered to usd and Stripe shipping_options are created in usd; converting them would double-convert provider amounts. The free-shipping rule is one USD threshold (lib/free-shipping.ts).',
    work: 'Keep one USD business rule; convert once, at the presentment boundary, with the same rate used for the line items.',
  },
  {
    id: 'analytics',
    where: 'lib/ga4-server.ts',
    reason: 'The server-side GA4 purchase is refused unless the order currency is usd.',
    work: 'Report the base-currency value, or the presentment currency with its converted value, deliberately.',
  },
  {
    id: 'affiliates',
    where: 'lib/affiliates.ts, affiliate commission SQL (migrations 020/033)',
    reason: 'Commission, payout and clawback maths run on USD order cents.',
    work: 'Commission on base-currency amounts only, proven by tests with a foreign-currency order fixture.',
  },
  {
    id: 'abandoned_recovery',
    where: 'lib/abandoned-checkout-resume.ts',
    reason: 'Recovery supports usd only (SUPPORTED_RECOVERY_CURRENCIES) and falls back to USD with a notice.',
    work: 'Extend only together with the checkout work above.',
  },
  {
    id: 'stripe_api',
    where: 'stripe@16.12 (API 2024-06-20)',
    reason: 'Checkout line items (price_data) take a single currency and have no currency_options; only shipping_rate_data.fixed_amount offers currency_options. Adaptive Pricing is an account setting with no create-session parameter in this SDK — only the read-only Session.currency_conversion field — so code can neither enable nor disable it per session.',
    work: 'Either pre-created Prices with currency_options, or confirm Adaptive Pricing behaviour in a Stripe test account and record the converted amounts from currency_conversion.',
  },
] as const

/** Per-currency facts that apply on top of the shared blockers. */
const CURRENCY_NOTES: Partial<Record<CurrencyCode, string>> = {
  USD: 'Base and settlement currency. Fully supported.',
  JPY: 'Zero-decimal in Stripe: 1 unit = 1 amount, not 100. KVRN\'s integer-cent maths would need a per-currency minor-unit table.',
  AED: 'Not verified against the account\'s Stripe presentment list (no Stripe calls were made).',
  SAR: 'Not verified against the account\'s Stripe presentment list (no Stripe calls were made).',
  CNY: 'Not verified against the account\'s Stripe presentment list (no Stripe calls were made).',
}

export interface CurrencySupport {
  code: CurrencyCode
  name: string
  /** Can a customer see prices in it right now? */
  displayable: boolean
  displayNote: string
  /** Can a customer be charged in it? */
  payable: boolean
  payableNote: string
  blockers: string[]
}

export function currencySupportMatrix(fx: FxConfig | null, enabled: readonly CurrencyCode[], now: Date = new Date()): CurrencySupport[] {
  return CURRENCIES.map(c => {
    const isEnabled = c.code === 'USD' || enabled.includes(c.code)
    const rate = usableRate(fx, c.code, now)
    const fxs = fxStatus(fx, now)
    const payable = PAYABLE_AUDIT_PASSED.includes(c.code)
    return {
      code: c.code,
      name: c.label.split(' — ')[1] ?? c.code,
      displayable: isEnabled && rate !== null,
      displayNote: c.code === 'USD' ? 'Always shown.'
        : !isEnabled ? 'Not enabled.'
        : rate !== null ? `Shown as an estimate (rate dated ${fx!.asOf}${fxs === 'stale' ? ', getting old' : ''}).`
        : fxs === 'expired' ? 'Hidden: the configured rates are more than 30 days old.'
        : 'Hidden: no rate is configured, so prices stay in USD.',
      payable,
      payableNote: payable ? 'Charged in USD.' : [CURRENCY_NOTES[c.code], 'Checkout stays USD until every blocker below is removed.'].filter(Boolean).join(' '),
      blockers: payable ? [] : CURRENCY_BLOCKERS.map(b => b.id),
    }
  })
}

export interface PayableResolution {
  requested: CurrencyCode
  /** What the customer's card will actually be charged in. Always a payable currency. */
  chargedIn: CurrencyCode
  payable: boolean
  /** Why `requested` is not what is charged (null when it is). */
  reason: null | 'not_audited' | 'flag_off' | 'not_enabled' | 'unknown_currency'
}

/**
 * Decide what the card is charged in. Fails SAFE: anything unsupported, disabled or unknown
 * resolves to USD with a reason, never to a guess and never to an error that blocks a sale.
 */
export function resolvePayableCurrency(
  requested: unknown,
  opts: { flagOn: boolean; enabledCurrencies: readonly CurrencyCode[] },
): PayableResolution {
  if (!isCurrencyCode(requested)) return { requested: 'USD', chargedIn: 'USD', payable: true, reason: 'unknown_currency' }
  if (requested === 'USD') return { requested, chargedIn: 'USD', payable: true, reason: null }
  if (!PAYABLE_AUDIT_PASSED.includes(requested)) return { requested, chargedIn: 'USD', payable: false, reason: 'not_audited' }
  if (!opts.flagOn) return { requested, chargedIn: 'USD', payable: false, reason: 'flag_off' }
  if (!opts.enabledCurrencies.includes(requested)) return { requested, chargedIn: 'USD', payable: false, reason: 'not_enabled' }
  return { requested, chargedIn: requested, payable: true, reason: null }
}

/** Currencies the storefront may charge in right now (always includes USD). */
export function payableCurrencies(opts: { flagOn: boolean; enabledCurrencies: readonly CurrencyCode[] }): CurrencyCode[] {
  return CURRENCIES.map(c => c.code).filter(c => resolvePayableCurrency(c, opts).payable && resolvePayableCurrency(c, opts).chargedIn === c)
}
