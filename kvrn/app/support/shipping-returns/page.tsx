import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Shipping & Returns — KVRN',
  description: 'KVRN shipping options and returns policy. Free returns on US orders within 30 days.',
}

const zones = [
  { zone: 'USA Standard',    time: '5–7 business days',  cost: '$8',  note: 'Free on orders over $350' },
  { zone: 'USA Express',     time: '2–3 business days',  cost: '$18', note: null },
  { zone: 'Canada',          time: '7–10 business days', cost: '$22', note: 'Import duties may apply' },
  { zone: 'Europe',          time: '7–12 business days', cost: '$28', note: 'Import duties may apply' },
  { zone: 'Rest of World',   time: '10–20 business days','cost': '$35', note: 'Import duties may apply' },
]

export default function ShippingReturnsPage() {
  return (
    <div className="pt-[60px]">
      <div className="kvrn-container section-y max-w-3xl">
        <nav aria-label="Breadcrumb" className="mb-12">
          <ol className="flex items-center gap-2 text-[11px] font-light text-[var(--color-muted)] tracking-wide">
            <li><Link href="/" className="hover:text-[var(--color-text)] transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-[var(--color-text)]" aria-current="page">Shipping & Returns</li>
          </ol>
        </nav>

        <h1 className="text-[clamp(40px,6vw,72px)] font-light leading-none tracking-[-0.025em] mb-16">
          Shipping & Returns
        </h1>

        {/* Shipping */}
        <section className="mb-16" aria-labelledby="shipping-h">
          <h2 id="shipping-h" className="kvrn-label mb-8">Shipping</h2>
          <div className="border-t border-[var(--color-border)]">
            {zones.map(z => (
              <div key={z.zone} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_80px_1fr] gap-2 md:gap-4 py-5 border-b border-[var(--color-border)]">
                <p className="text-[14px] font-light">{z.zone}</p>
                <p className="text-[14px] font-light text-[var(--color-muted)]">{z.time}</p>
                <p className="text-[14px] font-light text-[var(--color-muted)]">{z.cost}</p>
                <p className="text-[12px] font-light text-[var(--color-muted)]">{z.note ?? ''}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 space-y-3 text-[14px] font-light text-[var(--color-muted)] leading-relaxed">
            <p>Orders placed before 1pm EST ship the same day, Monday through Friday. Tracking is included with every order.</p>
            <p>International customers are responsible for any import duties or taxes levied by their local customs authority.</p>
          </div>
        </section>

        <div className="kvrn-rule mb-16" />

        {/* Returns */}
        <section className="mb-16" aria-labelledby="returns-h">
          <h2 id="returns-h" className="kvrn-label mb-8">Returns</h2>
          <p className="text-[16px] font-light mb-10 leading-relaxed max-w-lg">
            We accept returns within 30 days of delivery on unworn, unwashed items with original tags attached.
          </p>

          <div className="space-y-0">
            {[
              {
                n: '01',
                title: 'Initiate your return',
                body:  'Email hello@kvrn.com with your order number and the item(s) you wish to return. We respond within 24 hours.',
              },
              {
                n: '02',
                title: 'Receive your label',
                body:  'For US returns, we send a prepaid return label by email. International returns are at the customer\'s expense unless the item is faulty.',
              },
              {
                n: '03',
                title: 'Drop it off',
                body:  'Pack the item securely and attach the label. Drop off at any carrier location.',
              },
              {
                n: '04',
                title: 'Receive your refund',
                body:  'Once we receive and inspect your return — typically 1–3 business days — your refund is processed to the original payment method within 5–10 business days.',
              },
            ].map(step => (
              <div key={step.n} className="flex gap-8 py-7 border-b border-[var(--color-border)] last:border-0">
                <span className="kvrn-label text-[var(--color-muted)] flex-shrink-0 pt-0.5 w-5">{step.n}</span>
                <div>
                  <p className="text-[14px] font-light mb-2">{step.title}</p>
                  <p className="text-[13px] font-light text-[var(--color-muted)] leading-relaxed">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="kvrn-rule mb-16" />

        {/* Conditions */}
        <section aria-labelledby="conditions-h">
          <h2 id="conditions-h" className="kvrn-label mb-6">Return conditions</h2>
          <ul className="space-y-3 text-[14px] font-light text-[var(--color-muted)] leading-relaxed">
            {[
              'Items must be unworn, unwashed, and in original condition with tags attached.',
              'Items showing signs of wear cannot be accepted.',
              'Original shipping cost is non-refundable.',
              'Faulty items are covered regardless of the return window. Contact us immediately.',
            ].map(c => (
              <li key={c} className="flex items-start gap-3">
                <span className="flex-shrink-0 mt-2 w-1 h-1 rounded-full bg-[var(--color-muted)]" aria-hidden="true"/>
                {c}
              </li>
            ))}
          </ul>
        </section>

        <div className="mt-16 pt-10 border-t border-[var(--color-border)]">
          <p className="text-[14px] font-light text-[var(--color-muted)]">
            Questions? Email{' '}
            <a href="mailto:hello@kvrn.com" className="text-[var(--color-text)] underline underline-offset-2 hover:opacity-70 transition-opacity">
              hello@kvrn.com
            </a>
            . We respond within 24 hours.
          </p>
        </div>
      </div>
    </div>
  )
}
