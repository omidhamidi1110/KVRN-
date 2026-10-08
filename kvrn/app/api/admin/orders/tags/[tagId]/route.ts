// PATCH  /api/admin/orders/tags/[tagId] — rename / recolour / archive / restore { name?, color?, archived? }
// DELETE /api/admin/orders/tags/[tagId] — delete a tag that is not on any order (otherwise 409: archive it)
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  createOrderTagService, normalizeTagName, normalizeTagColor, OrderTagError, UUID_RE,
  type OrderTagColor,
} from '@/lib/order-tags'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ tagId: string }> }

export async function PATCH(req: NextRequest, context: Context) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const actor = identity?.email
  if (!actor) return NextResponse.json({ error: 'Admin identity unavailable.' }, { status: 401 })
  const { tagId } = await context.params
  if (!UUID_RE.test(tagId)) return NextResponse.json({ error: 'Invalid tag.' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  const extra = Object.keys(body ?? {}).filter(k => !['name', 'color', 'archived'].includes(k))
  if (extra.length > 0) return NextResponse.json({ error: `Unsupported fields: ${extra.join(', ')}.` }, { status: 400 })

  const patch: { name?: string; color?: OrderTagColor; archived?: boolean } = {}
  if (body?.name !== undefined) {
    const n = normalizeTagName(body.name)
    if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 })
    patch.name = n.name
  }
  if (body?.color !== undefined) {
    const c = normalizeTagColor(body.color)
    if (!c.ok) return NextResponse.json({ error: c.error }, { status: 400 })
    patch.color = c.color
  }
  if (body?.archived !== undefined) {
    if (typeof body.archived !== 'boolean') return NextResponse.json({ error: 'archived must be true or false.' }, { status: 400 })
    patch.archived = body.archived
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })

  try {
    const tag = await createOrderTagService(sql).updateTag(tagId, patch, actor)
    return NextResponse.json({ success: true, data: tag })
  } catch (err: any) {
    if (err instanceof OrderTagError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[admin/orders/tags PATCH]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to update tag.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, context: Context) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const actor = identity?.email
  if (!actor) return NextResponse.json({ error: 'Admin identity unavailable.' }, { status: 401 })
  const { tagId } = await context.params
  if (!UUID_RE.test(tagId)) return NextResponse.json({ error: 'Invalid tag.' }, { status: 400 })

  try {
    await createOrderTagService(sql).deleteTag(tagId, actor)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    if (err instanceof OrderTagError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[admin/orders/tags DELETE]', String(err?.message ?? '').slice(0, 120))
    return NextResponse.json({ error: 'Failed to delete tag.' }, { status: 500 })
  }
}
