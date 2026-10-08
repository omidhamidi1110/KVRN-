'use client'
// Private product preview: renders the real PDPClient from the DRAFT. Never indexed (see page.tsx),
// never in the sitemap, no analytics, no real cart. When embedded in the editor it re-renders
// from the unsaved snapshot the editor posts (same shape code as the live page).
import { useEffect, useMemo, useState } from 'react'
import { PDPClient } from '@/app/products/[slug]/PDPClient'
import { buildPublicProduct } from '@/lib/product-public-shape'
import type { ProductSnapshot } from '@/lib/product-model'
import type { Product } from '@/types'
import type { ProductDefaults } from '@/lib/product-defaults'
import { FALLBACK_PRODUCT_DEFAULTS } from '@/lib/product-defaults'

interface Variant { sku: string; size: string; sizeSort: number; colorCode: string; active: boolean }
interface Live { snapshot: ProductSnapshot; assets: Record<string, any>; canonicalPriceCents: number; variants: Variant[] }

export function PreviewClient({ id }: { id: string }) {
  const [initial, setInitial] = useState<{ product: Product; related: Product | null; defaults: ProductDefaults } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<Live | null>(null)

  useEffect(() => {
    let off = false
    void (async () => {
      const r = await fetch(`/api/admin/products/${id}/preview-data`, { cache: 'no-store' })
      const b = await r.json().catch(() => null)
      if (off) return
      if (!r.ok) { setError(b?.error ?? 'Preview is not available.'); return }
      setInitial({ product: b.product, related: b.relatedProduct ?? null, defaults: b.defaults ?? FALLBACK_PRODUCT_DEFAULTS })
    })()
    return () => { off = true }
  }, [id])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== 'kvrn-product-preview') return
      setLive({ snapshot: e.data.snapshot, assets: e.data.assets ?? {}, canonicalPriceCents: e.data.canonicalPriceCents ?? 0, variants: e.data.variants ?? [] })
    }
    window.addEventListener('message', onMsg)
    window.parent?.postMessage({ type: 'kvrn-product-preview-ready' }, window.location.origin)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const product = useMemo<Product | null>(() => {
    if (!initial) return null
    if (!live) return initial.product
    const s = live.snapshot
    // Preview what publishing WOULD produce: the draft's price/variants when set, else what is live.
    const price = s.commerce?.priceCents ?? live.canonicalPriceCents
    const variants = (s.commerce?.variants?.length ? s.commerce.variants : live.variants).map(v => ({ sku: v.sku, size: v.size, sizeSort: v.sizeSort, colorCode: v.colorCode, active: v.active }))
    return buildPublicProduct({
      id, snapshot: s, priceCents: price, variants, assets: live.assets, defaults: initial.defaults,
      relatedProductSlug: initial.related?.slug ?? null,
    }) ?? initial.product
  }, [initial, live, id])

  if (error) return <p style={{ padding: 24, fontFamily: 'sans-serif', fontSize: 13 }}>{error}</p>
  if (!product || !initial) return <p style={{ padding: 24, fontFamily: 'sans-serif', fontSize: 13 }}>Loading preview…</p>
  return <PDPClient product={product} relatedProduct={initial.related} preview />
}
