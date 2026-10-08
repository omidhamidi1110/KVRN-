// Language + currency preferences (cookie logic), config validation, the no-fake-FX currency model,
// the payable-currency policy and the checkout presentation. All pure: no database, no network.
import { LOCALE_CODES, type Locale } from '../i18n/locales'
import { readyLocales } from '../i18n/messages'
import {
  LOCALE_COOKIE, CURRENCY_COOKIE, PREFERENCE_MAX_AGE_SECONDS,
  resolvePreferences, applyLanguageChange, applyCurrencyChange, defaultCurrencyFor,
  readCookie, serializePreferenceCookie, servedLocales,
} from '../i18n/preferences'
import { defaultI18nConfig, parseI18nConfig, validateI18nConfig, loadStorefrontI18nSettings, type I18nConfig } from '../i18n/config'
import {
  validateFx, parseFx, fxStatus, fxAgeDays, usableRate, displayableCurrencies,
  FX_STALE_AFTER_DAYS, FX_EXPIRED_AFTER_DAYS, type FxConfig,
} from '../i18n/fx'
import {
  PAYABLE_AUDIT_PASSED, CURRENCY_BLOCKERS, currencySupportMatrix, resolvePayableCurrency, payableCurrencies,
} from '../i18n/currency-policy'
import { buildStorefrontI18n, displayRates } from '../i18n/server'
import { checkoutPresentation } from '../i18n/checkout'
import { CURRENCIES, CURRENCY_CODES, formatPrice, getCurrency, freeShippingThreshold, centsToFreeShipping, FREE_SHIPPING_THRESHOLD_CENTS as CUR_THRESHOLD, type CurrencyCode } from '../currency'
import { FREE_SHIPPING_THRESHOLD_CENTS, qualifiesForFreeShipping } from '../free-shipping'

const NOW = new Date('2026-10-07T12:00:00Z')
const FRESH: FxConfig = { rates: { EUR: 0.9, GBP: 0.8, JPY: 150 }, asOf: '2026-10-05', source: 'ECB reference rates' }
const cfg = (over: Partial<I18nConfig> = {}): I18nConfig => {
  const d = defaultI18nConfig()
  return { ...d, ...over, defaultCurrencyByLocale: { ...d.defaultCurrencyByLocale, ...(over.defaultCurrencyByLocale ?? {}) } }
}
const ALL = [...LOCALE_CODES] as Locale[]
const cookies = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? { value: o[k] } : undefined) })

describe('preference cookies', () => {
  test('names, lifetime and attributes (readable by the client switcher, never HttpOnly, no secrets)', () => {
    expect(LOCALE_COOKIE).toBe('kvrn_locale')
    expect(CURRENCY_COOKIE).toBe('kvrn_currency')
    expect(PREFERENCE_MAX_AGE_SECONDS).toBe(31_536_000)
    const c = serializePreferenceCookie(LOCALE_COOKIE, 'ar', { secure: false })
    expect(c).toBe('kvrn_locale=ar; Path=/; Max-Age=31536000; SameSite=Lax')
    expect(c).not.toMatch(/HttpOnly/i)
    expect(c).not.toMatch(/Secure/)
    expect(serializePreferenceCookie(CURRENCY_COOKIE, 'EUR', { secure: true })).toMatch(/; Secure$/)
  })
  test('rejects other cookie names and unsafe values', () => {
    expect(() => serializePreferenceCookie('session', 'x', { secure: false })).toThrow()
    expect(() => serializePreferenceCookie(LOCALE_COOKIE, 'a;b', { secure: false })).toThrow()
    expect(() => serializePreferenceCookie(LOCALE_COOKIE, '', { secure: false })).toThrow()
  })
  test('readCookie picks one cookie out of a header and refuses odd values', () => {
    expect(readCookie('a=1; kvrn_locale=fr; kvrn_currency=EUR', 'kvrn_locale')).toBe('fr')
    expect(readCookie('kvrn_locale=<script>', 'kvrn_locale')).toBeNull()
    expect(readCookie(null, 'kvrn_locale')).toBeNull()
    expect(readCookie('x=1', 'kvrn_locale')).toBeNull()
  })
})

