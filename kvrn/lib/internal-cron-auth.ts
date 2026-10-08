// lib/internal-cron-auth.ts — shared CRON_SECRET bearer check for internal job routes.
// Fail closed: no secret configured → 503; missing/incorrect bearer → 401/403.
import { NextResponse, type NextRequest } from 'next/server'

const NO_STORE = { 'Cache-Control': 'no-store' }

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i % (a.length || 1)) ^ b.charCodeAt(i % (b.length || 1)))
  return diff === 0
}

/** Returns a Response to send when the caller is NOT authorised, or null when it is. */
export function requireCronSecret(req: NextRequest, env: Record<string, string | undefined> = process.env): NextResponse | null {
  const secret = env.CRON_SECRET ?? ''
  if (!secret || (env.NODE_ENV === 'production' && secret.trim().length < 32)) return NextResponse.json({ error: 'Job endpoint is not configured.' }, { status: 503, headers: NO_STORE })
  const h = req.headers.get('Authorization') ?? ''
  if (!h.startsWith('Bearer ')) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE })
  if (!timingSafeEqual(h.slice(7), secret)) return NextResponse.json({ error: 'Forbidden.' }, { status: 403, headers: NO_STORE })
  return null
}
