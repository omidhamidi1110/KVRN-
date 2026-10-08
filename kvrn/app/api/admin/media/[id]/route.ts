// One media asset: detail (with usages), metadata edit, archive/restore, delete-if-unused.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import { getMediaBucket, toMediaAssetDTO, MEDIA_LIMITS, isValidMediaKey } from '@/lib/media-storage'
import { listMediaUsages } from '@/lib/media-usage'
import { invalidateAfterCommit, CMS_TAGS } from '@/lib/cache-invalidation'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function load(id: string) {
  const rows = await sql`SELECT * FROM media_assets WHERE id = ${id}` as any[]
  return rows[0] ?? null
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 })
  const row = await load(id)
  if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  return NextResponse.json({ success: true, data: toMediaAssetDTO(row), usages: await listMediaUsages(sql, id) })
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 })
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body.' }, { status: 400 }) }
  const row = await load(id)
  if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  const alt = body.altText === undefined ? row.alt_text : (String(body.altText ?? '').trim().slice(0, MEDIA_LIMITS.maxAltLength) || null)
  const title = body.title === undefined ? row.title : (String(body.title ?? '').trim().slice(0, 200) || null)
  const caption = body.caption === undefined ? row.caption : (String(body.caption ?? '').trim().slice(0, 500) || null)
  const tags = Array.isArray(body.tags) ? body.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12) : row.tags
  let status = row.status as 'active' | 'archived'
  if (body.status === 'archived' || body.status === 'active') status = body.status

  // Archiving an asset that a PUBLISHED page still uses is allowed (the object stays served so
  // nothing breaks) but the caller must see exactly where it is used and confirm.
  const usages = await listMediaUsages(sql, id)
  const livePublished = usages.filter(u => u.scope === 'published')
  if (status === 'archived' && row.status !== 'archived' && livePublished.length && body.confirmInUse !== true) {
    return NextResponse.json({ error: 'This image is in use.', code: 'IN_USE', usages }, { status: 409 })
  }

  // The record update and the admin audit must be one database transaction.
  // If the row vanishes between load() and UPDATE, do not report false success.
  const changed = await sql`
    WITH changed AS (
      UPDATE media_assets
         SET alt_text = ${alt}, title = ${title}, caption = ${caption}, tags = ${tags}, status = ${status},
             archived_at = ${status === 'archived' ? new Date().toISOString() : null}
       WHERE id = ${id}
       RETURNING id
    ), audited AS (
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      SELECT ${identity.email}, ${'media.' + (status !== row.status ? status : 'update')}, 'media_assets', id::text,
             ${JSON.stringify({ filename: row.filename })}::jsonb FROM changed
      RETURNING 1
    )
    SELECT id FROM changed` as any[]
  if (!changed.length) return NextResponse.json({ error: 'Image no longer exists. Reload media.' }, { status: 404 })
  // Alt text is rendered on public pages that reference this asset.
  const refresh = livePublished.length
    ? await invalidateAfterCommit(sql, { paths: ['/', '/shop'], tags: [CMS_TAGS.media, CMS_TAGS.products, CMS_TAGS.pages, CMS_TAGS.policies] },
                                  { reason: 'media metadata changed', actor: identity.email })
    : null
  return NextResponse.json({ success: true, data: toMediaAssetDTO(await load(id)), cacheInvalidation: refresh })
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const { id } = await ctx.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 })
  const row = await load(id)
  if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  // Hard delete is only for assets nothing references (draft OR published). Otherwise: archive.
  const usages = await listMediaUsages(sql, id)
  if (usages.length) {
    return NextResponse.json({ error: 'This image is in use. Archive it instead.', code: 'IN_USE', usages }, { status: 409 })
  }
  // Also guard the legacy hero reference on collections (FK is SET NULL, but we refuse silently dropping it).
  const col = await sql`SELECT 1 FROM collections WHERE hero_media_id = ${id} LIMIT 1` as any[]
  if (col.length) return NextResponse.json({ error: 'This image is a collection image. Archive it instead.', code: 'IN_USE' }, { status: 409 })

  try {
    const bucket = await getMediaBucket()
    const keys = [row.storage_key, ...(Array.isArray(row.variants) ? row.variants.map((v: any) => v.storage_key) : [])].filter(isValidMediaKey)
    // Delete the database record together with its audit entry, only if no
    // current reference exists. Retain keys in the private audit for manual
    // R2 cleanup if deletion of objects fails after the database commits.
    const deleted = await sql`
      WITH deleted AS (
        DELETE FROM media_assets
        WHERE id = ${id}
          AND NOT EXISTS (SELECT 1 FROM media_usages WHERE asset_id = media_assets.id)
          AND NOT EXISTS (SELECT 1 FROM collections WHERE hero_media_id = media_assets.id)
        RETURNING id
      ), audited AS (
        INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
        SELECT ${identity.email}, 'media.delete', 'media_assets', id::text,
               ${JSON.stringify({ filename: row.filename, storageKeys: keys })}::jsonb FROM deleted
        RETURNING 1
      )
      SELECT id FROM deleted` as any[]
    if (!deleted.length) return NextResponse.json({ error: 'Image changed or is in use. Reload media.', code: 'CONFLICT' }, { status: 409 })
    try {
      await bucket.delete(keys)
    } catch (storageError) {
      // The DB mutation already committed. Do not claim R2 was cleaned, and do
      // not encourage a retry of an already-deleted database row.
      console.error('[admin/media] R2 cleanup incomplete for deleted asset:', id,
        String(storageError instanceof Error ? storageError.message : storageError).slice(0, 120))
      return NextResponse.json({ success: true, storageCleanupPending: true,
        warning: 'The asset record was deleted, but R2 cleanup failed. The storage keys were retained in the private admin audit for manual cleanup.' })
    }
    return NextResponse.json({ success: true, storageCleanupPending: false })
  } catch {
    return NextResponse.json({ error: 'Delete failed.' }, { status: 500 })
  }
}