describe('server-side resolution of the cookies is validated and safe', () => {
  const base = { config: cfg({ enabledCurrencies: ['USD', 'EUR'], defaultCurrencyByLocale: { de: 'EUR' } as any }), readyLocales: ALL, displayable: ['USD', 'EUR'] as CurrencyCode[] }
  test('no cookies: English / USD', () => {
    expect(resolvePreferences({ ...base })).toMatchObject({ locale: 'en', currency: 'USD', localeFromCookie: false, currencyFromCookie: false })
  })
  test('valid cookies are honoured', () => {
    expect(resolvePreferences({ ...base, localeCookie: 'ar', currencyCookie: 'EUR' })).toMatchObject({ locale: 'ar', currency: 'EUR', localeFromCookie: true, currencyFromCookie: true })
  })
  test('a language without a currency cookie gets that language\'s default currency', () => {
    expect(resolvePreferences({ ...base, localeCookie: 'de' })).toMatchObject({ locale: 'de', currency: 'EUR', currencyFromCookie: false })
  })
  test.each([['xx'], [''], ['EN'], ['<b>'], ['ar;x']])('garbage locale %j falls back to English', (v) => {
    expect(resolvePreferences({ ...base, localeCookie: v }).locale).toBe('en')
  })
  test('a disabled or not-ready locale cannot be served from a cookie', () => {
    expect(resolvePreferences({ ...base, config: cfg({ enabledLocales: ['en', 'es'] }), localeCookie: 'ja' }).locale).toBe('en')
    expect(resolvePreferences({ ...base, readyLocales: ['en', 'es'], localeCookie: 'ja' }).locale).toBe('en')
    expect(servedLocales(cfg({ enabledLocales: ['en', 'es', 'ja'] }), ['en', 'es'])).toEqual(['en', 'es'])
  })
  test('a currency that is unknown, not enabled or has no usable rate falls back to the default / USD', () => {
    expect(resolvePreferences({ ...base, currencyCookie: 'ZZZ' }).currency).toBe('USD')
    expect(resolvePreferences({ ...base, currencyCookie: 'GBP' }).currency).toBe('USD')        // not displayable
    expect(resolvePreferences({ ...base, displayable: ['USD'], currencyCookie: 'EUR' }).currency).toBe('USD')
  })
})

describe('changing language applies its default currency; the currency choice is separate', () => {
  const config = cfg({ enabledCurrencies: ['USD', 'EUR', 'JPY'], defaultCurrencyByLocale: { de: 'EUR', ja: 'JPY', fr: 'EUR' } as any })
  const shown: CurrencyCode[] = ['USD', 'EUR', 'JPY']
  test('language change sets the language and its default currency', () => {
    expect(applyLanguageChange('de', config, shown)).toEqual({ locale: 'de', currency: 'EUR' })
    expect(applyLanguageChange('ja', config, shown)).toEqual({ locale: 'ja', currency: 'JPY' })
    expect(applyLanguageChange('en', config, shown)).toEqual({ locale: 'en', currency: 'USD' })
  })
  test('the currency selector overrides without touching the language', () => {
    const afterLang = applyLanguageChange('de', config, shown)
    const afterCur = applyCurrencyChange(afterLang, 'JPY', shown)
    expect(afterCur).toEqual({ locale: 'de', currency: 'JPY' })
  })
  test('changing language again re-applies the new default (the override does not stick)', () => {
    let p = applyLanguageChange('de', config, shown)
    p = applyCurrencyChange(p, 'JPY', shown)
    p = applyLanguageChange('fr', config, shown)
    expect(p).toEqual({ locale: 'fr', currency: 'EUR' })
  })
  test('a default that cannot be shown right now (no usable rate) falls back to USD, never to a guess', () => {
    expect(applyLanguageChange('de', config, ['USD'])).toEqual({ locale: 'de', currency: 'USD' })
    expect(defaultCurrencyFor('ja', config, ['USD', 'EUR'])).toBe('USD')
  })
  test('choosing a currency that cannot be shown is ignored', () => {
    expect(applyCurrencyChange({ locale: 'en', currency: 'USD' }, 'EUR', ['USD'])).toEqual({ locale: 'en', currency: 'USD' })
  })
})

