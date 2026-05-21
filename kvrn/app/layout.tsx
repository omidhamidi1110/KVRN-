import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { CartProvider }     from '@/context/CartContext'
import { CookiePrefsProvider } from '@/context/CookiePrefsContext'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { HeaderProvider }   from '@/context/HeaderContext'
import { WishlistProvider } from '@/context/WishlistContext'
import { I18nProvider }     from '@/context/I18nContext'
import { WishlistDrawer }   from '@/components/ui/WishlistDrawer'
import { ToastProvider }    from '@/components/ui/Toast'
import { CookieBanner }     from '@/components/ui/CookieConsent'
import { AnnouncementBar }  from '@/components/ui/AnnouncementBar'
import { Nav }              from '@/components/layout/Nav'
import { ConditionalFooter } from '@/components/layout/ConditionalFooter'
import { CartDrawer }       from '@/components/cart/CartDrawer'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default:  'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
    template: '%s | KVRN',
  },
  description:
    'KVRN heavyweight fleece. 400 GSM+ oversized hoodies and sweatpants. Double-layered hood. Concealed interior zippers. No drawstrings. Quiet luxury.',
  keywords: [
    'heavyweight hoodie', '400 gsm hoodie', '500 gsm hoodie',
    'oversized hoodie', 'quiet luxury', 'premium sweatpants',
    'french terry hoodie', 'cropped hoodie', 'luxury streetwear', 'KVRN',
  ],
  authors:     [{ name: 'KVRN' }],
  creator:     'KVRN',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kvrn.com'),
  openGraph: {
    type: 'website', locale: 'en_US', url: 'https://kvrn.com', siteName: 'KVRN',
    title: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
    description: 'Double-layered hood. Concealed zipper pockets. No drawstrings. 400–500 GSM fleece.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'KVRN — Heavyweight Oversized Fleece',
    description: '400–500 GSM. Quiet luxury.',
  },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true } },
  icons:  { icon: '/favicon.ico', apple: '/apple-touch-icon.png' },
  manifest: '/site.webmanifest',
}

export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, themeColor: '#0E0E0E',
}

const orgSchema = {
  '@context': 'https://schema.org',
  '@type':    'ClothingStore',
  name:       'KVRN',
  url:        'https://kvrn.com',
  description:'Premium heavyweight fleece. Oversized hoodies and sweatpants built for daily wear.',
  email:      'support@kvrn.shop',
  sameAs: ['https://instagram.com/thekvrn', 'https://tiktok.com/@thekvrn'],
  contactPoint: {
    '@type':        'ContactPoint',
    contactType:    'customer support',
    email:          'support@kvrn.shop',
    availableLanguage: 'English',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const gaId      = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
  const clarityId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID

  return (
    <html lang="en">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgSchema) }}
        />
        {/* GA4 Consent Mode — deny by default until user accepts cookie banner */}
        <script dangerouslySetInnerHTML={{ __html: `
          window.dataLayer=window.dataLayer||[];
          function gtag(){dataLayer.push(arguments);}
          gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',functionality_storage:'granted',wait_for_update:500});
        `}} />
      </head>
      <body className="bg-kvrn-bg text-kvrn-text font-body antialiased">
        <a href="#main-content" className="skip-link">Skip to main content</a>

        <CookiePrefsProvider>
        <I18nProvider>
        <HeaderProvider>
          <CurrencyProvider>
            <WishlistProvider>
              <CartProvider>
              <ToastProvider>
                <AnnouncementBar />
                <Nav />
                <CartDrawer />
                <WishlistDrawer />
                <main id="main-content">{children}</main>{/* Footer handled per page */}
                <CookieBanner />
              </ToastProvider>
            </CartProvider>
            </WishlistProvider>
          </CurrencyProvider>
        </HeaderProvider>
        </I18nProvider>
        </CookiePrefsProvider>

        {gaId && (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
            <Script id="ga4-init" strategy="afterInteractive">{`
              window.dataLayer=window.dataLayer||[];
              function gtag(){dataLayer.push(arguments);}
              gtag('js',new Date());
              gtag('config','${gaId}',{page_path:window.location.pathname});
            `}</Script>
          </>
        )}

        {clarityId && (
          <Script id="clarity-init" strategy="afterInteractive">{`
            setTimeout(function(){
              (function(c,l,a,r,i,t,y){
                c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
                t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
                y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
              })(window,document,"clarity","script","${clarityId}");
            },3000);
          `}</Script>
        )}
      </body>
    </html>
  )
}
