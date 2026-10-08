// Catalog search for the collection product picker (products are referenced, never copied).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { collectionsSvc, respond } from '@/lib/content-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => ({ data: await collectionsSvc().searchProducts((req.nextUrl.searchParams.get('q') ?? '').slice(0, 100)) }))
}
