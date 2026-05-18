'use client'

import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { ProductCard } from '@/components/product/ProductCard'
import type { Product } from '@/types'

interface Props { products: Product[]; type: string | null }

export function ShopClient({ products, type }: Props) {
  const { t } = useI18n()

  const heading = type === 'hoodies'
    ? t.hoodies
    : type === 'sweatpants'
    ? t.sweatpants
    : t.shopAll

  const TABS = [
    { label: t.shopAll,    href: '/shop',              active: !type },
    { label: t.hoodies,    href: '/shop?type=hoodies', active: type === 'hoodies' },
    { label: t.sweatpants, href: '/shop?type=sweatpants', active: type === 'sweatpants' },
  ]

  return (
    <div className="pt-[calc(36px+56px)]">
      <div className="container-kvrn py-10 md:py-14">
        {/* Header */}
        <div className="mb-8 md:mb-10">
          <h1 className="font-display font-light text-[38px] md:text-[52px] leading-none tracking-[-0.03em]">
            {heading}
          </h1>
          {!type && (
            <p className="text-[14px] text-[#6B6B6B] mt-3">
              {products.length} products
            </p>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-6 mb-10 border-b border-[#E8E5E0] pb-4">
          {TABS.map(tab => (
            <Link
              key={tab.href}
              href={tab.href}
              className={`text-[11px] font-light tracking-[0.1em] uppercase pb-4 -mb-4 border-b-[1.5px] transition-colors duration-150 ${
                tab.active
                  ? 'border-[#1A1A1A] text-[#1A1A1A]'
                  : 'border-transparent text-[#9B9B9B] hover:text-[#1A1A1A]'
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
          {products.map((product, i) => (
            <ProductCard key={product.id} product={product} priority={i < 2} />
          ))}
        </div>

        {/* SEO copy */}
        <details className="mt-14 group">
          <summary className="text-[11px] tracking-[0.1em] uppercase text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors list-none flex items-center gap-2 cursor-pointer">
            About this collection
            <span className="transition-transform group-open:rotate-180 duration-200">↓</span>
          </summary>
          <p className="mt-4 text-[13px] text-[#6B6B6B] leading-relaxed max-w-[640px]">
            KVRN produces two collections of heavyweight oversized hoodies and sweatpants.
            The Heavyweight collection is 400 GSM brushed fleece, 100% cotton.
            The Phantom collection is 500 GSM French terry, enzyme washed. Both are designed for daily wear.
          </p>
        </details>
      </div>
    </div>
  )
}
