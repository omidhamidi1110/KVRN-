// Version history of a product; `?version=N` returns that version's snapshot (compare / preview).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { productService, ok, bad, fail } from '@/lib/product-api'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  const v = req.nextUrl.searchParams.get('version')
  try {
    const svc = productService()
    if (v !== null) {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1) return bad('Invalid version.')
      const e: any = await svc.cms.get('product', id.toLowerCase())
      if (!e) return bad('Product not found.', 404)
      const row = await svc.cms.getVersion('product', id.toLowerCase(), n)
      return row ? ok({ version: row }) : bad('Version not found.', 404)
    }
    return ok({ versions: await svc.history(id) })
  } catch (e) { return fail(e) }
}
