// Draft (or live, when no draft is open) rendering inputs for the private preview.
// Never indexed, never public: this route is admin-only and the preview page is noindex.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { productService, ok, bad, fail } from '@/lib/product-api'
import { getProductPreview } from '@/lib/product-public'
import { snapshotAssetIds } from '@/lib/product-model'
import { loadProductDefaults } from '@/lib/product-defaults'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  try {
    const state = await productService().getEditorState(id)
    const preview = await getProductPreview(id)
    if (!preview) return bad('This product cannot be previewed yet. Add a name, colours and images.', 422)
    return ok({
      product: preview.product, relatedProduct: preview.relatedProduct, hasDraft: preview.hasDraft,
      snapshot: state.snapshot, assets: state.assets, assetIds: snapshotAssetIds(state.snapshot),
      defaults: (await loadProductDefaults(sql)).value,
    })
  } catch (e) { return fail(e) }
}
