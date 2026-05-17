import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Shipping & Returns — KVRN',
  description:
    'KVRN shipping and returns policy. Free returns within 30 days. Ships in 3–5 business days.',
}

const shippingOptions = [
  { zone: 'UK Standard',    time: '3–5 business days',  cost: '£4.99',  note: 'Free on orders over £250' },
  { zone: 'UK Express',     time: '1–2 business days',  cost: '£9.99',  note: null },
  { zone: 'Europe',         time: '5–10 business days', cost: '£14.99', note: 'Import duties may apply' },
  { zone: 'USA / Canada',   time: '7–14 business days', cost: '£19.99', note: 'Import duties may apply' },
  { zone: 'Rest of World',  time: '10–21 business days', cost: '£24.99', note: 'Import duties may apply' },
]

export default function ShippingReturnsPage() {
  return (
    <div className="pt-[56px]">
      <div className="container-kvrn section-padding max-w-3xl">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li><Link href="/support/faq" className="hover:text-kvrn-text transition-colors">Support</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Shipping & Returns</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[56px] leading-none tracking-tighter mb-16">
          Shipping & Returns
        </h1>

        {/* ─── Shipping ─── */}
        <section className="mb-16" aria-labelledby="shipping-heading">
          <h2 id="shipping-heading" className="label-11 mb-6">Shipping</h2>

          <div className="space-y-px border-t border-kvrn-border" role="table" aria-label="Shipping options">
            <div className="hidden md:grid grid-cols-4 gap-4 py-3 text-[11px] text-kvrn-muted tracking-widest uppercase border-b border-kvrn-border" role="row">
              <span role="columnheader">Zone</span>
              <span role="columnheader">Delivery time</span>
              <span role="columnheader">Cost</span>
              <span role="columnheader">Notes</span>
            </div>
            {shippingOptions.map((opt) => (
              <div
                key={opt.zone}
                className="grid grid-cols-1 md:grid-cols-4 gap-1 md:gap-4 py-4 border-b border-kvrn-border last:border-0 text-[14px]"
                role="row"
              >
                <span className="font-light" role="cell">{opt.zone}</span>
                <span className="text-kvrn-muted" role="cell">{opt.time}</span>
                <span className="text-kvrn-muted" role="cell">{opt.cost}</span>
                <span className="text-kvrn-muted text-[12px]" role="cell">{opt.note}</span>
              </div>
            ))}
          </div>

          <div className="mt-6 space-y-3 text-[14px] text-kvrn-muted leading-relaxed">
            <p>Orders placed before 1pm GMT ship the same day (Monday–Friday, excluding bank holidays).</p>
            <p>Every order ships with full tracking. You will receive a confirmation email with your tracking number once your order has been dispatched.</p>
            <p>
              <strong className="text-kvrn-text font-light">International orders:</strong> Import
              duties and taxes are the responsibility of the recipient. These are set by the
              destination country&apos;s customs authority and are not controlled by KVRN.
            </p>
          </div>
        </section>

        <div className="rule mb-16" />

        {/* ─── Returns ─── */}
        <section className="mb-16" aria-labelledby="returns-heading">
          <h2 id="returns-heading" className="label-11 mb-6">Returns</h2>

          <div className="space-y-6 text-[15px] font-light">
            <p>
              We accept returns within <strong className="font-light underline underline-offset-4">30 days</strong> of
              delivery on unworn, unwashed items with original tags attached.
            </p>
          </div>

          <div className="mt-8 space-y-6">
            {[
              {
                step: '01',
                title: 'Initiate your return',
                body: 'Email hello@kvrn.com with your order number and the item(s) you wish to return. We\'ll respond within 24 hours with your return authorisation.',
              },
              {
                step: '02',
                title: 'Receive your prepaid label',
                body: 'For UK returns, we\'ll email you a prepaid Royal Mail return label. International returns are at the customer\'s expense unless the item is faulty.',
              },
              {
                step: '03',
                title: 'Drop off your return',
                body: 'Pack the items securely in the original packaging if possible. Attach the label and drop off at any Post Office.',
              },
              {
                step: '04',
                title: 'Receive your refund',
                body: 'Once we receive and inspect your return (typically 1–3 business days), your refund will be processed to your original payment method within 5–10 business days.',
              },
            ].map((step) => (
              <div key={step.step} className="flex gap-6 pb-6 border-b border-kvrn-border last:border-0 last:pb-0">
                <span className="label-11 text-kvrn-muted flex-shrink-0 pt-1 min-w-[24px]">{step.step}</span>
                <div>
                  <p className="text-[14px] font-light mb-2">{step.title}</p>
                  <p className="text-[14px] text-kvrn-muted leading-relaxed">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="rule mb-16" />

        {/* ─── Conditions ─── */}
        <section className="mb-16" aria-labelledby="conditions-heading">
          <h2 id="conditions-heading" className="label-11 mb-6">Return conditions</h2>
          <ul className="space-y-3 text-[14px] text-kvrn-muted leading-relaxed">
            {[
              'Items must be unworn, unwashed, and in original condition with tags attached.',
              'Items showing signs of wear, washing, or use cannot be accepted.',
              'The original shipping cost is non-refundable.',
              'Items marked as final sale are not eligible for return.',
              'Faulty items are covered under UK consumer rights regardless of the return window.',
            ].map((cond) => (
              <li key={cond} className="flex items-start gap-3">
                <span className="flex-shrink-0 mt-1.5 w-1 h-1 rounded-full bg-kvrn-muted" aria-hidden="true" />
                {cond}
              </li>
            ))}
          </ul>
        </section>

        {/* ─── CTA ─── */}
        <section>
          <p className="text-[15px] font-light mb-2">Questions about your order?</p>
          <p className="text-[14px] text-kvrn-muted mb-4">
            Contact us at{' '}
            <a href="mailto:hello@kvrn.com" className="text-kvrn-text underline underline-offset-2 hover:opacity-70 transition-opacity">
              hello@kvrn.com
            </a>{' '}
            and we&apos;ll respond within 24 hours.
          </p>
          <Link
            href="/contact"
            className="text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150 underline underline-offset-2"
          >
            Contact form →
          </Link>
        </section>
      </div>
    </div>
  )
}
