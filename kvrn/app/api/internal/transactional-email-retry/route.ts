// app/api/internal/transactional-email-retry/route.ts
// Triggered by Cloudflare Cron Trigger every 5 minutes.
// Not public — requires CRON_SECRET in Authorization: Bearer header.
// Returns only safe counts — no PII, no row IDs, no email addresses.

import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { getEmailProvider } from '@/lib/resend-adapter'
import { processPendingTransactionalEmails } from '@/lib/transactional-email'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const BATCH_LIMIT = 25

/** Timing-safe string comparison using XOR over char codes. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do full comparison to prevent timing leak on length difference
    let result = 1
    for (let i = 0; i < a.length; i++) {
      result |= (a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0))
    }
    return false
  }
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= (a.charCodeAt(i) ^ b.charCodeAt(i))
  }
  return result === 0
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET ?? ''
  if (!cronSecret) {
    // Fail closed — no secret means route is unusable
    return NextResponse.json(
      { error: 'Retry endpoint is not configured.' },
      { status: 503, headers: NO_STORE }
    )
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Unauthorized.' },
      { status: 401, headers: NO_STORE }
    )
  }
  const provided = authHeader.slice('Bearer '.length)
  if (!timingSafeEqual(provided, cronSecret)) {
    return NextResponse.json(
      { error: 'Forbidden.' },
      { status: 403, headers: NO_STORE }
    )
  }

  let provider: ReturnType<typeof getEmailProvider>
  try {
    provider = getEmailProvider()
  } catch (err: any) {
    console.error('[email-retry] Email provider not configured:', err?.message?.slice(0, 80))
    return NextResponse.json(
      { error: 'Email provider not configured.' },
      { status: 500, headers: NO_STORE }
    )
  }

  try {
    const result = await processPendingTransactionalEmails({ sql, provider, limit: BATCH_LIMIT })
    // Return safe counts only — no PII, no row IDs, no addresses
    return NextResponse.json(
      { processed: result.processed, sent: result.sent, failed: result.failed },
      { headers: NO_STORE }
    )
  } catch (err: any) {
    console.error('[email-retry] Processing failed:', err?.message?.slice(0, 80))
    return NextResponse.json(
      { error: 'Processing failed.' },
      { status: 500, headers: NO_STORE }
    )
  }
}
