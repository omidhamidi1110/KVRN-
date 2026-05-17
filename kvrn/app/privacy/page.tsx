import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title:       'Privacy Policy — KVRN',
  description: 'How KVRN collects, uses, and protects your personal data.',
  robots:      { index: true, follow: false },
}

const LAST_UPDATED = '1 January 2025'

export default function PrivacyPage() {
  return (
    <div className="pt-[56px]">
      <div className="container-kvrn section-padding max-w-2xl">
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Privacy Policy</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[48px] leading-none tracking-tighter mb-3">
          Privacy Policy
        </h1>
        <p className="label-11 text-kvrn-muted mb-14">Last updated: {LAST_UPDATED}</p>

        <div className="space-y-10 text-[14px] text-kvrn-muted leading-relaxed">

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Who we are</h2>
            <p>
              KVRN is operated by [KVRN Ltd], a company registered in England and Wales
              (Company No. [XXXXXXXX]). Our registered address is [address].
              We are the data controller for the personal information we collect about you.
            </p>
            <p className="mt-3">
              For questions about this policy, contact us at{' '}
              <a href="mailto:hello@kvrn.com" className="text-kvrn-text underline underline-offset-2">
                hello@kvrn.com
              </a>.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">What data we collect and why</h2>
            <div className="space-y-4">
              {[
                {
                  what:  'Name, email address, shipping address',
                  why:   'To process and fulfil your order.',
                  basis: 'Contract — processing is necessary to deliver what you ordered.',
                },
                {
                  what:  'Payment details (card number, CVV)',
                  why:   'To take payment.',
                  basis: 'Contract — processed and tokenised by Stripe. We never see or store your card number.',
                },
                {
                  what:  'Phone number (optional)',
                  why:   'To send shipping notifications or drop alerts by SMS, if you opt in.',
                  basis: 'Consent — you can opt out at any time by replying STOP.',
                },
                {
                  what:  'Email address (waitlist)',
                  why:   'To notify you when new drops go live.',
                  basis: 'Consent — you can unsubscribe at any time via any email we send.',
                },
                {
                  what:  'IP address, device type, browser, pages visited',
                  why:   'To understand how our site is used (via Google Analytics 4 and Microsoft Clarity).',
                  basis: 'Consent — only collected if you accept analytics cookies.',
                },
                {
                  what:  'IP address (fraud signals)',
                  why:   'To detect and prevent fraudulent orders.',
                  basis: 'Legitimate interest — protecting our business and genuine customers.',
                },
              ].map((row) => (
                <div key={row.what} className="border-l-2 border-kvrn-border pl-4 space-y-1">
                  <p className="text-[13px] font-light text-kvrn-text">{row.what}</p>
                  <p>{row.why}</p>
                  <p className="text-[12px] text-kvrn-subtle">{row.basis}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Who we share data with</h2>
            <p className="mb-4">We never sell your personal data. We share it only with the services required to operate:</p>
            <ul className="space-y-2">
              {[
                ['Stripe',             'Payment processing (PCI DSS Level 1 certified)'],
                ['Shipping partner',   'Shipping label generation and order tracking'],
                ['Email service',      'Transactional email delivery'],
                ['SMS service',        'SMS notifications (opt-in only)'],
                ['Neon',               'Database hosting (encrypted at rest)'],
                ['Cloudflare',         'Hosting, CDN, and security'],
                ['Google Analytics 4', 'Anonymous website analytics (consent-gated)'],
                ['Microsoft Clarity',  'Session recordings (consent-gated)'],
              ].map(([provider, purpose]) => (
                <li key={provider} className="flex gap-3">
                  <span className="flex-shrink-0 font-light text-kvrn-text min-w-[160px]">{provider}</span>
                  <span>{purpose}</span>
                </li>
              ))}
            </ul>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">How long we keep data</h2>
            <ul className="space-y-2">
              <li>Order data: 7 years (required by HMRC for tax purposes)</li>
              <li>Marketing preferences (email/SMS consent): Until you withdraw consent</li>
              <li>Analytics data: 14 months (Google Analytics default)</li>
              <li>Session recordings: 30 days (Microsoft Clarity default)</li>
            </ul>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Your rights</h2>
            <p className="mb-4">Under UK GDPR, you have the right to:</p>
            <ul className="space-y-2">
              {[
                'Access the personal data we hold about you',
                'Correct inaccurate data',
                'Request erasure of your data (subject to legal retention obligations)',
                'Restrict or object to how we process your data',
                'Data portability — receive your data in a structured format',
                'Withdraw consent at any time (for consent-based processing)',
              ].map((right) => (
                <li key={right} className="flex items-start gap-3">
                  <span className="flex-shrink-0 mt-2 w-1 h-1 rounded-full bg-kvrn-muted" aria-hidden="true" />
                  {right}
                </li>
              ))}
            </ul>
            <p className="mt-4">
              To exercise any of these rights, email{' '}
              <a href="mailto:hello@kvrn.com" className="text-kvrn-text underline underline-offset-2">
                hello@kvrn.com
              </a>.
              We will respond within 30 days. If you are unhappy with our response, you may
              contact the ICO:{' '}
              <a href="https://ico.org.uk" target="_blank" rel="noopener noreferrer" className="text-kvrn-text underline underline-offset-2">
                ico.org.uk
              </a>.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Cookies</h2>
            <p>
              We use essential cookies (required for the site to function) and optional analytics
              cookies (only with your consent). See our{' '}
              <Link href="/cookies" className="text-kvrn-text underline underline-offset-2">
                Cookie Policy
              </Link>{' '}
              for full details.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Changes to this policy</h2>
            <p>
              We may update this policy. We will notify customers of material changes by email.
              The &ldquo;Last updated&rdquo; date at the top of this page reflects the most recent revision.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
