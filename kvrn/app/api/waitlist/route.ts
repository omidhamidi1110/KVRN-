// KVRN waitlist = email only. Phone data in a web request is NEVER marketing SMS consent.
// A real inbound Twilio JOIN->YES confirmation has a separate, gated flow.
import { NextRequest, NextResponse } from 'next/server'
import { normaliseEmail, upsertSubscriber } from '@/lib/marketing-subscribers'
import { validatePublicEmailConsent } from '@/lib/marketing-email-consent'
import { readLimitedJson } from '@/lib/limited-json-request'
import { allowPublicApiRequest } from '@/lib/public-api-rate-limit'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    try {
      const ok = await allowPublicApiRequest(sql, { bucket: 'waitlist_email_signup', headers: req.headers, limit: 8, windowSeconds: 600 })
      if (!ok) return NextResponse.json({ success: false, error: 'Too many attempts.' }, { status: 429, headers: { ...noStore, 'Retry-After': '600' } })
    } catch { return NextResponse.json({ success: false, error: 'Temporarily unavailable.' }, { status: 503, headers: noStore }) }
  }
  const read = await readLimitedJson(req, 2048)
  if (!read.ok || typeof read.value !== 'object' || !read.value || Array.isArray(read.value)) {
    return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: read.ok ? 400 : read.status, headers: noStore })
  }
  const body = read.value as Record<string, unknown>
  if (typeof body.email !== 'string') return NextResponse.json({ success: false, error: 'Valid email required.' }, { status: 400, headers: noStore })
  const email = normaliseEmail(body.email)
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ success: false, error: 'Valid email required.' }, { status: 400, headers: noStore })
  }
  const consent = validatePublicEmailConsent(body, 'waitlist')
  if (!consent.ok) return NextResponse.json({ success: false, error: consent.error }, { status: 400, headers: noStore })
  try {
    await upsertSubscriber({ email, consentSource: consent.source })
  } catch {
    return NextResponse.json({ success: false, error: 'Unable to save signup. Try again.' }, { status: 503, headers: noStore })
  }
  // Contact sync is performed by the authenticated, permissioned marketing cron.
  // The public form never connects directly to a provider or dispatches mail.
  return NextResponse.json({ success: true }, { headers: noStore })
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405, headers: noStore })
}
