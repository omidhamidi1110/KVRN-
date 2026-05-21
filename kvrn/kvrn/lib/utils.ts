import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// ─── CLASS MERGING ────────────────────────────────────────────────────────────
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── PRICE FORMATTING ────────────────────────────────────────────────────────
export function formatPrice(pence: number): string {
  return `£${(pence / 100).toFixed(0)}`
}

export function formatPriceWithDecimal(pence: number): string {
  const amount = pence / 100
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
  }).format(amount)
}

// ─── CART ITEM ID ────────────────────────────────────────────────────────────
export function buildCartItemId(
  productId: string,
  color: string,
  size: string
): string {
  return `${productId}-${color}-${size}`
}

// ─── LOCAL STORAGE HELPERS ────────────────────────────────────────────────────
export function getFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const item = localStorage.getItem(key)
    return item ? (JSON.parse(item) as T) : fallback
  } catch {
    return fallback
  }
}

export function setInStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Silently fail — storage may be full or restricted
  }
}

// ─── SCROLL HELPERS ──────────────────────────────────────────────────────────
export function scrollToElement(selector: string): void {
  const element = document.querySelector(selector)
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

// ─── DELAY ───────────────────────────────────────────────────────────────────
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── TRUNCATE ────────────────────────────────────────────────────────────────
export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.slice(0, length) + '...'
}

// ─── VALIDATION ──────────────────────────────────────────────────────────────
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function isValidPhone(phone: string): boolean {
  // UK phone validation (flexible)
  return /^(\+44|0)[0-9]{9,10}$/.test(phone.replace(/\s/g, ''))
}

// ─── ORDINAL ─────────────────────────────────────────────────────────────────
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
