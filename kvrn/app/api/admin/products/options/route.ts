// Pickers for the editor: collections, Complete-the-Set candidates, product types in use.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { productService, ok, fail } from '@/lib/product-api'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const exclude = req.nextUrl.searchParams.get('exclude') ?? undefined
  try { return ok({ ...(await productService().options(exclude)) }) } catch (e) { return fail(e) }
}
