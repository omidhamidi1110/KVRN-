// Product Editor contract: which size guide a product shows, assign / clear it, and
// "Duplicate and edit" (an independent copy, assigned to this product).
//   GET  → { assigned: {id,name}|null, options: [{id,name,garment,status,productCount}] }
//   PUT  → { sizeGuideId: string | null }
//   POST → { action: 'duplicate', sizeGuideId }
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { contentSvc, readJson, respond } from '@/lib/content-http'
import { ContentError } from '@/lib/content-service'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ productId: string }> }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { productId } = await ctx.params
    if (!UUID_RE.test(productId)) throw new ContentError('invalid', 'Invalid product.')
    const link = (await sql`SELECT size_guide_id FROM product_size_guides WHERE product_id = ${productId}` as any[])[0]
    const all = await contentSvc().list('size-guides')
    const options = all.filter(g => g.status !== 'archived').map(g => ({
      id: g.id, name: g.title, garment: g.snapshot?.garment ?? '', status: g.status, isLive: g.isLive, productCount: (g as any).extra?.productCount ?? 0,
    }))
    const assigned = link ? (options.find(o => o.id === link.size_guide_id) ?? { id: link.size_guide_id, name: link.size_guide_id, garment: '', status: 'archived', isLive: false, productCount: 0 }) : null
    return { data: { assigned, options } }
  })
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { productId } = await ctx.params
    const b = await readJson(req)
    const id = b.sizeGuideId === null || b.sizeGuideId === '' ? null : String(b.sizeGuideId)
    if (id !== null && !ID_RE.test(id)) throw new ContentError('invalid', 'Choose a size guide.')
    return await contentSvc().assignSizeGuide(productId, id, identity.email)
  })
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { productId } = await ctx.params
    const b = await readJson(req)
    if (b.action !== 'duplicate') throw new ContentError('invalid', 'Unknown action.')
    if (!UUID_RE.test(productId)) throw new ContentError('invalid', 'Invalid product.')
    const id = String(b.sizeGuideId ?? '')
    if (!ID_RE.test(id)) throw new ContentError('invalid', 'Choose a size guide.')
    return await contentSvc().duplicateSizeGuideForProduct(id, productId, identity.email)
  }, 201)
}
