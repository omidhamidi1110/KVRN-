// Replace a collection's ordered product list. Body: { productIds: string[], version }
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { collectionsSvc, readJson, respond, expectRevision } from '@/lib/content-http'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const b = await readJson(req)
    return await collectionsSvc().setProducts((await ctx.params).id, b.productIds, expectRevision(b.version, 'version'), identity.email)
  })
}