describe('Admin config validation: an incomplete locale cannot be enabled', () => {
  const ok = () => ({ enabledLocales: ['en', 'es'], enabledCurrencies: ['USD'], defaultCurrencyByLocale: Object.fromEntries(ALL.map(l => [l, 'USD'])) })
  test('valid config passes', () => {
    const v = validateI18nConfig(ok(), ALL)
    expect(v.ok).toBe(true)
  })
  test('enabling a locale that is not ready is rejected with a clear message', () => {
    const v = validateI18nConfig({ ...ok(), enabledLocales: ['en', 'es', 'ja'] }, ['en', 'es'])
    expect(v.ok).toBe(false)
    expect((v as any).errors.join(' ')).toMatch(/enabledLocales\.ja: Not ready/)
  })
  test('English and USD must stay enabled; unknown codes and default currencies outside the enabled set are rejected', () => {
    expect((validateI18nConfig({ ...ok(), enabledLocales: ['es'] }, ALL) as any).errors.join(' ')).toMatch(/English must stay enabled/)
    expect((validateI18nConfig({ ...ok(), enabledCurrencies: ['EUR'] }, ALL) as any).errors.join(' ')).toMatch(/USD must stay enabled/)
    expect((validateI18nConfig({ ...ok(), enabledLocales: ['en', 'xx'] }, ALL) as any).errors.join(' ')).toMatch(/not a known language/)
    const bad = { ...ok(), defaultCurrencyByLocale: { ...ok().defaultCurrencyByLocale, es: 'EUR' } }
    expect((validateI18nConfig(bad, ALL) as any).errors.join(' ')).toMatch(/defaultCurrencyByLocale\.es: EUR is not an enabled currency/)
    expect(validateI18nConfig('nope', ALL).ok).toBe(false)
  })
  test('the lenient reader never throws and degrades to the shipped default', () => {
    for (const junk of [null, undefined, 5, 'x', [], { enabledLocales: 'x', enabledCurrencies: 3, defaultCurrencyByLocale: 9 }]) {
      const c = parseI18nConfig(junk, ALL)
      expect(c.enabledLocales).toContain('en')
      expect(c.enabledCurrencies).toContain('USD')
    }
    // a stored locale that is no longer ready is dropped at read time
    expect(parseI18nConfig({ enabledLocales: ['en', 'ja'], enabledCurrencies: ['USD'], defaultCurrencyByLocale: {} }, ['en']).enabledLocales).toEqual(['en'])
  })
  test('the settings loader returns English / USD defaults when the database fails', async () => {
    const boom: any = async () => { throw new Error('db down') }
    const s = await loadStorefrontI18nSettings(boom, ALL, NOW)
    expect(s.fx).toBeNull()
    expect(s.config.enabledCurrencies).toEqual(['USD'])
  })
})

