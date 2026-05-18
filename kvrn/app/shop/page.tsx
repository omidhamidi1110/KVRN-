import type { Metadata } from 'next'
import { products, getProductsByType } from '@/data/products'
import { ProductCard }   from '@/components/product/ProductCard'

interface PageProps {
  searchParams: Promise<{ type?: string }>
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { type } = await searchParams
  const isHoodies    = type === 'hoodies'
  const isSweatpants = type === 'sweatpants'

  if (isHoodies)    return { title: 'Hoodies — KVRN Heavyweight Fleece', description: 'Shop KVRN heavyweight hoodies. 400 GSM brushed fleece, 500 GSM French terry. Double-layered hood. Hidden zipper pockets.' }
  if (isSweatpants) return { title: 'Sweatpants — KVRN Heavyweight Fleece', description: 'Shop KVRN heavyweight sweatpants. 400 GSM brushed fleece and 500 GSM French terry. Wide-leg and relaxed fits.' }
  return { title: 'Shop — KVRN Heavyweight Fleece', description: 'Shop the full KVRN collection. 400–500 GSM heavyweight hoodies and sweatpants. Quiet luxury.' }
}

export default async function ShopPage({ searchParams }: PageProps) {
  const { type } = await searchParams

  const isHoodies    = type === 'hoodies'
  const isSweatpants = type === 'sweatpants'

  const displayed = isHoodies
    ? getProductsByType('hoodie')
    : isSweatpants
    ? getProductsByType('sweatpants')
    : products

  const heading = isHoodies ? 'Hoodies'
    : isSweatpants ? 'Sweatpants'
    : 'Shop All'

  return (
    <div className="pt-[56px]" style={{ paddingTop: 'calc(36px + 56px)' }}>
      <div className="container-kvrn py-10 md:py-14">
        {/* Header */}
        <div className="mb-8 md:mb-12">
          <h1 className="font-display font-light text-[40px] md:text-[52px] leading-none tracking-tighter">
            {heading}
          </h1>
          {!isHoodies && !isSweatpants && (
            <p className="text-[14px] text-kvrn-muted mt-3">
              {products.length} products — 400–500 GSM heavyweight fleece
            </p>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-6 mb-10 border-b border-kvrn-border pb-4">
          {[
            { label: 'All',        href: '/shop' },
            { label: 'Hoodies',    href: '/shop?type=hoodies' },
            { label: 'Sweatpants', href: '/shop?type=sweatpants' },
          ].map(tab => (
            <a
              key={tab.href}
              href={tab.href}
              className={`text-[11px] font-light tracking-widest uppercase pb-4 -mb-4 border-b transition-colors duration-150 ${
                (tab.href === '/shop' && !type) || (type && tab.href.includes(type))
                  ? 'border-kvrn-text text-kvrn-text'
                  : 'border-transparent text-kvrn-muted hover:text-kvrn-text'
              }`}
            >
              {tab.label}
            </a>
          ))}
        </div>

        {/* Product grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8 xl:gap-10">
          {displayed.map((product, i) => (
            <ProductCard key={product.id} product={product} priority={i < 2} />
          ))}
        </div>

        {/* Collection SEO copy */}
        <details className="mt-14 group">
          <summary className="label-11 cursor-pointer text-kvrn-muted hover:text-kvrn-text transition-colors list-none flex items-center gap-2">
            About this collection
            <span className="transition-transform group-open:rotate-180 duration-200 text-[10px]">↓</span>
          </summary>
          <p className="mt-4 text-[13px] text-kvrn-muted leading-relaxed max-w-[640px]">
            KVRN produces two collections of heavyweight oversized hoodies and sweatpants.
            The Heavyweight collection is built from 400 GSM brushed fleece — 100% cotton, dense and structured.
            The Phantom collection uses a 500 GSM French terry blend, enzyme washed and pre-shrunk for an immediate softness.
            Both collections are designed for daily wear without compromise.
          </p>
        </details>
      </div>
    </div>
  )
}
