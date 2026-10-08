// lib/affiliate-program-http.ts — small shared helpers for the affiliate-program HTTP routes.
import { NextResponse } from 'next/server'
import { ProgramError, toProgramError } from './affiliate-program'
import { getEmailProvider } from './resend-adapter'
import { pendingOutboxIds, sendQueuedAffiliateEmails } from './affiliate-program-email'

export const NO_STORE = { 'Cache-Control': 'no-store' }

/** Map a thrown error to a safe JSON response. Raw database text is never returned. */
export function programErrorResponse(err: unknown, tag: string): NextResponse {
  const pe = err instanceof ProgramError ? err : toProgramError(err)
  if (pe) return NextResponse.json({ error: pe.message, code: pe.code }, { status: pe.status, headers: NO_STORE })
  console.error(`[${tag}]`, String((err as any)?.message ?? err).slice(0, 120))
  return NextResponse.json({ error: 'Could not complete that action.' }, { status: 500, headers: NO_STORE })
}

export async function readJsonBody(req: Request, maxBytes = 64 * 1024): Promise<any | null> {
  try {
    const text = await req.text()
    if (text.length > maxBytes) return null
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

/** Best-effort send of the emails a state change just queued. Never throws, never alters state. */
export async function flushQueuedEmails(sql: any, f: { applicationId?: string | null; affiliateId?: string | null }): Promise<void> {
  try {
    const ids = await pendingOutboxIds(sql, f)
    await sendQueuedAffiliateEmails(sql, getEmailProvider, ids)
  } catch { /* the retry job will pick the rows up */ }
}
