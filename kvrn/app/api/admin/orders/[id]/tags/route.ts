// GET    /api/admin/orders/[id]/tags            — tags on this order
// POST   /api/admin/orders/[id]/tags {tagId}    — add a tag (idempotent, max 10 per order)
// DELETE /api/admin/orders/[id]/tags?tagId=...  — remove a tag (idempotent)
//
// INTERNAL ONLY. A tag never changes payment, accounting, inventory or fulfillment. A tag called "Hold" is a
// label, not a fraud hold.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createOrderTagService, OrderTagError, UUID_RE } from '@/lib/order-tags'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, context: Context) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 })
  try {
    return NextResponse.json({ success: true, data: await createOrderTagService(sql).tagsForOrder(id) })
  } catch {
    return NextResponse.json({ error: 'Failed to load tags.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, context: Context) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const actor = identity?.email
  if (!actor) return NextResponse.json({ error: 'Admin identity unavailable.' }, { status: 401 })
  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  const extra = Object.keys(body ?? {}).filter(k => k !== 'tagId')
  if (extra.length > 0) return NextResponse.json({ error: `Unsupported fields: ${extra.join(', ')}.` }, { status: 400 })
  if (typeof body?.tagId !== 'string' || !UUID_RE.test(body.tagId)) {
    return NextResponse.json({ error: 'Invalid tag.' }, { status: 400 })
  }

  try {
    const svc = createOrderTagService(sql)
    const outcome = await svc.assign(id, body.tagId, actor)
    return NextResponse.json({ success: true, outcome, data: await svc.tagsForOrder(id) })
  } catch (err: any) {
    if (err instanceof OrderTagError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[admin/orders/id/tags POST]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to add tag.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, context: Context) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const actor = identity?.email
  if (!actor) return NextResponse.json({ error: 'Admin identity unavailable.' }, { status: 401 })
  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 })
  const tagId = req.nextUrl.searchParams.get('tagId') ?? ''
  if (!UUID_RE.test(tagId)) return NextResponse.json({ error: 'Invalid tag.' }, { status: 400 })

  try {
    const svc = createOrderTagService(sql)
    const outcome = await svc.remove(id, tagId, actor)
    return NextResponse.json({ success: true, outcome, data: await svc.tagsForOrder(id) })
  } catch (err: any) {
    if (err instanceof OrderTagError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[admin/orders/id/tags DELETE]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to remove tag.' }, { status: 500 })
  }
}
