// POST /api/admin/support/threads/[id]/read — mark a thread read (unread_count → 0)
// Not audited on purpose: opening a thread would otherwise write one audit row per click.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { SupportError, createSupportService, isUuid } from '@/lib/support-inbox'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
type Context = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, context: Context) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await context.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Thread not found.' }, { status: 404, headers: NO_STORE })
  // Optional body { seenMessageId }: clear only what the admin actually saw (a customer message that
  // arrived while the thread was open stays unread). No body = clear everything (older clients).
  let seen: string | null = null
  try {
    const text = await req.text()
    if (text.trim()) {
      const b = JSON.parse(text)
      if (b && b.seenMessageId != null) {
        if (!isUuid(b.seenMessageId)) return NextResponse.json({ error: 'Invalid message id.' }, { status: 400, headers: NO_STORE })
        seen = b.seenMessageId
      }
    }
  } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers: NO_STORE }) }
  try {
    const r = await createSupportService(sql).markRead(id, seen)
    if (!r.found) return NextResponse.json({ error: 'Thread not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true, cleared: r.cleared }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/support read]', err instanceof SupportError ? err.code : 'unexpected')
    return NextResponse.json({ error: 'Could not mark the thread read.' }, { status: 500, headers: NO_STORE })
  }
}
