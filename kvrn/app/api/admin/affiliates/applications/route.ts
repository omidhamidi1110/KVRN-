// GET /api/admin/affiliates/applications — application queue (+ counts).
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { APPLICATION_STATUSES } from '@/lib/affiliate-program'
import { getApplicationReadiness } from '@/lib/affiliate-program'
import { programErrorResponse, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const raw = req.nextUrl.searchParams.get('status')
  const status = raw && (APPLICATION_STATUSES as readonly string[]).includes(raw) ? raw : null
  try {
    const svc = createAffiliateProgramAdmin(sql)
    if (req.nextUrl.searchParams.get('countsOnly') === '1') {
      return NextResponse.json({ counts: await svc.counts() }, { headers: NO_STORE })
    }
    const [applications, counts, readiness] = await Promise.all([
      svc.listApplications({ status }), svc.counts(), getApplicationReadiness(sql),
    ])
    return NextResponse.json({ applications, counts, readiness }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/applications GET')
  }
}
