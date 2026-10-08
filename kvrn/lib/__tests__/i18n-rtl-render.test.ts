// Right-to-left (Arabic), first-render consistency and the language/currency providers, rendered for
// real with react-dom/server (jest here has no DOM). Plus source guards for the CSS / class rules.
import fs from 'fs'
import path from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createLoader } from './helpers/tsx-loader'
import { MESSAGES } from '../i18n/messages'
import { LOCALE_CODES, dirOf } from '../i18n/locales'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const shim = (id: string): any => {
  if (id === 'next/link') return { __esModule: true, default: (p: any) => React.createElement('a', { href: p.href, className: p.className }, p.children) }
  if (id === 'next/navigation') return { usePathname: () => '/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh() {}, push() {} }) }
  return require(id)
}

const PROBE = `
'use client'
import { useI18n } from '@/context/I18nContext'
import { useCurrency } from '@/context/CurrencyContext'
export function Probe() {
  const { t, locale, dir, isRTL } = useI18n()
  const { formatPrice, currencyCode, isEstimate } = useCurrency()
  return <p data-l={locale} data-dir={dir} data-rtl={String(isRTL)} data-c={currencyCode} data-e={String(isEstimate)}>{t.addToBag}|{formatPrice(8000)}</p>
}`
const COOKIE_STUB = `
export function useCookiePrefs() { return { openPreferences() {}, prefs: null } }
export function CookiePrefsProvider({ children }: any) { return children }`

const L = createLoader(shim as any, { sources: { 'lib/__tests__/__probe.tsx': PROBE, 'context/CookiePrefsContext.tsx': COOKIE_STUB } })
const I18n = () => L.load('context/I18nContext.tsx')
const Cur = () => L.load('context/CurrencyContext.tsx')
const { Probe } = L.load('lib/__tests__/__probe.tsx')
const h = React.createElement
const html = (el: React.ReactElement) => renderToStaticMarkup(el)

const EUR = { rates: { EUR: 0.9 }, rateAsOf: '2026-10-05', payable: ['USD'] }

describe('providers: first render is already in the visitor\'s language and currency', () => {
  test('no props: English, LTR, USD, the shipped wording and price', () => {
    const out = html(h(I18n().I18nProvider, null, h(Cur().CurrencyProvider, null, h(Probe))))
    expect(out).toContain('data-l="en"'); expect(out).toContain('data-dir="ltr"'); expect(out).toContain('data-c="USD"')
    expect(out).toContain('Add to Bag|$80')
  })
  test('server-seeded Arabic + EUR: Arabic text, rtl, an estimate marked with "≈" — in the first HTML', () => {
    const out = html(h(I18n().I18nProvider, { initialLocale: 'ar' },
      h(Cur().CurrencyProvider, { initialCurrency: 'EUR', ...EUR }, h(Probe))))
    expect(out).toContain('data-l="ar"'); expect(out).toContain('data-dir="rtl"'); expect(out).toContain('data-rtl="true"')
    expect(out).toContain('data-c="EUR"'); expect(out).toContain('data-e="true"')
    expect(out).toContain(`${MESSAGES.ar.addToBag}|≈\u00a0€72`)
    expect(out).not.toContain('Add to Bag')
  })
  test('the layout\'s server-read seed drives the unchanged provider tree (no props)', () => {
    const { StorefrontSeedProvider } = L.load('context/StorefrontSeed.tsx')
    const seed = {
      locale: 'ar', hasLocaleCookie: true, config: undefined, served: ['en', 'ar'], displayable: ['USD', 'EUR'],
      currency: 'EUR', hasCurrencyCookie: true, rates: { EUR: 0.9 }, rateAsOf: '2026-10-05', payable: ['USD'],
    }
    const out = html(h(StorefrontSeedProvider, { seed },
      h(I18n().I18nProvider, null, h(Cur().CurrencyProvider, null, h(Probe)))))
    expect(out).toContain('data-l="ar"'); expect(out).toContain('data-dir="rtl"'); expect(out).toContain('data-c="EUR"')
    expect(out).toContain(`${MESSAGES.ar.addToBag}|≈\u00a0€72`)
    // explicit props still win over the seed
    const over = html(h(StorefrontSeedProvider, { seed },
      h(I18n().I18nProvider, { initialLocale: 'de' }, h(Cur().CurrencyProvider, { initialCurrency: 'USD' }, h(Probe)))))
    expect(over).toContain('data-l="de"'); expect(over).toContain('data-c="USD"')
  })
  test('server HTML equals the client\'s first render for the same seed (no hydration mismatch / flash)', () => {
    const seed = () => h(I18n().I18nProvider, { initialLocale: 'de', hasLocaleCookie: true },
      h(Cur().CurrencyProvider, { initialCurrency: 'EUR', hasCurrencyCookie: true, ...EUR }, h(Probe)))
    expect(html(seed())).toBe(html(seed()))
    expect(html(seed())).toContain(`${MESSAGES.de.addToBag}|≈\u00a0€72`)
  })
  test('a currency without a configured rate is never shown: the seed falls back to USD', () => {
    const out = html(h(I18n().I18nProvider, { initialLocale: 'ja' },
      h(Cur().CurrencyProvider, { initialCurrency: 'JPY' }, h(Probe))))
    expect(out).toContain('data-c="USD"'); expect(out).toContain('data-e="false"'); expect(out).toContain(`${MESSAGES.ja.addToBag}|$80`)
  })
  test('an unknown initial locale renders English', () => {
    expect(html(h(I18n().I18nProvider, { initialLocale: 'xx' }, h(Cur().CurrencyProvider, null, h(Probe))))).toContain('data-l="en"')
  })
  test('every locale renders its own complete dictionary through the provider', () => {
    for (const l of LOCALE_CODES) {
      const out = html(h(I18n().I18nProvider, { initialLocale: l }, h(Cur().CurrencyProvider, null, h(Probe))))
      expect(out).toContain(`data-dir="${dirOf(l)}"`)
      expect(out).toContain(`${MESSAGES[l].addToBag}|$80`)
    }
  })
  test('useCurrency outside a provider is USD only (it never throws and never invents a conversion)', () => {
    const out = html(h(Probe))
    expect(out).toContain('data-c="USD"'); expect(out).toContain('|$80')
  })
})

describe('English-fallback blocks are honest (LocaleSwitch + LocaleScope)', () => {
  const sw = (locale: string, variants: Record<string, React.ReactNode>) => {
    const { LocaleSwitch } = L.load('components/content/LocaleSwitch.tsx')
    return html(h(I18n().I18nProvider, { initialLocale: locale }, h(Cur().CurrencyProvider, null, h(LocaleSwitch, { variants }))))
  }
  test('a published Arabic variant is shown as Arabic, right-to-left, with no notice', () => {
    const out = sw('ar', { en: 'EN body', ar: 'AR body' })
    expect(out).toContain('lang="ar"'); expect(out).toContain('dir="rtl"'); expect(out).toContain('AR body')
    expect(out).not.toContain('EN body'); expect(out).not.toContain('role="note"')
  })
  test('no Japanese variant: English is shown, marked lang="en", with a notice in Japanese', () => {
    const out = sw('ja', { en: 'EN body' })
    expect(out).toContain('lang="en"'); expect(out).toContain('EN body')
    expect(out).toContain('role="note"'); expect(out).toContain(MESSAGES.ja['content.englishOnly'])
  })
  test('Arabic visitor, English-only page: the English block is LTR, the notice is Arabic', () => {
    const out = sw('ar', { en: 'EN body' })
    expect(out).toMatch(/<div lang="en" style="display:contents">/)
    expect(out).not.toMatch(/<div lang="en" dir="rtl"/)
    expect(out).toContain(MESSAGES.ar['content.englishOnly'])
  })
  test('chrome inside the English fallback block is English, so the block does not mix two languages', () => {
    const out = sw('ar', { en: h(Probe) })
    expect(out).toContain('data-l="en"'); expect(out).toContain('Add to Bag')
  })
  test('the fallback is never labelled as the visitor\'s language', () => {
    const out = sw('fr', { en: 'EN body' })
    expect(out).not.toMatch(/<div lang="fr"[^>]*>\s*EN body/)
  })
})

describe('Footer renders in Arabic from the dictionary (chrome is translated, not just the page)', () => {
  test('Arabic footer text and no English column headings', () => {
    const { Footer } = L.load('components/layout/Footer.tsx')
    const out = html(h(I18n().I18nProvider, { initialLocale: 'ar' }, h(Cur().CurrencyProvider, null, h(Footer))))
    expect(out).toContain(MESSAGES.ar.shop); expect(out).toContain(MESSAGES.ar.support)
    expect(out).not.toContain('>Shipping &amp; Returns<')
  })
  test('English footer is unchanged', () => {
    const { Footer } = L.load('components/layout/Footer.tsx')
    const out = html(h(I18n().I18nProvider, null, h(Cur().CurrencyProvider, null, h(Footer))))
    expect(out).toContain('Shipping')
    expect(out).toContain('Privacy')
  })
})

describe('RTL source guards', () => {
  test('the root layout sets lang + dir from the server-resolved locale and imports the RTL stylesheet', () => {
    const src = read('app/layout.tsx')
    expect(src).toMatch(/<html lang=\{i18n\.locale\} dir=\{i18n\.dir === 'rtl' \? 'rtl' : undefined\}>/)
    expect(src).toMatch(/import '\.\/i18n-rtl\.css'/)
    expect(src).toMatch(/getStorefrontI18n\(sql\)/)
    // The provider tree is the original one (<I18nProvider> … <CurrencyProvider>); the server-read values arrive via the seed.
    expect(src).toMatch(/<StorefrontSeedProvider seed=\{\{/)
    expect(src).toMatch(/locale: i18n\.locale/)
    expect(src).toMatch(/currency: i18n\.currency/)
    expect(src).toContain('<I18nProvider>')
    expect(src).toContain('<CurrencyProvider>')
  })
  test('English has no dir attribute at all (output unchanged)', () => {
    expect(read('app/layout.tsx')).toMatch(/'rtl' : undefined/)
  })
  test('the stylesheet is scoped under [dir="rtl"] and keeps numbers / inputs left-to-right', () => {
    const css = read('app/i18n-rtl.css')
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
    for (const r of rules) {
      const sel = r.split('{')[0]
      expect(sel).toMatch(/\[dir="rtl"\]|html\[lang="ar"\]/)
    }
    expect(css).toMatch(/direction: ltr/)
    expect(css).toMatch(/unicode-bidi: isolate/)
    expect(css).toMatch(/letter-spacing: normal/)           // Arabic joins break with tracking
    expect(css).toMatch(/text-transform: none/)
  })
  test('drawers slide from the logical end edge and reverse in RTL', () => {
    for (const f of ['components/cart/CartDrawer.tsx', 'components/ui/WishlistDrawer.tsx']) {
      const src = read(f)
      expect(src).toMatch(/fixed top-0 end-0 bottom-0/)
      expect(src).toMatch(/rtl:-translate-x-full/)
      expect(src).not.toMatch(/fixed top-0 right-0/)
    }
  })
  test('components written for this batch use logical utilities, not physical left/right', () => {
    for (const f of [
      'components/content/LocaleSwitch.tsx', 'components/content/SizeGuideClient.tsx', 'components/ui/LanguageSelector.tsx',
      'components/ui/CurrencySelector.tsx', 'components/i18n/PreferenceRefresher.tsx', 'components/content/CollectionGrid.tsx',
    ]) {
      expect(read(f)).not.toMatch(/\b(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d/)
    }
  })
  test('the visitor-chosen language never reaches the document through innerHTML', () => {
    expect(read('context/I18nContext.tsx')).not.toMatch(/dangerouslySetInnerHTML|innerHTML/)
  })
  test('the client switcher updates <html lang dir> immediately and persists cookie + localStorage', () => {
    const src = read('context/I18nContext.tsx')
    expect(src).toMatch(/document\.documentElement\.dir\s*=\s*dirOf\(l\)/)
    expect(src).toMatch(/document\.documentElement\.lang\s*=\s*l/)
    expect(src).toMatch(/writeCookie\(LOCALE_COOKIE, l\)/)
    expect(src).toMatch(/writeStorage\(LOCALE_STORAGE_KEY, l\)/)
    expect(read('components/i18n/PreferenceRefresher.tsx')).toMatch(/router\.refresh\(\)/)
  })
})
