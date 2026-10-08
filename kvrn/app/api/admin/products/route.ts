// Admin products: list (search / status filter / sort) and create (draft).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { productService, ok, bad, fail, readJson } from '@/lib/product-api'
import type { DisplayStatus } from '@/lib/product-service'

export const dynamic = 'force-dynamic'

const STATUSES = new Set(['all', 'draft', 'scheduled', 'live', 'sold_out', 'archived'])
const SORTS = new Set(['updated', 'name', 'price', 'status'])

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const sp = req.nextUrl.searchParams
  const status = sp.get('status') ?? 'all'
  const sort = sp.get('sort') ?? 'updated'
  if (!STATUSES.has(status) || !SORTS.has(sort)) return bad('Invalid filter.')
  try {
    const r = await productService().list({
      q: sp.get('q') ?? '', status: status as DisplayStatus | 'all', sort: sort as 'updated' | 'name' | 'price' | 'status',
      limit: Number(sp.get('limit')) || 100, offset: Number(sp.get('offset')) || 0,
    })
    return ok({ ...r })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const b = await readJson(req)
  if (!b) return bad('Invalid body.')
  const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : ''
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  const type = typeof b.type === 'string' ? b.type.trim().toLowerCase() : ''
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : undefined
  if (!code || !name) return bad('Enter a product name and a product code.')
  try {
    const r = await productService().create({ code, name, type, slug, actor: identity.email })
    return ok(r, 201)
  } catch (e) { return fail(e) }
}
