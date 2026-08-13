import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title:  'Terms of Service — KVRN',
  robots: { index: true, follow: false },
}

const LAST_UPDATED = '12 August 2026'

export default function TermsPage() {
  return (
    <div>
      <PageHero title="Terms" breadcrumb="Terms" />
      <div className="pt-0">
      <div data-nav-theme="light" className="container-kvrn section-padding max-w-2xl">
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Terms of Service</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[48px] leading-none tracking-tighter mb-3">
          Terms of Service
        </h1>
        <p className="label-11 text-kvrn-muted mb-14">Last updated: {LAST_UPDATED}</p>

        <div className="space-y-10 text-[14px] text-kvrn-muted leading-relaxed">

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Who you are contracting with</h2>
            <p>
              These terms govern your use of kvrn.shop and any purchase you make from KVRN,
              operated by Omid Hamidi as a sole proprietor in the United States.
              By using the site or placing an order, you agree to these terms.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Orders and contract formation</h2>
            <p className="mb-3">
              Placing an order is an offer to buy. A contract between you and KVRN is formed
              when we confirm your order by email — not at the point of placing it.
            </p>
            <p>
              We reserve the right to cancel any order before dispatch. If we cancel your order,
              we will refund you in full within 5 business days. We will notify you by email.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Pricing and payment</h2>
            <ul className="space-y-2">
              <li>All prices are displayed in GBP and include UK VAT at 20%.</li>
              <li>International orders may be subject to import duties and taxes payable by you.</li>
              <li>We accept payment via Stripe (card, Apple Pay, Google Pay).</li>
              <li>Payment is taken immediately on order confirmation.</li>
              <li>If a pricing error occurs, we will notify you and give you the option to reorder at the correct price or cancel.</li>
            </ul>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Delivery</h2>
            <p className="mb-3">
              Delivery timescales are estimates and not guaranteed. We are not liable for delays
              caused by customs, weather, carrier issues, or events outside our control.
            </p>
            <p>
              Risk of loss passes to you when the carrier accepts the parcel. If your order
              is lost in transit, contact us and we will investigate with the carrier.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Returns and consumer rights</h2>
            <p className="mb-3">
              You have the right to cancel your order within 14 days of delivery under the
              Consumer Contracts Regulations 2013. Our 30-day returns window exceeds this
              statutory minimum.
            </p>
            <p>
              Faulty or incorrectly shipped goods are covered regardless of our returns window. Contact us at{' '}
              <a href="mailto:support@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
                support@kvrn.shop
              </a>{' '}
              for all warranty and fault claims.
            </p>
            <p className="mt-3">
              See our full{' '}
              <Link href="/support/shipping-returns" className="text-kvrn-text underline underline-offset-2">
                Shipping & Returns policy
              </Link>
              .
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Intellectual property</h2>
            <p>
              All content on this site — including text, photography, design, and brand elements
              — is owned by or licensed to KVRN. You may not reproduce, distribute, or use any
              content without our prior written permission.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Limitation of liability</h2>
            <p>
              To the maximum extent permitted by law, KVRN&apos;s liability for any claim arising
              from your use of this site or any purchase is limited to the value of the goods
              you purchased. We are not liable for indirect, consequential, or economic losses.
            </p>
            <p className="mt-3">
              Nothing in these terms affects your statutory rights as a consumer.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Governing law</h2>
            <p>
              These terms are governed by the laws of England and Wales. Any disputes will be
              subject to the exclusive jurisdiction of the courts of England and Wales.
            </p>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">SMS marketing program</h2>
            <div className="space-y-3">
              <p>
                By affirmatively opting in to the KVRN SMS program, you agree
                to receive recurring automated marketing text messages about
                KVRN product launches, drops, restocks, early access, and
                promotional offers at the mobile number you provide.
              </p>
              <p>
                Message frequency varies. Msg &amp; data rates may apply.
                Consent to receive marketing text messages is not a condition
                of purchasing goods or services from KVRN.
              </p>
              <p>
                Reply STOP at any time to cancel. Reply HELP for help or contact{' '}
                <a href="mailto:support@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
                  support@kvrn.shop
                </a>.
              </p>
              <p>
                Mobile carriers are not responsible for delayed or undelivered
                messages. See our{' '}
                <Link href="/privacy" className="text-kvrn-text underline underline-offset-2">
                  Privacy Policy
                </Link>{' '}
                for information about how we handle mobile information.
              </p>
            </div>
          </section>

          <div className="rule" />

          <section>
            <h2 className="text-[15px] font-light text-kvrn-text mb-3">Contact</h2>
            <p>
              For any queries relating to these terms, contact us at{' '}
              <a href="mailto:support@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
                support@kvrn.shop
              </a>.
            </p>
          </section>

        </div>
      </div>
    </div>
      </div>
  )
}