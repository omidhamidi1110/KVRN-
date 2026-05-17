import { NextRequest, NextResponse } from 'next/server'

// ─── POST /api/notify-me ───────────────────────────────────────────────────────
// Saves an out-of-stock alert request.
// Called when customer clicks "Notify me" on a sold-out size.
// When that variant is restocked, the admin triggers notification emails.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { email, productId, color, size } = body

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'A valid email is required.' }, { status: 400 })
    }
    if (!productId || !color || !size) {
      return NextResponse.json({ success: false, error: 'Missing product variant.' }, { status: 400 })
    }

    const sku = `${productId}-${color}-${size}`.toLowerCase()

    // ── Neon DB insert ──────────────────────────────────────────────────────
    // Uncomment once @neondatabase/serverless is installed:
    //
    // import { neon } from '@neondatabase/serverless'
    // const db = neon(process.env.DATABASE_URL!)
    //
    // // Upsert customer
    // await db`
    //   INSERT INTO customers (id, email, email_consent, email_consent_source, segment, created_at)
    //   VALUES (gen_random_uuid()::text, ${email.toLowerCase()}, false, 'notify_me', 'A', NOW())
    //   ON CONFLICT (email) DO NOTHING
    // `
    //
    // // Find the variant ID by SKU
    // const [variant] = await db`SELECT id FROM variants WHERE sku = ${sku} LIMIT 1`
    // if (!variant) {
    //   return NextResponse.json({ success: false, error: 'Variant not found.' }, { status: 404 })
    // }
    //
    // // Save alert (ignore if already exists)
    // await db`
    //   INSERT INTO stock_alerts (id, email, variant_id, created_at)
    //   VALUES (gen_random_uuid()::text, ${email.toLowerCase()}, ${variant.id}, NOW())
    //   ON CONFLICT DO NOTHING
    // `

    console.log(`[notify-me] ${email} → ${sku}`)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[notify-me] Error:', err)
    return NextResponse.json({ success: false, error: 'Server error.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
