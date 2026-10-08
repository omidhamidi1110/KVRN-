// Global product defaults (Shipping & Returns wording used by every product that does not override it).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { loadProductDefaults, saveProductDefaults } from '@/lib/product-defaults'
import { invalidateAfterCommit, CMS_TAGS } from '@/lib/cache-invalidation'
import { ok, bad, fail, readJson, asRevision } from '@/lib/product-api'
import { SettingsStaleError } from '@/lib/site-settings'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const d = await loadProductDefaults(sql)
  return ok({ data: d.value, revision: d.revision })
}

export async function PUT(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const b = await readJson(req)
  if (!b) return bad('Invalid body.')
  const revision = asRevision(b.revision)
  if (revision === null) return bad('Missing revision. Reload the page.')
  try {
    const r = await saveProductDefaults(sql, b.value, revision, identity.email)
    if (!r.ok) return bad('Some fields are not valid.', 400, { errors: r.errors })
    // Every product page shows these lines, so refresh the product pages (tag-based; no path list).
    const cacheInvalidation = await invalidateAfterCommit(sql, { paths: ['/shop'], tags: [CMS_TAGS.products] }, { reason: 'product defaults', actor: identity.email })
    return ok({ revision: r.revision, data: r.value, cacheInvalidation })
  } catch (e) {
    if (e instanceof SettingsStaleError) return bad('This was changed by someone else. Reload and try again.', 409, { code: 'stale' })
    return fail(e)
  }
}
