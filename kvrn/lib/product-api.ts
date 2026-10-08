// lib/product-api.ts — shared plumbing for the Admin product API routes (server only).
// Authentication is NOT done here: every route handler calls requireAdmin(req) itself, first.
import { NextResponse } from 'next/server'
import { sql } from './db'
import { createProductService, errorResponse, type ProductService } from './product-service'

let svc: ProductService | null = null
export function productService(): ProductService { return (svc ??= createProductService(sql)) }

const NO_STORE = { 'Cache-Control': 'no-store' }

export function ok(body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ success: true, ...body }, { status, headers: NO_STORE })
}
export function bad(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status, headers: NO_STORE })
}
/** Typed service errors -> HTTP (stale 409, blocked 422 with the exact blocker list, ...). */
export function fail(e: unknown) {
  const r = errorResponse(e)
  if (r.status >= 500) console.error('product api error:', (e as Error)?.message)
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE })
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json()
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  } catch { return null }
}

export function asRevision(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000_000 ? v : null
}

export function asDate(v: unknown): Date | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') return 'invalid'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? 'invalid' : d
}
