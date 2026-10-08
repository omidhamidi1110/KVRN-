// Product lifecycle actions. Every action is one atomic database call; the response carries
// `cacheInvalidation` (ok:false when the storefront cache could not be refreshed) so Admin can
// say so and offer a retry.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { productService, ok, bad, fail, readJson, asRevision, asDate } from '@/lib/product-api'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

const ACTIONS = new Set(['publish', 'unpublish', 'schedule', 'archive', 'restore', 'rollback', 'duplicate', 'validate'])

export async function POST(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  const b = await readJson(req)
  if (!b) return bad('Invalid body.')
  const action = typeof b.action === 'string' ? b.action : ''
  if (!ACTIONS.has(action)) return bad('Unknown action.')
  const svc = productService()
  const actor = identity.email
  try {
    if (action === 'validate') return ok({ ...(await svc.validate(id)) })
    if (action === 'duplicate') return ok({ ...(await svc.duplicate(id, actor)) }, 201)

    const revision = asRevision(b.revision)
    if (revision === null) return bad('Missing revision. Reload the product.')
    if (action === 'publish') return ok({ ...(await svc.publish(id, revision, actor)) })
    if (action === 'unpublish') return ok({ ...(await svc.unpublish(id, revision, actor)) })
    if (action === 'archive') return ok({ ...(await svc.archive(id, revision, actor)) })
    if (action === 'restore') return ok({ ...(await svc.restore(id, revision, actor)) })
    if (action === 'rollback') {
      const v = typeof b.versionNo === 'number' ? b.versionNo : NaN
      if (!Number.isInteger(v)) return bad('Choose a version to restore.')
      return ok({ ...(await svc.rollback(id, v, revision, actor)) })
    }
    // schedule
    const publishAt = asDate(b.publishAt), unpublishAt = asDate(b.unpublishAt)
    if (publishAt === 'invalid' || unpublishAt === 'invalid') return bad('That date is not valid.')
    return ok({ ...(await svc.schedule(id, publishAt, unpublishAt, revision, actor)) })
  } catch (e) { return fail(e) }
}
