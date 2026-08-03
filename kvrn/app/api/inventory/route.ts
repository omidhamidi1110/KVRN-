import { type NextRequest, NextResponse } from 'next/server'
import { getVariantAvailability } from '@/lib/inventory'

// No caching — availability must be current
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug')
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })
  const variants = await getVariantAvailability(slug)
  return NextResponse.json({ variants }, {
    headers: { 'Cache-Control': 'no-store' }
  })
}
