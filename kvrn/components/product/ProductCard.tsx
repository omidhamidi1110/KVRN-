'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCurrency }  from '@/context/CurrencyContext'
import { useWishlist }  from '@/context/WishlistContext'
import { StockBadge, computeStock } from '@/components/ui/StockBadge'
import { cn } from '@/lib/utils'
import type { Product, ColorOption } from '@/types'

interface ProductCardProps {
  product:    Product
  priority?:  boolean
  className?: string
}

export function ProductCard({ product, priority = false, className }: ProductCardProps) {
  const { formatPrice }                      = useCurrency()
  const { isWishlisted, toggleItem }         = useWishlist()
  const [activeColor, setActiveColor]        = useState<ColorOption>(product.colors[0])

  const stock      = computeStock(product.sizes)
  const frontImage = activeColor.images.find(i => i.type === 'front')
  const backImage  = activeColor.images.find(i => i.type === 'back') ?? activeColor.images[1]
  const wished     = isWishlisted(product.id, activeColor.value)

  const handleWishlist = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const front = activeColor.images.find(i => i.type === 'front')
    toggleItem({
      productId:   product.id,
      productName: product.name,
      slug:        product.slug,
      colorValue:  activeColor.value,
      colorName:   activeColor.name,
      colorHex:    activeColor.hex,
      price:       product.price,
      image:       front?.src ?? '',
    })
  }

  return (
    <div className={cn('group flex flex-col', className)}>
      <Link
        href={`/products/${product.slug}?color=${activeColor.value}`}
        className="relative aspect-[3/4] bg-[#F3F0EB] overflow-hidden block"
        aria-label={`${product.name} in ${activeColor.name}`}
      >
        {frontImage?.src ? (
          <Image
            src={frontImage.src} alt={frontImage.alt} fill priority={priority}
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 50vw, 25vw"
            className="object-cover transition-opacity duration-500 group-hover:opacity-0"
          />
        ) : (
          <div className="absolute inset-0 flex items-end p-4" style={{ backgroundColor: activeColor.hex + '18' }}>
            <p className="text-[11px] text-[#9B9B9B] tracking-wider uppercase">{product.name}</p>
          </div>
        )}

        {backImage?.src && (
          <Image
            src={backImage.src} alt={backImage.alt} fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 50vw, 25vw"
            className="object-cover absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          />
        )}

        <StockBadge stock={stock} position="card" />

        {/* Wishlist heart — appears on hover, functional */}
        <button
          onClick={handleWishlist}
          aria-label={wished ? `Remove ${product.name} from saved` : `Save ${product.name}`}
          className={cn(
            'absolute top-2.5 right-2.5 w-8 h-8 flex items-center justify-center',
            'bg-white/80 backdrop-blur-sm',
            'transition-all duration-200',
            wished
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100',
            'hover:bg-white'
          )}
        >
          <svg width="14" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
              stroke={wished ? '#B91C1C' : '#1A1A1A'}
              strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
              fill={wished ? '#B91C1C' : 'none'}
            />
          </svg>
        </button>
      </Link>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Link href={`/products/${product.slug}?color=${activeColor.value}`}
            className="text-[14px] font-light text-[#1A1A1A] hover:text-[#6B6B6B] transition-colors">
            {product.name}
          </Link>
          <span className="text-[14px] font-light text-[#1A1A1A] flex-shrink-0 tabular-nums">
            {formatPrice(product.price)}
          </span>
        </div>

        {product.colors.length > 1 && (
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label={`Color: ${activeColor.name}`}>
            {product.colors.map(c => (
              <button key={c.value} title={c.name} aria-label={c.name}
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

        {product.founderNote && (
          <p className="text-[11px] text-[#9B9B9B]">{product.founderNote}</p>
        )}
      </div>
    </div>
  )
}
