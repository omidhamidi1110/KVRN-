// Resolves what the in-admin preview needs to render a DRAFT: media urls for asset ids and
// the live content of referenced reusable blocks. ?media=id,id&blocks=id,id
import { type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { respond } from '@/lib/content-http'
import { mediaUrlForKey } from '@/lib/media-storage'

export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ids = (v: string | null, re: RegExp) => (v ?? '').split(',').map(s => s.trim()).filter(s => re.test(s)).slice(0, 100)

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  return respond(async () => {
    const sp = req.nextUrl.searchParams
    const media: Record<string, { url: string; alt: string; width: number | null; height: number | null }> = {}
    const m = ids(sp.get('media'), UUID_RE)
    if (m.length) {
      const rows = await sql`SELECT id, storage_key, alt_text, width, height FROM media_assets WHERE id = ANY(${m}::uuid[])` as any[]
      for (const r of rows) media[r.id] = { url: mediaUrlForKey(r.storage_key), alt: r.alt_text ?? '', width: r.width, height: r.height }
    }
    const blocks: Record<string, unknown> = {}
    const b = ids(sp.get('blocks'), ID_RE)
    if (b.length) {
      // Preview shows what a published page would pull in: only LIVE blocks resolve.
      const rows = await sql`
        SELECT e.entity_id, v.snapshot FROM content_entities e
          JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id AND v.version_no = e.published_version_no
         WHERE e.entity_type = 'content_block' AND e.status = 'published' AND e.entity_id = ANY(${b}::text[])` as any[]
      for (const r of rows) blocks[r.entity_id] = r.snapshot?.content ?? null
    }
    return { data: { media, blocks } }
  })
}
