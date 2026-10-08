// One content entity: read (draft + live), autosave the draft, lifecycle actions.
// Every state change carries the revision the editor loaded; a stale revision is a 409.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { contentSvc, parseKind, readJson, respond, expectRevision } from '@/lib/content-http'
import { ContentError } from '@/lib/content-service'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ kind: string; id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { kind: k, id } = await ctx.params
    return { data: await contentSvc().get(parseKind(k), id) }
  })
}

/** Save the working draft (autosave and Save draft). Body: { snapshot, revision, note? } */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { kind: k, id } = await ctx.params
    const body = await readJson(req)
    const rev = expectRevision(body.revision)
    return await contentSvc().saveDraft(parseKind(k), id, body.snapshot, rev, identity.email, typeof body.note === 'string' ? body.note.slice(0, 200) : null)
  })
}

/** Lifecycle. Body: { action: publish|unpublish|rollback|archive|restore|duplicate, revision, versionNo?, force? } */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { kind: k, id } = await ctx.params
    const kind = parseKind(k)
    const body = await readJson(req)
    const svc = contentSvc()
    switch (body.action) {
      case 'publish':   return await svc.publish(kind, id, expectRevision(body.revision), identity.email)
      case 'unpublish': return await svc.unpublish(kind, id, expectRevision(body.revision), identity.email)
      case 'archive':   return await svc.archive(kind, id, expectRevision(body.revision), identity.email, { force: body.force === true })
      case 'restore':   return await svc.restore(kind, id, expectRevision(body.revision), identity.email)
      case 'duplicate': return await svc.duplicate(kind, id, identity.email)
      case 'rollback':  return await svc.rollback(kind, id, expectRevision(body.versionNo, 'version'), expectRevision(body.revision), identity.email)
      default: throw new ContentError('invalid', 'Unknown action.')
    }
  })
}
