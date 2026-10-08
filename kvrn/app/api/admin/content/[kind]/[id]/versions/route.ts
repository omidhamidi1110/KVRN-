// Version history of one entity; ?version=N returns that version's snapshot (for preview / diff).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { contentSvc, parseKind, respond } from '@/lib/content-http'
import { ContentError } from '@/lib/content-service'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ kind: string; id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { kind: k, id } = await ctx.params
    const kind = parseKind(k)
    const v = req.nextUrl.searchParams.get('version')
    if (v !== null) {
      if (!/^\d{1,9}$/.test(v)) throw new ContentError('invalid', 'Invalid version.')
      return { data: await contentSvc().getVersion(kind, id, Number(v)) }
    }
    return { data: await contentSvc().history(kind, id) }
  })
}
