import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title:       'Shipping & Returns — KVRN',
  description: 'KVRN shipping and returns policy. Store credit returns. Orders ship within 1–3 business days.',
}

export default function ShippingReturnsPage() {
  return (
    <div className="pt-[calc(36px+56px)]">
      <div className="container-kvrn section-padding max-w-3xl">
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li><Link href="/support/faq" className="hover:text-kvrn-text transition-colors">Support</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Shipping & Returns</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[52px] leading-none tracking-tighter mb-16">
          Shipping & Returns
        </h1>

        {/* ── Shipping ── */}
        <section className="mb-16" aria-labelledby="shipping-h">
          <h2 id="shipping-h" className="label-11 mb-6">Shipping</h2>

          <div className="space-y-5 text-[14px] text-kvrn-muted leading-relaxed">
            <p>
              Orders are processed within approximately{' '}
              <strong className="font-light text-kvrn-text">1–3 business days</strong>{' '}
              of payment confirmation. Products are not available for preorder unless explicitly stated.
            </p>
            <p>
              Shipping costs vary based on destination, selected method, and package size.
              Exact costs are calculated at checkout.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              {[
                { label: 'Domestic delivery',      est: '2–7 business days' },
                { label: 'International delivery', est: '5–14+ business days' },
              ].map(row => (
                <div key={row.label} className="border border-kvrn-border p-4">
                  <p className="label-11 mb-1">{row.label}</p>
                  <p className="text-[14px] font-light">{row.est}</p>
                </div>
              ))}
            </div>

            <p className="text-[13px] text-kvrn-subtle">
              Delivery estimates are not guarantees. Factors outside our control —
              including customs processing, carrier delays, and weather — may affect timelines.
            </p>

            <p>
              Every order includes tracking. You will receive a shipping confirmation with
              a tracking link when your order dispatches.
            </p>

            <p>
              Complimentary shipping is available on qualifying orders — see the checkout
              page or our shipping progress bar for current thresholds.
            </p>
          </div>
        </section>

        <div className="rule mb-16" />

        {/* ── Returns ── */}
        <section id="returns" className="mb-16" aria-labelledby="returns-h">
          <h2 id="returns-h" className="label-11 mb-6">Returns</h2>

          <div className="space-y-5 text-[14px] text-kvrn-muted leading-relaxed">
            <p>
              We accept returns for{' '}
              <strong className="font-light text-kvrn-text">store credit</strong>{' '}
              on eligible items within our return window.
            </p>

            <div className="border border-kvrn-border bg-kvrn-bg-raised p-5 text-[13px] space-y-1">
              <p className="text-kvrn-text font-light mb-2">Why store credit?</p>
              <p>
                Store credit allows us to continue investing in product quality rather than
                increasing prices. We believe it&apos;s a fair exchange — and you keep full
                value to spend on any future product.
              </p>
            </div>

            <div className="space-y-3">
              {[
                {
                  step: '01',
                  title: 'Check eligibility',
                  body: 'Items must be unworn, unwashed, in original condition, with tags still attached. Items showing signs of use or washing cannot be accepted.',
                },
                {
                  step: '02',
                  title: 'Initiate your return',
                  body: 'Email returns@kvrn.shop with your order number and the item(s) you wish to return. We will respond within 24 hours with instructions.',
                },
                {
                  step: '03',
                  title: 'Ship back to us',
                  body: 'Pack the items securely and ship them using a tracked service. Customer is responsible for return shipping costs, except in cases of faulty, damaged, or incorrect items.',
                },
                {
                  step: '04',
                  title: 'Receive store credit',
                  body: 'Once we receive and inspect your return, we will issue store credit for the item value. Store credit does not expire.',
                },
              ].map(step => (
                <div key={step.step} className="flex gap-5 pb-5 border-b border-kvrn-border last:border-0 last:pb-0">
                  <span className="label-11 text-kvrn-muted flex-shrink-0 pt-0.5 min-w-[24px]">{step.step}</span>
                  <div>
                    <p className="text-[14px] font-light mb-1">{step.title}</p>
                    <p className="text-[13px] text-kvrn-muted leading-relaxed">{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="rule mb-16" />

        {/* ── Exceptions ── */}
        <section className="mb-16" aria-labelledby="exceptions-h">
          <h2 id="exceptions-h" className="label-11 mb-6">Exceptions</h2>
          <ul className="space-y-3 text-[13px] text-kvrn-muted leading-relaxed">
            {[
              'Faulty, damaged, or incorrectly shipped items: full refund or replacement at our cost, including return shipping.',
              'Final sale items, if designated as such, are not eligible for return.',
              'Items that have been worn, washed, or altered cannot be accepted.',
            ].map(item => (
              <li key={item} className="flex items-start gap-3">
                <span className="flex-shrink-0 mt-2 w-1 h-1 rounded-full bg-kvrn-muted" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <p className="text-[14px] font-light mb-2">Questions?</p>
          <p className="text-[13px] text-kvrn-muted">
            Email{' '}
            <a href="mailto:returns@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
              returns@kvrn.shop
            </a>{' '}
            — we respond within 24 hours.
          </p>
        </section>
      </div>
    </div>
  )
}
