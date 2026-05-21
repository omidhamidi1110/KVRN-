import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms of Service — KVRN',
  robots: { index: false, follow: false },
}

const sections = [
  {
    heading: 'Use of the site',
    body: 'By accessing kvrn.com, you agree to use it for lawful purposes only. You may not attempt to gain unauthorised access to any part of the site or its backend systems. Automated scraping or data collection without permission is prohibited.',
  },
  {
    heading: 'Orders and payment',
    body: 'A contract is formed when your payment is confirmed, not when you place an order. We reserve the right to cancel orders in cases of pricing errors, stock discrepancies, or suspected fraud. Payment is processed by Stripe. KVRN never stores your card details.',
  },
  {
    heading: 'Pricing',
    body: 'All prices are displayed in USD and include applicable taxes where required by law. Prices are subject to change without notice. The price displayed at the time of purchase is the price you pay.',
  },
  {
    heading: 'Shipping and delivery',
    body: 'Estimated delivery dates are not guaranteed. KVRN is not responsible for delays caused by carriers or customs authorities. Risk of loss transfers to you upon delivery to the carrier.',
  },
  {
    heading: 'Returns',
    body: 'Our returns policy is detailed on the Shipping & Returns page. You retain statutory consumer rights regardless of our policy. Faulty items will be remedied by replacement or full refund.',
  },
  {
    heading: 'Intellectual property',
    body: 'All content on kvrn.com — including copy, photography, brand assets, and design — is the property of KVRN and protected by copyright law. You may not reproduce, distribute, or create derivative works without written permission.',
  },
  {
    heading: 'Limitation of liability',
    body: 'To the maximum extent permitted by law, KVRN\'s liability for any claim arising from your use of the site or purchase of products is limited to the amount paid for the order in question. We are not liable for indirect, incidental, or consequential damages.',
  },
  {
    heading: 'Governing law',
    body: 'These terms are governed by the laws of the State of Delaware, USA. Any disputes shall be resolved in the courts of Delaware.',
  },
]

export default function TermsPage() {
  return (
    <div className="pt-[60px]">
      <div className="kvrn-container section-y max-w-2xl">
        <nav aria-label="Breadcrumb" className="mb-12">
          <ol className="flex items-center gap-2 text-[11px] font-light text-[var(--color-muted)] tracking-wide">
            <li><Link href="/" className="hover:text-[var(--color-text)] transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-[var(--color-text)]" aria-current="page">Terms of Service</li>
          </ol>
        </nav>

        <p className="kvrn-label mb-6">Legal</p>
        <h1 className="text-[clamp(36px,5vw,64px)] font-light leading-none tracking-tight mb-4">
          Terms of Service
        </h1>
        <p className="text-[13px] font-light text-[var(--color-muted)] mb-16">Last updated: May 2025</p>

        <div className="space-y-0">
          {sections.map((s, i) => (
            <div key={s.heading} className="py-8 border-b border-[var(--color-border)] last:border-0 grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-6 md:gap-12">
              <p className="text-[13px] font-light">{String(i + 1).padStart(2, '0')}. {s.heading}</p>
              <p className="text-[13px] font-light text-[var(--color-muted)] leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