describe('FX: configured, dated, never hardcoded', () => {
  test('validation requires positive rates, a real as-of date and a source', () => {
    expect(validateFx({ rates: { EUR: 0.9 }, asOf: '2026-10-01', source: 'ECB' }, NOW).ok).toBe(true)
    const errs = (v: unknown) => (validateFx(v, NOW) as any).errors.join(' | ')
    expect(errs({ rates: { EUR: 0 }, asOf: '2026-10-01', source: 'x' })).toMatch(/rates\.EUR/)
    expect(errs({ rates: { EUR: -1 }, asOf: '2026-10-01', source: 'x' })).toMatch(/rates\.EUR/)
    expect(errs({ rates: { EUR: 'abc' }, asOf: '2026-10-01', source: 'x' })).toMatch(/rates\.EUR/)
    expect(errs({ rates: { USD: 1 }, asOf: '2026-10-01', source: 'x' })).toMatch(/rates\.USD/)
    expect(errs({ rates: { XXX: 1 }, asOf: '2026-10-01', source: 'x' })).toMatch(/Unknown currency/)
    expect(errs({ rates: { EUR: 1 }, asOf: 'yesterday', source: 'x' })).toMatch(/asOf/)
    expect(errs({ rates: { EUR: 1 }, asOf: '2027-01-01', source: 'x' })).toMatch(/future/)
    expect(errs({ rates: { EUR: 1 }, asOf: '2026-10-01', source: '' })).toMatch(/source/)
  })
  test('staleness: fresh up to 7 days, stale to 30, then expired and unusable', () => {
    expect(FX_STALE_AFTER_DAYS).toBe(7); expect(FX_EXPIRED_AFTER_DAYS).toBe(30)
    const at = (d: string) => fxStatus({ ...FRESH, asOf: d }, NOW)
    expect(at('2026-10-07')).toBe('fresh')
    expect(at('2026-09-30')).toBe('fresh')          // 7 days
    expect(at('2026-09-29')).toBe('stale')          // 8 days
    expect(at('2026-09-07')).toBe('stale')          // 30 days
    expect(at('2026-09-06')).toBe('expired')        // 31 days
    expect(fxStatus(null, NOW)).toBe('missing')
    expect(fxStatus({ ...FRESH, rates: {} }, NOW)).toBe('missing')
    expect(fxAgeDays(FRESH, NOW)).toBe(2)
  })
  test('an expired or missing rate is not usable: the price stays USD', () => {
    expect(usableRate(null, 'EUR', NOW)).toBeNull()
    expect(usableRate({ ...FRESH, asOf: '2026-01-01' }, 'EUR', NOW)).toBeNull()
    expect(usableRate(FRESH, 'MXN', NOW)).toBeNull()                    // no rate for that currency
    expect(usableRate(FRESH, 'EUR', NOW)).toBe(0.9)
    expect(usableRate(FRESH, 'USD', NOW)).toBe(1)
    expect(usableRate({ ...FRESH, asOf: '2026-09-20' }, 'EUR', NOW)).toBe(0.9)   // stale still usable (warned in Admin)
  })
  test('displayable = USD + enabled currencies that have a usable rate', () => {
    expect(displayableCurrencies(FRESH, ['USD', 'EUR', 'MXN'], NOW)).toEqual(['USD', 'EUR'])
    expect(displayableCurrencies(null, ['USD', 'EUR'], NOW)).toEqual(['USD'])
    expect(displayableCurrencies(FRESH, ['USD'], NOW)).toEqual(['USD'])         // a rate alone does not enable a currency
  })
  test('parseFx is lenient: malformed storage means no rates', () => {
    expect(parseFx({ rates: 'x' }, NOW)).toBeNull()
    expect(parseFx(null, NOW)).toBeNull()
    expect(parseFx(FRESH, NOW)).toEqual(FRESH)
  })
  test('there are no built-in rates in lib/currency.ts', () => {
    // Without a configured rate, every non-USD currency formats as the USD price (never an invented conversion).
    for (const c of CURRENCIES) expect(formatPrice(24000, c)).toBe('$240')
    expect(formatPrice(24000, getCurrency('EUR'), undefined)).toBe('$240')
    expect(formatPrice(24000, getCurrency('EUR'), 0)).toBe('$240')
    expect(formatPrice(24000, getCurrency('EUR'), NaN)).toBe('$240')
    expect(formatPrice(24000, getCurrency('EUR'), 0.9)).toMatch(/216/)
    expect(Object.keys(require('../currency'))).not.toEqual(expect.arrayContaining(['RATES', 'FX_RATES', 'rate']))
  })
  test('USD output is the shipped output (whole dollars) and real cents are not rounded away', () => {
    expect(formatPrice(8000, getCurrency('USD'))).toBe('$80')
    expect(formatPrice(7950, getCurrency('USD'))).toBe('$79.50')
  })
})

describe('first render: the server-seeded values are what the client starts with', () => {
  const settings = (over: any = {}) => ({
    config: cfg({ enabledLocales: ALL, enabledCurrencies: ['USD', 'EUR', 'GBP'], defaultCurrencyByLocale: { de: 'EUR' } as any, ...over }),
    fx: FRESH as FxConfig | null,
  })
  test('cookies in, provider seed out (language, direction, currency, rates)', () => {
    const s = buildStorefrontI18n({ localeCookie: 'ar', currencyCookie: 'EUR', settings: settings(), now: NOW, multiCurrencyFlag: false })
    expect(s).toMatchObject({ locale: 'ar', dir: 'rtl', currency: 'EUR', hasLocaleCookie: true, hasCurrencyCookie: true })
    expect(s.rates).toEqual({ EUR: 0.9, GBP: 0.8 })           // JPY has a rate but is not enabled
    expect(s.rateAsOf).toBe('2026-10-05')
  })
  test('no cookies: English / LTR / USD, and nothing estimated', () => {
    const s = buildStorefrontI18n({ localeCookie: null, currencyCookie: null, settings: settings({ enabledCurrencies: ['USD'] }), now: NOW, multiCurrencyFlag: false })
    expect(s).toMatchObject({ locale: 'en', dir: 'ltr', currency: 'USD', hasLocaleCookie: false })
    expect(s.rates).toEqual({}); expect(s.rateAsOf).toBeNull()
  })
  test('an expired rate table seeds USD even if the cookie says EUR (no stale price flash)', () => {
    const s = buildStorefrontI18n({ localeCookie: 'en', currencyCookie: 'EUR', settings: { ...settings(), fx: { ...FRESH, asOf: '2026-01-01' } }, now: NOW, multiCurrencyFlag: false })
    expect(s.currency).toBe('USD'); expect(s.rates).toEqual({})
  })
  test('the seed is deterministic for the same inputs (server and client agree)', () => {
    const a = buildStorefrontI18n({ localeCookie: 'de', currencyCookie: null, settings: settings(), now: NOW, multiCurrencyFlag: false })
    const b = buildStorefrontI18n({ localeCookie: 'de', currencyCookie: null, settings: settings(), now: NOW, multiCurrencyFlag: false })
    expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)))
    expect(a.currency).toBe('EUR')                              // the German default currency
  })
  test('displayRates drops USD, unrated and expired currencies', () => {
    expect(displayRates(FRESH, ['USD', 'EUR', 'MXN'], NOW)).toEqual({ EUR: 0.9 })
    expect(displayRates(null, ['EUR'], NOW)).toEqual({})
  })
})

