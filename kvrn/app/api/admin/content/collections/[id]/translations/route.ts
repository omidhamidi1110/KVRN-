// Collection translations (name, description, SEO title/description).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { collectionsSvc, readJson, respond } from '@/lib/content-http'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => ({ data: await collectionsSvc().translationOverview((await ctx.params).id) }))
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const b = await readJson(req)
    const status = b.status === 'needs_review' || b.status === 'published' ? b.status : 'draft'
    return await collectionsSvc().saveTranslation((await ctx.params).id,
      { locale: String(b.locale ?? ''), field: String(b.field ?? ''), value: String(b.value ?? ''), status, machineGenerated: b.machineGenerated === true }, identity.email)
  })
}

/** ?locale=es&field=name */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const sp = req.nextUrl.searchParams
    return await collectionsSvc().clearTranslation((await ctx.params).id, String(sp.get('locale') ?? ''), String(sp.get('field') ?? ''), identity.email)
  })
}
