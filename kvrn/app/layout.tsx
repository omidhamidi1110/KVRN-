import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { CartProvider } from '@/context/CartContext'
import { ToastProvider } from '@/components/ui/Toast'
import { CookieBanner } from '@/components/ui/CookieBanner'
import { Nav } from '@/components/layout/Nav'
import { Footer } from '@/components/layout/Footer'
import { CartDrawer } from '@/components/cart/CartDrawer'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
    template: '%s | KVRN',
  },
  description:
    'KVRN heavyweight fleece. 400 GSM+ oversized hoodies and sweatpants. Structured 3-panel hood. Concealed interior zippers. No drawstrings. Quiet luxury.',
  keywords: ['heavyweight hoodie', '400 gsm hoodie', 'oversized hoodie', 'quiet luxury', 'premium hoodie', 'heavyweight fleece', 'structured hood', 'KVRN'],
  authors:  [{ name: 'KVRN' }],
  creator:  'KVRN',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kvrn.com'),
  openGraph: {
    type: 'website', locale: 'en_GB', url: 'https://kvrn.com', siteName: 'KVRN',
    title: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
    description: '400 GSM+ heavyweight fleece. Structured 3-panel hood. Concealed interior zippers.',
  },
  twitter: { card: 'summary_large_image', title: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants', description: '400 GSM+ heavyweight fleece. Quiet luxury.' },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true } },
  icons: { icon: '/favicon.ico', apple: '/apple-touch-icon.png' },
  manifest: '/site.webmanifest',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#FAFAF8',
}

const orgSchema = {
  '@context': 'https://schema.org',
  '@type': 'ClothingStore',
  name: 'KVRN',
  url: 'https://kvrn.com',
  description: 'Quiet luxury meets premium utility. Heavyweight oversized hoodies and sweatpants.',
  sameAs: ['https://instagram.com/kvrn', 'https://tiktok.com/@kvrn'],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const gaId      = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
  const clarityId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID

  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgSchema) }}
        />
      </head>
      <body className="bg-kvrn-bg text-kvrn-text font-body antialiased">
        <a href="#main-content" className="skip-link">Skip to main content</a>

        {/* GA4 Consent Mode defaults — must run before gtag loads */}
        <script dangerouslySetInnerHTML={{ __html: `
          window.dataLayer=window.dataLayer||[];
          function gtag(){dataLayer.push(arguments);}
          gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',functionality_storage:'granted',wait_for_update:500});
        `}} />

        <CartProvider>
          <ToastProvider>
            <Nav />
            <CartDrawer />
            <main id="main-content">{children}</main>
            <CookieBanner />
            <Footer />
          </ToastProvider>
        </CartProvider>

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
