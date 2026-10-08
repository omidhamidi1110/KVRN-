// Source guards for the storefront localization / currency wiring: things that must stay true but
// are not worth a full render (and could not be rendered in jest's node environment anyway).
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('customer-facing surfaces take their words from the dictionary', () => {
  const files = [
    'components/layout/Nav.tsx', 'components/layout/Footer.tsx', 'components/layout/PageHero.tsx', 'components/ui/AnnouncementBar.tsx',
    'components/ui/CookieConsent.tsx', 'app/cookies/CookieControls.tsx', 'components/cart/CartDrawer.tsx', 'components/ui/WishlistDrawer.tsx',
    'components/shop/ShopClient.tsx', 'components/shop/CollectionHero.tsx', 'app/products/[slug]/PDPClient.tsx',
    'app/checkout/page.tsx', 'app/checkout/success/page.tsx', 'app/checkout/recover/RecoverClient.tsx',
    'app/support/track/page.tsx', 'app/contact/ContactClient.tsx', 'app/not-found.tsx', 'components/product/ProductCard.tsx',
  ]
  test.each(files)('%s reads the active language', (f) => {
    expect(read(f)).toMatch(/useI18n\(\)|MESSAGES\[/)
  })
  test('the about page picks its dictionary on the server from the visitor\'s locale', () => {
    const src = read('app/about/page.tsx')
    expect(src).toMatch(/getRequestLocale\(sql\)/)
    expect(src).toMatch(/MESSAGES\[locale\]/)
  })
})

describe('prices: displayed estimates, charged in USD', () => {
  test('no exchange-rate table exists in the codebase (only the Admin-configured i18n.fx)', () => {
    const src = read('lib/currency.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/\bRATES?\s*[:=]\s*[{\[]/)
    expect(src).not.toMatch(/rate\s*:\s*\d/)
    expect(src).not.toMatch(/\b0\.9\d?\b|\b1\.0[5-9]\b|\b1[45]\d\.\d+\b/)          // no remembered EUR/GBP/JPY numbers
    expect(read('context/CurrencyContext.tsx')).not.toMatch(/\bRATES?\s*[:=]\s*[{\[]/)
  })
  test('the selectors offer only currencies that can be shown now (rate configured), never the whole list', () => {
    expect(read('components/ui/CurrencySelector.tsx')).toMatch(/available\.map/)
    expect(read('components/ui/CurrencySelector.tsx')).not.toMatch(/CURRENCIES\.map/)
  })
  test('structured data stays USD (what is charged), whatever the display currency', () => {
    expect(read('lib/product-seo.ts')).toMatch(/priceCurrency: 'USD'/)
  })
  test('checkout tells a shopper who saw a non-USD estimate that the charge is USD', () => {
    expect(read('app/checkout/page.tsx')).toMatch(/currency\.chargedInUsd/)
    expect(read('app/checkout/page.tsx')).toMatch(/currencyCode !== 'USD'/)
  })
  test('the Stripe session is created in usd; the currency cookie is never copied into it', () => {
    const src = read('lib/checkout-session-handler.ts')
    expect(src).toMatch(/currency:\s+'usd'/)
    expect(src).not.toMatch(/currency:\s*presentation\.(requestedCurrency|currency)/)
    expect(src).toMatch(/presentation\.currency\.chargedIn !== 'USD'/)
    expect(src).toMatch(/\.\.\.\(presentation\.stripeLocale \? \{ locale: presentation\.stripeLocale \} : \{\}\)/)
  })
  test('there is no currency-specific free-shipping threshold; the checkout rule is the one in lib/free-shipping.ts', () => {
    expect(read('lib/currency.ts')).toMatch(/from '\.\/free-shipping'/)
  })
})

describe('pages that read the visitor\'s cookies are dynamic (never statically cached with one visitor\'s language)', () => {
  test('root layout is force-dynamic and reads the cookies via the server helper', () => {
    const src = read('app/layout.tsx')
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    expect(src).toMatch(/getStorefrontI18n/)
  })
  test.each(['app/about/page.tsx', 'app/products/[slug]/page.tsx', 'app/shop/page.tsx'])('%s is not statically generated', (f) => {
    const src = read(f)
    expect(src).not.toMatch(/export const dynamic = 'force-static'/)
    expect(src).not.toMatch(/export const revalidate = \d+/)
    expect(src).not.toMatch(/generateStaticParams/)
  })
  test('the cookie helper tolerates being called outside a request (tests, static generation)', () => {
    expect(read('lib/i18n/server.ts')).toMatch(/Outside a request/)
  })
})

describe('abandoned-checkout recovery honours the language', () => {
  test('the recovery landing page explains every failure in the visitor\'s language', () => {
    const src = read('app/checkout/recover/RecoverClient.tsx')
    expect(src).toMatch(/recover\.fail\./)
    expect(src).toMatch(/useI18n\(\)/)
  })
  test('the checkout records the chosen language for the recovery email and keeps the record in usd', () => {
    const src = read('lib/checkout-session-handler.ts')
    expect(src).toMatch(/locale:\s+presentation\.recordLocale \?\? req\.headers\?\.get\?\.\('accept-language'\) \?\? null/)
    expect(src).toMatch(/currency:\s+'usd'/)
  })
})

describe('Admin tab registration is minimal', () => {
  test('the content hub has a Languages & currency tab that renders LanguagesPanel', () => {
    const src = read('components/admin/content/ContentHub.tsx')
    expect(src).toMatch(/Languages & currency/)
    expect(src).toMatch(/<LanguagesPanel/)
  })
  test('the panel never offers a switch that makes a currency payable', () => {
    const src = read('components/admin/content/LanguagesPanel.tsx')
    expect(src).toMatch(/NOT READY/)
    expect(src).not.toMatch(/payable\s*:\s*true|setPayable|MULTI_CURRENCY_CHECKOUT\s*=/)
  })
})
