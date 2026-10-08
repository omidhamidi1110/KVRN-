// lib/affiliate-portal-http.ts — small response helpers shared by every /api/affiliate/* handler.
// Server-only.
import { NextResponse } from 'next/server'
import { assertPortalPayloadSafe, PortalPrivacyError } from '@/lib/affiliate-portal-privacy'
import { NO_STORE } from '@/lib/affiliate-auth-guard'

/**
 * JSON response for a portal payload. Every payload passes the privacy scan (forbidden key patterns at any depth);
 * a violation is a SERVER bug and becomes a generic 500 — the offending data is never sent.
 */
export function portalJson(payload: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  try {
    assertPortalPayloadSafe(payload)
  } catch (err) {
    if (err instanceof PortalPrivacyError) console.error('[affiliate-portal] payload blocked by privacy scan:', err.message.slice(0, 120))
    return NextResponse.json({ error: 'Temporarily unavailable.' }, { status: 500, headers: NO_STORE })
  }
  return NextResponse.json(payload, { status, headers: { ...NO_STORE, ...headers } })
}

/** Read a small JSON body; null on anything unexpected (too large, not an object, invalid JSON). */
export async function readSmallJson(req: Request, maxBytes = 8 * 1024): Promise<Record<string, any> | null> {
  try {
    const text = await req.text()
    if (text.length > maxBytes) return null
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
