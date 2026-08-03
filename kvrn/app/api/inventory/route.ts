import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { toNeonSlug } from '@/lib/catalog'

// No caching — availability must always be current
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const publicSlug = req.nextUrl.searchParams.get('slug')
  if (!publicSlug) {
    return NextResponse.json({ error: 'slug parameter is required.' }, { status: 400 })
  }

  const neonSlug = toNeonSlug(publicSlug)
  if (!neonSlug) {
    return NextResponse.json({ error: `Unknown product slug: ${publicSlug}` }, { status: 404 })
  }

  try {
    const rows = await sql`
      SELECT
        pv.sku,
        pv.size,
        pv.size_sort,
        pv.color_code,
        pv.active,
        -- Return boolean only — exact counts are admin-only
        (pv.stock_on_hand - pv.reserved_quantity > 0 AND pv.active = true) AS in_stock
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE p.slug = ${neonSlug} AND p.active = true
      ORDER BY pv.size_sort ASC
    `

    // Strip any quantity fields — public response is boolean only
    const variants = (rows as any[]).map(v => ({
      sku:        v.sku        as string,
      size:       v.size       as string,
      size_sort:  v.size_sort  as number,
      color_code: v.color_code as string,
      active:     Boolean(v.active),
      in_stock:   Boolean(v.in_stock),
      // Deliberately omit: stock_on_hand, reserved_quantity, available_quantity
    }))

    return NextResponse.json({ variants }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err: any) {
    console.error('Inventory fetch error:', err.message)
    return NextResponse.json(
      { error: 'Inventory temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
