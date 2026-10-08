// GET /api/affiliate/me — who am I, and what may I do.
import { type NextRequest } from 'next/server'
import { requireAffiliate } from '@/lib/affiliate-auth-guard'
import { portalJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { ctx, error } = await requireAffiliate(req)
  if (error) return error
  return portalJson({
    name: ctx!.displayName ?? ctx!.name,
    code: ctx!.code,
    programStatus: ctx!.programStatus,
    readOnly: ctx!.readOnly,
    accessReason: ctx!.accessReason,
    requiresReacceptance: ctx!.requiresReacceptance,
  })
}
