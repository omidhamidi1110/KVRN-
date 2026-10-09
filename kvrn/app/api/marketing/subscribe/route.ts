// app/api/marketing/subscribe/route.ts
// Unified marketing subscribe endpoint.
// Public email enrollment requires an affirmative checkbox; SMS is entirely separate.
// Consent is recorded in Neon; provider sync is independently gated through cron.
import { type NextRequest, NextResponse } from 'next/server'
import { normaliseEmail, upsertSubscriber } from '@/lib/marketing-subscribers'
import { validatePublicEmailConsent } from '@/lib/marketing-email-consent'
import { readLimitedJson } from '@/lib/limited-json-request'
import { allowPublicApiRequest } from '@/lib/public-api-rate-limit'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    try {
      const allowed = await allowPublicApiRequest(sql, { bucket: 'marketing_subscribe', headers: req.headers, limit: 8, windowSeconds: 600 })
      if (!allowed) return NextResponse.json({ success: false, error: 'Too many attempts.' }, { status: 429, headers: { 'Retry-After': '600' } })
    } catch { return NextResponse.json({ success: false, error: 'Subscription temporarily unavailable.' }, { status: 503 }) }
  }
  const read = await readLimitedJson(req, 2048)
  if (!read.ok || !read.value || typeof read.value !== 'object' || Array.isArray(read.value)) {
    return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: read.ok ? 400 : read.status })
  }
  const body = read.value as Record<string, unknown>
  const rawEmail = body.email
  if (typeof rawEmail !== 'string' || !rawEmail.trim()) {
    return NextResponse.json({ success: false, error: 'Email is required.' }, { status: 400 })
  }
  const email = normaliseEmail(rawEmail)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return NextResponse.json({ success: false, error: 'A valid email address is required.' }, { status: 400 })
  }

  const consent = validatePublicEmailConsent(body, 'homepage')
  if (!consent.ok) return NextResponse.json({ success: false, error: consent.error }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

  const firstName = typeof body.firstName === 'string' ? body.firstName.trim().slice(0, 80) || null : null
  const lastName  = typeof body.lastName  === 'string' ? body.lastName.trim().slice(0, 80)  || null : null

  // ── Store consent in Neon first (source of truth) ──────────────────────
  try {
    await upsertSubscriber({ email, firstName, lastName, consentSource: consent.source })
  } catch {
    // DB errors can contain customer information; do not print the error string.
    return NextResponse.json({ success: false, error: 'Subscription could not be saved. Please try again.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  // Sync is cron-only and gated until verified provider configuration/consent.
  return NextResponse.json({ success: true })
}
