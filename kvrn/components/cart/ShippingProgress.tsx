'use client'

import { useCurrency } from '@/context/CurrencyContext'
import { shippingProgressPct, centsToFreeShipping, freeShippingThreshold } from '@/lib/currency'

interface Props { cartUsdCents: number; className?: string }

export function ShippingProgress({ cartUsdCents, className }: Props) {
  const { currency, formatPrice } = useCurrency()
  const pct       = shippingProgressPct(cartUsdCents)
  const remaining = centsToFreeShipping(cartUsdCents)
  const achieved  = remaining === 0

  return (
    <div className={className}>
      <p className="text-[12px] text-[#6B6B6B] mb-2 leading-snug">
        {achieved ? (
          <span className="text-[#1A1A1A] font-light">Complimentary U.S. shipping unlocked</span>
        ) : (
          <><span className="text-[#1A1A1A] font-light">{formatPrice(remaining)}</span> away from complimentary U.S. shipping</>
        )}
      </p>
      <div className="h-px bg-[#E8E5E0] overflow-hidden"
        role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
        aria-label={`${Math.round(pct)}% toward free shipping`}>
        <div
          className={`h-full transition-all duration-700 ease-out ${achieved ? 'bg-[#15803D]' : 'bg-[#1A1A1A]'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-[#9B9B9B] mt-1.5 tracking-wide">
        Complimentary shipping applies to U.S. orders only.
      </p>
    </div>
  )
}
