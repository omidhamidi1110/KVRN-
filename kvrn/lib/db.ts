// lib/db.ts — Neon serverless connection
// DATABASE_URL must never reach the browser — server-only
import { neon } from '@neondatabase/serverless'

// Use a placeholder during build so the app still compiles without DATABASE_URL
// At runtime the real value is required
const dbUrl = process.env.DATABASE_URL ?? ''
export const sql = neon(dbUrl || 'postgresql://placeholder:placeholder@placeholder/placeholder')

export type Product = {
  id:           string
  drop_code:    string
  product_code: string
  name:         string
  slug:         string
  description:  string | null
  price_cents:  number
  currency:     string
  active:       boolean
  created_at:   string
  updated_at:   string
}

export type ProductVariant = {
  id:                string
  product_id:        string
  sku:               string
  color_name:        string
  color_code:        string
  size:              string
  size_sort:         number
  stock_on_hand:     number
  reserved_quantity: number
  available_quantity: number  // computed: stock_on_hand - reserved_quantity
  active:            boolean
  image_set:         string | null
  stripe_product_id: string | null
  stripe_price_id:   string | null
  created_at:        string
  updated_at:        string
  // joined from products
  product_name?:     string
  product_slug?:     string
  price_cents?:      number
}