describe('what can actually be charged: USD only, whatever is displayed', () => {
  test('the audit-passed set is exactly USD', () => {
    expect([...PAYABLE_AUDIT_PASSED]).toEqual(['USD'])
  })
  test.each(CURRENCY_CODES.filter(c => c !== 'USD'))('%s resolves to USD with the flag OFF and with it ON (unsupported fails safe)', (c) => {
    const everything = [...CURRENCY_CODES]
    const off = resolvePayableCurrency(c, { flagOn: false, enabledCurrencies: everything })
    const on = resolvePayableCurrency(c, { flagOn: true, enabledCurrencies: everything })
    expect(off).toMatchObject({ chargedIn: 'USD', payable: false })
    expect(on).toMatchObject({ chargedIn: 'USD', payable: false, reason: 'not_audited' })
  })
  test('USD and junk both resolve to a USD charge without throwing', () => {
    expect(resolvePayableCurrency('USD', { flagOn: false, enabledCurrencies: [] })).toMatchObject({ chargedIn: 'USD', payable: true, reason: null })
    for (const junk of [undefined, null, 5, 'usd', 'EURO', {}]) {
      expect(resolvePayableCurrency(junk, { flagOn: true, enabledCurrencies: ['USD'] }).chargedIn).toBe('USD')
    }
  })
  test('payableCurrencies is [USD] regardless of the flag or the enabled list', () => {
    expect(payableCurrencies({ flagOn: true, enabledCurrencies: [...CURRENCY_CODES] })).toEqual(['USD'])
    expect(payableCurrencies({ flagOn: false, enabledCurrencies: ['USD'] })).toEqual(['USD'])
  })
  test('the audit is written down: every blocker says where it lives, why it blocks and what work removes it', () => {
    expect(CURRENCY_BLOCKERS.map(b => b.id).sort()).toEqual([
      'abandoned_recovery', 'affiliates', 'analytics', 'discounts', 'order_finalize', 'refunds_disputes_fees',
      'reporting_currency', 'reservation', 'shipping', 'stripe_api',
    ].sort())
    for (const b of CURRENCY_BLOCKERS) {
      expect(b.where.length).toBeGreaterThan(5)
      expect(b.reason.length).toBeGreaterThan(20)
      expect(b.work.length).toBeGreaterThan(20)
    }
  })
  test('support matrix: only USD is payable; non-USD is displayable only with a fresh configured rate AND enabled', () => {
    const m = currencySupportMatrix(FRESH, ['USD', 'EUR'], NOW)
    const by = Object.fromEntries(m.map(r => [r.code, r]))
    expect(m.length).toBe(CURRENCY_CODES.length)
    expect(m.filter(r => r.payable).map(r => r.code)).toEqual(['USD'])
    expect(by.USD).toMatchObject({ displayable: true, payable: true, blockers: [] })
    expect(by.EUR).toMatchObject({ displayable: true, payable: false })
    expect(by.EUR.displayNote).toMatch(/estimate/i)
    expect(by.GBP).toMatchObject({ displayable: false })                    // rate exists but GBP not enabled
    expect(by.GBP.displayNote).toBe('Not enabled.')
    expect(by.MXN.displayable).toBe(false)
    expect(by.EUR.blockers.length).toBe(CURRENCY_BLOCKERS.length)
    expect(by.JPY.payableNote).toMatch(/zero-decimal/i)
    for (const c of ['AED', 'SAR', 'CNY']) expect(by[c].payableNote).toMatch(/not verified/i)
    // no rates at all: nothing but USD is displayable, and the note says why
    const none = currencySupportMatrix(null, [...CURRENCY_CODES], NOW)
    expect(none.filter(r => r.displayable).map(r => r.code)).toEqual(['USD'])
    expect(none.find(r => r.code === 'EUR')!.displayNote).toMatch(/no rate is configured/i)
    // expired rates
    const old = currencySupportMatrix({ ...FRESH, asOf: '2026-01-01' }, [...CURRENCY_CODES], NOW)
    expect(old.find(r => r.code === 'EUR')!.displayNote).toMatch(/more than 30 days/)
  })
})

