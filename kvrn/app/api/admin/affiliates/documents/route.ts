// GET  /api/admin/affiliates/documents — every document version + the re-acceptance list.
// POST /api/admin/affiliates/documents — save draft / discard draft / publish / request re-acceptance.
// Published versions are immutable (database trigger); a change is always a new version.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { isUuid, validateDocumentInput } from '@/lib/affiliate-program'
import { getEmailProvider } from '@/lib/resend-adapter'
import { drainAffiliateEmailOutbox } from '@/lib/affiliate-program-email'
import { programErrorResponse, readJsonBody, flushQueuedEmails, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const svc = createAffiliateProgramAdmin(sql)
    const [documents, reacceptance] = await Promise.all([svc.listDocuments(), svc.reacceptanceList()])
    return NextResponse.json({ documents, reacceptance }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/documents GET')
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const body = await readJsonBody(req, 400 * 1024)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers: NO_STORE })
  const actor = identity!.email
  const svc = createAffiliateProgramAdmin(sql)
  try {
    switch (body.action) {
      case 'save_draft': {
        const v = validateDocumentInput(body.document)
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400, headers: NO_STORE })
        return NextResponse.json({ ok: true, result: await svc.saveDocumentDraft(v.value, actor) }, { headers: NO_STORE })
      }
      case 'discard_draft':
        if (!isUuid(body.documentId)) return NextResponse.json({ error: 'Invalid document.' }, { status: 400, headers: NO_STORE })
        return NextResponse.json({ ok: true, result: await svc.discardDocumentDraft(body.documentId, actor) }, { headers: NO_STORE })
      case 'publish': {
        if (!isUuid(body.documentId)) return NextResponse.json({ error: 'Invalid document.' }, { status: 400, headers: NO_STORE })
        const r = await svc.publishDocument(body.documentId, body.material === true, actor)
        // A material change queues a notice for each affected affiliate; send what is due.
        if (body.material === true) {
          try { await drainAffiliateEmailOutbox(sql, getEmailProvider(), 50) } catch { /* the retry job sends them */ }
        }
        return NextResponse.json({ ok: true, result: r }, { headers: NO_STORE })
      }
      case 'request_reacceptance': {
        const ids = Array.isArray(body.affiliateIds) ? body.affiliateIds.filter(isUuid).slice(0, 500) : []
        if (ids.length === 0) return NextResponse.json({ error: 'Choose at least one affiliate.' }, { status: 400, headers: NO_STORE })
        const r = await svc.requestReacceptance(ids, actor)
        for (const id of ids.slice(0, 50)) await flushQueuedEmails(sql, { affiliateId: id })
        return NextResponse.json({ ok: true, result: r }, { headers: NO_STORE })
      }
      default:
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400, headers: NO_STORE })
    }
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/documents POST')
  }
}
