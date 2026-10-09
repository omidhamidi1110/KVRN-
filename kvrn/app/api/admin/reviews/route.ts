import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const reviews = await sql`SELECT id, display_name, item_label, rating, headline, body, status, created_at, moderated_at
      FROM kvrn_product_reviews ORDER BY created_at DESC LIMIT 200`
    return NextResponse.json({ reviews }, { headers: NO_STORE })
  } catch { return NextResponse.json({ error: 'Review storage is not ready. Apply migration 067.' }, { status: 503, headers: NO_STORE }) }
}

export async function PATCH(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  // Admin auth may have passed; require a same-origin request for any state change.
  if (req.headers.get('origin') !== new URL(req.url).origin) {
    return NextResponse.json({ error: 'Request blocked.' }, { status: 403, headers: NO_STORE })
  }
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE }) }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  const { id, status } = body as Record<string, unknown>
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !['approved','rejected','pending'].includes(String(status))) {
    return NextResponse.json({ error: 'Invalid review decision.' }, { status: 400, headers: NO_STORE })
  }
  try {
    const changed = await sql`UPDATE kvrn_product_reviews
       SET status=${status as string}, moderated_at=CASE WHEN ${status as string}='pending' THEN NULL ELSE now() END,
           moderated_by=CASE WHEN ${status as string}='pending' THEN NULL ELSE ${identity.email} END
       WHERE id=${id}::uuid RETURNING id`
    if (changed.length === 0) return NextResponse.json({ error: 'Review not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch { return NextResponse.json({ error: 'Could not update review.' }, { status: 503, headers: NO_STORE }) }
}
