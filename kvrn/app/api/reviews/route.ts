import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { allowPublicApiRequest } from '@/lib/public-api-rate-limit'
import { validateReview } from '@/lib/review-policy'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
type Row = { id: string; display_name: string; item_label: string; rating: number; headline: string; body: string; created_at: string }

export async function GET() {
  try {
    const rows = await sql`
      SELECT id, display_name, item_label, rating, headline, body, created_at
      FROM kvrn_product_reviews WHERE status='approved'
      ORDER BY created_at DESC LIMIT 30
    ` as Row[]
    const summary = await sql`
      SELECT count(*)::int AS count, avg(rating)::float AS average
      FROM kvrn_product_reviews WHERE status='approved'
    ` as Array<{ count: number; average: number | null }>
    return NextResponse.json({ ready: true, reviews: rows, count: Number(summary[0]?.count ?? 0), average: summary[0]?.average ?? null }, { headers: NO_STORE })
  } catch {
    // Release of the Worker and the independently approved database migration can occur separately.
    return NextResponse.json({ ready: false, reviews: [], count: 0, average: null }, { headers: NO_STORE })
  }
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  if (!origin || origin !== new URL(req.url).origin) return NextResponse.json({ error: 'Request blocked.' }, { status: 403, headers: NO_STORE })
  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (contentLength > 12000) return NextResponse.json({ error: 'Review is too long.' }, { status: 413, headers: NO_STORE })
  const ct = req.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().startsWith('application/json')) return NextResponse.json({ error: 'Invalid request.' }, { status: 415, headers: NO_STORE })
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE }) }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  const b = body as Record<string, unknown>
  if (b.website) return NextResponse.json({ ok: true, pending: true }, { status: 202, headers: NO_STORE }) // bot honeypot
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  const headline = typeof b.headline === 'string' ? b.headline.trim() : ''
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  const item = typeof b.item === 'string' ? b.item : ''
  const rating = b.rating
  // Same policy module as the browser form: field-specific messages, identical bounds (mirror migration 067's CHECKs).
  const fields = validateReview({ name, item, rating, headline, text })
  if (Object.keys(fields).length > 0) {
    return NextResponse.json({ error: 'Please fix the highlighted fields.', fields }, { status: 400, headers: NO_STORE })
  }
  try {
    const allowed = await allowPublicApiRequest(sql, { bucket: 'shared_reviews', headers: req.headers, limit: 3, windowSeconds: 86400 })
    if (!allowed) return NextResponse.json({ error: 'Review limit reached. Please try again tomorrow.' }, { status: 429, headers: NO_STORE })
    await sql`INSERT INTO kvrn_product_reviews (display_name,item_label,rating,headline,body)
      VALUES (${name}, ${item}, ${rating}, ${headline}, ${text})`
    return NextResponse.json({ ok: true, pending: true }, { status: 202, headers: NO_STORE })
  } catch {
    return NextResponse.json({ error: 'Reviews are temporarily unavailable. Please try again later.' }, { status: 503, headers: NO_STORE })
  }
}
