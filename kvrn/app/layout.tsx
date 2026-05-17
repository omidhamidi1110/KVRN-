import type { Metadata, Viewport } from 'next'
import { CartProvider } from '@/context/CartContext'
import { Nav } from '@/components/layout/Nav'
import { Footer } from '@/components/layout/Footer'
import { CartDrawer } from '@/components/cart/CartDrawer'
import './globals.css'

// ─── FONTS ────────────────────────────────────────────────────────────────────
// Using a premium system font stack.
// To upgrade: add Neue Haas Grotesk or similar via next/font/local.
// Self-host fonts in /public/fonts/ — never use Google Fonts CDN in production
// (blocks rendering + privacy concern per V2 Blueprint).
//
// Font CSS variables are defined in globals.css and referenced here.
// The font-family fallback stack achieves the KVRN aesthetic on any device.

// ─── METADATA ────────────────────────────────────────────────────────────────
export const metadata: Metadata = {
  title: {
    default: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
    template: '%s | KVRN',
  },
  description:
    'KVRN heavyweight fleece. 400 GSM+ oversized hoodies and sweatpants. Structured 3-panel hood. Concealed interior zippers. No drawstrings. Quiet luxury.',
  keywords: [
    'heavyweight hoodie',
    '400 gsm hoodie',
    'oversized hoodie',
    'quiet luxury',
    'premium hoodie',
    'heavyweight fleece',
    'structured hood',
    'KVRN',
  ],
  authors: [{ name: 'KVRN' }],
  creator: 'KVRN',
  openGraph: {
    type: 'website',
    locale: 'en_GB',
    url: 'https://kvrn.com',
    siteName: 'KVRN',
    title: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
    description:
      '400 GSM+ heavyweight fleece. Structured 3-panel hood. Concealed interior zippers. No drawstrings.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
    description: '400 GSM+ heavyweight fleece. Quiet luxury.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#FAFAF8',
}

// ─── LAYOUT ──────────────────────────────────────────────────────────────────
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-kvrn-bg text-kvrn-text font-body antialiased">
        {/* Skip link for accessibility */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        <CartProvider>
          <Nav />
          <CartDrawer />
          <main id="main-content">{children}</main>
          <Footer />
        </CartProvider>
      </body>
    </html>
  )
}
