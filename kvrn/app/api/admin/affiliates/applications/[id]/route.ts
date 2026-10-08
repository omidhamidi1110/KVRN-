// GET  /api/admin/affiliates/applications/[id] — one application (Admin only; includes internal notes).
// POST /api/admin/affiliates/applications/[id] — review actions. Every mutation is one audited SQL
// function; nothing here approves automatically.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { isUuid, validateApprovalConfig } from '@/lib/affiliate-program'
import { cleanText } from '@/lib/affiliate-application-input'
import { programErrorResponse, readJsonBody, flushQueuedEmails, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid application.' }, { status: 400, headers: NO_STORE })
  try {
    const application = await createAffiliateProgramAdmin(sql).getApplication(id)
    if (!application) return NextResponse.json({ error: 'Application not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ application }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/applications/[id] GET')
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid application.' }, { status: 400, headers: NO_STORE })
  const body = await readJsonBody(req)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers: NO_STORE })
  const actor = identity!.email
  const svc = createAffiliateProgramAdmin(sql)
  const message = cleanText(body.message, 1000) || null

  try {
    switch (body.action) {
      case 'approve': {
        const v = validateApprovalConfig(body.config ?? {})
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400, headers: NO_STORE })
        const r = await svc.approve(id, v.value, actor)
        await flushQueuedEmails(sql, { applicationId: id, affiliateId: r?.affiliate_id ?? null })
        return NextResponse.json({ ok: true, result: r }, { headers: NO_STORE })
      }
      case 'reject': {
        const r = await svc.reject(id, message, actor)
        await flushQueuedEmails(sql, { applicationId: id })
        return NextResponse.json({ ok: true, result: r }, { headers: NO_STORE })
      }
      case 'request_info': {
        if (!message) return NextResponse.json({ error: 'Write the question for the applicant.' }, { status: 400, headers: NO_STORE })
        const r = await svc.setApplicationStatus(id, 'needs_info', message, actor)
        await flushQueuedEmails(sql, { applicationId: id })
        return NextResponse.json({ ok: true, result: r }, { headers: NO_STORE })
      }
      case 'under_review':
        return NextResponse.json({ ok: true, result: await svc.setApplicationStatus(id, 'under_review', null, actor) }, { headers: NO_STORE })
      case 'withdraw':
        return NextResponse.json({ ok: true, result: await svc.setApplicationStatus(id, 'withdrawn', message, actor) }, { headers: NO_STORE })
      case 'add_note': {
        const note = cleanText(body.note, 2000)
        if (!note) return NextResponse.json({ error: 'Write a note first.' }, { status: 400, headers: NO_STORE })
        return NextResponse.json({ ok: true, result: await svc.addNote(id, null, note, actor) }, { headers: NO_STORE })
      }
      case 'anonymize':
        return NextResponse.json({ ok: true, result: await svc.anonymize(id, actor) }, { headers: NO_STORE })
      default:
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400, headers: NO_STORE })
    }
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/applications/[id] POST')
  }
}
