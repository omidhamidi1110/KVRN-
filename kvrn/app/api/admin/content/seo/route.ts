// Site-wide SEO defaults (site_settings key seo.global).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { seoSvc, readJson, respond, expectRevision } from '@/lib/content-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => ({ data: await seoSvc().get() }))
}

/** Body: { value, revision } */
export async function PUT(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const b = await readJson(req)
    return await seoSvc().put(b.value, expectRevision(b.revision), identity.email)
  })
}
