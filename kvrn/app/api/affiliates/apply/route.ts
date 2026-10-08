// POST /api/affiliates/apply — public affiliate application.
// Feature-flagged (AFFILIATE_APPLICATIONS, default OFF): when off the route does not exist (404) and
// touches nothing. It NEVER approves anything and answers identically for a new application, a repeat
// and an existing affiliate, so it cannot be used to discover who applied. No raw IP/UA is stored.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { readLimitedJson } from '@/lib/limited-json-request'
import { clientIpFrom, submitPublicApplication } from '@/lib/affiliate-application'
import { getEmailProvider } from '@/lib/resend-adapter'
import { drainAffiliateEmailOutbox } from '@/lib/affiliate-program-email'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const MAX_BODY = 32 * 1024

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled('AFFILIATE_APPLICATIONS')) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404, headers: NO_STORE })
  }
  const read = await readLimitedJson(req, MAX_BODY)
  if (!read.ok) return NextResponse.json({ error: read.reason === 'too_large' ? 'Request too large.' : 'Invalid request.' }, { status: read.status, headers: NO_STORE })
  const body: any = read.value
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  }

  const inviteToken = typeof body.inviteToken === 'string' && /^[0-9a-f]{64}$/.test(body.inviteToken) ? body.inviteToken : null
  const out = await submitPublicApplication(sql, body, {
    ip: clientIpFrom(req.headers),
    userAgent: req.headers.get('user-agent') ?? '',
    formToken: body.formToken,
    honeypot: body.company_fax,
    inviteToken,
  })

  switch (out.kind) {
    case 'received': {
      // The confirmation email was queued in the same transaction; sending is best effort and the
      // retry job covers failures. Draining is idempotent (rows are claimed atomically).
      try { await drainAffiliateEmailOutbox(sql, getEmailProvider(), 5) } catch { /* retry job */ }
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }
    case 'invalid':
      return NextResponse.json({ error: 'Please fix the highlighted fields.', fields: out.errors }, { status: 400, headers: NO_STORE })
    case 'closed':
      return NextResponse.json({ error: 'Applications are not open right now.' }, { status: 503, headers: NO_STORE })
    case 'rate_limited':
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '3600' } })
    case 'retry':
      return NextResponse.json({ error: out.message, retry: true }, { status: 409, headers: NO_STORE })
    default:
      return NextResponse.json({ error: out.message }, { status: out.status, headers: NO_STORE })
  }
}
