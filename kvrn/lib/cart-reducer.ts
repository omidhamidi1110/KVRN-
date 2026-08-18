// lib/cart-reducer.ts — CartContext reducer, extracted for testability
// No hooks, no browser APIs, no 'use client'. Pure data-transformation.
// Imported by context/CartContext.tsx (runtime) and lib/__tests__/ (tests).

import type { CartItem } from '@/types'

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
  | {
      type:    'REFRESH_CAPS'
      payload: Array<{ cartItemId: string; availableQuantity: number }>
    }

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, items: action.payload }

    case 'REFRESH_CAPS': {
      // cap=0: item is sold out — remove it (never leave quantity:0 in cart).
      // cap>0: clamp quantity to new cap and store updated availableQuantity.
      // Items not in the payload are left untouched.
      const capMap = new Map(action.payload.map(c => [c.cartItemId, c.availableQuantity]))
      return {
        ...state,
        items: state.items
          .map(item => {
            const cap = capMap.get(item.cartItemId)
            if (cap === undefined) return item    // not in refresh batch — unchanged
            if (cap === 0)         return null    // sold out — mark for removal
            return { ...item, availableQuantity: cap, quantity: Math.min(item.quantity, cap) }
          })
          .filter((item): item is CartItem => item !== null),
      }
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

    case 'REMOVE_ITEM':
      return {
        ...state,
        items: state.items.filter(item => item.cartItemId !== action.payload.cartItemId),
      }

    case 'UPDATE_QUANTITY': {
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
