/** Legacy unsubscribe URL retained for links already in circulation.
 * An unauthenticated `?email=` MUST NEVER identify an account or change consent.
 * GET never mutates state. RFC 8058 POST accepts an opaque signed contact token.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { verifyMarketingUnsubscribe } from '@/lib/marketing-unsubscribe'
import { revokeMarketingSubscriberById } from '@/lib/marketing-subscribers'
import { readLimitedText } from '@/lib/limited-json-request'
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' }
const tokenPattern = /^v1\.[A-Za-z0-9._-]{70,150}$/

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('t') ?? ''
  const destination = new URL('/email-preferences', req.nextUrl.origin)
  if (tokenPattern.test(token)) destination.searchParams.set('token', token)
  // An old ?email= link cannot be trusted to unsubscribe anybody.
  return NextResponse.redirect(destination, { status: 303, headers: NO_STORE })
}

/** One-click headers should link here with ?t=<signed-token>. Body per RFC 8058. */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('t') ?? ''
  const id = await verifyMarketingUnsubscribe(token)
  if (!id) return NextResponse.json({ error: 'Invalid subscription link.' }, { status: 400, headers: NO_STORE })
  const contentType = req.headers.get('content-type') ?? ''
  if (!/application\/x-www-form-urlencoded(?:\s*;|\s*$)/i.test(contentType)) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 415, headers: NO_STORE })
  }
  const data = await readLimitedText(req, 256)
  if (!data.ok || new URLSearchParams(data.value).get('List-Unsubscribe') !== 'One-Click') {
    return NextResponse.json({ error: 'Invalid one-click request.' }, { status: 400, headers: NO_STORE })
  }
  try {
    await revokeMarketingSubscriberById(id)
    return NextResponse.json({ success: true }, { headers: NO_STORE })
  } catch {
    return NextResponse.json({ error: 'Subscription update unavailable.' }, { status: 503, headers: NO_STORE })
  }
}
