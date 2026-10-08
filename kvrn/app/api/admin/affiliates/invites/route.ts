// GET  /api/admin/affiliates/invites — invitation list.
// POST /api/admin/affiliates/invites — create / resend / revoke.
// An invitation only pre-fills the application. The invitee still applies, accepts every document and
// is reviewed. The raw token exists only in memory long enough to be emailed; it is never stored,
// logged or returned. With AFFILIATE_APPLICATIONS off, nothing is emailed (email_status stays held).
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { getEmailProvider } from '@/lib/resend-adapter'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { getProgramSettings, isUuid, validateInviteInput } from '@/lib/affiliate-program'
import { sendInviteEmail } from '@/lib/affiliate-program-email'
import { programErrorResponse, readJsonBody, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    return NextResponse.json({ invites: await createAffiliateProgramAdmin(sql).listInvites() }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/invites GET')
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const body = await readJsonBody(req)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers: NO_STORE })
  const actor = identity!.email
  const svc = createAffiliateProgramAdmin(sql)
  const emailOn = isFeatureEnabled('AFFILIATE_APPLICATIONS')

  try {
    const { settings } = await getProgramSettings(sql)
    if (body.action === 'create') {
      const v = validateInviteInput(body.invite ?? {})
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400, headers: NO_STORE })
      const created = await svc.createInvite(v.value, settings.inviteExpiryDays, actor)
      let email: 'sent' | 'failed' | 'held' = 'held'
      if (emailOn) {
        email = await sendInviteEmail(sql, getEmailProvider,
          { id: created.inviteId, email: String(v.value.email), displayName: String(v.value.displayName), sendCount: created.sendCount }, created.token)
      }
      return NextResponse.json({ ok: true, inviteId: created.inviteId, email }, { status: 201, headers: NO_STORE })
    }
    if (body.action === 'resend') {
      if (!isUuid(body.inviteId)) return NextResponse.json({ error: 'Invalid invitation.' }, { status: 400, headers: NO_STORE })
      if (!emailOn) return NextResponse.json({ error: 'Invitations cannot be emailed while the applications feature is off.' }, { status: 409, headers: NO_STORE })
      const r = await svc.rotateInvite(body.inviteId, settings.inviteExpiryDays, actor)
      const email = await sendInviteEmail(sql, getEmailProvider,
        { id: r.inviteId, email: r.email, displayName: r.displayName, sendCount: r.sendCount }, r.token)
      return NextResponse.json({ ok: true, email }, { headers: NO_STORE })
    }
    if (body.action === 'revoke') {
      if (!isUuid(body.inviteId)) return NextResponse.json({ error: 'Invalid invitation.' }, { status: 400, headers: NO_STORE })
      await svc.revokeInvite(body.inviteId, actor)
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400, headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/invites POST')
  }
}
