'use client'
// One set ("Complete the Set") in the bag: its real component lines grouped under a single title,
// one quantity control and one Remove, with the set price and the amount saved. Prices shown are the
// allocated NET prices the server will charge; the server re-prices at checkout and reports changes.
import Image from 'next/image'
import type { BundleGroup } from '@/lib/bundle-cart'
import { maxSetQuantity } from '@/lib/bundle-cart'

export function BagBundleGroup({ group, formatPrice, onRemove, onQuantity }: {
  group: BundleGroup
  formatPrice: (cents: number) => string
  onRemove: () => void
  onQuantity: (q: number) => void
}) {
  const cap = maxSetQuantity(group.lines)
  const atCap = group.quantity >= cap
  const saved = Math.max(0, group.subtotalCents - group.netCents)
  return (
    <li className="px-6 py-5" data-bundle-id={group.bundleId}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] tracking-[0.12em] uppercase text-kvrn-subtle">{group.title || 'Complete the Set'}</p>
        <p className="text-[13px] font-light flex-shrink-0">{formatPrice(group.netCents)}</p>
      </div>
      <ul className="mt-3 space-y-3" aria-label="Items in this set">
        {group.lines.map(l => (
          <li key={l.cartItemId} className="flex gap-3">
            <div className="relative w-[52px] h-[69px] flex-shrink-0 bg-kvrn-bg-raised overflow-hidden">
              {l.image ? (
                <Image src={l.image} alt={l.productName} fill sizes="52px" className="object-cover" />
              ) : (
                <div className="absolute inset-0" style={{ backgroundColor: l.colorHex + '30' }} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-light leading-snug">{l.productName}</p>
              <p className="text-[11px] text-kvrn-muted mt-1">{l.colorName} / {l.size}</p>
            </div>
          </li>
        ))}
      </ul>
      {saved > 0 && <p className="text-[11px] text-kvrn-muted mt-3">Set price. You save {formatPrice(saved)}.</p>}
      <div className="flex items-center gap-4 mt-3">
        <div className="flex items-center border border-kvrn-border" role="group" aria-label="Set quantity">
          <button onClick={() => onQuantity(group.quantity - 1)} aria-label="Decrease set quantity"
            className="w-8 h-8 flex items-center justify-center text-[14px] text-kvrn-muted hover:text-kvrn-text">−</button>
          <span className="w-8 h-8 flex items-center justify-center text-[13px] font-light">{group.quantity}</span>
          <button onClick={() => !atCap && onQuantity(group.quantity + 1)} aria-label="Increase set quantity" aria-disabled={atCap}
            className={`w-8 h-8 flex items-center justify-center text-[14px] ${atCap ? 'text-kvrn-border cursor-default' : 'text-kvrn-muted hover:text-kvrn-text'}`}>+</button>
        </div>
        <button onClick={onRemove} className="text-[11px] text-kvrn-subtle hover:text-kvrn-text transition-colors tracking-wide"
          aria-label="Remove set">Remove set</button>
      </div>
    </li>
  )
}
