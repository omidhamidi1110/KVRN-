// GET /api/admin/affiliates/audit — recent affiliate-program audit entries (payloads hold no secrets or PII).
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { programErrorResponse, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 100)
  try {
    return NextResponse.json({ entries: await createAffiliateProgramAdmin(sql).listAudit(Number.isFinite(limit) ? limit : 100) }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/audit GET')
  }
}
