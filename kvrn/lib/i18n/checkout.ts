// lib/i18n/checkout.ts — what the visitor's language / currency choice means for ONE checkout request.
// PURE (no I/O): the checkout handler passes in the request's cookies.
//
//   stripeLocale  The Stripe-hosted Checkout `locale` for the visitor's chosen language, or null when
//                 they have not chosen one (the param is then omitted and Stripe uses the browser's
//                 language exactly as before). Languages Stripe cannot render (ar, hi) give 'auto'.
//   recordLocale  The chosen language, to store on the abandoned-checkout record so the recovery
//                 email is sent in the language the shopper actually used (else Accept-Language).
//   currency      Always resolves to something payable. Today that is USD for everything: the
//                 handler asserts `chargedIn === 'USD'` and still creates the session in usd.

import { isLocale, toStripeLocale, type Locale } from './locales'
import { LOCALE_COOKIE, CURRENCY_COOKIE } from './preferences'
import { resolvePayableCurrency, type PayableResolution } from './currency-policy'
import { CURRENCY_CODES, type CurrencyCode } from '../currency'

export interface CookieGetter { get(name: string): { value: string } | undefined }

export interface CheckoutPresentation {
  locale: Locale | null
  stripeLocale: string | null
  recordLocale: string | null
  requestedCurrency: string | null
  currency: PayableResolution
}

export function checkoutPresentation(
  cookies: CookieGetter | null | undefined,
  opts: { flagOn: boolean; enabledCurrencies?: readonly CurrencyCode[] },
): CheckoutPresentation {
  let rawLocale: string | undefined, rawCurrency: string | undefined
  try { rawLocale = cookies?.get(LOCALE_COOKIE)?.value } catch { /* none */ }
  try { rawCurrency = cookies?.get(CURRENCY_COOKIE)?.value } catch { /* none */ }
  const locale = isLocale(rawLocale) ? rawLocale : null
  const requestedCurrency = (CURRENCY_CODES as readonly string[]).includes(String(rawCurrency)) ? String(rawCurrency) : null
  return {
    locale,
    stripeLocale: locale ? toStripeLocale(locale) : null,
    recordLocale: locale,
    requestedCurrency,
    currency: resolvePayableCurrency(requestedCurrency, { flagOn: opts.flagOn, enabledCurrencies: opts.enabledCurrencies ?? ['USD'] }),
  }
}
