// POST /api/admin/support/threads/[id]/status  { status: 'open' | 'closed' } — close / reopen (audited)
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { SupportError, createSupportService, isUuid } from '@/lib/support-inbox'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
type Context = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, context: Context) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await context.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Thread not found.' }, { status: 404, headers: NO_STORE })

  // JSON only: a cross-site <form> post cannot send this content type, so it cannot trigger the action.
  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json.' }, { status: 415, headers: NO_STORE })
  }

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers: NO_STORE })
  }
  const status = body?.status
  if (status !== 'open' && status !== 'closed') {
    return NextResponse.json({ error: "status must be 'open' or 'closed'." }, { status: 400, headers: NO_STORE })
  }
  try {
    const r = await createSupportService(sql).setStatus(id, status, identity.email)
    return NextResponse.json({ ok: true, changed: r.changed, status: r.status }, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof SupportError && err.status < 500) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: NO_STORE })
    }
    console.error('[admin/support status]', err instanceof SupportError ? err.code : 'unexpected')
    return NextResponse.json({ error: 'Could not update the thread.' }, { status: 500, headers: NO_STORE })
  }
}
