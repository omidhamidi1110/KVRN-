// GET /api/admin/support/threads/[id] — one conversation, messages in chronological order
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { SupportError, createSupportService, isUuid } from '@/lib/support-inbox'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
type Context = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, context: Context) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await context.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Thread not found.' }, { status: 404, headers: NO_STORE })
  try {
    const thread = await createSupportService(sql).getThread(id)
    if (!thread) return NextResponse.json({ error: 'Thread not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ thread }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/support GET thread]', err instanceof SupportError ? err.code : 'unexpected')
    return NextResponse.json({ error: 'Could not load the thread.' }, { status: 500, headers: NO_STORE })
  }
}
