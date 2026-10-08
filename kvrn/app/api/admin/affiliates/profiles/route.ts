// GET /api/admin/affiliates/profiles — affiliates with program identity and status.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { createAffiliateProgramAdmin } from '@/lib/affiliate-program-admin'
import { programErrorResponse, NO_STORE } from '@/lib/affiliate-program-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    return NextResponse.json({ profiles: await createAffiliateProgramAdmin(sql).listProfiles() }, { headers: NO_STORE })
  } catch (err) {
    return programErrorResponse(err, 'admin/affiliates/profiles GET')
  }
}
