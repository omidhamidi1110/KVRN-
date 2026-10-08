// Translations of one entity: overview + completeness, save a field, clear a field, and the
// per-locale publish / unpublish actions (legal content needs an explicit acknowledgement).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { contentSvc, parseKind, readJson, respond } from '@/lib/content-http'
import { ContentError } from '@/lib/content-service'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ kind: string; id: string }> }
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { kind: k, id } = await ctx.params
    return { data: await contentSvc().translationOverview(parseKind(k), id) }
  })
}

/** Save one field. Body: { locale, field, value, status?: draft|needs_review|published, machineGenerated? } */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { kind: k, id } = await ctx.params
    const b = await readJson(req)
    const status = b.status === 'needs_review' || b.status === 'published' ? b.status : 'draft'
    return await contentSvc().saveTranslation(parseKind(k), id, {
      locale: String(b.locale ?? ''), field: String(b.field ?? ''), value: String(b.value ?? ''), status, machineGenerated: b.machineGenerated === true,
    }, identity.email)
  })
}

/** Body: { action: 'publish-locale' | 'unpublish-locale', locale, acknowledge? } */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { kind: k, id } = await ctx.params
    const kind = parseKind(k)
    const b = await readJson(req)
    const locale = String(b.locale ?? '')
    if (!LOCALE.test(locale)) throw new ContentError('invalid', 'Choose a translation language.')
    if (b.action === 'publish-locale') return await contentSvc().publishLocale(kind, id, locale, identity.email, { acknowledge: b.acknowledge === true })
    if (b.action === 'unpublish-locale') return await contentSvc().unpublishLocale(kind, id, locale, identity.email)
    throw new ContentError('invalid', 'Unknown action.')
  })
}

/** ?locale=es&field=title */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const { kind: k, id } = await ctx.params
    const sp = req.nextUrl.searchParams
    return await contentSvc().clearTranslation(parseKind(k), id, String(sp.get('locale') ?? ''), String(sp.get('field') ?? ''), identity.email)
  })
}
