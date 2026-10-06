// POST /api/admin/support/threads/[id]/reply  { body, clientRequestId } — send a reply to the customer
//
// Sends FROM "KVRN Support <support@kvrn.shop>" through Resend, ONLY to the thread's customer.
// The outbound message is stored only after the provider accepted it; a provider failure stores
// nothing and is reported as a failure. The same clientRequestId never sends twice.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { getSupportMailer } from '@/lib/support-email'
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
  // Only these two fields are read. A client cannot choose the recipient, sender or subject.
  if (typeof body?.body !== 'string') {
    return NextResponse.json({ error: 'Reply body is required.' }, { status: 400, headers: NO_STORE })
  }

  try {
    const r = await createSupportService(sql).sendReply(
      { threadId: id, body: body.body, clientRequestId: String(body.clientRequestId ?? ''), actorEmail: identity.email },
      getSupportMailer())
    return NextResponse.json({ ok: true, ...r }, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof SupportError) {
      if (err.status >= 500) console.error('[admin/support reply]', err.code)
      return NextResponse.json({ error: err.message, code: err.code, ...(err.extra ?? {}) },
        { status: err.status, headers: NO_STORE })
    }
    console.error('[admin/support reply] unexpected failure')
    return NextResponse.json({ error: 'Could not send the reply.' }, { status: 500, headers: NO_STORE })
  }
}
