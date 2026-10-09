#!/usr/bin/env node
/**
 * Build responsive WebP renditions of the large static storefront images (workstream E).
 *
 *   node scripts/generate-image-renditions.mjs           # (re)generate what is missing/stale
 *   node scripts/generate-image-renditions.mjs --check   # verify committed renditions + manifest, change nothing (CI/test)
 *
 * Why: `images.unoptimized: true` means next/image serves the ORIGINAL file at every size, so a 50%-width product card on a phone
 * downloaded a 1.3-5 MB file. The originals in public/images are never modified. Renditions go to public/images-r/<width>/<same path>.webp
 * and are described by lib/image-renditions.generated.json (only listed renditions are ever referenced, so a missing file can't be linked).
 * Deterministic: same input + same sharp version => same output. Both outputs are committed so deploys never depend on running sharp.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SRC_DIR = path.join(ROOT, 'public/images')
const OUT_DIR = path.join(ROOT, 'public/images-r')
const MANIFEST = path.join(ROOT, 'lib/image-renditions.generated.json')
export const WIDTHS = [640, 1080, 1600]
const MIN_BYTES = 120 * 1024         // smaller originals are already fine
const QUALITY = 85   // fleece texture is the product: keep fine grain (PSNR >= ~41 dB on the product shots)
const EXT = /\.(webp|png|jpe?g)$/i
const check = process.argv.includes('--check')

const sha = b => crypto.createHash('sha256').update(b).digest('hex')
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p); else yield p
  }
}

const files = [...walk(SRC_DIR)].filter(p => EXT.test(p) && fs.statSync(p).size >= MIN_BYTES).sort()
const web = p => '/images/' + path.relative(SRC_DIR, p).split(path.sep).join('/')
const outRel = (src, w) => `${w}/${src.slice('/images/'.length).replace(EXT, '.webp')}`
const seen = new Map()
for (const f of files) { const k = web(f).replace(EXT, ''); if (seen.has(k)) throw new Error(`rendition name collision: ${web(f)} vs ${seen.get(k)}`); seen.set(k, web(f)) }

let sharp = null
if (!check) sharp = createRequire(import.meta.url)('sharp')

const entries = {}
let wrote = 0, kept = 0, problems = []
for (const f of files) {
  const src = web(f)
  const buf = fs.readFileSync(f)
  const hash = sha(buf)
  const meta = check ? null : await sharp(buf).metadata()
  const prev = (() => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).images[src] } catch { return null } })()
  const width = meta?.width ?? prev?.width ?? 0
  const have = []
  // Fixed widths strictly below the original, plus - for originals up to the largest width - a "native" WebP at the original's own
  // width, so the (often multi-MB PNG/WebP) original itself is never the candidate a browser has to pick.
  const targets = [...new Set([...WIDTHS.filter(w => !width || w < width), ...(width && width <= WIDTHS[WIDTHS.length - 1] ? [width] : [])])].sort((a, b) => a - b)
  for (const w of targets) {
    const out = path.join(OUT_DIR, outRel(src, w))
    if (check) {
      if (prev && prev.renditions.includes(w)) { if (!fs.existsSync(out)) problems.push(`missing file for ${src} @${w}`); else have.push(w) }
      continue
    }
    const fresh = prev?.sha256 === hash && prev?.q === QUALITY && fs.existsSync(out)
    if (!fresh) {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      await sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: QUALITY, effort: 5 }).toFile(out)
      const made = fs.statSync(out).size
      if (made >= buf.length && /\.webp$/i.test(src) && w === width) { fs.unlinkSync(out); continue }   // native WebP no smaller than the original: keep the original
      wrote++
    } else kept++
    have.push(w)
  }
  if (check) {
    if (!prev) problems.push(`${src} is not in the manifest (run the generator)`)
    else if (prev.sha256 !== hash) problems.push(`${src} changed since its renditions were made (run the generator)`)
    else entries[src] = prev
  } else entries[src] = { sha256: hash, width, q: QUALITY, renditions: have }
}
if (check) {
  for (const k of Object.keys((() => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).images } catch { return {} } })()))
    if (!files.some(f => web(f) === k)) problems.push(`manifest lists ${k} which no longer exists`)
  if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
  console.log(`renditions OK for ${files.length} images`); process.exit(0)
}

// remove stale rendition files that are no longer referenced
const wanted = new Set(Object.entries(entries).flatMap(([src, e]) => e.renditions.map(w => path.join(OUT_DIR, outRel(src, w)))))
if (fs.existsSync(OUT_DIR)) for (const p of walk(OUT_DIR)) if (!wanted.has(p)) { fs.unlinkSync(p); problems.push('removed stale ' + path.relative(ROOT, p)) }

fs.writeFileSync(MANIFEST, JSON.stringify({
  _: 'GENERATED by scripts/generate-image-renditions.mjs - do not edit by hand. Source image (public/images) -> WebP renditions in public/images-r/<width>/. Only listed widths exist on disk.',
  widths: WIDTHS, images: entries,
}, null, 1) + '\n')
console.log(`renditions: wrote ${wrote}, kept ${kept}, images ${files.length}${problems.length ? '\n' + problems.join('\n') : ''}`)
