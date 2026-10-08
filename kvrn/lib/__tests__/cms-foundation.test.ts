// Foundation (migration 027 libs): feature flags, cache invalidation, media storage, translations.
import { isFeatureEnabled, listFeatureFlags, parseFlagValue, FEATURE_FLAGS } from '../feature-flags'
import {
  invalidateAfterCommit, normalizePaths, normalizeTags, productInvalidation,
  retryPendingInvalidations, collectionInvalidation, globalShellInvalidation,
} from '../cache-invalidation'
import {
  sniffImage, buildStorageKey, isValidMediaKey, registerMediaAsset, getMediaBucket,
  MediaStorageNotConfiguredError, sha256Hex, mediaUrlForKey, MEDIA_LIMITS, MediaValidationError,
} from '../media-storage'
import { resolveFields, summarizeCompleteness, sourceHash } from '../translations'
import { toCmsError } from '../cms-core'

describe('feature flags — default OFF, fail closed, independent', () => {
  test('every flag is OFF with an empty environment', () => {
    for (const name of Object.keys(FEATURE_FLAGS) as Array<keyof typeof FEATURE_FLAGS>) {
      expect(isFeatureEnabled(name, {})).toBe(false)
    }
  })
  test('only explicit truthy values enable; typos/empty/off stay OFF', () => {
    for (const v of ['on', 'ON', 'true', '1', 'yes', 'Enabled', ' on ']) expect(parseFlagValue(v)).toBe(true)
    for (const v of ['', 'off', 'false', '0', 'no', 'onn', 'enable', undefined, null, 1, true]) expect(parseFlagValue(v as any)).toBe(false)
  })
  test('flags are independent', () => {
    const env = { KVRN_FLAG_AFFILIATE_PORTAL: 'on' }
    expect(isFeatureEnabled('AFFILIATE_PORTAL', env)).toBe(true)
    expect(isFeatureEnabled('AFFILIATE_APPLICATIONS', env)).toBe(false)
    expect(isFeatureEnabled('MULTI_CURRENCY_CHECKOUT', env)).toBe(false)
  })
  test('listing reports source and flags unrecognised values without leaking them', () => {
    const l = listFeatureFlags({ KVRN_FLAG_CMS_PRODUCT_ROUTING: 'onn', KVRN_FLAG_AFFILIATE_PORTAL: 'on' })
    const typo = l.find(f => f.name === 'CMS_PRODUCT_ROUTING')!
    expect(typo.enabled).toBe(false); expect(typo.recognised).toBe(false); expect(typo.source).toBe('env')
    expect(JSON.stringify(l)).not.toContain('onn')
    expect(l.find(f => f.name === 'AFFILIATE_PORTAL')!.enabled).toBe(true)
    expect(l.find(f => f.name === 'RADAR_FULFILLMENT_HOLDS')!.source).toBe('default')
  })
  test('the flag module has no database or network dependency (kill switch must not depend on the feature)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../feature-flags.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"]\.\/db['"]|neon|fetch\(/)
  })
})

