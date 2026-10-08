// lib/media-storage.ts — R2-backed media storage core (Neon holds metadata only).
//
// SERVER-ONLY. No new npm dependency: image type + dimensions are read from file headers,
// hashing uses Web Crypto (available in Workers, Node 20 and jest).
//
// STORAGE MODEL
//   * Content-addressed. The key embeds the SHA-256 of the original, so a key's bytes never
//     change: public URLs are immutable and cacheable for a year, and "replacing" an image
//     means registering a new asset (new hash → new URL) — no stale-asset problem.
//   * One binary per distinct file: media_assets.sha256 is UNIQUE; re-uploading the same
//     bytes returns the existing asset instead of storing a second copy.
//   * The R2 binding is named KVRN_MEDIA. If it is absent every call fails CLEARLY with
//     MediaStorageNotConfiguredError (HTTP 503 in routes) — never silently falling back to
//     Neon or the filesystem. One-time setup is documented in the rollout plan.
//   * Responsive renditions (e.g. 480/960/1600 px WebP) are generated in the ADMIN BROWSER
//     before upload and registered as `variants`; the Worker does not decode images.

export const MEDIA_BINDING_NAME = 'KVRN_MEDIA'

export const MEDIA_LIMITS = {
  /** Original upload ceiling. Larger files must be resized first. */
  maxOriginalBytes: 12 * 1024 * 1024,
  maxVariantBytes:  6 * 1024 * 1024,
  maxVariants:      6,
  maxDimension:     12000,
  maxFilenameLength: 180,
  maxAltLength:     500,
} as const

export const ALLOWED_MEDIA_MIME = ['image/webp', 'image/jpeg', 'image/png', 'image/avif', 'image/gif'] as const
export type MediaMime = typeof ALLOWED_MEDIA_MIME[number]

const EXT: Record<MediaMime, string> = {
  'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/avif': 'avif', 'image/gif': 'gif',
}

/** Minimal R2 surface we depend on (so tests can supply an in-memory fake). */
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>
  get(key: string): Promise<null | {
    body: ReadableStream | null
    arrayBuffer(): Promise<ArrayBuffer>
    httpEtag?: string
    size?: number
    httpMetadata?: { contentType?: string }
  }>
  head?(key: string): Promise<null | { size?: number }>
  delete(key: string | string[]): Promise<void>
}

export class MediaStorageNotConfiguredError extends Error {
  readonly code = 'MEDIA_STORAGE_NOT_CONFIGURED'
  constructor() {
    super(`Media storage is not configured: the R2 binding "${MEDIA_BINDING_NAME}" is missing. ` +
          'Create the bucket and add the binding (see the production setup plan), then redeploy.')
  }
}

export class MediaValidationError extends Error {
  readonly code = 'MEDIA_INVALID'
  constructor(message: string) { super(message) }
}

/** Resolve the R2 bucket. Throws MediaStorageNotConfiguredError when absent. */
export async function getMediaBucket(envOverride?: Record<string, unknown>): Promise<R2BucketLike> {
  if (envOverride) {
    const b = envOverride[MEDIA_BINDING_NAME]
    if (!b) throw new MediaStorageNotConfiguredError()
    return b as R2BucketLike
  }
  try {
    const mod = await import('@opennextjs/cloudflare')
    const ctx = (mod as any).getCloudflareContext?.()
    const env = ctx?.env as Record<string, unknown> | undefined
    const b = env?.[MEDIA_BINDING_NAME]
    if (b) return b as R2BucketLike
  } catch { /* not running inside a Worker (next build, local dev, tests) */ }
  throw new MediaStorageNotConfiguredError()
}

// ── Header sniffing ───────────────────────────────────────────────────────────

export interface SniffedImage { mime: MediaMime; width: number | null; height: number | null }

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u32be = (b: Uint8Array, o: number) => ((b[o] * 2 ** 24) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3])
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))

