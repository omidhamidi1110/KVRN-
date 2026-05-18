import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Shipping & Returns — KVRN',
  description: 'KVRN shipping and returns policy. Store credit returns. Orders ship within 1–3 business days.',
}

export default function ShippingReturnsPage() {
  return (
    <div className="pt-[calc(36px+56px)]">
      <div className="container-kvrn section-padding max-w-3xl">
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-[#9B9B9B]">
            <li><Link href="/" className="hover:text-[#1A1A1A] transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-[#1A1A1A]" aria-current="page">Shipping & Returns</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[52px] leading-none tracking-[-0.03em] mb-14">
          Shipping & Returns
        </h1>

        {/* Shipping */}
        <section className="mb-14" aria-labelledby="shipping-h">
          <h2 id="shipping-h" className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-6">Shipping</h2>
          <div className="space-y-4 text-[14px] text-[#6B6B6B] leading-relaxed">
            <p>
              Orders are processed within approximately <strong className="font-light text-[#1A1A1A]">1–3 business days</strong> of payment confirmation.
              Products are not available for preorder unless explicitly stated on the product page.
            </p>
            <p>
              Shipping costs depend on your destination and the shipping method selected at checkout.
              Actual costs are calculated at checkout before payment.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4">
              {[
                { label: 'Domestic',      est: '2–7 business days (approx.)' },
                { label: 'International', est: '5–14+ business days (approx.)' },
              ].map(row => (
                <div key={row.label} className="border border-[#E8E5E0] p-4">
                  <p className="text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B] mb-1">{row.label}</p>
                  <p className="text-[14px] font-light text-[#1A1A1A]">{row.est}</p>
                </div>
              ))}
            </div>
            <p className="text-[13px] text-[#9B9B9B]">
              Delivery estimates are not guarantees. Carrier delays and customs processing can affect timelines.
            </p>
            <p>All orders include tracking. You will receive a shipping confirmation with tracking information when your order dispatches.</p>
          </div>
        </section>

        <div className="h-px bg-[#E8E5E0] mb-14" />

        {/* Returns */}
        <section id="returns" className="mb-14" aria-labelledby="returns-h">
          <h2 id="returns-h" className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-6">Returns</h2>
          <div className="space-y-4 text-[14px] text-[#6B6B6B] leading-relaxed">
            <p>
              We accept returns for <strong className="font-light text-[#1A1A1A]">store credit</strong> on eligible items within our return window.
            </p>
            <div className="border border-[#E8E5E0] bg-[#F3F0EB] p-5 text-[13px]">
              <p className="text-[#1A1A1A] font-light mb-1">Why store credit?</p>
              <p className="text-[#6B6B6B]">
                Store credit allows us to continue investing in product quality. You retain full value to use on any future order.
              </p>
            </div>

            <p className="font-light text-[#1A1A1A]">To be eligible for return, items must be:</p>
            <ul className="space-y-1.5 text-[13px]">
              {[
                'Unworn and unwashed',
                'In original condition with tags attached',
                'Returned within our return window (shown in your order confirmation)',
              ].map(item => (
                <li key={item} className="flex items-start gap-2.5">
                  <span className="mt-2 w-1 h-1 rounded-full bg-[#9B9B9B] flex-shrink-0" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>

            <p>Customer is responsible for return shipping costs unless the item arrives damaged, faulty, or incorrect.</p>
            <p>Final sale items are not eligible for return.</p>

            <p>
              To initiate a return, email <a href="mailto:returns@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">returns@kvrn.shop</a> with your order number.
            </p>
          </div>
        </section>

        <section>
          <p className="text-[14px] font-light mb-1">Questions?</p>
          <p className="text-[13px] text-[#6B6B6B]">
            Email <a href="mailto:support@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">support@kvrn.shop</a> — we respond within 1–2 business days.
          </p>
        </section>
      </div>
    </div>
  )
}
