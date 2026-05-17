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
    items,
    isOpen,
    closeCart,
    removeItem,
    updateQuantity,
    itemCount,
    subtotalPence,
  } = useCart()

  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const firstFocusableRef = useRef<HTMLDivElement>(null)

  // Focus management when drawer opens
  useEffect(() => {
    if (isOpen) {
      closeButtonRef.current?.focus()
    }
  }, [isOpen])

  return (
    <>
      {/* Overlay */}
      <div
        className={cn(
          'fixed inset-0 z-[300] transition-all duration-300',
          isOpen
            ? 'bg-black/40 pointer-events-auto'
            : 'bg-transparent pointer-events-none'
        )}
        onClick={closeCart}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Shopping bag"
        className={cn(
          'fixed top-0 right-0 bottom-0 z-[400] w-full max-w-[400px]',
          'bg-kvrn-bg flex flex-col',
          'transition-transform duration-[600ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          isOpen ? 'translate-x-0' : 'translate-x-full'
        )}
        ref={firstFocusableRef}
      >
        {/* ─── Header ─── */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-kvrn-border">
          <h2 className="text-[11px] font-light tracking-widest uppercase">
            Bag {itemCount > 0 && `(${itemCount})`}
          </h2>
          <button
            ref={closeButtonRef}
            onClick={closeCart}
            aria-label="Close shopping bag"
            className="p-2 -mr-2 text-kvrn-muted hover:text-kvrn-text transition-colors duration-150"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M4 4L16 16M16 4L4 16"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* ─── Items ─── */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {items.length === 0 ? (
            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full px-6 text-center">
              <p className="text-[13px] text-kvrn-muted mb-6">Your bag is empty.</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={closeCart}
                as="span"
              >
                <Link href="/shop">Browse products</Link>
              </Button>
            </div>
          ) : (
            <ul
              className="divide-y divide-kvrn-border"
              aria-label="Items in your shopping bag"
            >
              {items.map((item) => (
                <li
                  key={item.cartItemId}
                  className="px-6 py-5 flex gap-4"
                >
                  {/* Item image */}
                  <div className="relative w-[80px] h-[107px] flex-shrink-0 bg-kvrn-bg-raised overflow-hidden">
                    {item.image ? (
                      <Image
                        src={item.image}
                        alt={item.productName}
                        fill
                        sizes="80px"
                        className="object-cover"
                      />
                    ) : (
                      <div
                        className="absolute inset-0"
                        style={{ backgroundColor: item.colorHex + '40' }}
                        aria-hidden="true"
                      />
                    )}
                  </div>

                  {/* Item details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-[14px] font-light text-kvrn-text leading-snug">
                          {item.productName}
                        </p>
                        <p className="text-[12px] text-kvrn-muted mt-1">
                          {item.colorName} / {item.size}
                        </p>
                      </div>
                      <p className="text-[14px] font-light text-kvrn-text flex-shrink-0">
                        {formatPrice(item.price * item.quantity)}
                      </p>
                    </div>

                    {/* Quantity + Remove */}
                    <div className="flex items-center gap-4 mt-3">
                      {/* Quantity control */}
                      <div className="flex items-center border border-kvrn-border" role="group" aria-label="Quantity">
                        <button
                          onClick={() =>
                            updateQuantity(item.cartItemId, item.quantity - 1)
                          }
                          aria-label={`Decrease quantity of ${item.productName}`}
                          className="w-8 h-8 flex items-center justify-center text-kvrn-muted hover:text-kvrn-text transition-colors"
                        >
                          <svg width="10" height="2" viewBox="0 0 10 2" fill="none" aria-hidden="true">
                            <path d="M0 1H10" stroke="currentColor" strokeWidth="1"/>
                          </svg>
                        </button>
                        <span
                          className="w-8 h-8 flex items-center justify-center text-[13px] font-light"
                          aria-label={`Quantity: ${item.quantity}`}
                        >
                          {item.quantity}
                        </span>
                        <button
                          onClick={() =>
                            updateQuantity(item.cartItemId, item.quantity + 1)
                          }
                          aria-label={`Increase quantity of ${item.productName}`}
                          className="w-8 h-8 flex items-center justify-center text-kvrn-muted hover:text-kvrn-text transition-colors"
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                            <path d="M5 0V10M0 5H10" stroke="currentColor" strokeWidth="1"/>
                          </svg>
                        </button>
                      </div>

                      {/* Remove */}
                      <button
                        onClick={() => removeItem(item.cartItemId)}
                        className="text-[11px] text-kvrn-subtle hover:text-kvrn-text tracking-wide transition-colors duration-150"
                        aria-label={`Remove ${item.productName} from bag`}
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

        {/* ─── Footer ─── */}
        {items.length > 0 && (
          <div className="border-t border-kvrn-border px-6 py-6 space-y-4">
            {/* Subtotal */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-kvrn-muted font-light">Subtotal</span>
              <span className="text-[15px] font-light">{formatPrice(subtotalPence)}</span>
            </div>
            <p className="text-[11px] text-kvrn-subtle tracking-wide">
              Shipping calculated at checkout
            </p>

            {/* Checkout CTA */}
            <Link href="/checkout" onClick={closeCart} className="block">
              <Button variant="primary" size="lg" fullWidth>
                Checkout
              </Button>
            </Link>

            {/* Trust signal */}
            <p className="text-[11px] text-kvrn-subtle text-center tracking-wide">
              Free returns within 30 days
            </p>
          </div>
        )}
      </div>
    </>
  )
}
