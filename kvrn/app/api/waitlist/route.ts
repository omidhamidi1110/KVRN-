import { NextRequest, NextResponse } from 'next/server'
import { sendEmail, waitlistConfirmationHTML } from '@/lib/email'
import { normaliseEmail, upsertSubscriber, updateSyncStatus, ALLOWED_CONSENT_SOURCES } from '@/lib/marketing-subscribers'
import { syncSubscribeToResend } from '@/lib/resend-marketing'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      email,
      phone,
      smsConsent = false,
      dropId     = 'drop_001',
      source     = 'waitlist',
    } = body

    // ── Validate ──────────────────────────────────────────────────────────
    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'A valid email address is required.' }, { status: 400 })
    }

    const normEmail    = normaliseEmail(email)
    const consentSource = ALLOWED_CONSENT_SOURCES.has(source) ? source : 'waitlist'

    // ── Store marketing consent in Neon (source of truth) ─────────────────
    // If Neon fails, the explicit email marketing consent cannot be stored.
    // Return a failure — do not silently report success without stored consent.
    let subscriberId: string
    try {
      const result = await upsertSubscriber({ email: normEmail, consentSource })
      subscriberId = result.id
    } catch (dbErr: any) {
      console.error('[waitlist] DB error (consent not stored):', dbErr?.message?.slice(0, 80))
      return NextResponse.json(
        { success: false, error: 'Subscription could not be saved. Please try again.' },
        { status: 500 }
      )
    }

    // ── Sync to Resend (best-effort) ──────────────────────────────────────
    if (subscriberId) {
      try {
        const sync = await syncSubscribeToResend({ email: normEmail, firstName: null, lastName: null })
        await updateSyncStatus(subscriberId, sync.ok ? 'synced' : 'failed', sync.contactId, sync.ok ? null : sync.error)
      } catch (syncErr: any) {
        console.error('[waitlist] Resend sync failed (non-fatal):', syncErr?.message?.slice(0, 80))
        try { await updateSyncStatus(subscriberId, 'failed', null, 'Sync exception') } catch {}
      }
    }

    // ── Confirmation email (stub — kept for backward compat) ─────────────
    // In production, Resend Broadcasts handle promotional emails.
    // This stub call is a no-op (sendEmail is not yet wired for marketing).
    try {
      await sendEmail({
        to:      email.trim(),
        subject: "You're on the list.",
        html:    waitlistConfirmationHTML({ email: email.trim(), dropId }),
      })
    } catch {
      // Non-fatal stub
    }

    console.log(`[waitlist] ${normEmail} | drop: ${dropId} | source: ${consentSource} | sms: ${smsConsent}`)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[waitlist] Error:', err)
    return NextResponse.json({ success: false, error: 'Server error. Please try again.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
