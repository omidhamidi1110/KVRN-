// POST /api/analytics/event — PUBLIC, first-party funnel event ingestion.
//
// Accepts only the three browser-originated stages (session_start, product_viewed,
// add_to_cart). checkout_started and purchase_completed are written by server code on the
// checkout and paid-order paths and are NOT accepted here.
//
// Deliberately narrow: same-origin only, tiny body, strict allowlist (unknown event names and
// unknown fields are rejected, so there is nowhere to smuggle PII or a JSON blob), bots and
// internal paths dropped, per-session cap. It never returns database details, and a failure
// is invisible to the shopper: analytics is best-effort and must never affect the storefront.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import {
  validateClientEvent, createFunnelService, isLikelyBot, MAX_BODY_BYTES,
} from '@/lib/funnel-analytics'

export const dynamic = 'force-dynamic'

const noContent = () => new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
const reject = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })

/** Same-origin check. A browser always sends Origin on a POST; a request without one is not from our pages. */
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return false
  let o: URL
  try { o = new URL(origin) } catch { return false }
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host
  if (o.host === host) return true
  const site = process.env.NEXT_PUBLIC_SITE_URL
  if (site) { try { return new URL(site).host === o.host } catch { /* fall through */ } }
  return false
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return reject(403, 'Forbidden.')
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return reject(415, 'Unsupported media type.')
  }

  let text: string
  try { text = await req.text() } catch { return reject(400, 'Invalid event.') }
  if (text.length > MAX_BODY_BYTES) return reject(413, 'Payload too large.')

  let body: unknown
  try { body = JSON.parse(text) } catch { return reject(400, 'Invalid event.') }

  const v = validateClientEvent(body)
  if (!v.ok) return reject(400, 'Invalid event.')

  // Automation is acknowledged but never counted.
  if (isLikelyBot(req.headers.get('user-agent'))) return noContent()

  try {
    await createFunnelService(sql).recordClientEvent(v.value)
    return noContent()
  } catch (err: any) {
    // Message only, truncated; never returned to the caller.
    console.error('[analytics/event]', String(err?.message ?? err).slice(0, 80))
    return reject(503, 'Unavailable.')
  }
}
