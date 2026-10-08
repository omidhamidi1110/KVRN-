// One product: editor state (GET) and draft autosave with stale-revision protection (PUT).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { productService, ok, bad, fail, readJson, asRevision } from '@/lib/product-api'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  try { return ok({ data: await productService().getEditorState(id) }) } catch (e) { return fail(e) }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  const b = await readJson(req)
  if (!b) return bad('Invalid body.')
  const revision = asRevision(b.revision)
  if (revision === null) return bad('Missing revision. Reload the product.')
  const note = typeof b.note === 'string' ? b.note.slice(0, 200) : null
  try { return ok({ ...(await productService().saveDraft(id, b.snapshot, revision, identity.email, note)) }) } catch (e) { return fail(e) }
}
