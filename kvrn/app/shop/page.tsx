import type { Metadata } from 'next'
import Link from 'next/link'
import { products } from '@/data/products'
import { ProductCard } from '@/components/product/ProductCard'

export const metadata: Metadata = {
  title: 'Collection — KVRN Heavyweight Fleece',
  description:
    'KVRN heavyweight hoodies and sweatpants. 400 GSM+ ring-spun cotton fleece. Structured 3-panel hood. Concealed interior zippers.',
}

export default function ShopPage() {
  return (
    <div className="pt-[60px]">

      {/* Page header */}
      <section className="section-y-sm border-b border-[var(--color-border)]">
        <div className="kvrn-container">
          <div className="flex items-end justify-between">
            <div>
              <p className="kvrn-label mb-4">Collection</p>
              <h1 className="text-[clamp(40px,6vw,72px)] font-light leading-none tracking-[-0.025em]">
                Heavyweight
                <br />
                Fleece
              </h1>
            </div>
            <p className="hidden md:block text-[13px] font-light text-[var(--color-muted)]">
              {products.length} {products.length === 1 ? 'product' : 'products'}
            </p>
          </div>

          {/* Collection description — SEO + brand context */}
          <div className="mt-10 max-w-[640px]">
            <p className="text-[14px] font-light text-[var(--color-muted)] leading-relaxed">
              KVRN heavyweight fleece. 400 GSM+ ring-spun combed cotton, tested per batch.
              Structured 3-panel hood — holds form without a drawstring. Concealed interior
              zipper pockets, both sides. No visible branding beyond a single moulded rubber
              patch. Built to last years.
            </p>
          </div>
        </div>
      </section>

      {/* Product grid */}
      <section className="section-y" aria-label="Products">
        <div className="kvrn-container">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-10">
            {products.map((product, i) => (
              <ProductCard
                key={product.id}
                product={product}
                priority={i === 0}
              />
            ))}
          </div>

          <p className="mt-16 kvrn-label text-[var(--color-subtle)] text-center">
            {products.length} {products.length === 1 ? 'product' : 'products'}
          </p>
        </div>
      </section>

      {/* Bottom brand bar */}
      <section className="border-t border-[var(--color-border)] section-y-sm bg-[var(--color-bg-raised)]">
        <div className="kvrn-container flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <p className="text-[14px] font-light text-[var(--color-muted)] max-w-sm leading-relaxed">
            Every garment ships in 3–5 business days. Free returns within 30 days.
          </p>
          <Link
            href="/support/faq"
            className="text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Sizing & FAQ →
          </Link>
        </div>
      </section>
    </div>
  )
}
