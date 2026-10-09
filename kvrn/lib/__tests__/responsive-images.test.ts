// Workstream E: responsive image renditions — pure helpers, loader, and the committed manifest/files stay in sync.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { renditionFor, imageSrcSet, loadImage } from '../responsive-image'
import loader from '../image-loader'
import manifest from '../image-renditions.generated.json'

const ROOT = path.resolve(__dirname, '../..')
const IMAGES = manifest.images as Record<string, { sha256: string; width: number; renditions: number[] }>
const HOODIE = '/images/products/project-kvrn-heavyweight-hoodie/5.webp'

describe('rendition selection', () => {
  test('smallest rendition that covers the requested width; the largest when the request exceeds all', () => {
    expect(renditionFor(HOODIE, 300)).toMatchObject({ width: 640, url: '/images-r/640/products/project-kvrn-heavyweight-hoodie/5.webp' })
    expect(renditionFor(HOODIE, 640)!.width).toBe(640)
    expect(renditionFor(HOODIE, 641)!.width).toBe(1080)
    expect(renditionFor(HOODIE, 1200)!.width).toBe(1600)
    expect(renditionFor(HOODIE, 3840)!.width).toBe(1600)        // never the multi-MB original
  })
  test('PNG/JPEG sources map to .webp renditions; query strings are ignored', () => {
    const r = renditionFor('/images/collections/shop-all-mobile-hero.png?v=2', 300)
    expect(r!.url).toBe('/images-r/640/collections/shop-all-mobile-hero.webp')
  })
  test('unknown, remote, protocol-relative, R2 and invalid inputs are returned unchanged', () => {
    for (const s of ['/images/unknown.webp', 'https://cdn.example.com/a.webp', '//evil.test/a.webp', '/media/ab/cdef/original.webp', 'data:image/png;base64,AA', '']) {
      expect(renditionFor(s, 800)).toBeNull(); expect(loadImage(s, 800)).toBe(s); expect(imageSrcSet(s)).toBeUndefined()
    }
    expect(renditionFor(HOODIE, 0)).toBeNull(); expect(renditionFor(HOODIE, NaN)).toBeNull()
  })
  test('srcset lists only renditions, ascending; the original is never a candidate', () => {
    const s = imageSrcSet(HOODIE)!
    const parts = s.split(', ')
    expect(parts[0]).toMatch(/^\/images-r\/640\/.* 640w$/)
    expect(parts.map(p => Number(p.match(/ (\d+)w$/)![1]))).toEqual([...parts.map(p => Number(p.match(/ (\d+)w$/)![1]))].sort((a, b) => a - b))
    expect(s).not.toContain(HOODIE + ' ')
    expect(parts).toHaveLength(IMAGES[HOODIE].renditions.length)
  })
  test('the next/image loader delegates to the same mapping', () => {
    expect(loader({ src: HOODIE, width: 828 })).toBe(renditionFor(HOODIE, 828)!.url)
    expect(loader({ src: '/images/unknown.webp', width: 828 })).toBe('/images/unknown.webp')
  })
})

describe('committed manifest matches the files on disk (run `node scripts/generate-image-renditions.mjs` after changing an original)', () => {
  const entries = Object.entries(IMAGES)
  test('there are entries', () => { expect(entries.length).toBeGreaterThanOrEqual(15) })
  test.each(entries)('%s: original hash matches and every listed rendition exists, is smaller and is WebP', (src, e) => {
    const orig = fs.readFileSync(path.join(ROOT, 'public', src))
    expect(crypto.createHash('sha256').update(orig).digest('hex')).toBe(e.sha256)
    for (const w of e.renditions) {
      const out = path.join(ROOT, 'public/images-r', String(w), src.slice('/images/'.length).replace(/\.(webp|png|jpe?g)$/i, '.webp'))
      const b = fs.readFileSync(out)
      expect(b.subarray(0, 4).toString()).toBe('RIFF'); expect(b.subarray(8, 12).toString()).toBe('WEBP')
      expect(b.length).toBeLessThan(orig.length)
      expect(w).toBeLessThanOrEqual(e.width)                    // never an upscale (== is the native-width WebP)
    }
  })
  test('no stray rendition files outside the manifest', () => {
    const wanted = new Set(entries.flatMap(([src, e]) => e.renditions.map(w => path.join(ROOT, 'public/images-r', String(w), src.slice('/images/'.length).replace(/\.(webp|png|jpe?g)$/i, '.webp')))))
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)])
    expect(walk(path.join(ROOT, 'public/images-r')).filter(f => !wanted.has(f))).toEqual([])
  })
  test('the heaviest originals all have renditions', () => {
    for (const s of Object.keys(IMAGES)) expect(IMAGES[s].renditions.length).toBeGreaterThan(0)
  })
})

describe('wiring', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  test('next.config uses the custom loader and no longer sets images.unoptimized', () => {
    const c = read('next.config.js')
    expect(c).toMatch(/loaderFile:\s*'\.\/lib\/image-loader\.ts'/); expect(c).toMatch(/loader:\s*'custom'/)
    expect(c.replace(/\/\/.*$/gm, '')).not.toMatch(/unoptimized/)
  })
  test('PDP raw <img> galleries pass a srcset and sizes', () => {
    const s = read('app/products/[slug]/PDPClient.tsx')
    expect((s.match(/srcSet=\{imageSrcSet\(img\.src\)\}/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })
  test('PDP mobile cache-warming Image() uses the srcset, never only the multi-MB original', () => {
    const s = read('app/products/[slug]/PDPClient.tsx')
    const i = s.indexOf('new window.Image()')
    expect(i).toBeGreaterThan(-1)
    const block = s.slice(i, i + 600)
    expect(block).toMatch(/el\.sizes\s*=/)
    expect(block).toMatch(/el\.srcset\s*=\s*set/)
  })
})
