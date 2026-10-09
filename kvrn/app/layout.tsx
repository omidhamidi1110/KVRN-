import type { Metadata, Viewport } from 'next'
import { CartProvider }     from '@/context/CartContext'
import { CookiePrefsProvider } from '@/context/CookiePrefsContext'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { HeaderProvider }   from '@/context/HeaderContext'
import { WishlistProvider } from '@/context/WishlistContext'
import { I18nProvider }     from '@/context/I18nContext'
import { StorefrontSeedProvider } from '@/context/StorefrontSeed'
import { WishlistDrawer }   from '@/components/ui/WishlistDrawer'
import { ToastProvider }    from '@/components/ui/Toast'
import { CookieBanner }     from '@/components/ui/CookieConsent'
import { FunnelTracker }    from '@/components/analytics/FunnelTracker'
import { GaTracker }        from '@/components/analytics/GaTracker'
import { AnnouncementBar }  from '@/components/ui/AnnouncementBar'
import { Nav }              from '@/components/layout/Nav'
import { ConditionalFooter } from '@/components/layout/ConditionalFooter'
import { ConditionalSmsPopup } from '@/components/sms/ConditionalSmsPopup'
import { CartDrawer }       from '@/components/cart/CartDrawer'
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { siteMetadata, orgSchema, jsonLd } from '@/lib/content-seo'
import { DEFAULT_GLOBAL_SEO } from '@/lib/content-defaults'
import { sql } from '@/lib/db'
import { getStorefrontI18n } from '@/lib/i18n/server'
import { PreferenceRefresher } from '@/components/i18n/PreferenceRefresher'
import { MESSAGES } from '@/lib/i18n/messages'
import type { CurrencyCode } from '@/lib/currency'
import './globals.css'
import './i18n-rtl.css'

// Site metadata comes from the global SEO defaults (Admin > Content > SEO) when the
// CMS_PUBLIC_CONTENT flag is on; with it off (the default) it is exactly the previous hardcoded
// metadata (DEFAULT_GLOBAL_SEO is that object). Rendered per request so a flag/content change
// needs no rebuild.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return siteMetadata(cmsContentEnabled() ? await contentPublic().getGlobalSeo() : DEFAULT_GLOBAL_SEO)
}

export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, themeColor: '#000000',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cms    = cmsContentEnabled()
  const seo    = cms ? await contentPublic().getGlobalSeo() : DEFAULT_GLOBAL_SEO
  // Navigation / footer / announcement from Admin (each part falls back to the coded content).
  const shell  = cms ? await contentPublic().getShell() : null
  // The visitor's language + currency, from first-party cookies read on the server: the first HTML
  // already has the right <html lang dir>, text and prices (no English flash, no price flash).
  // Falls back to English / USD if the settings cannot be read quickly.
  const i18n   = await getStorefrontI18n(sql)

  // GA is loaded by <GaTracker /> ONLY after effective analytics consent — nothing Google-related is
  // in the initial HTML. The measurement id is deliberately NOT read here: layout code is inlined at
  // BUILD time, and the id is a RUNTIME Cloudflare variable (see /api/analytics/config).

  return (
    <html lang={i18n.locale} dir={i18n.dir === 'rtl' ? 'rtl' : undefined}>
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLd(orgSchema(seo)) }}
        />
      </head>
      <body className="w-full min-w-0 bg-kvrn-bg text-kvrn-text font-body antialiased">
        <a href="#main-content" className="skip-link">{MESSAGES[i18n.locale]['nav.skipToContent']}</a>

        <StorefrontSeedProvider seed={{
          locale: i18n.locale, hasLocaleCookie: i18n.hasLocaleCookie, config: i18n.config, served: i18n.served,
          displayable: ['USD', ...(Object.keys(i18n.rates) as CurrencyCode[])],
          currency: i18n.currency, hasCurrencyCookie: i18n.hasCurrencyCookie, rates: i18n.rates, rateAsOf: i18n.rateAsOf, payable: i18n.payable,
        }}>
        <CookiePrefsProvider>
        <I18nProvider>
        <HeaderProvider>
          <CurrencyProvider>
            <WishlistProvider>
              <CartProvider>
              <ToastProvider>
                <AnnouncementBar shell={shell} />
                <Nav shell={shell} />
                <CartDrawer />
        <ConditionalSmsPopup />
                <WishlistDrawer />
                <main id="main-content" className="w-full min-w-0">{children}</main>
                <ConditionalFooter shell={shell} />
                <CookieBanner />
                <FunnelTracker />
                <GaTracker />
                <PreferenceRefresher />
              </ToastProvider>
            </CartProvider>
            </WishlistProvider>
          </CurrencyProvider>
        </HeaderProvider>
        </I18nProvider>
        </CookiePrefsProvider>
        </StorefrontSeedProvider>

        {/* Microsoft Clarity is disabled: it must never initialize before effective analytics consent.
            Re-enable only with a tested consent/revocation lifecycle. GA4 remains consent-gated. */}
      </body>
    </html>
  )
}
