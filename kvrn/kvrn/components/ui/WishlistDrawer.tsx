'use client'

import { useRef, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useWishlist } from '@/context/WishlistContext'
import { useCurrency } from '@/context/CurrencyContext'
import { cn } from '@/lib/utils'

export function WishlistDrawer() {
  const { items, isOpen, closeWishlist, toggleItem } = useWishlist()
  const { formatPrice } = useCurrency()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { if (isOpen) closeRef.current?.focus() }, [isOpen])

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-[300] transition-all duration-300',
          isOpen ? 'bg-black/40 pointer-events-auto' : 'bg-transparent pointer-events-none'
        )}
        onClick={closeWishlist}
        aria-hidden="true"
      />
      <div
        role="dialog" aria-modal="true" aria-label="Saved items"
        className={cn(
          'fixed top-0 right-0 bottom-0 z-[400] w-full max-w-[380px]',
          'bg-[#F9F8F6] flex flex-col',
          'transition-transform duration-500 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          isOpen ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-[#E8E5E0]">
          <h2 className="text-[11px] font-light tracking-[0.1em] uppercase">
            Saved {items.length > 0 && `(${items.length})`}
          </h2>
          <button ref={closeRef} onClick={closeWishlist} aria-label="Close saved items"
            className="text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 3l12 12M15 3L3 15" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-[#C8C4BF]" aria-hidden="true">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <p className="text-[13px] text-[#9B9B9B]">No saved items yet.</p>
              <Link href="/shop" onClick={closeWishlist}
                className="text-[11px] tracking-[0.1em] uppercase border border-[#1A1A1A] px-5 py-2.5 hover:bg-[#1A1A1A] hover:text-white transition-all duration-200">
                Browse products
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-[#E8E5E0]">
              {items.map(item => (
                <li key={`${item.productId}-${item.colorValue}`} className="px-6 py-4 flex gap-4">
                  <Link href={`/products/${item.slug}?color=${item.colorValue}`}
                    onClick={closeWishlist}
                    className="relative w-[64px] h-[85px] flex-shrink-0 bg-[#F3F0EB] overflow-hidden block">
                    {item.image
                      ? <Image src={item.image} alt={item.productName} fill sizes="64px" className="object-cover" />
                      : <div className="absolute inset-0" style={{ backgroundColor: item.colorHex + '30' }} />
                    }
                  </Link>
                  <div className="flex-1 min-w-0">
                    <Link href={`/products/${item.slug}?color=${item.colorValue}`} onClick={closeWishlist}
                      className="text-[13px] font-light hover:opacity-60 transition-opacity">
                      {item.productName}
                    </Link>
                    <p className="text-[11px] text-[#9B9B9B] mt-0.5">{item.colorName}</p>
                    <p className="text-[13px] font-light mt-1">{formatPrice(item.price)}</p>
                    <button onClick={() => toggleItem(item)}
                      className="text-[11px] text-[#9B9B9B] hover:text-[#B91C1C] transition-colors mt-2">
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  )
}
