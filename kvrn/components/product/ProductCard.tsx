import Link from 'next/link'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { formatPrice } from '@/data/products'
import type { Product } from '@/types'

interface ProductCardProps {
  product:    Product
  priority?:  boolean
  className?: string
}

export function ProductCard({ product, priority = false, className }: ProductCardProps) {
  const defaultColor = product.colors[0]
  const front = defaultColor?.images.find(i => i.type === 'front')
  const back  = defaultColor?.images.find(i => i.type === 'back') ?? defaultColor?.images[1]

  const allOutOfStock = product.sizes.every(s => !s.inStock)

  return (
    <Link
      href={`/products/${product.slug}`}
      className={cn('group block card-hover', className)}
      aria-label={`${product.name} — ${formatPrice(product.price)}`}
    >
      {/* Image container */}
      <div className="relative aspect-[3/4] bg-[var(--color-bg-raised)] overflow-hidden mb-4">

        {/* Primary image */}
        {front?.src ? (
          <Image
            src={front.src}
            alt={front.alt}
            fill
            priority={priority}
            sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 640px"
            className="object-cover img-primary"
            quality={88}
          />
        ) : (
          /* Clean colour fallback — no text, no instructions */
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(145deg, ${defaultColor?.hex}18 0%, ${defaultColor?.hex}30 100%)`,
            }}
            aria-hidden="true"
          />
        )}

        {/* Secondary (back) — revealed on hover */}
        {back?.src && (
          <Image
            src={back.src}
            alt={back.alt}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 640px"
            className="object-cover img-secondary"
            quality={88}
          />
        )}

        {/* Sold out */}
        {allOutOfStock && (
          <div className="absolute bottom-4 left-4">
            <span className="kvrn-label bg-[var(--color-bg)]/90 px-3 py-1.5">
              Sold Out
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[15px] font-light">{product.name}</p>
          <p className="text-[15px] font-light flex-shrink-0">{formatPrice(product.price)}</p>
        </div>

        {/* Color dots */}
        <div className="flex gap-1.5" aria-label="Available colorways" role="list">
          {product.colors.map(color => (
            <span
              key={color.value}
              role="listitem"
              aria-label={color.name}
              className={cn(
                'w-2.5 h-2.5 rounded-full border',
                color.value === 'off-white'
                  ? 'border-[var(--color-border)]'
                  : 'border-transparent'
              )}
              style={{ backgroundColor: color.hex }}
            />
          ))}
        </div>
      </div>
    </Link>
  )
}
