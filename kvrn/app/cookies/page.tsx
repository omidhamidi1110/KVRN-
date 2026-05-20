import type { Metadata } from 'next'
import Link from 'next/link'
import { CookieControls } from './CookieControls'

export const metadata: Metadata = {
  title:  'Cookie Policy — KVRN',
  robots: { index: true, follow: false },
}

export default function CookiesPage() {
  return (
    <div>
      <div className="bg-[#0E0E0E] pt-[calc(36px+56px+40px)] pb-12">
        <div className="container-kvrn max-w-3xl">
  
        </div>
      </div>
      <div className="pt-0">
      <div className="container-kvrn section-padding max-w-2xl">
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Cookie Policy</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[48px] leading-none tracking-tighter mb-3">
          Cookie Policy
        </h1>
        <p className="label-11 text-kvrn-muted mb-14">Last updated: 1 January 2025</p>

        <div className="space-y-10 text-[14px] text-kvrn-muted leading-relaxed">
          <section>
            <p>
              This policy explains what cookies are, what we use them for, and how to control them.
              Under PECR (Privacy and Electronic Communications Regulations), we need your consent
              before placing non-essential cookies on your device.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-4">Essential cookies</h2>
            <p className="mb-4">Required for the site to function. Cannot be opted out of.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" aria-label="Essential cookies">
                <thead>
                  <tr className="border-b border-kvrn-border">
                    <th className="text-left py-2 font-light label-11">Cookie</th>
                    <th className="text-left py-2 font-light label-11">Purpose</th>
                    <th className="text-left py-2 font-light label-11">Expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-kvrn-border">
                  <tr>
                    <td className="py-2.5 font-mono text-[12px] text-kvrn-text">kvrn_cart</td>
                    <td className="py-2.5">Stores your shopping bag contents</td>
                    <td className="py-2.5">30 days</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 font-mono text-[12px] text-kvrn-text">kvrn_cookie_consent</td>
                    <td className="py-2.5">Remembers your cookie preferences</td>
                    <td className="py-2.5">1 year</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-4">Analytics cookies (optional)</h2>
            <p className="mb-4">
              Only set if you accept. Used to understand how visitors use our site.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" aria-label="Analytics cookies">
                <thead>
                  <tr className="border-b border-kvrn-border">
                    <th className="text-left py-2 font-light label-11">Cookie</th>
                    <th className="text-left py-2 font-light label-11">Provider</th>
                    <th className="text-left py-2 font-light label-11">Purpose</th>
                    <th className="text-left py-2 font-light label-11">Expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-kvrn-border">
                  <tr>
                    <td className="py-2.5 font-mono text-[12px] text-kvrn-text">_ga, _ga_*</td>
                    <td className="py-2.5">Google Analytics 4</td>
                    <td className="py-2.5">Distinguishes users and sessions</td>
                    <td className="py-2.5">2 years</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 font-mono text-[12px] text-kvrn-text">_clck, _clsk</td>
                    <td className="py-2.5">Microsoft Clarity</td>
                    <td className="py-2.5">Session recordings</td>
                    <td className="py-2.5">1 year / 1 day</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Advertising cookies</h2>
            <p>We do not use advertising or tracking cookies. KVRN does not run paid advertising.</p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-4">Manage your preferences</h2>
            <CookieControls />
          </section>

          <div className="rule" />

          <section>
            <p>
              For more information, see our{' '}
              <Link href="/privacy" className="text-kvrn-text underline underline-offset-2">Privacy Policy</Link>.
              Questions? Email{' '}
              <a href="mailto:support@kvrn.shop" className="text-kvrn-text underline underline-offset-2">support@kvrn.shop</a>.
            </p>
          </section>
        </div>
      </div>
    </div>
      </div>
  )
}