// app/api/bundles/quote/route.ts — PUBLIC, read-only price + availability check for a set.
//
// The storefront calls this before "Add set to bag" and when it refreshes a saved bag, so the price
// and availability it shows are the server's, not the browser's. It reserves nothing and writes
// nothing. Gated by the CMS_PRODUCT_ROUTING flag (404 when off). Errors are customer-safe.
import { NextResponse, type NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { createBundleCheckout } from '@/lib/bundle-checkout'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { readLimitedJson } from '@/lib/limited-json-request'
import { allowPublicApiRequest, PublicRateLimitConfigError } from '@/lib/public-api-rate-limit'

export const dynamic = 'force-dynamic'

const bundles = createBundleCheckout(sql)
const NO_STORE = { 'Cache-Control': 'no-store' } as const
const MAX_BODY_BYTES = 16 * 1024

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled('CMS_PRODUCT_ROUTING')) {
    return NextResponse.json({ ok: false, code: 'BUNDLE_DISABLED', message: 'Sets are not available right now.' }, { status: 404, headers: NO_STORE })
  }

  if (process.env.NODE_ENV === 'production') {
    try {
      const allowed = await allowPublicApiRequest(sql, { bucket: 'bundle_quote', headers: req.headers, limit: 60, windowSeconds: 60 })
      if (!allowed) {
        return NextResponse.json(
          { ok: false, code: 'BUNDLE_RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
          { status: 429, headers: { ...NO_STORE, 'Retry-After': '60' } },
        )
      }
    } catch (err) {
      if (!(err instanceof PublicRateLimitConfigError)) console.error('[bundle] rate limit failed')
      return NextResponse.json(
        { ok: false, code: 'BUNDLE_ERROR', message: 'We could not check this set right now. Please try again.' },
        { status: 503, headers: NO_STORE },
      )
    }
  }

  const read = await readLimitedJson(req, MAX_BODY_BYTES)
  if (!read.ok) return NextResponse.json({ ok: false, code: 'BUNDLE_INVALID_REQUEST', message: 'Invalid request.' }, { status: read.status, headers: NO_STORE })
  const body = read.value
  const q = await bundles.quote(body)
  if (!q.ok) {
    return NextResponse.json(
      { ok: false, code: q.code, message: q.message, ...(q.sku ? { sku: q.sku } : {}),
        ...(q.newSetNetCents !== undefined ? { newSetNetCents: q.newSetNetCents } : {}) },
      { status: q.status, headers: NO_STORE })
  }
  return NextResponse.json(q, { headers: NO_STORE })
}
