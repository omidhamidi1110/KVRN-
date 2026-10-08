// lib/content-http.ts — shared plumbing for /api/admin/content/** routes.
//
// Each route handler calls `requireAdmin(req)` ITSELF as its first statement (the guard test
// reads the route source); this module only holds what comes after authentication:
// body parsing, the uniform error → response mapping, and the lazily created services.

import { NextResponse } from 'next/server'
import { sql } from './db'
import { createContentService, ContentError, toHttpError, type ContentService } from './content-service'
import { createCollectionsService, type CollectionsService } from './content-collections'
import { createSeoService, type SeoService } from './content-seo-service'
import { isContentKind, KINDS, type ContentKind } from './content-schemas'

let _svc: ContentService | null = null
let _cols: CollectionsService | null = null
let _seo: SeoService | null = null
export const contentSvc = () => (_svc ??= createContentService(sql))
export const collectionsSvc = () => (_cols ??= createCollectionsService(sql))
export const seoSvc = () => (_seo ??= createSeoService(sql))

export function parseKind(raw: string): ContentKind {
  if (!isContentKind(raw)) throw new ContentError('not_found', 'Unknown content type.')
  return raw
}

export const kindLabel = (k: ContentKind) => KINDS[k].label

/** JSON object body (max 2 MB). Anything else is a 400, never a 500. */
export async function readJson(req: Request): Promise<Record<string, any>> {
  let text = ''
  try { text = await req.text() } catch { throw new ContentError('invalid', 'Invalid request body.') }
  if (text.length > 2_000_000) throw new ContentError('invalid', 'That request is too large.')
  if (!text.trim()) return {}
  let v: unknown
  try { v = JSON.parse(text) } catch { throw new ContentError('invalid', 'Invalid request body.') }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ContentError('invalid', 'Invalid request body.')
  return v as Record<string, any>
}

/** The revision / version the editor loaded. Required for every state-changing call. */
export function expectRevision(v: unknown, label = 'revision'): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new ContentError('invalid', `Missing ${label}. Reload the page and try again.`)
  return n
}

/** Run a handler body and map the result / any error to a JSON response. */
export async function respond(fn: () => Promise<{ data?: unknown; invalidation?: unknown }>, status = 200): Promise<Response> {
  try {
    const r = await fn()
    return NextResponse.json({ success: true, data: r.data, invalidation: r.invalidation ?? null }, { status })
  } catch (e) {
    const h = toHttpError(e)
    if (h.status === 500) console.error('[content-api]', String((e as any)?.message ?? e).slice(0, 200))
    return NextResponse.json({ success: false, ...h.body }, { status: h.status })
  }
}
