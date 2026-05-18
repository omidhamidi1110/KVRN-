'use client'

import { useCurrency } from '@/context/CurrencyContext'
import { shippingProgressPct, centsToFreeShipping, freeShippingThreshold } from '@/lib/currency'
import { cn } from '@/lib/utils'

interface ShippingProgressProps {
  cartUsdCents: number
  className?:  string
}

export function ShippingProgress({ cartUsdCents, className }: ShippingProgressProps) {
  const { currency, formatPrice } = useCurrency()
  const pct       = shippingProgressPct(cartUsdCents)
  const remaining = centsToFreeShipping(cartUsdCents)
  const threshold = freeShippingThreshold(currency)
  const achieved  = remaining === 0

  return (
    <div className={cn('space-y-2', className)}>
      {/* Message */}
      <p className="text-[12px] text-kvrn-muted leading-relaxed">
        {achieved ? (
          <span className="text-kvrn-text font-light">
            Complimentary U.S. shipping unlocked
          </span>
        ) : (
          <>
            <span className="text-kvrn-text font-light">{formatPrice(remaining)}</span>
            {' '}away from complimentary U.S. shipping
          </>
        )}
      </p>

      {/* Progress bar */}
      <div
        className="h-px bg-kvrn-border overflow-hidden"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${Math.round(pct)}% toward free shipping`}
      >
        <div
          className={cn(
            'h-full transition-all duration-700 ease-out',
            achieved ? 'bg-kvrn-success' : 'bg-kvrn-text'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Disclaimer */}
      <p className="text-[10px] text-kvrn-subtle tracking-wide">
        Complimentary shipping applies to U.S. orders only. Threshold: {threshold}.
      </p>
    </div>
  )
}