describe('cache invalidation helpers', () => {
  test('normalizePaths keeps plain same-origin paths only and de-dupes', () => {
    expect(normalizePaths(['/a', '/a/', '//evil.test', 'https://x.test', '/a/../b', '/ok path', '/b?x=1', '/p/q'])).toEqual(['/a', '/p/q'])
  })
  test('normalizeTags', () => { expect(normalizeTags(['cms:a', 'bad tag', 'cms:a', ''])).toEqual(['cms:a']) })
  test('product slug change invalidates BOTH old and new paths plus shop/home/sitemap', () => {
    const t = productInvalidation('new-slug', 'old-slug')
    expect(t.paths).toEqual(expect.arrayContaining(['/products/new-slug', '/products/old-slug', '/shop', '/', '/sitemap.xml']))
    expect(t.tags).toEqual(expect.arrayContaining(['cms:product:new-slug', 'cms:product:old-slug']))
  })
  test('collection and shell targets are precise (no full-site purge)', () => {
    expect(collectionInvalidation('c', 'o').paths).toEqual(expect.arrayContaining(['/collections/c', '/collections/o']))
    expect(globalShellInvalidation('footer').tags).toEqual(['cms:footer'])
  })

  function fakeSql(log: any[]) {
    const f: any = async (s: TemplateStringsArray, ...v: any[]) => {
      const text = s.join('?'); log.push({ text, v })
      if (/INSERT INTO cache_invalidations/.test(text)) return [{ id: 'inv-1' }]
      if (/SELECT id, paths, tags/.test(text)) return [{ id: 'r1', paths: ['/x'], tags: ['cms:x'] }]
      return []
    }
    return f
  }
  test('success → recorded done and ok:true', async () => {
    const log: any[] = []
    const calls: string[] = []
    const r = await invalidateAfterCommit(fakeSql(log), { paths: ['/p'], tags: ['cms:p'] }, { reason: 't' },
      { revalidatePath: p => { calls.push('path:' + p) }, revalidateTag: t => { calls.push('tag:' + t) } })
    expect(r.ok).toBe(true); expect(calls).toEqual(['path:/p', 'tag:cms:p'])
    expect(log.some(l => /status = 'done'/.test(l.text))).toBe(true)
  })
  test('failure is VISIBLE: recorded failed, ok:false returned, never thrown', async () => {
    const log: any[] = []
    const r = await invalidateAfterCommit(fakeSql(log), { paths: ['/p'] }, { reason: 't' },
      { revalidatePath: () => { throw new Error('boom') }, revalidateTag: () => {} })
    expect(r.ok).toBe(false); expect(r.error).toMatch(/boom/)
    expect(log.some(l => /status = 'failed'/.test(l.text))).toBe(true)
  })
  test('log-write failure is also reported as not-ok (site never claimed current)', async () => {
    const bad: any = async () => { throw new Error('db down') }
    const r = await invalidateAfterCommit(bad, { paths: ['/p'] }, { reason: 't' }, { revalidatePath() {}, revalidateTag() {} })
    expect(r.ok).toBe(false)
  })
  test('empty target is a no-op ok', async () => {
    const r = await invalidateAfterCommit(fakeSql([]), {}, { reason: 't' }, { revalidatePath() {}, revalidateTag() {} })
    expect(r).toMatchObject({ ok: true, id: null })
  })
  test('retry processes open rows', async () => {
    const log: any[] = []
    const out = await retryPendingInvalidations(fakeSql(log), {}, { revalidatePath() {}, revalidateTag() {} })
    expect(out).toEqual({ attempted: 1, done: 1, failed: 0 })
  })
})

// ── media ────────────────────────────────────────────────────────────────────
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h)
  return b
}
function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58])
  const wm = w - 1, hm = h - 1
  b[24] = wm & 255; b[25] = (wm >> 8) & 255; b[26] = (wm >> 16) & 255
  b[27] = hm & 255; b[28] = (hm >> 8) & 255; b[29] = (hm >> 16) & 255
  return b
}
function jpeg(w: number, h: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9])
}
const gif = (w: number, h: number) => Uint8Array.from([0x47,0x49,0x46,0x38,0x39,0x61, w&255,w>>8, h&255,h>>8, 0,0,0,0])

