// Collections: list + create. A collection is live while active and not archived.
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { collectionsSvc, readJson, respond } from '@/lib/content-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const sp = req.nextUrl.searchParams
    return { data: await collectionsSvc().list({ q: sp.get('q') ?? undefined, archived: sp.get('archived') === '1' }) }
  })
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => collectionsSvc().create(await readJson(req), identity.email), 201)
}
