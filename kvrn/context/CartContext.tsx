'use client'

import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
} from 'react'
import type { CartItem } from '@/types'
import { buildCartItemId, getFromStorage, setInStorage } from '@/lib/utils'
import { cartReducer, type CartState, type CartAction } from '@/lib/cart-reducer'

// ─── TYPES ───────────────────────────────────────────────────────────────────

// CartState and CartAction are imported from lib/cart-reducer.ts

interface CartContextValue extends CartState {
  addItem: (item: Omit<CartItem, 'cartItemId'>) => void
  removeItem: (cartItemId: string) => void
  updateQuantity: (cartItemId: string, quantity: number) => void
  clearCart: () => void
  openCart: () => void
  closeCart: () => void
  itemCount: number
  subtotalPence: number
  refreshInventoryCaps: (explicitItems?: CartItem[]) => Promise<void>
}

// ─── CONTEXT / PROVIDER ──────────────────────────────────────────────────────

const STORAGE_KEY = 'kvrn_cart'

const CartContext = createContext<CartContextValue | null>(null)

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, {
    items: [],
    isOpen: false,
  })

  // ── Refresh helper ─────────────────────────────────────────────────────────
  // Accepts optional explicit items to avoid closure-timing issues during hydration.
  // When called from the mount effect, stored items are passed directly.
  // When called manually elsewhere, falls back to current state.items.
  const refreshInventoryCaps = useCallback(async (explicitItems?: CartItem[]) => {
    const items = explicitItems ?? state.items
    if (items.length === 0) return

    const slugs = [...new Set(items.map(i => i.slug).filter(Boolean))]
    try {
      const results = await Promise.allSettled(
        slugs.map(slug =>
          fetch(`/api/inventory?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        )
      )
      const skuMap = new Map<string, number>()
      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value?.variants) continue
        for (const v of result.value.variants) {
          if (v.sku && typeof v.available_qty === 'number') {
            skuMap.set(v.sku, v.available_qty)
          }
        }
      }
      const caps = items
        .filter(item => item.sku && skuMap.has(item.sku!))
        .map(item => ({
          cartItemId:        item.cartItemId,
          availableQuantity: skuMap.get(item.sku!)!,
        }))
      if (caps.length > 0) {
        dispatch({ type: 'REFRESH_CAPS', payload: caps })
      }
    } catch {
      // Network failure: existing state unchanged; server reserveInventory is authoritative
    }
  }, [state.items])

  // ── Hydration: read localStorage → dispatch HYDRATE → immediately refresh caps ──
  // Stored items are passed directly to refreshInventoryCaps to avoid effect-ordering
  // ambiguity: the refresh sees the freshly-read items without waiting for the
  // HYDRATE re-render (which is async from React's perspective).
  useEffect(() => {
    const stored = getFromStorage<CartItem[]>(STORAGE_KEY, [])
    if (stored.length > 0) {
      dispatch({ type: 'HYDRATE', payload: stored })
      setTimeout(() => { void refreshInventoryCaps(stored) }, 300)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // mount-only; refreshInventoryCaps is stable for this call site

  // ── Persist to localStorage on items change ────────────────────────────────
  useEffect(() => {
    setInStorage(STORAGE_KEY, state.items)
  }, [state.items])

  // ── Close cart on Escape ───────────────────────────────────────────────────
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.isOpen) {
        dispatch({ type: 'CLOSE_CART' })
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [state.isOpen])

  // ── Cart actions ───────────────────────────────────────────────────────────

  const addItem = useCallback((item: Omit<CartItem, 'cartItemId'>) => {
    const cartItemId = buildCartItemId(item.productId, item.color, item.size)
    dispatch({ type: 'ADD_ITEM', payload: { ...item, cartItemId } })
  }, [])

  const removeItem = useCallback((cartItemId: string) => {
    dispatch({ type: 'REMOVE_ITEM', payload: { cartItemId } })
  }, [])

  const updateQuantity = useCallback((cartItemId: string, quantity: number) => {
    dispatch({ type: 'UPDATE_QUANTITY', payload: { cartItemId, quantity } })
  }, [])

  const itemCount    = state.items.reduce((sum, item) => sum + item.quantity, 0)
  const subtotalPence = state.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  )

  return (
    <CartContext.Provider
      value={{
        ...state,
        addItem,
        removeItem,
        updateQuantity,
        clearCart: () => dispatch({ type: 'CLEAR_CART' }),
        openCart:  () => dispatch({ type: 'OPEN_CART' }),
        closeCart: () => dispatch({ type: 'CLOSE_CART' }),
        itemCount,
        subtotalPence,
        refreshInventoryCaps,
      }}
    >
      {children}
    </CartContext.Provider>
  )
}

// ─── HOOK ────────────────────────────────────────────────────────────────────

export function useCart(): CartContextValue {
  const context = useContext(CartContext)
  if (!context) {
    throw new Error('useCart must be used within a CartProvider')
  }
  return context
}
