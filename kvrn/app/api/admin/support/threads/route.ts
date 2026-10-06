// GET /api/admin/support/threads — support inbox list (Admin → Support)
//   ?status=open|closed|all  &unread=1  &q=<search>  &limit=<n>  &cursor=<opaque>
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { SupportError, createSupportService, type ThreadFilter } from '@/lib/support-inbox'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error

  const u = new URL(req.url)
  const s = u.searchParams.get('status')
  const status: ThreadFilter = s === 'open' || s === 'closed' ? s : 'all'
  const limitRaw = Number(u.searchParams.get('limit'))
  try {
    const result = await createSupportService(sql).listThreads({
      status,
      unreadOnly: u.searchParams.get('unread') === '1',
      q: u.searchParams.get('q') ?? '',
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      cursor: u.searchParams.get('cursor'),
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof SupportError && err.status < 500) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: NO_STORE })
    }
    console.error('[admin/support GET threads]', err instanceof SupportError ? err.code : 'unexpected')
    return NextResponse.json({ error: 'Could not load support threads.' }, { status: 500, headers: NO_STORE })
  }
}
