import type { Metadata } from 'next'
import { products } from '@/data/products'
import { ProductCard } from '@/components/product/ProductCard'

export const metadata: Metadata = {
  title: 'Shop — KVRN Heavyweight Fleece',
  description:
    'Shop KVRN heavyweight hoodies and sweatpants. 400 GSM+ oversized fleece with structured 3-panel hood and concealed interior zippers.',
}

export default function ShopPage() {
  return (
    <div className="pt-[56px]">
      {/* Header */}
      <section className="container-kvrn py-12 md:py-16">
        <p className="label-11 mb-3">Drop 001</p>
        <h1 className="font-display font-light text-[40px] md:text-[56px] leading-none tracking-tighter">
          Shop
        </h1>
        <p className="text-[15px] text-kvrn-muted mt-4 max-w-[480px] leading-relaxed">
          400 GSM+ heavyweight fleece. Built for daily wear.
        </p>
      </section>

      {/* Collection description — SEO */}
      <section className="container-kvrn pb-0">
        <div className="border-t border-kvrn-border pt-6 mb-8">
          <details className="group">
            <summary className="list-none cursor-pointer flex items-center justify-between text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors">
              <span>About this collection</span>
              <span className="transition-transform group-open:rotate-180 duration-200">↓</span>
            </summary>
            <p className="mt-4 text-[14px] text-kvrn-muted leading-relaxed max-w-[640px]">
              KVRN hoodies and sweatpants are built from 400 GSM+ heavyweight fleece —
              dense enough to feel structural, considered enough to be worn without
              thinking. The structured 3-panel hood holds its form without a drawstring.
              Concealed YKK zippers run parallel to both kangaroo pocket openings,
              invisible from outside. A single rubber patch marks the hood. Nothing else.
            </p>
          </details>
        </div>
      </section>

      {/* Product grid */}
      <section className="container-kvrn pb-24 md:pb-32">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-10">
          {products.map((product, i) => (
            <ProductCard
              key={product.id}
              product={product}
              priority={i === 0}
            />
          ))}
        </div>

        {/* End of collection — no "load more" for 2 products */}
        {products.length > 0 && (
          <p className="text-center label-11 mt-16 text-kvrn-subtle">
            {products.length} {products.length === 1 ? 'product' : 'products'}
          </p>
        )}
      </section>
    </div>
  )
}
