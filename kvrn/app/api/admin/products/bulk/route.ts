// Safe bulk product actions with a per-product result. Publish/unpublish need a typed
// confirmation and are validated product by product; there are no bulk price/stock/cost writes.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { productService, ok, bad, fail, readJson, asRevision } from '@/lib/product-api'

export const dynamic = 'force-dynamic'

const ACTIONS = ['archive', 'restore', 'publish', 'unpublish', 'add_collection', 'remove_collection'] as const

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const b = await readJson(req)
  if (!b) return bad('Invalid body.')
  const action = ACTIONS.find(a => a === b.action)
  if (!action) return bad('Unknown action.')
  if (!Array.isArray(b.items)) return bad('Select at least one product.')
  const items: Array<{ id: string; revision: number }> = []
  for (const it of b.items) {
    const o = it as Record<string, unknown>
    const rev = asRevision(o?.revision)
    if (!o || typeof o.id !== 'string' || rev === null) return bad('Invalid selection. Reload the list.')
    items.push({ id: o.id, revision: rev })
  }
  try {
    const r = await productService().bulk({
      action, items, actor: identity.email,
      confirm: typeof b.confirm === 'string' ? b.confirm : null,
      collectionId: typeof b.collectionId === 'string' ? b.collectionId : null,
    })
    return ok({ ...r })
  } catch (e) { return fail(e) }
}
