// Collection assignment for one product (direct, unversioned; audited; caches invalidated).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { productService, ok, bad, fail, readJson } from '@/lib/product-api'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  const b = await readJson(req)
  if (!b || !Array.isArray(b.collectionIds)) return bad('Invalid body.')
  const ids = b.collectionIds.filter((x): x is string => typeof x === 'string')
  try { return ok({ ...(await productService().setCollections(id, ids, identity.email)) }) } catch (e) { return fail(e) }
}
