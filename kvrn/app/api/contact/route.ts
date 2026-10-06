// POST /api/contact — storefront contact form → KVRN Support inbox
//
// The message is stored in the support inbox (Admin → Support) FIRST. The route returns success
// ONLY if that database write succeeded; if it could not be persisted the customer is told so
// and nothing claims "sent". The owner notification email is a convenience copy and is
// fail-open: the database copy is authoritative.
//
// SUPPORT_FORWARD_TO is read on the server only and is never returned to the browser.
// No customer-facing auto-acknowledgement is sent: a public form that emails whatever address
// was typed into it is a spam relay, and the page already states the response time.
import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { sendContactNotification } from '@/lib/support-email'
import {
  SUPPORT_LIMITS, SupportError, createSupportService, validateContactSubmission,
} from '@/lib/support-inbox'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  }

  const v = validateContactSubmission(body)
  if (!v.ok) {
    return NextResponse.json({ success: false, error: v.error }, { status: 400, headers: NO_STORE })
  }
  const c = v.value

  const service = createSupportService(sql)
  try {
    const rate = await service.contactRate(c.email)
    if (rate.perEmail >= SUPPORT_LIMITS.CONTACT_PER_EMAIL_PER_HOUR || rate.global >= SUPPORT_LIMITS.CONTACT_GLOBAL_PER_HOUR) {
      return NextResponse.json(
        { success: false, error: 'Too many messages right now. Please try again later.' },
        { status: 429, headers: NO_STORE })
    }
    const stored = await service.recordContactSubmission(c)

    // Fail-open owner copy — only for a NEW submission (a duplicate was already notified).
    if (!stored.duplicate) {
      try {
        const outcome = await sendContactNotification(c)
        if (outcome === 'failed') console.error('[contact] owner notification failed (message is stored in Admin → Support)')
      } catch { console.error('[contact] owner notification error (message is stored in Admin → Support)') }
    }
    return NextResponse.json({ success: true }, { status: 200, headers: NO_STORE })
  } catch (err) {
    // The message was NOT persisted: never report success.
    console.error('[contact] could not store message', err instanceof SupportError ? err.code : 'unexpected')
    return NextResponse.json(
      { success: false, error: 'We could not save your message. Please try again, or email support@kvrn.shop.' },
      { status: 500, headers: NO_STORE })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
}
