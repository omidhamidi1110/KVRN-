'use client'

import React, {
  createContext,
  useContext,
  useReducer,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react'
import type { CartItem } from '@/types'
import { buildCartItemId, getFromStorage, setInStorage } from '@/lib/utils'
import { cartReducer, computeAddedQuantity, type CartState, type CartAction } from '@/lib/cart-reducer'
import { bundleGroups, cartSubtotalCents, splitCartForCheckout } from '@/lib/bundle-cart'
import { trackAddToCartEvent } from '@/lib/funnel-client'
import { gaAddToCartWhenReady } from '@/lib/ga-client'

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
  /** Bundle ("Complete the Set"): add / change / remove the set as one unit. One set per bag. */
  addBundle: (lines: CartItem[]) => void
  removeBundle: (bundleId: string) => void
  updateBundleQuantity: (bundleId: string, quantity: number) => void
  /** Ask the server for the current price/availability of the set in the bag and apply it honestly. */
  refreshBundles: () => Promise<void>
  /** Plain-language note when a set's price changed or it was removed. Cleared by dismissBundleNotice. */
  bundleNotice: string | null
  dismissBundleNotice: () => void
}

// ─── CONTEXT / PROVIDER ──────────────────────────────────────────────────────

const STORAGE_KEY = 'kvrn_cart'

const CartContext = createContext<CartContextValue | null>(null)

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, {
    items: [],
    isOpen: false,
  })

  // Latest cart items, for deriving the actual quantity an add contributes (funnel analytics
  // only). Refreshed on every render and advanced synchronously by addItem so two adds in the
  // same tick each see the other.
  const itemsRef = useRef<CartItem[]>(state.items)
  itemsRef.current = state.items
  const [bundleNotice, setBundleNotice] = useState<string | null>(null)

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

  // ── Bundle refresh ─────────────────────────────────────────────────────────
  // The bag only DISPLAYS a set price; the server owns it. Re-quote the set from the published rule
  // and today's canonical prices: apply a changed price (and say so), or remove the set if it can no
  // longer be bought as a whole. Never throws; a network failure leaves the bag as it is (checkout
  // re-validates anyway).
  const refreshBundles = useCallback(async () => {
    const groups = bundleGroups(itemsRef.current)
    for (const g of groups) {
      if (!g.complete) continue
      try {
        const split = splitCartForCheckout(g.lines)
        if (!split.ok || !split.bundle) continue
        const res = await fetch('/api/bundles/quote', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ ...split.bundle, expectedSetNetCents: null }),
        })
        const data = await res.json().catch(() => null)
        if (data?.ok) {
          const changed = data.setNetCents !== g.lines[0].bundle!.setNetCents
          dispatch({ type: 'APPLY_BUNDLE_QUOTE', payload: {
            bundleId: g.bundleId, setNetCents: data.setNetCents, setSubtotalCents: data.setSubtotalCents,
            lines: data.lines.map((l: any) => ({ productId: l.productId, priceCents: l.originalUnitPriceCents, netUnitCents: l.netUnitPriceCents })),
          } })
          if (changed) setBundleNotice('The price of the set in your bag changed. The prices shown are today’s.')
        } else if (data && (res.status === 409 || res.status === 404)) {
          dispatch({ type: 'REMOVE_BUNDLE', payload: { bundleId: g.bundleId } })
          setBundleNotice(data.message || 'A set in your bag is no longer available and was removed.')
        }
      } catch { /* leave the bag unchanged; checkout re-validates */ }
    }
  }, [])

  // ── Hydration: read localStorage → dispatch HYDRATE → immediately refresh caps ──
  // Stored items are passed directly to refreshInventoryCaps to avoid effect-ordering
  // ambiguity: the refresh sees the freshly-read items without waiting for the
  // HYDRATE re-render (which is async from React's perspective).
  useEffect(() => {
    const stored = getFromStorage<CartItem[]>(STORAGE_KEY, [])
    if (stored.length > 0) {
      dispatch({ type: 'HYDRATE', payload: stored })
      setTimeout(() => { void refreshInventoryCaps(stored) }, 300)
      if (stored.some(i => i && i.bundle)) setTimeout(() => { void refreshBundles() }, 600)
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
    const payload: CartItem = { ...item, cartItemId }
    // Funnel analytics must record what the reducer will ACTUALLY add (it clamps an existing
    // line to availableQuantity), so derive the delta from the current cart BEFORE dispatching.
    // The reducer itself is untouched.
    const added = computeAddedQuantity(itemsRef.current, payload)
    dispatch({ type: 'ADD_ITEM', payload })
    itemsRef.current = cartReducer({ items: itemsRef.current, isOpen: false }, { type: 'ADD_ITEM', payload }).items
    // addItem is the single place an item enters the cart (product page, quick-add, set bundle).
    // Consent-gated and fire-and-forget; only a real increase (delta > 0) is recorded.
    if (added > 0) {
      trackAddToCartEvent({ slug: item.slug, sku: item.sku, quantity: added })
      // GA4 add_to_cart: the SAME delta (what the cart actually gained after stock clamping).
      gaAddToCartWhenReady({ slug: item.slug, name: item.productName, sku: item.sku, priceCents: item.price, quantity: added })
    }
  }, [])

  const removeItem = useCallback((cartItemId: string) => {
    dispatch({ type: 'REMOVE_ITEM', payload: { cartItemId } })
  }, [])

  const updateQuantity = useCallback((cartItemId: string, quantity: number) => {
    dispatch({ type: 'UPDATE_QUANTITY', payload: { cartItemId, quantity } })
  }, [])

  const addBundle = useCallback((lines: CartItem[]) => {
    dispatch({ type: 'ADD_BUNDLE', payload: lines })
    // Same analytics rule as addItem: record what really entered the bag, at the net price charged.
    for (const l of lines) {
      trackAddToCartEvent({ slug: l.slug, sku: l.sku, quantity: l.quantity })
      gaAddToCartWhenReady({ slug: l.slug, name: l.productName, sku: l.sku, priceCents: l.bundle ? l.bundle.netUnitCents : l.price, quantity: l.quantity })
    }
  }, [])
  const removeBundle = useCallback((bundleId: string) => { dispatch({ type: 'REMOVE_BUNDLE', payload: { bundleId } }) }, [])
  const updateBundleQuantity = useCallback((bundleId: string, quantity: number) => {
    dispatch({ type: 'UPDATE_BUNDLE_QUANTITY', payload: { bundleId, quantity } })
  }, [])

  const itemCount    = state.items.reduce((sum, item) => sum + item.quantity, 0)
  // Bundle lines are charged at their allocated net price; ordinary lines at their own price.
  const subtotalPence = cartSubtotalCents(state.items)

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
        addBundle,
        removeBundle,
        updateBundleQuantity,
        refreshBundles,
        bundleNotice,
        dismissBundleNotice: () => setBundleNotice(null),
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
