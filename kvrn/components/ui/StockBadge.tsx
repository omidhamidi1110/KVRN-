import { cn } from '@/lib/utils'

interface StockBadgeProps {
  stock:      number   // total in-stock units across all variants, or for a specific variant
  className?: string
  position?:  'card' | 'pdp'  // card = corner overlay, pdp = inline near title
}

export function StockBadge({ stock, className, position = 'card' }: StockBadgeProps) {
  if (stock >= 3) return null  // No badge needed

  const label    = stock === 0 ? 'Sold out' : 'Few left'
  const isSoldOut = stock === 0

  if (position === 'card') {
    return (
      <span
        className={cn(
          'absolute bottom-3 left-3 px-2.5 py-1 text-[10px] font-light tracking-widest',
          isSoldOut
            ? 'bg-kvrn-text text-kvrn-bg'
            : 'bg-kvrn-bg/90 text-kvrn-text border border-kvrn-border',
          className
        )}
        aria-label={isSoldOut ? 'Sold out' : 'Limited stock remaining'}
      >
        {label}
      </span>
    )
  }

  // PDP inline badge
  return (
    <span
      className={cn(
        'inline-flex items-center px-2.5 py-1 text-[10px] font-light tracking-widest',
        isSoldOut
          ? 'bg-kvrn-text text-kvrn-bg'
          : 'border border-kvrn-border-strong text-kvrn-text',
        className
      )}
      aria-label={isSoldOut ? 'Sold out' : 'Limited stock remaining'}
    >
      {label}
    </span>
  )
}

/** Compute total in-stock unit count from a product's size options */
export function computeStock(sizes: Array<{ inStock: boolean; stockCount?: number }>): number {
  // If stockCount is available use it; otherwise inStock booleans give 0 or ∞
  const hasCount = sizes.some(s => typeof s.stockCount === 'number')
  if (hasCount) {
    return sizes.reduce((sum, s) => sum + (s.stockCount ?? 0), 0)
  }
  // Fall back: in-stock = large number, out of stock = 0
  const inStockCount = sizes.filter(s => s.inStock).length
  return inStockCount === 0 ? 0 : 99  // 99 means "available, no badge"
}
