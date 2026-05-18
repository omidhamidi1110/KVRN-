'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n }     from '@/context/I18nContext'
import { StockBadge, computeStock } from '@/components/ui/StockBadge'
import { QuickAddModal } from '@/components/product/QuickAddModal'
import { cn } from '@/lib/utils'
import type { Product, ColorOption } from '@/types'

interface Props {
  product:    Product
  priority?:  boolean
  className?: string
}

export function ProductCard({ product, priority = false, className }: Props) {
  const { formatPrice }  = useCurrency()
  const { t }            = useI18n()
  const [activeColor, setActiveColor] = useState<ColorOption>(product.colors[0])
  const [showQuickAdd,  setShowQuickAdd]  = useState(false)

  const stock      = computeStock(product.sizes)
  const frontImage = activeColor.images.find(i => i.type === 'front')
  const backImage  = activeColor.images.find(i => i.type === 'back') ?? activeColor.images[1]

  return (
    <>
      <div className={cn('group flex flex-col', className)}>
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
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                className="object-cover transition-opacity duration-700 group-hover:opacity-0"
              />
              {backImage?.src && (
                <Image
                  src={backImage.src} alt={backImage.alt} fill
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                  className="object-cover absolute inset-0 opacity-0 transition-opacity duration-700 group-hover:opacity-100"
                />
              )}
            </>
          ) : (
            <div className="absolute inset-0 flex items-end p-3" style={{ backgroundColor: activeColor.hex + '14' }}>
              <span className="text-[10px] tracking-wider uppercase text-[#9B9B9B]">{product.name}</span>
            </div>
          )}

          <StockBadge stock={stock} position="card" />

          {/* + Quick add circle button on image */}
          {stock > 0 && (
            <button
              onClick={e => { e.preventDefault(); e.stopPropagation(); setShowQuickAdd(true) }}
              aria-label={`Quick add ${product.name}`}
              className={cn(
                'absolute bottom-3 right-3',
                'w-8 h-8 rounded-full flex items-center justify-center',
                'bg-[#F9F8F6] border border-[#E8E5E0]',
                'opacity-0 group-hover:opacity-100 transition-all duration-200',
                'hover:bg-[#1A1A1A] hover:text-white hover:border-[#1A1A1A]',
                'text-[#1A1A1A] text-[18px] font-light leading-none'
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
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label={`Color: ${activeColor.name}`}>
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

          {/* Quick add text — below price */}
          {stock > 0 ? (
            <button
              onClick={() => setShowQuickAdd(true)}
              className="text-[11px] font-light tracking-[0.08em] uppercase text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors"
            >
              + {t.addToBag}
            </button>
          ) : (
            <span className="text-[11px] font-light tracking-[0.08em] uppercase text-[#9B9B9B]">
              {t.soldOut}
            </span>
          )}
        </div>
      </div>

      {showQuickAdd && (
        <QuickAddModal
          product={product}
          initialColor={activeColor.value}
          onClose={() => setShowQuickAdd(false)}
        />
      )}
    </>
  )
}
