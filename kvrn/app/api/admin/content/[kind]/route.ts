// List / create content of one kind (policies, size-guides, blocks, faq, pages, about, contact,
// support-pages, announcement, navigation, footer).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { contentSvc, parseKind, readJson, respond } from '@/lib/content-http'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ kind: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const kind = parseKind((await ctx.params).kind)
    const sp = req.nextUrl.searchParams
    const status = sp.get('status')
    const rows = await contentSvc().list(kind, { q: sp.get('q') ?? undefined, status: status && /^[a-z]+$/.test(status) ? status : undefined })
    // Lists never ship full bodies; the editor loads one entity at a time.
    return { data: rows.map(({ snapshot, ...r }) => r) }
  })
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const kind = parseKind((await ctx.params).kind)
    const body = await readJson(req)
    return await contentSvc().create(kind, body.snapshot, identity.email, typeof body.id === 'string' ? body.id : undefined)
  }, 201)
}
