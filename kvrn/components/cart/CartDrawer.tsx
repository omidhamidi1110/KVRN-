'use client'

import { useRef, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCart } from '@/context/CartContext'
import { Button } from '@/components/ui/Button'
import { formatPrice } from '@/data/products'
import { cn } from '@/lib/utils'

export function CartDrawer() {
  const {
    items, isOpen, closeCart, removeItem, updateQuantity, itemCount, subtotalPence,
  } = useCart()

  const closeBtnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (isOpen) closeBtnRef.current?.focus() }, [isOpen])

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

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Shopping bag"
        className={cn(
          'fixed top-0 right-0 bottom-0 z-[400] w-full max-w-[400px]',
          'bg-[var(--color-bg)] flex flex-col',
          'transition-transform duration-[550ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          isOpen ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--color-border)]">
          <h2 className="text-[11px] font-light tracking-[0.14em] uppercase">
            Bag{itemCount > 0 && ` (${itemCount})`}
          </h2>
          <button
            ref={closeBtnRef}
            onClick={closeCart}
            aria-label="Close bag"
            className="p-2 -mr-2 opacity-40 hover:opacity-100 transition-opacity"
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
              <p className="text-[14px] font-light text-[var(--color-muted)]">Your bag is empty.</p>
              <Link href="/shop" onClick={closeCart}>
                <Button variant="secondary" size="sm">Browse collection</Button>
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]" aria-label="Bag items">
              {items.map(item => (
                <li key={item.cartItemId} className="px-6 py-5 flex gap-4">
                  {/* Thumbnail */}
                  <div className="relative w-[76px] h-[100px] flex-shrink-0 bg-[var(--color-bg-raised)] overflow-hidden">
                    {item.image ? (
                      <Image src={item.image} alt={item.productName} fill sizes="76px" className="object-cover" />
                    ) : (
                      <div className="absolute inset-0" style={{ backgroundColor: item.colorHex + '25' }} />
                    )}
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-[13px] font-light leading-snug">{item.productName}</p>
                        <p className="text-[12px] font-light text-[var(--color-muted)] mt-0.5">
                          {item.colorName} · {item.size}
                        </p>
                      </div>
                      <p className="text-[13px] font-light flex-shrink-0">
                        {formatPrice(item.price * item.quantity)}
                      </p>
                    </div>

                    {/* Quantity + remove */}
                    <div className="flex items-center gap-5 mt-3">
                      <div className="flex items-center border border-[var(--color-border)]">
                        {[-1, 1].map(delta => (
                          <button
                            key={delta}
                            onClick={() => updateQuantity(item.cartItemId, item.quantity + delta)}
                            aria-label={delta === -1 ? `Decrease quantity` : `Increase quantity`}
                            className="w-8 h-8 flex items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
                          >
                            {delta === -1 ? '−' : '+'}
                          </button>
                        ))}
                        <span className="w-8 h-8 flex items-center justify-center text-[13px] font-light" aria-label={`Qty: ${item.quantity}`}>
                          {item.quantity}
                        </span>
                      </div>
                      <button
                        onClick={() => removeItem(item.cartItemId)}
                        className="text-[11px] font-light text-[var(--color-subtle)] hover:text-[var(--color-text)] tracking-wide transition-colors"
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
          <div className="border-t border-[var(--color-border)] px-6 py-6 space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-[13px] font-light text-[var(--color-muted)]">Subtotal</span>
              <span className="text-[16px] font-light">{formatPrice(subtotalPence)}</span>
            </div>
            <p className="text-[11px] font-light text-[var(--color-subtle)] tracking-wide">
              Shipping calculated at checkout
            </p>
            <Link href="/checkout" onClick={closeCart} className="block">
              <Button variant="primary" size="lg" fullWidth>Checkout</Button>
            </Link>
            <p className="text-[11px] font-light text-[var(--color-subtle)] text-center tracking-wide">
              Free returns within 30 days
            </p>
          </div>
        )}
      </div>
    </>
  )
}