describe('media storage', () => {
  test('sniffs type + size from magic bytes', () => {
    expect(sniffImage(png(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 })
    expect(sniffImage(webpVp8x(1200, 800))).toEqual({ mime: 'image/webp', width: 1200, height: 800 })
    expect(sniffImage(jpeg(300, 200))).toEqual({ mime: 'image/jpeg', width: 300, height: 200 })
    expect(sniffImage(gif(20, 10))).toEqual({ mime: 'image/gif', width: 20, height: 10 })
  })
  test('rejects SVG, HTML and text regardless of claimed type', () => {
    const enc = (s: string) => new TextEncoder().encode(s.padEnd(40, ' '))
    expect(sniffImage(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(sniffImage(enc('<!doctype html><script>alert(1)</script>'))).toBeNull()
    expect(sniffImage(new Uint8Array(4))).toBeNull()
  })
  test('keys are content-addressed and strictly validated', async () => {
    const sha = await sha256Hex(png(1, 1))
    const k = buildStorageKey(sha, 'image/webp', 'original')
    expect(isValidMediaKey(k)).toBe(true)
    expect(mediaUrlForKey(k)).toBe('/' + k)
    expect(isValidMediaKey(buildStorageKey(sha, 'image/webp', { width: 960 }))).toBe(true)
    for (const bad of ['media/../etc/passwd', 'media/aa/zz/original.webp', `${k}/x`, 'other/' + sha, '']) expect(isValidMediaKey(bad)).toBe(false)
  })
  test('absent R2 binding fails CLEARLY', async () => {
    await expect(getMediaBucket({})).rejects.toBeInstanceOf(MediaStorageNotConfiguredError)
    await expect(getMediaBucket({})).rejects.toThrow(/KVRN_MEDIA/)
  })

  function memBucket() {
    const m = new Map<string, Uint8Array>()
    return { m, bucket: {
      put: async (k: string, v: any) => { m.set(k, v) }, get: async () => null, delete: async (k: any) => { for (const x of [k].flat()) m.delete(x) },
    } as any }
  }
  function memSql() {
    const rows: any[] = []
    const f: any = async (s: TemplateStringsArray, ...v: any[]) => {
      const t = s.join('?')
      if (/SELECT \* FROM media_assets WHERE sha256/.test(t)) return rows.filter(r => r.sha256 === v[0])
      if (/INSERT INTO media_assets/.test(t)) {
        if (rows.some(r => r.sha256 === v[1])) return []
        const r = { id: 'id' + rows.length, storage_key: v[0], sha256: v[1], mime_type: v[2], byte_size: v[3], width: v[4], height: v[5],
          variants: JSON.parse(v[6]), filename: v[7], alt_text: v[8], title: v[9], tags: v[10], status: 'active', created_at: new Date() }
        rows.push(r); return [r]
      }
      return []
    }
    return { f, rows }
  }
  test('same bytes twice → one object, reused asset (no duplicate binary)', async () => {
    const { m, bucket } = memBucket(); const { f, rows } = memSql()
    const img = webpVp8x(900, 600)
    const a = await registerMediaAsset(f, bucket, { original: img, filename: 'a b.webp', actor: 'x@y.z', variants: [{ bytes: webpVp8x(480, 320) }] })
    const b = await registerMediaAsset(f, bucket, { original: img, filename: 'again.webp', actor: 'x@y.z' })
    expect(a.reused).toBe(false); expect(b.reused).toBe(true); expect(b.asset.id).toBe(a.asset.id)
    expect(rows).toHaveLength(1); expect(m.size).toBe(2)       // original + one rendition, written once
    expect(a.asset.variants[0].width).toBe(480)
  })
  test('rejects oversize, non-image and absurd dimensions before touching R2', async () => {
    const { m, bucket } = memBucket(); const { f } = memSql()
    await expect(registerMediaAsset(f, bucket, { original: new TextEncoder().encode('<svg onload=alert(1)>'.padEnd(40)), filename: 'x.svg', actor: 'a' })).rejects.toBeInstanceOf(MediaValidationError)
    await expect(registerMediaAsset(f, bucket, { original: png(50000, 10), filename: 'x.png', actor: 'a' })).rejects.toThrow(/dimensions/)
    const big = new Uint8Array(MEDIA_LIMITS.maxOriginalBytes + 1); big.set(png(1, 1))
    await expect(registerMediaAsset(f, bucket, { original: big, filename: 'x.png', actor: 'a' })).rejects.toThrow(/too large/)
    expect(m.size).toBe(0)
  })
})

describe('translations — completeness is honest', () => {
  const src = { title: 'Terms', body: 'Long legal text' }
  test('fallback is labelled fallback, never "translated"', () => {
    const r = resolveFields(src, [], 'es')
    expect(r.title).toEqual({ value: 'Terms', state: 'fallback' })
  })
  test('only PUBLISHED translations are used; drafts/needs_review fall back', () => {
    const rows = [
      { field: 'title', value: 'Términos', status: 'published' as const, source_hash: sourceHash('Terms') },
      { field: 'body', value: 'borrador', status: 'draft' as const, source_hash: null },
    ]
    const r = resolveFields(src, rows, 'es')
    expect(r.title.state).toBe('translated'); expect(r.body.state).toBe('fallback'); expect(r.body.value).toBe('Long legal text')
  })
  test('changed source marks a translation stale', () => {
    const rows = [{ field: 'title', value: 'Términos', status: 'published' as const, source_hash: sourceHash('Old title') }]
    expect(resolveFields(src, rows, 'es').title.state).toBe('stale')
  })
  test('summary: incomplete until every field is translated', () => {
    const rows = { es: [{ field: 'title', value: 'T', status: 'published' as const, source_hash: null }] }
    const s = summarizeCompleteness(src, rows, ['en', 'es', 'fr'])
    expect(s.find(x => x.locale === 'es')).toMatchObject({ total: 2, translated: 1, missing: 1, complete: false })
    expect(s.find(x => x.locale === 'fr')).toMatchObject({ translated: 0, complete: false })
    expect(s.find(x => x.locale === 'en')).toBeUndefined()
  })
})

describe('cms error mapping', () => {
  test.each([
    ['CMS_STALE_REVISION|product|x', 'stale', 409], ['CMS_SLUG_TAKEN|product|a', 'slug_taken', 409],
    ['CMS_NO_DRAFT|p|x', 'no_draft', 400], ['CMS_NOT_FOUND|p|x', 'not_found', 404], ['weird', 'unknown', 500],
  ])('%s', (msg, code, status) => {
    const e = toCmsError(new Error(msg)); expect(e.code).toBe(code); expect(e.status).toBe(status)
  })
})
