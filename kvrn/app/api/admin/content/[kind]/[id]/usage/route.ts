// Where a reusable content block / size guide is used (shown before unpublish or archive).
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
    if (kind === 'blocks') return { data: await contentSvc().blockUsage(id) }
    if (kind === 'size-guides') return { data: await contentSvc().listGuideProducts(id) }
    throw new ContentError('invalid', 'Usage is only tracked for blocks and size guides.')
  })
}
