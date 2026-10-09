// lib/responsive-image.ts — pure helpers that point static storefront images at their pre-built responsive renditions.
// (Renditions are made by scripts/generate-image-renditions.mjs; the manifest only lists files that exist.)
// Anything that is not a listed static image (R2 /media/ assets with their own variants, remote URLs, small files) is returned unchanged.
import manifest from './image-renditions.generated.json'

interface Entry { sha256: string; width: number; q?: number; renditions: number[] }
const IMAGES = manifest.images as Record<string, Entry>

/** Pathname of a same-site static image src, without query/hash. null when src is not a plain site-relative path. */
function sitePath(src: string): string | null {
  if (typeof src !== 'string' || !src.startsWith('/') || src.startsWith('//')) return null
  const cut = src.search(/[?#]/)
  return cut === -1 ? src : src.slice(0, cut)
}

export function renditionFor(src: string, width: number): { url: string; width: number } | null {
  const p = sitePath(src)
  const e = p ? IMAGES[p] : undefined
  if (!p || !e || !e.renditions.length || !Number.isFinite(width) || width <= 0) return null
  const sorted = [...e.renditions].sort((a, b) => a - b)
  // smallest rendition that is at least `width`; if the request is bigger than every rendition use the largest one
  // (never the multi-megabyte original: a 1600px rendition is already ≥ 1.25x on a 1280px layout slot).
  const w = sorted.find(r => r >= width) ?? sorted[sorted.length - 1]
  return { url: `/images-r/${w}/${p.slice('/images/'.length).replace(/\.(webp|png|jpe?g)$/i, '.webp')}`, width: w }
}

/** next/image custom loader body: a rendition URL when one exists, otherwise the original src. */
export function loadImage(src: string, width: number): string {
  return renditionFor(src, width)?.url ?? src
}

/** `srcset` string for a raw <img>, or undefined when the image has no renditions (the original stays the only candidate). */
export function imageSrcSet(src: string): string | undefined {
  const p = sitePath(src)
  const e = p ? IMAGES[p] : undefined
  if (!p || !e || !e.renditions.length) return undefined
  const parts = [...e.renditions].sort((a, b) => a - b).map(w => `${renditionFor(src, w)!.url} ${w}w`)
  // The original is deliberately NOT a candidate: it is the multi-megabyte fallback `src` for browsers without srcset support only.
  return parts.join(', ')
}
