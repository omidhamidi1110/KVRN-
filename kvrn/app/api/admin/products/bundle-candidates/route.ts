// Products a bundle can include (editor picker): name, canonical price, status, variants + live availability.
// Read-only. Admin only.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { ok, fail } from '@/lib/product-api'
import { listBundleCandidates } from '@/lib/bundle-admin'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const sp = req.nextUrl.searchParams
  try {
    const candidates = await listBundleCandidates(sql, { exclude: sp.get('exclude'), q: sp.get('q') })
    return ok({ candidates })
  } catch (e) { return fail(e) }
}
