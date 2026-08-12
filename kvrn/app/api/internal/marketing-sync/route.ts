// app/api/internal/marketing-sync/route.ts
// Called by the Cloudflare cron to process pending Resend contact syncs.
// Protected by CRON_SECRET — not public.
import { type NextRequest, NextResponse } from 'next/server'
import { getPendingSyncs, updateSyncStatus } from '@/lib/marketing-subscribers'
import { syncOnePendingSubscriber } from '@/lib/resend-marketing'

export const dynamic = 'force-dynamic'
const NO_STORE   = { 'Cache-Control': 'no-store' }
const BATCH_LIMIT = 25

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    let r = 1
    for (let i = 0; i < a.length; i++) r |= (a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0))
    return false
  }
  let r = 0
  for (let i = 0; i < a.length; i++) r |= (a.charCodeAt(i) ^ b.charCodeAt(i))
  return r === 0
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET ?? ''
  if (!cronSecret) {
    return NextResponse.json({ error: 'Not configured.' }, { status: 503, headers: NO_STORE })
  }
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ') || !timingSafeEqual(auth.slice(7), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE })
  }

  try {
    const pending = await getPendingSyncs(BATCH_LIMIT)
    let synced = 0, failed = 0

    for (const sub of pending) {
      try {
        const result = await syncOnePendingSubscriber(sub)
        await updateSyncStatus(sub.id, result.ok ? 'synced' : 'failed', result.contactId, result.ok ? null : result.error)
        if (result.ok) synced++; else failed++
      } catch (err: any) {
        failed++
        try { await updateSyncStatus(sub.id, 'failed', null, err?.message?.slice(0, 80)) } catch {}
      }
    }

    return NextResponse.json({ processed: pending.length, synced, failed }, { headers: NO_STORE })
  } catch (err: any) {
    console.error('[marketing-sync] Error:', err?.message?.slice(0, 80))
    return NextResponse.json({ error: 'Processing failed.' }, { status: 500, headers: NO_STORE })
  }
}
