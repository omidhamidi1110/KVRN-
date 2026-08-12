// app/api/marketing/subscribe/route.ts
// Unified marketing subscribe endpoint.
// Source is determined server-side from the request body allowlist — never trusted blindly.
// Consent stored in Neon first; Resend sync is best-effort.
import { type NextRequest, NextResponse } from 'next/server'
import { normaliseEmail, upsertSubscriber, updateSyncStatus, ALLOWED_CONSENT_SOURCES } from '@/lib/marketing-subscribers'
import { syncSubscribeToResend } from '@/lib/resend-marketing'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: 400 })
  }

  const rawEmail = body.email
  if (typeof rawEmail !== 'string' || !rawEmail.trim()) {
    return NextResponse.json({ success: false, error: 'Email is required.' }, { status: 400 })
  }
  const email = normaliseEmail(rawEmail)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return NextResponse.json({ success: false, error: 'A valid email address is required.' }, { status: 400 })
  }

  // Server determines the consent source — allowlisted only
  const rawSource = body.source ?? 'homepage'
  const source    = ALLOWED_CONSENT_SOURCES.has(rawSource) ? rawSource : 'homepage'

  const firstName = typeof body.firstName === 'string' ? body.firstName.trim().slice(0, 80) || null : null
  const lastName  = typeof body.lastName  === 'string' ? body.lastName.trim().slice(0, 80)  || null : null

  // ── Store consent in Neon first (source of truth) ──────────────────────
  let subscriberId: string
  try {
    const result = await upsertSubscriber({ email, firstName, lastName, consentSource: source })
    subscriberId = result.id
  } catch (err: any) {
    console.error('[marketing/subscribe] DB error:', err?.message?.slice(0, 80))
    return NextResponse.json({ success: false, error: 'Subscription could not be saved. Please try again.' }, { status: 500 })
  }

  // ── Sync to Resend (best-effort — DB consent already committed) ─────────
  try {
    const sync = await syncSubscribeToResend({ email, firstName, lastName })
    await updateSyncStatus(subscriberId, sync.ok ? 'synced' : 'failed', sync.contactId, sync.ok ? null : sync.error)
  } catch (err: any) {
    // Non-fatal — log and move on; cron will retry
    console.error('[marketing/subscribe] Resend sync failed (non-fatal):', err?.message?.slice(0, 80))
    try { await updateSyncStatus(subscriberId, 'failed', null, 'Sync exception') } catch {}
  }

  return NextResponse.json({ success: true })
}
