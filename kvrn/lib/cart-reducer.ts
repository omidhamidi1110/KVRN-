// lib/cart-reducer.ts — CartContext reducer, extracted for testability
// No hooks, no browser APIs, no 'use client'. Pure data-transformation.
// Imported by context/CartContext.tsx (runtime) and lib/__tests__/ (tests).

import type { CartItem } from '@/types'
import { dropIncompleteBundles, maxSetQuantity } from './bundle-cart'

export interface CartState {
  items: CartItem[]
  isOpen: boolean
}

export type CartAction =
  | { type: 'ADD_ITEM';       payload: CartItem }
  | { type: 'REMOVE_ITEM';    payload: { cartItemId: string } }
  | { type: 'UPDATE_QUANTITY'; payload: { cartItemId: string; quantity: number } }
  | { type: 'CLEAR_CART' }
  | { type: 'OPEN_CART' }
  | { type: 'CLOSE_CART' }
  | { type: 'HYDRATE';        payload: CartItem[] }
  // Bundle ("Complete the Set"): a set is added/changed/removed as ONE unit (see lib/bundle-cart.ts)
  | { type: 'ADD_BUNDLE';     payload: CartItem[] }
  | { type: 'REMOVE_BUNDLE';  payload: { bundleId: string } }
  | { type: 'UPDATE_BUNDLE_QUANTITY'; payload: { bundleId: string; quantity: number } }
  // Server quote applied to a set already in the bag (new net prices); see CartContext.refreshBundles
  | { type: 'APPLY_BUNDLE_QUOTE'; payload: { bundleId: string; lines: Array<{ productId: string; priceCents: number; netUnitCents: number }>; setNetCents: number; setSubtotalCents: number } }
  | {
      type:    'REFRESH_CAPS'
      payload: Array<{ cartItemId: string; availableQuantity: number }>
    }

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'HYDRATE':
      // A saved bag can never hold a partial set (dropIncompleteBundles returns the same array when
      // no bundle line exists, so carts saved before bundles existed load exactly as before).
      return { ...state, items: dropIncompleteBundles(action.payload) }

    case 'ADD_BUNDLE': {
      // One set per bag: a new set replaces the previous one. Ordinary lines are untouched.
      const lines = action.payload.filter(i => i.bundle)
      if (lines.length === 0) return state
      return { ...state, items: [...state.items.filter(i => !i.bundle), ...lines], isOpen: true }
    }

    case 'APPLY_BUNDLE_QUOTE': {
      const { bundleId, lines, setNetCents, setSubtotalCents } = action.payload
      const byProduct = new Map(lines.map(l => [l.productId, l]))
      return {
        ...state,
        items: state.items.map(i => {
          if (i.bundle?.bundleId !== bundleId) return i
          const l = byProduct.get(i.bundle.componentProductId)
          if (!l) return i
          return { ...i, price: l.priceCents, bundle: { ...i.bundle, netUnitCents: l.netUnitCents, setNetCents, setSubtotalCents } }
        }),
      }
    }

    case 'REMOVE_BUNDLE':
      return { ...state, items: state.items.filter(i => i.bundle?.bundleId !== action.payload.bundleId) }

    case 'UPDATE_BUNDLE_QUANTITY': {
      const lines = state.items.filter(i => i.bundle?.bundleId === action.payload.bundleId)
      if (lines.length === 0) return state
      if (action.payload.quantity <= 0) {
        return { ...state, items: state.items.filter(i => i.bundle?.bundleId !== action.payload.bundleId) }
      }
      const q = Math.min(action.payload.quantity, maxSetQuantity(lines))
      if (q <= 0) return state
      return { ...state, items: state.items.map(i => i.bundle?.bundleId === action.payload.bundleId ? { ...i, quantity: q } : i) }
    }

    case 'REFRESH_CAPS': {
      // cap=0: item is sold out — remove it (never leave quantity:0 in cart).
      // cap>0: clamp quantity to new cap and store updated availableQuantity.
      // Items not in the payload are left untouched.
      const capMap = new Map(action.payload.map(c => [c.cartItemId, c.availableQuantity]))
      const refreshed = state.items
        .map(item => {
          const cap = capMap.get(item.cartItemId)
          if (cap === undefined) return item    // not in refresh batch — unchanged
          if (cap === 0)         return null    // sold out — mark for removal
          return { ...item, availableQuantity: cap, quantity: Math.min(item.quantity, cap) }
        })
        .filter((item): item is CartItem => item !== null)
      // A set whose component sold out (or was clamped unevenly) is dropped / re-synced as a whole.
      return { ...state, items: syncBundleQuantities(dropIncompleteBundles(refreshed)) }
    }

    case 'ADD_ITEM': {
      const existingIndex = state.items.findIndex(
        item => item.cartItemId === action.payload.cartItemId
      )
      if (existingIndex >= 0) {
        // Existing line: refresh availableQuantity from the latest PDP fetch,
        // then increment and clamp. Prevents stale localStorage caps from
        // surviving across deploys or inventory changes.
        const updatedItems = state.items.map((item, i) => {
          if (i !== existingIndex) return item
          const freshCap = action.payload.availableQuantity ?? item.availableQuantity ?? Infinity
          const newQty   = Math.min(item.quantity + action.payload.quantity, freshCap)
          return {
            ...item,
            availableQuantity: freshCap === Infinity ? undefined : freshCap,
            quantity: newQty,
          }
        })
        return { ...state, items: updatedItems, isOpen: true }
      }
      return { ...state, items: [...state.items, action.payload], isOpen: true }
    }

    case 'REMOVE_ITEM': {
      // Removing one line of a set removes the whole set (a partial set must never be bought).
      const target = state.items.find(item => item.cartItemId === action.payload.cartItemId)
      if (target?.bundle) {
        return { ...state, items: state.items.filter(item => item.bundle?.bundleId !== target.bundle!.bundleId) }
      }
      return {
        ...state,
        items: state.items.filter(item => item.cartItemId !== action.payload.cartItemId),
      }
    }

    case 'UPDATE_QUANTITY': {
      const target = state.items.find(item => item.cartItemId === action.payload.cartItemId)
      if (target?.bundle) {
        return cartReducer(state, { type: 'UPDATE_BUNDLE_QUANTITY', payload: { bundleId: target.bundle.bundleId, quantity: action.payload.quantity } })
      }
      if (action.payload.quantity <= 0) {
        return {
          ...state,
          items: state.items.filter(item => item.cartItemId !== action.payload.cartItemId),
        }
      }
      return {
        ...state,
        items: state.items.map(item => {
          if (item.cartItemId !== action.payload.cartItemId) return item
          const cap = item.availableQuantity ?? Infinity
          return { ...item, quantity: Math.min(action.payload.quantity, cap) }
        }),
      }
    }

    case 'CLEAR_CART':  return { ...state, items: [] }
    case 'OPEN_CART':   return { ...state, isOpen: true }
    case 'CLOSE_CART':  return { ...state, isOpen: false }
    default:            return state
  }
}