/**
 * Identify the image from its MAGIC BYTES (never from the client-supplied type or file
 * extension) and read its pixel size. Returns null for anything that is not an allowed
 * raster image — including SVG and HTML masquerading as an image.
 */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  if (b.length < 12) return null

  // PNG
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
    return { mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20) }
  }

  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue }
      const marker = b[o + 1]
      if (marker === 0xff) { o++; continue }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue }
      const len = u16be(b, o + 2)
      if (len < 2) return { mime: 'image/jpeg', width: null, height: null }
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: u16be(b, o + 5), width: u16be(b, o + 7) }
      }
      o += 2 + len
    }
    return { mime: 'image/jpeg', width: null, height: null }
  }

  // GIF
  if (ascii(b, 0, 3) === 'GIF' && (ascii(b, 3, 3) === '87a' || ascii(b, 3, 3) === '89a')) {
    return { mime: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) }
  }

  // WebP (RIFF....WEBP)
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8X' && b.length >= 30) {
      return { mime: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
    }
    if (chunk === 'VP8 ' && b.length >= 30) {
      return { mime: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
    }
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] * 2 ** 24)
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    return { mime: 'image/webp', width: null, height: null }
  }

  // AVIF (ISO-BMFF: size, 'ftyp', brand avif/avis)
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4)
    if (brand === 'avif' || brand === 'avis') {
      // Dimensions live in nested 'ispe' box; scan a bounded window for it.
      const lim = Math.min(b.length - 12, 4096)
      for (let o = 12; o < lim; o++) {
        if (b[o] === 0x69 && ascii(b, o, 4) === 'ispe') {
          return { mime: 'image/avif', width: u32be(b, o + 8), height: u32be(b, o + 12) }
        }
      }
      return { mime: 'image/avif', width: null, height: null }
    }
  }
  return null
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('')
}

// ── Keys and URLs ─────────────────────────────────────────────────────────────

/** media/<aa>/<sha256>/original.webp  or  media/<aa>/<sha256>/w960.webp */
export function buildStorageKey(sha256: string, mime: MediaMime, rendition: 'original' | { width: number }): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new MediaValidationError('Invalid hash.')
  const name = rendition === 'original' ? 'original' : `w${Math.trunc(rendition.width)}`
  return `media/${sha256.slice(0, 2)}/${sha256}/${name}.${EXT[mime]}`
}

export const MEDIA_KEY_RE = /^media\/[0-9a-f]{2}\/[0-9a-f]{64}\/(?:original|w\d{2,5})\.(?:webp|jpg|png|avif|gif)$/

export function isValidMediaKey(key: string): boolean {
  return typeof key === 'string' && key.length < 200 && MEDIA_KEY_RE.test(key) && !key.includes('..')
}

/** Public URL for a stored key. Served by app/media/[...key]/route.ts. */
export function mediaUrlForKey(storageKey: string): string {
  if (!isValidMediaKey(storageKey)) throw new MediaValidationError('Invalid media key.')
  return `/${storageKey}`
}

const MIME_BY_EXT: Record<string, MediaMime> = {
  webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png', avif: 'image/avif', gif: 'image/gif',
}
export function mimeForKey(storageKey: string): MediaMime | null {
  const ext = storageKey.split('.').pop() ?? ''
  return MIME_BY_EXT[ext] ?? null
}

// ── Registration (upload) ─────────────────────────────────────────────────────

export interface MediaAssetDTO {
  id: string
  url: string
  storageKey: string
  mimeType: MediaMime
  width: number | null
  height: number | null
  byteSize: number
  filename: string
  altText: string | null
  title: string | null
  tags: string[]
  status: 'active' | 'archived'
  variants: Array<{ width: number; url: string; byteSize: number }>
  createdAt: string
}

