// lib/product-images.ts — turn snapshot image slots into storefront ProductImage values (pure).
//
// * Image refs are {kind:'static', src} (legacy files in /public) or {kind:'media', assetId}
//   (Media Library). Media URLs are resolved from the asset rows, never typed by hand.
// * Focal points are normalised (x,y in 0..1) and stored separately for mobile and desktop;
//   they become CSS object-position. null = "use the template default" so coded products
//   render exactly as before.
import type { FocalPoint, ProductImage } from '@/types'
import type { ImageRef, ImageSlot } from './product-model'
import { imageTypeAt } from './product-model'

/** Minimal asset shape the resolver needs (MediaAssetDTO satisfies it). */
export interface AssetLite {
  id: string
  url: string
  width?: number | null
  variants?: Array<{ width: number; url: string }>
}
export type AssetMap = Record<string, AssetLite | undefined>

/** CSS object-position from a focal point, or the supplied template default. */
export function objectPositionFor(focal: FocalPoint | null | undefined, fallback: string): string {
  if (!focal) return fallback
  return `${Math.round(focal.x * 1000) / 10}% ${Math.round(focal.y * 1000) / 10}%`
}

export function resolveRefUrl(ref: ImageRef | null | undefined, assets: AssetMap): { src: string; srcSet?: string } | null {
  if (!ref) return null
  if (ref.kind === 'static') return { src: ref.src }
  const a = assets[ref.assetId.toLowerCase()] ?? assets[ref.assetId]
  if (!a) return null
  const vs = [...(a.variants ?? [])].sort((x, y) => x.width - y.width)
  const srcSet = vs.length ? vs.map(v => `${v.url} ${v.width}w`).join(', ') : undefined
  return { src: a.url, ...(srcSet ? { srcSet } : {}) }
}

export function slotToImage(slot: ImageSlot | null | undefined, index: number, assets: AssetMap, fallbackAlt: string): ProductImage | null {
  if (!slot) return null
  const r = resolveRefUrl(slot.ref, assets)
  if (!r) return null
  return {
    src: r.src, ...(r.srcSet ? { srcSet: r.srcSet } : {}),
    alt: slot.alt || fallbackAlt, type: imageTypeAt(index),
    focalMobile: slot.focal?.mobile ?? null, focalDesktop: slot.focal?.desktop ?? null,
  }
}
