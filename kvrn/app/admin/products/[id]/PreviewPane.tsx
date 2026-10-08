'use client'
// Live preview: the REAL product page component, rendered from the unsaved snapshot, inside an
// iframe (so mobile/desktop breakpoints are real). The editor posts the snapshot on every change;
// the preview page (noindex, admin-only) rebuilds the product with the same shape code as the
// storefront and re-renders. Nothing here touches the real cart or analytics.
import { useEffect, useRef, useState } from 'react'
import { AdminButton } from '@/components/admin/ui/AdminUI'
import type { ProductSnapshot } from '@/lib/product-model'
import type { Assets } from './editor-shared'

export const PREVIEW_MESSAGE = 'kvrn-product-preview'

export function PreviewPane({ productId, snapshot, assets, canonicalPriceCents, variants }: {
  productId: string; snapshot: ProductSnapshot; assets: Assets; canonicalPriceCents: number
  variants: Array<{ sku: string; size: string; sizeSort: number; colorCode: string; active: boolean }>
}) {
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop')
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (e.data?.type === 'kvrn-product-preview-ready') setReady(true)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => {
      frame.current?.contentWindow?.postMessage({ type: PREVIEW_MESSAGE, snapshot, assets, canonicalPriceCents, variants }, window.location.origin)
    }, 250)
    return () => clearTimeout(t)
  }, [ready, snapshot, assets, canonicalPriceCents, variants])

  return (
    <div className="flex h-full min-h-[480px] flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Preview size">
          <AdminButton size="sm" variant={mode === 'desktop' ? 'primary' : 'secondary'} aria-pressed={mode === 'desktop'} onClick={() => setMode('desktop')}>Desktop</AdminButton>
          <AdminButton size="sm" variant={mode === 'mobile' ? 'primary' : 'secondary'} aria-pressed={mode === 'mobile'} onClick={() => setMode('mobile')}>Mobile</AdminButton>
        </div>
        <a href={`/admin/products/${productId}/preview`} target="_blank" rel="noreferrer" className="text-[11px] underline underline-offset-2 text-[#4A4A46]">Open full screen</a>
      </div>
      <div className="flex flex-1 justify-center overflow-hidden rounded-[12px] border border-black/[0.10] bg-[#E8E5E0]">
        <iframe ref={frame} title="Product preview" src={`/admin/products/${productId}/preview`}
          className="h-full bg-white" style={{ width: mode === 'mobile' ? 390 : '100%', maxWidth: '100%', minHeight: 560 }} />
      </div>
      <p className="mt-1 text-[10px] text-[#8A8A85]">Preview of your unsaved changes. Sizes show as available; adding to the bag is off.</p>
    </div>
  )
}
