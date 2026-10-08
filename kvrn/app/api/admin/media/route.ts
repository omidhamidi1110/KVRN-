// Media Library: list/search + upload. Admin only.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { sql } from '@/lib/db'
import {
  getMediaBucket, registerMediaAsset, toMediaAssetDTO, MediaStorageNotConfiguredError, MediaValidationError, MEDIA_LIMITS,
} from '@/lib/media-storage'

export const dynamic = 'force-dynamic'
const MAX_REQUEST_BYTES = 40 * 1024 * 1024

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const p = req.nextUrl.searchParams
  const limit = Math.min(Math.max(parseInt(p.get('limit') ?? '48', 10) || 48, 1), 100)
  const offset = Math.max(parseInt(p.get('offset') ?? '0', 10) || 0, 0)
  const status = p.get('status') === 'archived' ? 'archived' : 'active'
  const q = (p.get('search') ?? '').trim().slice(0, 100)
  const like = q ? `%${q.replace(/[%_\\]/g, m => '\\' + m)}%` : null
  try {
    const rows = await sql`
      SELECT m.*, (SELECT COUNT(*)::int FROM media_usages u WHERE u.asset_id = m.id) AS usage_count
        FROM media_assets m
       WHERE m.status = ${status}
         AND (${like}::text IS NULL OR m.filename ILIKE ${like} OR m.alt_text ILIKE ${like}
              OR m.title ILIKE ${like} OR EXISTS (SELECT 1 FROM unnest(m.tags) t WHERE t ILIKE ${like}))
       ORDER BY m.created_at DESC LIMIT ${limit} OFFSET ${offset}` as any[]
    const total = (await sql`
      SELECT COUNT(*)::int AS n FROM media_assets m
       WHERE m.status = ${status}
         AND (${like}::text IS NULL OR m.filename ILIKE ${like} OR m.alt_text ILIKE ${like}
              OR m.title ILIKE ${like} OR EXISTS (SELECT 1 FROM unnest(m.tags) t WHERE t ILIKE ${like}))`)[0]?.n ?? 0
    return NextResponse.json({
      success: true,
      data: rows.map(r => ({ ...toMediaAssetDTO(r), usageCount: r.usage_count })),
      meta: { total, limit, offset },
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Failed to load media.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error

  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > MAX_REQUEST_BYTES) return NextResponse.json({ error: 'Upload is too large.' }, { status: 413 })

  let bucket
  try { bucket = await getMediaBucket() } catch (e) {
    if (e instanceof MediaStorageNotConfiguredError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 503 })
    }
    return NextResponse.json({ error: 'Media storage unavailable.' }, { status: 503 })
  }

  let form: FormData
  try { form = await req.formData() } catch { return NextResponse.json({ error: 'Invalid upload.' }, { status: 400 }) }
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided.' }, { status: 400 })

  // Enforce all byte/count limits BEFORE converting File objects to ArrayBuffers. formData() has already
  // parsed the multipart request, but this prevents a large upload from being duplicated into Worker memory.
  const variantFiles = form.getAll('variants').filter((v): v is File => v instanceof File)
  if (variantFiles.length > MEDIA_LIMITS.maxVariants) return NextResponse.json({ error: 'Too many renditions.' }, { status: 400 })
  if (file.size > MEDIA_LIMITS.maxOriginalBytes) return NextResponse.json({ error: 'Original image is too large.' }, { status: 413 })
  if (variantFiles.some(v => v.size > MEDIA_LIMITS.maxVariantBytes)) return NextResponse.json({ error: 'A rendition is too large.' }, { status: 413 })
  const actualBytes = file.size + variantFiles.reduce((n, v) => n + v.size, 0)
  if (actualBytes > MAX_REQUEST_BYTES) return NextResponse.json({ error: 'Upload is too large.' }, { status: 413 })

  const variants: Array<{ bytes: Uint8Array }> = []
  for (const v of variantFiles) variants.push({ bytes: new Uint8Array(await v.arrayBuffer()) })

  const str = (k: string, max: number) => { const x = form.get(k); return typeof x === 'string' ? x.trim().slice(0, max) || null : null }
  const tags = (str('tags', 300) ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 12)

  try {
    const { asset, reused } = await registerMediaAsset(sql, bucket, {
      original: new Uint8Array(await file.arrayBuffer()),
      filename: file.name, altText: str('altText', MEDIA_LIMITS.maxAltLength), title: str('title', 200),
      tags, actor: identity.email, variants,
    })
    if (!reused) {
      await sql`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
                VALUES (${identity.email}, 'media.upload', 'media_assets', ${asset.id}, ${JSON.stringify({ filename: asset.filename, bytes: asset.byteSize })}::jsonb)`
    }
    return NextResponse.json({ success: true, data: asset, meta: { reused } }, { status: reused ? 200 : 201 })
  } catch (e) {
    if (e instanceof MediaValidationError) return NextResponse.json({ error: e.message }, { status: 400 })
    return NextResponse.json({ error: 'Upload failed.' }, { status: 500 })
  }
}