/**
 * The quantity an ADD_ITEM would ACTUALLY add to the cart, using exactly the reducer's own
 * semantics (a new line is added as requested; an existing line is incremented and clamped to
 * the freshest availableQuantity). Pure: no side effects, does not run the reducer's business
 * logic differently — it mirrors it. Returns 0 when nothing would be added (already at the
 * cap, a stale line above the cap, or an invalid request). Used to record funnel analytics only
 * for adds that really increased the cart.
 */
export function computeAddedQuantity(items: CartItem[], payload: CartItem): number {
  const requested = payload.quantity
  if (!Number.isInteger(requested) || requested < 1) return 0
  const existing = items.find(item => item.cartItemId === payload.cartItemId)
  if (!existing) return requested
  const freshCap = payload.availableQuantity ?? existing.availableQuantity ?? Infinity
  const newQty = Math.min(existing.quantity + requested, freshCap)
  return Math.max(0, newQty - existing.quantity)
}

/** Keep every line of a set at the same quantity (the smallest after a stock clamp). */
function syncBundleQuantities(items: CartItem[]): CartItem[] {
  if (!items.some(i => i.bundle)) return items
  const mins = new Map<string, number>()
  for (const i of items) {
    if (!i.bundle) continue
    mins.set(i.bundle.bundleId, Math.min(mins.get(i.bundle.bundleId) ?? Infinity, i.quantity))
  }
  return items.map(i => i.bundle && i.quantity !== mins.get(i.bundle.bundleId) ? { ...i, quantity: mins.get(i.bundle.bundleId)! } : i)
}
