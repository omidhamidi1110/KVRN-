// Languages & currency settings (site_settings keys i18n.config and i18n.fx).
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { respond, readJson, expectRevision } from '@/lib/content-http'
import { i18nSvc } from '@/lib/i18n-admin-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => ({ data: await i18nSvc().get() }))
}

/** Body: { section: 'config' | 'fx', value, revision } */
export async function PUT(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const b = await readJson(req)
    const rev = expectRevision(b.revision)
    if (b.section === 'fx') return await i18nSvc().putFx(b.value, rev, identity.email)
    if (b.section === 'config') return await i18nSvc().putConfig(b.value, rev, identity.email)
    const { ContentError } = await import('@/lib/content-service')
    throw new ContentError('invalid', 'Choose what to save: config or fx.')
  })
}
