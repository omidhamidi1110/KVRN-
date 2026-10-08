// POST /api/admin/affiliates/profiles/[id] — program lifecycle and settings for one affiliate.
// Suspension and termination disable the discount code and the referral link immediately; commissions,
// attribution history and anything owed are never touched.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { isUuid, validateProfileSettingsInput } from '@/lib/affiliate-program'
import { cleanText, normalizeEmail, isEmailShape } from '@/lib/affiliate-application-input'
import { programErrorResponse, readJsonBody, flushQueuedEmails, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid affiliate.' }, { status: 400, headers: NO_STORE })
  const body = await readJsonBody(req)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers: NO_STORE })
  const actor = identity!.email
  const svc = createAffiliateProgramAdmin(sql)
  const reason = cleanText(body.reason, 500) || null
  const message = cleanText(body.message, 1000) || null
  const notify = body.notify !== false && isFeatureEnabled('AFFILIATE_APPLICATIONS')

  try {
    switch (body.action) {
      case 'activate':
      case 'reinstate':
      case 'suspend':
      case 'terminate': {
        const target = body.action === 'suspend' ? 'suspended' : body.action === 'terminate' ? 'terminated' : 'active'
        if (body.action === 'terminate' && !reason) {
          return NextResponse.json({ error: 'Give a reason for terminating.' }, { status: 400, headers: NO_STORE })
        }
        const r = await svc.setProgramStatus(id, target, {
          actor, reason, message, notify, revokePortal: body.revokePortal === true,
          effectiveAt: typeof body.effectiveAt === 'string' && body.effectiveAt ? new Date(body.effectiveAt).toISOString() : null,
        })
        await flushQueuedEmails(sql, { affiliateId: id })
        return NextResponse.json({ ok: true, result: r }, { headers: NO_STORE })
      }
      case 'settings': {
        const v = validateProfileSettingsInput(body.settings)
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400, headers: NO_STORE })
        return NextResponse.json({ ok: true, result: await svc.updateProfileSettings(id, v.value, actor) }, { headers: NO_STORE })
      }
      case 'change_code': {
        const code = cleanText(body.code, 40).toUpperCase()
        if (!CODE_RE.test(code)) return NextResponse.json({ error: 'Code must be 2–32 characters: A–Z, 0–9, hyphen or underscore.' }, { status: 400, headers: NO_STORE })
        return NextResponse.json({ ok: true, result: await svc.changeCode(id, code, actor) }, { headers: NO_STORE })
      }
      case 'set_email': {
        const email = normalizeEmail(body.email)
        if (!isEmailShape(email)) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400, headers: NO_STORE })
        return NextResponse.json({ ok: true, result: await svc.setEmail(id, email, actor) }, { headers: NO_STORE })
      }
      case 'add_note': {
        const note = cleanText(body.note, 2000)
        if (!note) return NextResponse.json({ error: 'Write a note first.' }, { status: 400, headers: NO_STORE })
        return NextResponse.json({ ok: true, result: await svc.addNote(null, id, note, actor) }, { headers: NO_STORE })
      }
      case 'request_reacceptance':
        return NextResponse.json({ ok: true, result: await svc.requestReacceptance([id], actor) }, { headers: NO_STORE })
      default:
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400, headers: NO_STORE })
    }
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/profiles/[id] POST')
  }
}
