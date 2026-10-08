// POST /api/affiliates/invite — pre-fill data for an invitation link.
// The raw invitation token arrives in a small JSON body, never in this endpoint's URL/query string.
// The email link carries the token in the browser URL FRAGMENT, which is not sent in HTTP requests.
// Returns only the invitee's own name and email for a valid, unused, unexpired token.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { clientIpFrom, hashValue } from '@/lib/affiliate-application'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const MAX_BODY_BYTES = 1024

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled('AFFILIATE_APPLICATIONS')) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404, headers: NO_STORE })
  }

  let token = ''
  try {
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
    const body = JSON.parse(raw)
    token = typeof body?.token === 'string' ? body.token : ''
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  }
  if (!/^[0-9a-f]{64}$/.test(token)) return NextResponse.json({ error: 'This invitation is not valid.' }, { status: 404, headers: NO_STORE })

  try {
    const ipHash = await hashValue('ip', clientIpFrom(req.headers))
    const ok = ((await sql`SELECT affiliate_rate_limit_check('invite_lookup_h', ${ipHash}, 60::int, 3600::int) AS ok` as any[])[0]?.ok) === true
    if (!ok) return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '3600' } })
    const inv = await createAffiliateProgramAdmin(sql).lookupInvite(token)
    if (!inv) return NextResponse.json({ error: 'This invitation is not valid or has expired.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ invite: inv }, { headers: NO_STORE })
  } catch (err: any) {
    console.error('[affiliates/invite]', String(err?.message ?? '').slice(0, 80))
    return NextResponse.json({ error: 'Could not load the invitation.' }, { status: 500, headers: NO_STORE })
  }
}
