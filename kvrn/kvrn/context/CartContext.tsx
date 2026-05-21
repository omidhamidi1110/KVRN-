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

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface CartState {
  items: CartItem[]
  isOpen: boolean
}

type CartAction =
  | { type: 'ADD_ITEM'; payload: CartItem }
  | { type: 'REMOVE_ITEM'; payload: { cartItemId: string } }
  | { type: 'UPDATE_QUANTITY'; payload: { cartItemId: string; quantity: number } }
  | { type: 'CLEAR_CART' }
  | { type: 'OPEN_CART' }
  | { type: 'CLOSE_CART' }
  | { type: 'HYDRATE'; payload: CartItem[] }

interface CartContextValue extends CartState {
  addItem: (item: Omit<CartItem, 'cartItemId'>) => void
  removeItem: (cartItemId: string) => void
  updateQuantity: (cartItemId: string, quantity: number) => void
  clearCart: () => void
  openCart: () => void
  closeCart: () => void
  itemCount: number
  subtotalPence: number
}

// ─── REDUCER ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'kvrn_cart'

function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, items: action.payload }

    case 'ADD_ITEM': {
      const existingIndex = state.items.findIndex(
        (item) => item.cartItemId === action.payload.cartItemId
      )
      if (existingIndex >= 0) {
        // Increment quantity if same variant already in cart
        const updatedItems = state.items.map((item, i) =>
          i === existingIndex
            ? { ...item, quantity: item.quantity + action.payload.quantity }
            : item
        )
        return { ...state, items: updatedItems, isOpen: true }
      }
      return {
        ...state,
        items: [...state.items, action.payload],
        isOpen: true,
      }
    }

    case 'REMOVE_ITEM':
      return {
        ...state,
        items: state.items.filter(
          (item) => item.cartItemId !== action.payload.cartItemId
        ),
      }

    case 'UPDATE_QUANTITY': {
      if (action.payload.quantity <= 0) {
        return {
          ...state,
          items: state.items.filter(
            (item) => item.cartItemId !== action.payload.cartItemId
          ),
        }
      }
      return {
        ...state,
        items: state.items.map((item) =>
          item.cartItemId === action.payload.cartItemId
            ? { ...item, quantity: action.payload.quantity }
            : item
        ),
      }
    }

    case 'CLEAR_CART':
      return { ...state, items: [] }

    case 'OPEN_CART':
      return { ...state, isOpen: true }

    case 'CLOSE_CART':
      return { ...state, isOpen: false }

    default:
      return state
  }
}

// ─── CONTEXT ─────────────────────────────────────────────────────────────────

const CartContext = createContext<CartContextValue | null>(null)

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, {
    items: [],
    isOpen: false,
  })

  // Hydrate from localStorage on mount
  useEffect(() => {
    const stored = getFromStorage<CartItem[]>(STORAGE_KEY, [])
    if (stored.length > 0) {
      dispatch({ type: 'HYDRATE', payload: stored })
    }
  }, [])

  // Persist to localStorage on items change
  useEffect(() => {
    setInStorage(STORAGE_KEY, state.items)
  }, [state.items])

  // Close cart on escape key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.isOpen) {
        dispatch({ type: 'CLOSE_CART' })
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [state.isOpen])

  // Prevent body scroll when cart is open
  useEffect(() => {
    if (state.isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [state.isOpen])

  const addItem = useCallback(
    (item: Omit<CartItem, 'cartItemId'>) => {
      const cartItemId = buildCartItemId(item.productId, item.color, item.size)
      dispatch({ type: 'ADD_ITEM', payload: { ...item, cartItemId } })
    },
    []
  )

  const removeItem = useCallback((cartItemId: string) => {
    dispatch({ type: 'REMOVE_ITEM', payload: { cartItemId } })
  }, [])

  const updateQuantity = useCallback((cartItemId: string, quantity: number) => {
    dispatch({ type: 'UPDATE_QUANTITY', payload: { cartItemId, quantity } })
  }, [])

  const clearCart = useCallback(() => {
    dispatch({ type: 'CLEAR_CART' })
  }, [])

  const openCart = useCallback(() => {
    dispatch({ type: 'OPEN_CART' })
  }, [])

  const closeCart = useCallback(() => {
    dispatch({ type: 'CLOSE_CART' })
  }, [])

  const itemCount = state.items.reduce((sum, item) => sum + item.quantity, 0)

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
        clearCart,
        openCart,
        closeCart,
        itemCount,
        subtotalPence,
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
