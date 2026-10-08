// GET  /api/admin/orders/tags  — list internal order tags
// POST /api/admin/orders/tags  — create a tag { name, color? }
//
// Tags are INTERNAL organisation only: they never reach a customer and never change payment,
// accounting or fulfillment. Every mutation is audited by the database function.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createOrderTagService, normalizeTagName, normalizeTagColor, OrderTagError } from '@/lib/order-tags'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const includeArchived = req.nextUrl.searchParams.get('includeArchived') !== '0'
  try {
    const data = await createOrderTagService(sql).listTags({ includeArchived })
    return NextResponse.json({ success: true, data })
  } catch {
    return NextResponse.json({ error: 'Failed to load tags.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const actor = identity?.email
  if (!actor) return NextResponse.json({ error: 'Admin identity unavailable.' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  const extra = Object.keys(body ?? {}).filter(k => !['name', 'color'].includes(k))
  if (extra.length > 0) return NextResponse.json({ error: `Unsupported fields: ${extra.join(', ')}.` }, { status: 400 })

  const name = normalizeTagName(body?.name)
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })
  const color = normalizeTagColor(body?.color)
  if (!color.ok) return NextResponse.json({ error: color.error }, { status: 400 })

  try {
    const tag = await createOrderTagService(sql).createTag(name.name, color.color, actor)
    return NextResponse.json({ success: true, data: tag }, { status: 201 })
  } catch (err: any) {
    if (err instanceof OrderTagError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[admin/orders/tags POST]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to create tag.' }, { status: 500 })
  }
}
