'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useI18n } from '@/context/I18nContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useCart } from '@/context/CartContext'
import { StockBadge, computeStock } from '@/components/ui/StockBadge'
import { QuickAddModal } from '@/components/product/QuickAddModal'
import { cn } from '@/lib/utils'
import type { Product, ColorOption } from '@/types'

interface Props { products: Product[] }

export function HomepageProducts({ products }: Props) {
  const { t } = useI18n()
  const [quickAddProduct, setQuickAddProduct] = useState<Product | null>(null)

  return (
    <>
      <section className="bg-[#F9F8F6] py-16 md:py-24" aria-labelledby="collection-heading">
        <div className="container-kvrn">
          {/* Header */}
          <div className="flex items-baseline justify-between mb-10 md:mb-14">
            <h2 id="collection-heading"
              className="font-display font-light text-[26px] md:text-[34px] leading-tight tracking-[-0.02em]">
              {t.theCollection}
            </h2>
            <Link href="/shop"
              className="text-[11px] font-light tracking-[0.1em] uppercase text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors hidden sm:block">
              {t.viewAll}
            </Link>
          </div>

          {/* Editorial 2+2 grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            {products.map((product, i) => (
              <ProductTile
                key={product.id}
                product={product}
                priority={i < 2}
                onQuickAdd={() => setQuickAddProduct(product)}
              />
            ))}
          </div>

          {/* Founder note */}
          <p className="mt-6 text-[11px] text-[#9B9B9B] tracking-wide">
            {t.founderPrice}
          </p>
        </div>
      </section>

      {quickAddProduct && (
        <QuickAddModal
          product={quickAddProduct}
          onClose={() => setQuickAddProduct(null)}
        />
      )}
    </>
  )
}

function ProductTile({
  product, priority, onQuickAdd,
}: {
  product: Product
  priority: boolean
  onQuickAdd: () => void
}) {
  const { formatPrice } = useCurrency()
  const { t } = useI18n()
  const [activeColor, setActiveColor] = useState<ColorOption>(product.colors[0])

  const stock      = computeStock(product.sizes)
  const frontImage = activeColor.images.find(i => i.type === 'front')
  const backImage  = activeColor.images.find(i => i.type === 'back') ?? activeColor.images[1]

  return (
    <div className="group flex flex-col">
      {/* Image */}
      <Link
        href={`/products/${product.slug}?color=${activeColor.value}`}
        className="relative aspect-[3/4] bg-[#F0EDE8] overflow-hidden block"
        aria-label={`${product.name} — ${formatPrice(product.price)}`}
      >
        {frontImage?.src ? (
          <>
            <Image
              src={frontImage.src} alt={frontImage.alt} fill priority={priority}
              sizes="(max-width: 640px) 50vw, 25vw"
              className="object-cover transition-opacity duration-700 group-hover:opacity-0"
            />
            {backImage?.src && (
              <Image
                src={backImage.src} alt={backImage.alt} fill
                sizes="(max-width: 640px) 50vw, 25vw"
                className="object-cover absolute inset-0 opacity-0 transition-opacity duration-700 group-hover:opacity-100"
              />
            )}
          </>
        ) : (
          <ColorPlaceholder color={activeColor} />
        )}

        <StockBadge stock={stock} position="card" />

        {/* Quick-add button */}
        {stock > 0 && (
          <button
            onClick={e => { e.preventDefault(); e.stopPropagation(); onQuickAdd() }}
            aria-label={`Quick add ${product.name}`}
            className={cn(
              'absolute bottom-3 right-3',
              'w-8 h-8 rounded-full flex items-center justify-center',
              'bg-[#F9F8F6] border border-[#E8E5E0] text-[#1A1A1A]',
              'opacity-0 group-hover:opacity-100 transition-all duration-200',
              'hover:bg-[#1A1A1A] hover:text-white hover:border-[#1A1A1A]',
              'text-[18px] font-light leading-none'
            )}
          >
            +
          </button>
        )}
      </Link>

      {/* Info */}
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Link href={`/products/${product.slug}?color=${activeColor.value}`}
            className="text-[13px] font-light text-[#1A1A1A] hover:text-[#6B6B6B] transition-colors leading-snug">
            {product.name}
          </Link>
          <span className="text-[13px] font-light text-[#1A1A1A] tabular-nums flex-shrink-0">
            {formatPrice(product.price)}
          </span>
        </div>

        {/* Color swatches */}
        {product.colors.length > 1 && (
          <div className="flex items-center gap-1.5">
            {product.colors.map(c => (
              <button
                key={c.value} title={c.name} aria-label={c.name}
                aria-pressed={c.value === activeColor.value}
                onClick={() => setActiveColor(c)}
                className={cn(
                  'w-3 h-3 rounded-full transition-all duration-150',
                  c.value === activeColor.value
                    ? 'ring-1 ring-[#1A1A1A] ring-offset-1 ring-offset-[#F9F8F6]'
                    : 'hover:scale-110'
                )}
                style={{ backgroundColor: c.hex }}
              />
            ))}
          </div>
        )}

        {/* Quick add text link — always visible */}
        {stock > 0 && (
          <button
            onClick={onQuickAdd}
            className="text-[11px] font-light tracking-[0.08em] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors uppercase"
          >
            + {t.addToBag}
          </button>
        )}
      </div>
    </div>
  )
}

function ColorPlaceholder({ color }: { color: ColorOption }) {
  return (
    <div className="absolute inset-0 flex items-end p-3"
      style={{ backgroundColor: color.hex + '14' }}>
      <span className="text-[10px] tracking-wider uppercase text-[#9B9B9B]">{color.name}</span>
    </div>
  )
}
