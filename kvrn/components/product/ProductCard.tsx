'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCurrency } from '@/context/CurrencyContext'
import { StockBadge, computeStock } from '@/components/ui/StockBadge'
import { cn } from '@/lib/utils'
import type { Product, ColorOption } from '@/types'

interface ProductCardProps {
  product:   Product
  priority?: boolean
  className?: string
}

export function ProductCard({ product, priority = false, className }: ProductCardProps) {
  const { formatPrice } = useCurrency()
  const [activeColor, setActiveColor] = useState<ColorOption>(product.colors[0])

  const frontImage = activeColor.images.find(i => i.type === 'front')
  const backImage  = activeColor.images.find(i => i.type === 'back') ?? activeColor.images[1]
  const stock      = computeStock(product.sizes)

  return (
    <div className={cn('group flex flex-col', className)}>
      {/* ── Image ── */}
      <Link
        href={`/products/${product.slug}?color=${activeColor.value}`}
        className="relative aspect-[3/4] bg-kvrn-bg-raised overflow-hidden block"
        aria-label={`${product.name} in ${activeColor.name} — ${formatPrice(product.price)}`}
        tabIndex={0}
      >
        {/* Primary image */}
        {frontImage?.src ? (
          <Image
            src={frontImage.src}
            alt={frontImage.alt}
            fill
            priority={priority}
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw"
            className="object-cover transition-opacity duration-500 group-hover:opacity-0"
            quality={85}
          />
        ) : (
          <PlaceholderSwatch color={activeColor} label={product.name} />
        )}

        {/* Back/secondary image */}
        {backImage?.src && (
          <Image
            src={backImage.src}
            alt={backImage.alt}
            fill
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw"
            className="object-cover absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
            quality={85}
          />
        )}

        {/* Stock badge */}
        <StockBadge stock={stock} position="card" />

        {/* Wishlist — UI only, future feature */}
        <button
          onClick={e => { e.preventDefault(); e.stopPropagation() }}
          aria-label={`Save ${product.name} to wishlist`}
          className={cn(
            'absolute top-3 right-3 w-8 h-8 flex items-center justify-center',
            'bg-kvrn-bg/80 backdrop-blur-sm',
            'opacity-0 group-hover:opacity-100 transition-opacity duration-200',
            'hover:bg-kvrn-bg'
          )}
        >
          <svg width="14" height="13" viewBox="0 0 14 13" fill="none" aria-hidden="true">
            <path d="M7 12S1 7.5 1 4a3 3 0 015.2-2A3 3 0 0113 4c0 3.5-6 8-6 8z"
              stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </Link>

      {/* ── Product info ── */}
      <div className="mt-3 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <Link href={`/products/${product.slug}?color=${activeColor.value}`}
            className="text-[14px] font-light text-kvrn-text hover:opacity-70 transition-opacity">
            {product.name}
          </Link>
          <span className="text-[14px] font-light text-kvrn-text flex-shrink-0">
            {formatPrice(product.price)}
          </span>
        </div>

        {/* Color swatches — always visible */}
        {product.colors.length > 1 && (
          <div
            className="flex items-center gap-1.5"
            role="radiogroup"
            aria-label={`Color options for ${product.name}`}
          >
            {product.colors.map(color => (
              <button
                key={color.value}
                title={color.name}
                aria-label={color.name}
                aria-pressed={color.value === activeColor.value}
                onClick={() => setActiveColor(color)}
                className={cn(
                  'w-4 h-4 rounded-full transition-all duration-150',
                  'border',
                  color.value === 'off-white' || color.hex.startsWith('#F')
                    ? 'border-kvrn-border'
                    : 'border-transparent',
                  color.value === activeColor.value
                    ? 'ring-1 ring-kvrn-text ring-offset-1 ring-offset-kvrn-bg scale-110'
                    : 'hover:scale-110'
                )}
                style={{ backgroundColor: color.hex }}
              />
            ))}
          </div>
        )}

        <p className="text-[11px] text-kvrn-muted">{product.shortDescription}</p>
      </div>
    </div>
  )
}

function PlaceholderSwatch({ color, label }: { color: ColorOption; label: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3"
      style={{ backgroundColor: color.hex + '20' }}>
      <div className="w-10 h-10 rounded-full opacity-40" style={{ backgroundColor: color.hex }} />
      <span className="label-11 text-kvrn-subtle text-center px-4">{label}</span>
    </div>
  )
}
