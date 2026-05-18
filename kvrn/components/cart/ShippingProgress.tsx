'use client'

import { useCurrency } from '@/context/CurrencyContext'
import { useI18n }     from '@/context/I18nContext'
import { shippingProgressPct, centsToFreeShipping } from '@/lib/currency'

interface Props { cartUsdCents: number; className?: string }

export function ShippingProgress({ cartUsdCents, className }: Props) {
  const { formatPrice } = useCurrency()
  const { t }           = useI18n()
  const pct       = shippingProgressPct(cartUsdCents)
  const remaining = centsToFreeShipping(cartUsdCents)
  const achieved  = remaining === 0

  return (
    <div className={className}>
      <p className="text-[12px] text-[#6B6B6B] mb-2 leading-snug">
        {achieved ? (
          <span className="text-[#1A1A1A] font-light">{t.freeShippingUnlocked}</span>
        ) : (
          <>
            <span className="text-[#1A1A1A] font-light">{formatPrice(remaining)}</span>
            {' '}{t.freeShipping}
          </>
        )}
      </p>
      <div className="h-px bg-[#E8E5E0] overflow-hidden"
        role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`h-full transition-all duration-700 ease-out ${achieved ? 'bg-[#15803D]' : 'bg-[#1A1A1A]'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-[#9B9B9B] mt-1.5 tracking-wide">
        {t.freeShippingNote}
      </p>
    </div>
  )
}
