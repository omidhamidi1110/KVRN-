import { cn } from '@/lib/utils'

interface StockBadgeProps {
  stock:      number
  className?: string
  position?:  'card' | 'pdp'
}

export function StockBadge({ stock, className, position = 'card' }: StockBadgeProps) {
  if (stock >= 3) return null

  const soldOut = stock === 0
  const label   = soldOut ? 'Sold Out' : 'Few Left'

  if (position === 'card') {
    return (
      <span
        className={cn(
          'absolute bottom-2.5 left-2.5 px-2 py-0.5 text-[10px] font-light tracking-[0.1em] uppercase',
          soldOut
            ? 'bg-[#181818] text-[#F0EDE8]'
            : 'bg-[#F9F8F6]/90 text-[#1A1A1A] border border-[#E8E5E0]',
          className
        )}
        aria-label={soldOut ? 'Sold out' : 'Limited stock remaining'}
      >
        {label}
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex px-2.5 py-1 text-[11px] font-light tracking-[0.08em] uppercase',
        soldOut
          ? 'bg-[#181818] text-[#F0EDE8]'
          : 'border border-[#C8C4BF] text-[#1A1A1A]',
        className
      )}
      aria-label={soldOut ? 'Sold out' : 'Limited stock remaining'}
    >
      {label}
    </span>
  )
}

export function computeStock(sizes: Array<{ inStock: boolean; stockCount?: number }>): number {
  const hasCount = sizes.some(s => typeof s.stockCount === 'number')
  if (hasCount) return sizes.reduce((sum, s) => sum + (s.stockCount ?? 0), 0)
  return sizes.filter(s => s.inStock).length === 0 ? 0 : 99
}