describe('checkout presentation (what the Stripe request does with the cookies)', () => {
  test('no cookies: no Stripe locale (the param is omitted and Stripe behaves exactly as before)', () => {
    const p = checkoutPresentation(cookies({}), { flagOn: false })
    expect(p).toMatchObject({ locale: null, stripeLocale: null, recordLocale: null, requestedCurrency: null })
    expect(p.currency).toMatchObject({ chargedIn: 'USD', payable: true })
    expect(checkoutPresentation(undefined, { flagOn: false }).stripeLocale).toBeNull()
    expect(checkoutPresentation(null, { flagOn: true }).stripeLocale).toBeNull()
  })
  test.each([
    ['en', 'en'], ['es', 'es'], ['fr', 'fr'], ['de', 'de'], ['ja', 'ja'], ['ko', 'ko'], ['pt', 'pt'], ['zh', 'zh'],
    ['ar', 'auto'], ['hi', 'auto'],
  ])('locale cookie %s gives Stripe locale %s', (l, s) => {
    const p = checkoutPresentation(cookies({ kvrn_locale: l }), { flagOn: false })
    expect(p.stripeLocale).toBe(s); expect(p.recordLocale).toBe(l)
  })
  test('an invalid locale cookie is ignored', () => {
    for (const bad of ['xx', 'EN', '', '../..']) expect(checkoutPresentation(cookies({ kvrn_locale: bad }), { flagOn: false }).stripeLocale).toBeNull()
  })
  test('a foreign-currency cookie never changes what is charged (flag OFF and ON)', () => {
    for (const flagOn of [false, true]) {
      const p = checkoutPresentation(cookies({ kvrn_currency: 'EUR', kvrn_locale: 'de' }), { flagOn, enabledCurrencies: [...CURRENCY_CODES] })
      expect(p.requestedCurrency).toBe('EUR')
      expect(p.currency.chargedIn).toBe('USD')
      expect(p.currency.payable).toBe(false)
    }
  })
  test('a throwing cookie jar degrades to defaults', () => {
    const p = checkoutPresentation({ get: () => { throw new Error('x') } }, { flagOn: false })
    expect(p.stripeLocale).toBeNull(); expect(p.currency.chargedIn).toBe('USD')
  })
})

describe('one free-shipping rule, in USD', () => {
  test('lib/currency.ts re-exports the single threshold from lib/free-shipping.ts', () => {
    expect(CUR_THRESHOLD).toBe(FREE_SHIPPING_THRESHOLD_CENTS)
    expect(FREE_SHIPPING_THRESHOLD_CENTS).toBe(15000)
  })
  test('the remaining amount is computed in USD cents and is the same whichever currency is displayed', () => {
    expect(centsToFreeShipping(12000)).toBe(3000)
    expect(centsToFreeShipping(15000)).toBe(0)
    expect(qualifiesForFreeShipping('US', 15000)).toBe(true)
    expect(qualifiesForFreeShipping('US', 14999)).toBe(false)
    expect(qualifiesForFreeShipping('CA', 99999)).toBe(false)
  })
  test('the displayed threshold is an estimate of the same USD amount, USD when no rate', () => {
    expect(freeShippingThreshold(getCurrency('USD'))).toBe('$150')
    expect(freeShippingThreshold(getCurrency('EUR'))).toBe('$150')
    expect(freeShippingThreshold(getCurrency('EUR'), 0.9)).toMatch(/135/)
  })
  test('no per-currency threshold table exists', () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../currency.ts'), 'utf8')
    expect(src).not.toMatch(/freeShippingThreshold\s*:\s*\d/)
    expect(src).not.toMatch(/threshold\s*:\s*\d{2,}/i)
  })
})
