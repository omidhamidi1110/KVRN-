// app/api/internal/marketing-sync/route.ts
// Called by the Cloudflare cron to process pending Resend contact syncs.
// Protected by CRON_SECRET — not public.
import { type NextRequest, NextResponse } from 'next/server'
import { getPendingSyncs, getVerifiedResendOptIn, getMarketingSyncState, updateSyncStatus, suppressMarketingEmailFromResendTopic } from '@/lib/marketing-subscribers'
import { syncOnePendingSubscriber, syncUnsubscribeFromResend } from '@/lib/resend-marketing'

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
  if (!cronSecret || (process.env.NODE_ENV === 'production' && cronSecret.trim().length < 32)) {
    return NextResponse.json({ error: 'Not configured.' }, { status: 503, headers: NO_STORE })
  }
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ') || !timingSafeEqual(auth.slice(7), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE })
  }

  // A configured API key alone must never activate provider marketing synchronization.
  // This guard does not affect transactional receipts or service-related email.
  if (process.env.RESEND_MARKETING_CONTACT_SYNC_ENABLED !== 'true') {
    return NextResponse.json({ disabled: true, processed: 0 }, { headers: NO_STORE })
  }
  try {
    const pending = await getPendingSyncs(BATCH_LIMIT, process.env.RESEND_MARKETING_OPT_IN_SYNC_ENABLED === 'true')
    let synced = 0, failed = 0, skipped = 0

    for (const sub of pending) {
      try {
        let current = sub
        if (sub.status === 'subscribed') {
          // Marketing signup assertions are NOT proof of mailbox ownership.
          // This separate switch must be explicitly approved before even syncing
          // subscribed contacts to the provider. Unsubscribes still flow when
          // only RESEND_MARKETING_CONTACT_SYNC_ENABLED is on.
          if (process.env.RESEND_MARKETING_OPT_IN_SYNC_ENABLED !== 'true') { skipped++; continue }
          const verified = await getVerifiedResendOptIn(sub.id)
          if (!verified) { skipped++; continue }
          current = verified
        }
        const result = await syncOnePendingSubscriber(current)
        if (current.status === 'subscribed' && result.providerTopicOptOut === true) {
          // Resend is authoritative for its own topic preference. Record an
          // actual KVRN marketing STOP, never merely a sync failure that a
          // later broadcast might mistake for a consenting subscriber.
          if (!result.contactId) throw Error('PROVIDER_TOPIC_ID_UNKNOWN')
          await suppressMarketingEmailFromResendTopic(current.id, current.email, result.contactId)
          await updateSyncStatus(current.id, 'failed', result.contactId,
            'Provider topic opted out; reconcile segment removal.', 'unsubscribed')
          failed++
          continue
        }
        if (current.status === 'subscribed' && await getMarketingSyncState(current.id) !== 'subscribed') {
          // STOP arrived while the external opt-in request was in flight.
          // Attempt immediate provider suppression; always keep local STOP in force.
          const rollback = await syncUnsubscribeFromResend({ contactId: result.contactId ?? current.resendContactId, email: current.email })
          await updateSyncStatus(current.id, rollback.ok ? 'synced' : 'failed', result.contactId ?? current.resendContactId,
            rollback.ok ? null : rollback.error, 'unsubscribed')
          if (rollback.ok) synced++; else failed++
          continue
        }
        await updateSyncStatus(current.id, result.ok ? 'synced' : 'failed', result.contactId, result.ok ? null : result.error, current.status)
        if (result.ok) synced++; else failed++
      } catch (err: any) {
        failed++
        try { await updateSyncStatus(sub.id, 'failed', null, 'Provider sync failed', sub.status) } catch {}
      }
    }

    return NextResponse.json({ processed: pending.length, synced, failed, skipped }, { headers: NO_STORE })
  } catch (err: any) {
    console.error('[marketing-sync] Processing failed (redacted)')
    return NextResponse.json({ error: 'Processing failed.' }, { status: 500, headers: NO_STORE })
  }
}
