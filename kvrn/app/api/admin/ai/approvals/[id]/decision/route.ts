import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { decideApproval, expireStaleAiApprovals } from '@/lib/ai/repository'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid approval id.' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }) }
  if (body?.decision !== 'approved' && body?.decision !== 'rejected') {
    return NextResponse.json({ error: 'Decision must be approved or rejected.' }, { status: 400 })
  }
  const note = body?.note === undefined || body?.note === null ? null : String(body.note).trim().slice(0, 2000)
  try {
    await expireStaleAiApprovals()
    const result = await decideApproval({ approvalId: id, decision: body.decision, actorEmail: identity.email, note })
    if (!result) return NextResponse.json({ error: 'Approval is no longer pending.' }, { status: 409 })
    return NextResponse.json({ ok: true, actionId: result.actionId })
  } catch {
    return NextResponse.json({ error: 'Failed to record decision.' }, { status: 500 })
  }
}
