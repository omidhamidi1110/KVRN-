'use client'

import { useRef, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCart } from '@/context/CartContext'
import { useI18n } from '@/context/I18nContext'
import { useCurrency } from '@/context/CurrencyContext'
import { Button } from '@/components/ui/Button'
import { ShippingProgress } from '@/components/cart/ShippingProgress'
import { cn } from '@/lib/utils'

export function CartDrawer() {
  const {
    items, isOpen, closeCart, removeItem, updateQuantity, itemCount, subtotalPence,
  } = useCart()
  const { formatPrice } = useCurrency()
  const { t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isOpen) closeRef.current?.focus()
  }, [isOpen])

  return (
    <>
      {/* Overlay */}
      <div
        className={cn(
          'fixed inset-0 z-[300] transition-all duration-300',
          isOpen ? 'bg-black/40 pointer-events-auto' : 'bg-transparent pointer-events-none'
        )}
        onClick={closeCart}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        role="dialog" aria-modal="true" aria-label={t.bag}
        className={cn(
          'fixed top-0 right-0 bottom-0 z-[400] w-full max-w-[400px]',
          'bg-kvrn-bg flex flex-col',
          'transition-transform duration-[500ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          isOpen ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-kvrn-border">
          <h2 className="text-[11px] font-light tracking-widest uppercase">
            Bag {itemCount > 0 && `(${itemCount})`}
          </h2>
          <button
            ref={closeRef}
            onClick={closeCart}
            aria-label={t.bag}
            className="p-2 -mr-2 text-kvrn-muted hover:text-kvrn-text transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 3l12 12M15 3L3 15" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Items */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-5">
              <p className="text-[13px] text-kvrn-muted">Your bag is empty.</p>
              <Button variant="secondary" size="sm" onClick={closeCart}>
                <Link href="/shop">Browse products</Link>
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-kvrn-border" aria-label="Bag items">
              {items.map(item => (
                <li key={item.cartItemId} className="px-6 py-5 flex gap-4">
                  {/* Thumbnail */}
                  <div className="relative w-[76px] h-[101px] flex-shrink-0 bg-kvrn-bg-raised overflow-hidden">
                    {item.image ? (
                      <Image src={item.image} alt={item.productName} fill sizes="76px" className="object-cover" />
                    ) : (
                      <div className="absolute inset-0" style={{ backgroundColor: item.colorHex + '30' }} />
                    )}
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-[13px] font-light leading-snug">{item.productName}</p>
                        <p className="text-[11px] text-kvrn-muted mt-1">
                          {item.colorName} / {item.size}
                        </p>
                      </div>
                      <p className="text-[13px] font-light flex-shrink-0">
                        {formatPrice(item.price * item.quantity)}
                      </p>
                    </div>

                    <div className="flex items-center gap-4 mt-3">
                      {/* Qty */}
                      <div className="flex items-center border border-kvrn-border" role="group" aria-label="Quantity">
                        {[
                          { label: '−', delta: -1 },
                          { label: '+', delta: +1 },
                        ].map((btn, i) => (
                          <button
                            key={i}
                            onClick={() => updateQuantity(item.cartItemId, item.quantity + btn.delta)}
                            aria-label={`${btn.delta > 0 ? 'Increase' : 'Decrease'} quantity`}
                            className="w-8 h-8 flex items-center justify-center text-[14px] text-kvrn-muted hover:text-kvrn-text transition-colors"
                          >
                            {btn.label}
                          </button>
                        )).flatMap((el, i, arr) =>
                          i < arr.length - 1
                            ? [el, <span key={`sep-${i}`} className="w-8 h-8 flex items-center justify-center text-[13px] font-light">{item.quantity}</span>]
                            : [el]
                        )}
                      </div>
                      <button
                        onClick={() => removeItem(item.cartItemId)}
                        className="text-[11px] text-kvrn-subtle hover:text-kvrn-text transition-colors tracking-wide"
                        aria-label={`Remove ${item.productName}`}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="border-t border-kvrn-border px-6 py-5 space-y-4">
            {/* Free shipping progress */}
            <ShippingProgress cartUsdCents={subtotalPence} />

            {/* Subtotal */}
            <div className="flex justify-between text-[14px] font-light">
              <span className="text-kvrn-muted">Subtotal</span>
              <span>{formatPrice(subtotalPence)}</span>
            </div>
            <p className="text-[11px] text-kvrn-subtle tracking-wide">
              Shipping calculated at checkout
            </p>

            <Link href="/checkout" onClick={closeCart}>
              <Button variant="primary" size="lg" fullWidth>Checkout</Button>
            </Link>

            <p className="text-[11px] text-kvrn-subtle text-center tracking-wide">
              Store credit returns · Secure checkout
            </p>
          </div>
        )}
      </div>
    </>
  )
}
