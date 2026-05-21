'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export interface WishlistItem {
  productId:   string
  productName: string
  slug:        string
  colorValue:  string
  colorName:   string
  colorHex:    string
  price:       number
  image:       string
}

interface WishlistCtx {
  items:        WishlistItem[]
  isOpen:       boolean
  openWishlist: () => void
  closeWishlist:() => void
  toggleItem:   (item: WishlistItem) => void
  isWishlisted: (productId: string, colorValue: string) => boolean
  count:        number
}

const WishlistContext = createContext<WishlistCtx | null>(null)
const STORAGE_KEY = 'kvrn_wishlist'

export function WishlistProvider({ children }: { children: React.ReactNode }) {
  const [items,  setItems]  = useState<WishlistItem[]>([])
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) setItems(JSON.parse(stored))
    } catch {}
  }, [])

  const persist = (next: WishlistItem[]) => {
    setItems(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch {}
  }

  const toggleItem = useCallback((item: WishlistItem) => {
    setItems(prev => {
      const exists = prev.some(i => i.productId === item.productId && i.colorValue === item.colorValue)
      const next   = exists
        ? prev.filter(i => !(i.productId === item.productId && i.colorValue === item.colorValue))
        : [...prev, item]
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const isWishlisted = useCallback(
    (productId: string, colorValue: string) =>
      items.some(i => i.productId === productId && i.colorValue === colorValue),
    [items]
  )

  return (
    <WishlistContext.Provider value={{
      items, isOpen,
      openWishlist:  () => setIsOpen(true),
      closeWishlist: () => setIsOpen(false),
      toggleItem,
      isWishlisted,
      count: items.length,
    }}>
      {children}
    </WishlistContext.Provider>
  )
}

export function useWishlist() {
  const ctx = useContext(WishlistContext)
  if (!ctx) throw new Error('useWishlist must be inside WishlistProvider')
  return ctx
}
