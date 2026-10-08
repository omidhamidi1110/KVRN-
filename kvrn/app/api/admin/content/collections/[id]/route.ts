// One collection: read, save (optimistic `version`), archive / restore.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { collectionsSvc, readJson, respond, expectRevision } from '@/lib/content-http'
import { ContentError } from '@/lib/content-service'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => ({ data: await collectionsSvc().get((await ctx.params).id) }))
}

/** Body: { collection: {...fields}, version } */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const b = await readJson(req)
    return await collectionsSvc().update((await ctx.params).id, b.collection, expectRevision(b.version, 'version'), identity.email)
  })
}

/** Body: { action: 'archive' | 'restore', version } */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const b = await readJson(req)
    if (b.action !== 'archive' && b.action !== 'restore') throw new ContentError('invalid', 'Unknown action.')
    return await collectionsSvc().setArchived((await ctx.params).id, b.action === 'archive', expectRevision(b.version, 'version'), identity.email)
  })
}