export function toMediaAssetDTO(row: any): MediaAssetDTO {
  const variants = Array.isArray(row.variants) ? row.variants : []
  return {
    id: row.id,
    url: mediaUrlForKey(row.storage_key),
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    width: row.width ?? null,
    height: row.height ?? null,
    byteSize: row.byte_size,
    filename: row.filename,
    altText: row.alt_text ?? null,
    title: row.title ?? null,
    tags: row.tags ?? [],
    status: row.status,
    variants: variants
      .filter((v: any) => v && isValidMediaKey(v.storage_key))
      .map((v: any) => ({ width: v.width, url: mediaUrlForKey(v.storage_key), byteSize: v.byte_size })),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export function sanitizeFilename(raw: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim()
  return (cleaned || 'image').slice(0, MEDIA_LIMITS.maxFilenameLength)
}

export interface RegisterMediaInput {
  original: Uint8Array
  filename: string
  altText?: string | null
  title?: string | null
  tags?: string[]
  actor: string
  /** Browser-generated renditions of the SAME image. Each is sniffed and size-checked. */
  variants?: Array<{ bytes: Uint8Array }>
}

/**
 * Store an image (idempotent on content) and register it. Returns the asset and whether it
 * already existed. If the same bytes were uploaded before, nothing is written to R2 again.
 */
export async function registerMediaAsset(
  sql: any, bucket: R2BucketLike, input: RegisterMediaInput,
): Promise<{ asset: MediaAssetDTO; reused: boolean }> {
  const b = input.original
  if (!(b instanceof Uint8Array) || b.byteLength === 0) throw new MediaValidationError('Empty file.')
  if (b.byteLength > MEDIA_LIMITS.maxOriginalBytes) throw new MediaValidationError('File is too large.')
  const sniff = sniffImage(b)
  if (!sniff) throw new MediaValidationError('Unsupported image type. Use WebP, JPEG, PNG, AVIF or GIF.')
  if ((sniff.width && sniff.width > MEDIA_LIMITS.maxDimension) || (sniff.height && sniff.height > MEDIA_LIMITS.maxDimension)) {
    throw new MediaValidationError('Image dimensions are too large.')
  }
  if (input.altText && input.altText.length > MEDIA_LIMITS.maxAltLength) {
    throw new MediaValidationError('Alt text is too long.')
  }

  const sha = await sha256Hex(b)
  const existing = await sql`SELECT * FROM media_assets WHERE sha256 = ${sha}` as any[]
  if (existing[0]) return { asset: toMediaAssetDTO(existing[0]), reused: true }

  // Validate + key every variant before writing anything.
  const vs = (input.variants ?? [])
  if (vs.length > MEDIA_LIMITS.maxVariants) throw new MediaValidationError('Too many renditions.')
  const prepared: Array<{ bytes: Uint8Array; mime: MediaMime; width: number; key: string }> = []
  for (const v of vs) {
    if (v.bytes.byteLength === 0 || v.bytes.byteLength > MEDIA_LIMITS.maxVariantBytes) {
      throw new MediaValidationError('Rendition size is invalid.')
    }
    const s = sniffImage(v.bytes)
    if (!s || !s.width) throw new MediaValidationError('Rendition is not a readable image.')
    prepared.push({ bytes: v.bytes, mime: s.mime, width: s.width, key: buildStorageKey(sha, s.mime, { width: s.width }) })
  }
  if (new Set(prepared.map(p => p.key)).size !== prepared.length) {
    throw new MediaValidationError('Duplicate rendition width.')
  }

  const originalKey = buildStorageKey(sha, sniff.mime, 'original')
  const written: string[] = []
  try {
    const put = async (key: string, bytes: Uint8Array, mime: MediaMime) => {
      await bucket.put(key, bytes, { httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' } })
      written.push(key)
    }
    await put(originalKey, b, sniff.mime)
    for (const p of prepared) await put(p.key, p.bytes, p.mime)

    const variantsJson = JSON.stringify(prepared.map(p => ({
      width: p.width, storage_key: p.key, mime_type: p.mime, byte_size: p.bytes.byteLength,
    })))
    const rows = await sql`
      INSERT INTO media_assets
        (storage_key, sha256, mime_type, byte_size, width, height, variants, filename, alt_text, title, tags, created_by)
      VALUES
        (${originalKey}, ${sha}, ${sniff.mime}, ${b.byteLength}, ${sniff.width}, ${sniff.height},
         ${variantsJson}::jsonb, ${sanitizeFilename(input.filename)}, ${input.altText ?? null},
         ${input.title ?? null}, ${input.tags ?? []}, ${input.actor})
      ON CONFLICT (sha256) DO NOTHING
      RETURNING *
    ` as any[]
    if (rows[0]) return { asset: toMediaAssetDTO(rows[0]), reused: false }
    // Lost a race with a concurrent identical upload: the winner's rows are identical.
    const again = await sql`SELECT * FROM media_assets WHERE sha256 = ${sha}` as any[]
    return { asset: toMediaAssetDTO(again[0]), reused: true }
  } catch (e) {
    // Best-effort cleanup of objects THIS call wrote, only if no asset row references them.
    try {
      const row = await sql`SELECT 1 FROM media_assets WHERE sha256 = ${sha}` as any[]
      if (!row[0] && written.length) await bucket.delete(written)
    } catch { /* orphaned objects are harmless: content-addressed and re-usable */ }
    throw e
  }
}
