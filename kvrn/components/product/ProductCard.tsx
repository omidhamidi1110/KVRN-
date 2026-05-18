'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCurrency } from '@/context/CurrencyContext'
import { StockBadge, computeStock } from '@/components/ui/StockBadge'
import { cn } from '@/lib/utils'
import type { Product, ColorOption } from '@/types'

interface ProductCardProps {
  product:    Product
  priority?:  boolean
  className?: string
}

export function ProductCard({ product, priority = false, className }: ProductCardProps) {
  const { formatPrice } = useCurrency()
  const [activeColor, setActiveColor] = useState<ColorOption>(product.colors[0])

  const stock      = computeStock(product.sizes)
  const frontImage = activeColor.images.find(i => i.type === 'front')
  const backImage  = activeColor.images.find(i => i.type === 'back') ?? activeColor.images[1]

  return (
    <div className={cn('group flex flex-col', className)}>
      {/* Image */}
      <Link
        href={`/products/${product.slug}?color=${activeColor.value}`}
        className="relative aspect-[3/4] bg-[#F3F0EB] overflow-hidden block"
        aria-label={`${product.name} — ${formatPrice(product.price)}`}
      >
        {frontImage?.src ? (
          <Image
            src={frontImage.src} alt={frontImage.alt} fill priority={priority}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="object-cover transition-opacity duration-500 group-hover:opacity-0"
          />
        ) : (
          <ColorPlaceholder color={activeColor} label={product.name} />
        )}

        {backImage?.src && (
          <Image
            src={backImage.src} alt={backImage.alt} fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="object-cover absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          />
        )}

        <StockBadge stock={stock} position="card" />
      </Link>

      {/* Info */}
      <div className="mt-3 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <Link href={`/products/${product.slug}?color=${activeColor.value}`}
            className="text-[14px] font-light text-[#1A1A1A] hover:text-[#6B6B6B] transition-colors leading-snug">
            {product.name}
          </Link>
          <span className="text-[14px] font-light text-[#1A1A1A] flex-shrink-0 tabular-nums">
            {formatPrice(product.price)}
          </span>
        </div>

        {/* Color swatches — always visible when multiple */}
        {product.colors.length > 1 && (
          <div className="flex items-center gap-1.5" role="radiogroup"
            aria-label={`Color: ${activeColor.name}`}>
            {product.colors.map(c => (
              <button
                key={c.value} title={c.name} aria-label={c.name}
                aria-pressed={c.value === activeColor.value}
                onClick={() => setActiveColor(c)}
                className={cn(
                  'w-3.5 h-3.5 rounded-full flex-shrink-0 transition-all duration-150',
                  c.value === activeColor.value
                    ? 'ring-1 ring-[#1A1A1A] ring-offset-1 ring-offset-[#F9F8F6]'
                    : 'hover:scale-110'
                )}
                style={{ backgroundColor: c.hex }}
              />
            ))}
          </div>
        )}

        {/* Founder note */}
        {product.founderNote && (
          <p className="text-[11px] text-[#6B6B6B] leading-snug">{product.founderNote}</p>
        )}
      </div>
    </div>
  )
}

function ColorPlaceholder({ color, label }: { color: ColorOption; label: string }) {
  return (
    <div className="absolute inset-0 flex items-end p-4"
      style={{ backgroundColor: color.hex + '18' }}>
      <p className="text-[11px] text-[#9B9B9B] tracking-wider uppercase">{label}</p>
    </div>
  )
}
