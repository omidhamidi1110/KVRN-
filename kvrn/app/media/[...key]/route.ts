// Public, immutable media delivery from R2. Content-addressed keys → cache for a year.
// Only keys matching the strict media key pattern are served; anything else is a 404, so
// this route cannot be used to read arbitrary objects from the bucket.
import { type NextRequest } from 'next/server'
import { getMediaBucket, isValidMediaKey, mimeForKey, MediaStorageNotConfiguredError } from '@/lib/media-storage'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ key: string[] }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { key: parts } = await ctx.params
  const key = `media/${(parts ?? []).join('/')}`
  if (!isValidMediaKey(key)) return new Response('Not found', { status: 404 })

  let bucket
  try { bucket = await getMediaBucket() } catch (e) {
    if (e instanceof MediaStorageNotConfiguredError) return new Response('Media storage unavailable', { status: 503 })
    return new Response('Media storage unavailable', { status: 503 })
  }

  const obj = await bucket.get(key)
  if (!obj || !obj.body) return new Response('Not found', { status: 404 })

  const etag = obj.httpEtag
  if (etag && req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' } })
  }
  const headers: Record<string, string> = {
    'Content-Type': obj.httpMetadata?.contentType ?? mimeForKey(key) ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // Defence in depth: even if a non-image ever landed here it cannot execute as a page.
    'Content-Security-Policy': "default-src 'none'; sandbox",
  }
  if (etag) headers.ETag = etag
  if (typeof obj.size === 'number') headers['Content-Length'] = String(obj.size)
  return new Response(obj.body as any, { status: 200, headers })
}
