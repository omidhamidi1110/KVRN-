import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { resolveAiAlert } from '@/lib/ai/repository'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error, identity } = await requireAdmin(req)
  if (error) return error
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({})) as { note?: string }
    const ok = await resolveAiAlert({
      alertId: id,
      actorEmail: identity?.email || 'admin@kvrn.internal',
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
    })
    if (!ok) return NextResponse.json({ error: 'Alert is already resolved or was not found.' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Failed to resolve AI alert.' }, { status: 500 })
  }
}
