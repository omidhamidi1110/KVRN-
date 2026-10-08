// GET  /api/admin/affiliates/emails — recent program emails (status only; no bodies, no addresses).
// POST /api/admin/affiliates/emails — retry anything that is due.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { getEmailProvider } from '@/lib/resend-adapter'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { drainAffiliateEmailOutbox } from '@/lib/affiliate-program-email'
import { programErrorResponse, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    return NextResponse.json({ emails: await createAffiliateProgramAdmin(sql).listEmailOutbox() }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/emails GET')
  }
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  let provider
  try { provider = getEmailProvider() } catch {
    return NextResponse.json({ error: 'Email sending is not configured.' }, { status: 409, headers: NO_STORE })
  }
  try {
    return NextResponse.json({ ok: true, ...(await drainAffiliateEmailOutbox(sql, provider)) }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/emails POST')
  }
}
