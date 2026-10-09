// POST { revision } — load the owner's October 6 text into a policy DRAFT (terms, privacy). Never publishes.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { contentSvc, readJson, respond, expectRevision } from '@/lib/content-http'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { id } = await ctx.params
    const body = await readJson(req)
    return await contentSvc().loadOwnerDraft(id, expectRevision(body.revision), identity.email)
  })
}
