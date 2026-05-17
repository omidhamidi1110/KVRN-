import Link from 'next/link'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { formatPrice } from '@/data/products'
import type { Product } from '@/types'

interface ProductCardProps {
  product:    Product
  priority?:  boolean  // Preload image for LCP
  className?: string
}

export function ProductCard({ product, priority = false, className }: ProductCardProps) {
  const defaultColor = product.colors[0]
  const frontImage   = defaultColor?.images.find((i) => i.type === 'front')
  const backImage    = defaultColor?.images.find((i) => i.type === 'back') ||
                       defaultColor?.images[1]

  return (
    <Link
      href={`/products/${product.slug}`}
      className={cn(
        'group block product-card-wrap',
        className
      )}
      aria-label={`${product.name} — ${formatPrice(product.price)}`}
    >
      {/* ─── Image container ─── */}
      <div className="relative aspect-[3/4] bg-kvrn-bg-raised overflow-hidden mb-4">
        {/* Primary image */}
        {frontImage?.src ? (
          <Image
            src={frontImage.src}
            alt={frontImage.alt}
            fill
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 640px"
            className="object-cover product-image-primary"
            priority={priority}
            quality={85}
          />
        ) : (
          /* Colorway placeholder when images not yet added */
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2"
            aria-hidden="true"
          >
            <div
              className="w-12 h-12 rounded-full opacity-30"
              style={{ backgroundColor: defaultColor?.hex }}
            />
            <span className="label-11 text-kvrn-subtle text-center px-4">
              {product.name}
            </span>
          </div>
        )}

        {/* Secondary image (back view — revealed on hover) */}
        {backImage?.src && (
          <Image
            src={backImage.src}
            alt={backImage.alt}
            fill
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 640px"
            className="object-cover product-image-secondary"
            quality={85}
          />
        )}

        {/* Sold out badge */}
        {product.sizes.every((s) => !s.inStock) && (
          <div className="absolute bottom-4 left-4">
            <span className="label-11 bg-kvrn-bg/90 px-3 py-1.5 text-kvrn-text">
              Sold Out
            </span>
          </div>
        )}
      </div>

      {/* ─── Product info ─── */}
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <p className="text-[15px] font-light text-kvrn-text">
            {product.name}
          </p>
          <p className="text-[13px] text-kvrn-muted mt-0.5">
            {product.shortDescription}
          </p>
        </div>
        <p className="text-[15px] font-light text-kvrn-text flex-shrink-0">
          {formatPrice(product.price)}
        </p>
      </div>

      {/* Color dots */}
      <div className="flex gap-1.5 mt-3" aria-label="Available colors" role="list">
        {product.colors.map((color) => (
          <span
            key={color.value}
            role="listitem"
            aria-label={color.name}
            className={cn(
              'w-3 h-3 rounded-full border',
              color.value === 'off-white'
                ? 'border-kvrn-border'
                : 'border-transparent'
            )}
            style={{ backgroundColor: color.hex }}
          />
        ))}
      </div>
    </Link>
  )
}
