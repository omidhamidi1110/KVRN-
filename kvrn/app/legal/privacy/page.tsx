import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy — KVRN',
  robots: { index: false, follow: false },
}

const sections = [
  {
    heading: 'What we collect',
    body: `When you place an order, we collect your name, email address, shipping address, and payment information. Payment data is processed and tokenised by Stripe — KVRN never stores raw card numbers. When you join our waitlist, we collect your email address and, if you opt in, your phone number. We also collect standard web analytics data (pages viewed, referral source, device type) via Google Analytics.`,
  },
  {
    heading: 'How we use it',
    body: `Order data is used to process and fulfil your purchase, communicate about your order, and handle returns. Waitlist data is used solely to notify you of new collection releases. Analytics data is used to understand how people use the site so we can improve it. We do not sell your data to third parties. We do not use your data for advertising.`,
  },
  {
    heading: 'Who we share it with',
    body: `Your data is shared with the services necessary to operate the business: Stripe (payments), Shippo (shipping labels), Resend (email), Twilio (SMS, if opted in), Neon (database), and Google Analytics. All providers are bound by data processing agreements. We do not share your data with any other parties.`,
  },
  {
    heading: 'Cookies',
    body: `We use essential cookies required for the site to function (cart state, session management) and analytics cookies (Google Analytics, Microsoft Clarity). Analytics cookies are only set after you give consent via our cookie notice. You can withdraw consent at any time via our Cookie Policy page.`,
  },
  {
    heading: 'Your rights',
    body: `You have the right to access the personal data we hold about you, request correction of inaccurate data, request deletion of your data, and withdraw consent for marketing communications at any time. To exercise any of these rights, email support@kvrn.shop.`,
  },
  {
    heading: 'Retention',
    body: `Order data is retained for 7 years to comply with tax and accounting obligations. Marketing consent records are retained until you withdraw consent. Analytics data is retained for 14 months in Google Analytics.`,
  },
  {
    heading: 'Contact',
    body: `For any privacy-related questions, email support@kvrn.shop. We aim to respond within 5 business days.`,
  },
]

export default function PrivacyPage() {
  return (
    <div className="pt-[60px]">
      <div className="kvrn-container section-y max-w-2xl">
        <nav aria-label="Breadcrumb" className="mb-12">
          <ol className="flex items-center gap-2 text-[11px] font-light text-[var(--color-muted)] tracking-wide">
            <li><Link href="/" className="hover:text-[var(--color-text)] transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-[var(--color-text)]" aria-current="page">Privacy Policy</li>
          </ol>
        </nav>

        <p className="kvrn-label mb-6">Legal</p>
        <h1 className="text-[clamp(36px,5vw,64px)] font-light leading-none tracking-tight mb-4">
          Privacy Policy
        </h1>
        <p className="text-[13px] font-light text-[var(--color-muted)] mb-16">Last updated: May 2025</p>

        <p className="text-[15px] font-light text-[var(--color-muted)] leading-relaxed mb-12 max-w-lg">
          KVRN collects only what is necessary to operate the business.
          We do not sell data. We do not advertise with it.
        </p>

        <div className="space-y-0">
          {sections.map((s, i) => (
            <div key={s.heading} className="py-8 border-b border-[var(--color-border)] last:border-0 grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-6 md:gap-12">
              <p className="text-[13px] font-light">{String(i + 1).padStart(2, '0')}. {s.heading}</p>
              <p className="text-[13px] font-light text-[var(--color-muted)] leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-10 border-t border-[var(--color-border)]">
          <p className="text-[13px] font-light text-[var(--color-muted)]">
            Questions?{' '}
            <a href="mailto:support@kvrn.shop" className="text-[var(--color-text)] underline underline-offset-2 hover:opacity-70 transition-opacity">
              support@kvrn.shop
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
