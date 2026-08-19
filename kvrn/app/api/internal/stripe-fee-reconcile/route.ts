// app/api/internal/stripe-fee-reconcile/route.ts
// Triggered by the Cloudflare Cron Trigger every 5 minutes.
// Not public — requires CRON_SECRET in an Authorization: Bearer header.
// Returns only safe counts — no PII, no order ids, no Stripe identifiers.
//
// Reconciles the ACTUAL Stripe processing fee for paid orders that do not have one
// yet. Fees are never estimated; an order stays unreconciled until Stripe reports
// a real balance transaction, and the financial layer labels it as such.

import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { getStripe } from '@/lib/stripe-client'
import { reconcilePendingStripeFees } from '@/lib/stripe-fees'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const BATCH_LIMIT = 20

/** Timing-safe string comparison using XOR over char codes. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
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
    return NextResponse.json(
      { error: 'Reconciliation endpoint is not configured.' },
      { status: 503, headers: NO_STORE }
    )
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE })
  }
  if (!timingSafeEqual(authHeader.slice('Bearer '.length), cronSecret)) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403, headers: NO_STORE })
  }

  let stripe: ReturnType<typeof getStripe>
  try {
    stripe = getStripe()
  } catch {
    // Stripe not configured in this environment — nothing to do, not an error.
    return NextResponse.json(
      { processed: 0, enriched: 0, notSettled: 0, failed: 0, skipped: 'stripe_unconfigured' },
      { headers: NO_STORE }
    )
  }

  try {
    const result = await reconcilePendingStripeFees({
      sql,
      stripe,
      limit: BATCH_LIMIT,
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (err: any) {
    console.error('[fee-reconcile] batch failed:', err?.message?.slice(0, 100))
    return NextResponse.json(
      { error: 'Reconciliation batch failed.' },
      { status: 500, headers: NO_STORE }
    )
  }
}
