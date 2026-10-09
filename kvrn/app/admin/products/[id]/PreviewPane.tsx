'use client'
// Live preview: the REAL product page component, rendered from the unsaved snapshot, inside an
// iframe (so mobile/desktop breakpoints are real). The editor posts the snapshot on every change;
// the preview page (noindex, admin-only) rebuilds the product with the same shape code as the
// storefront and re-renders. Nothing here touches the real cart or analytics.
import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_DESKTOP_WIDTH, DEFAULT_MOBILE_WIDTH, DESKTOP_WIDTHS, MOBILE_WIDTHS, frameGeometry, type PreviewMode,
} from '@/lib/cms-preview-viewport'
import { AdminButton } from '@/components/admin/ui/AdminUI'
import type { ProductSnapshot } from '@/lib/product-model'
import type { Assets } from './editor-shared'

export const PREVIEW_MESSAGE = 'kvrn-product-preview'

export function PreviewPane({ productId, snapshot, assets, canonicalPriceCents, variants }: {
  productId: string; snapshot: ProductSnapshot; assets: Assets; canonicalPriceCents: number
  variants: Array<{ sku: string; size: string; sizeSort: number; colorCode: string; active: boolean }>
}) {
  const [mode, setMode] = useState<PreviewMode>('mobile')
  const [desktopWidth, setDesktopWidth] = useState<number>(DEFAULT_DESKTOP_WIDTH)
  const [mobileWidth, setMobileWidth] = useState<number>(DEFAULT_MOBILE_WIDTH)
  const [full, setFull] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const pane = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [paneSize, setPaneSize] = useState({ w: 640, h: 640 })
  const deviceWidth = mode === 'mobile' ? mobileWidth : desktopWidth

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (e.data?.type === 'kvrn-product-preview-ready') setReady(true)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Measure the pane so the real-device-width frame can be scaled to fit it (re-measured on resize / full screen).
  useEffect(() => {
    const el = pane.current
    if (!el) return
    const measure = () => setPaneSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [full])

  // Full screen: Escape closes it, the page behind stays still, focus returns to the toggle.
  const fullBtn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; fullBtn.current?.focus() }
  }, [full])

  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => {
      frame.current?.contentWindow?.postMessage({ type: PREVIEW_MESSAGE, snapshot, assets, canonicalPriceCents, variants }, window.location.origin)
    }, 250)
    return () => clearTimeout(t)
  }, [ready, snapshot, assets, canonicalPriceCents, variants])

  const g = frameGeometry({ mode, paneWidth: paneSize.w, paneHeight: paneSize.h, deviceWidth })
  const widths = mode === 'mobile' ? MOBILE_WIDTHS : DESKTOP_WIDTHS

  return (
    <div className={full ? 'fixed inset-0 z-[70] flex flex-col bg-[#F5F5F3] p-3' : 'flex h-full min-h-[480px] flex-col'}
      {...(full ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Full screen product preview' } : {})}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Preview size">
          <AdminButton size="sm" variant={mode === 'desktop' ? 'primary' : 'secondary'} aria-pressed={mode === 'desktop'} onClick={() => setMode('desktop')}>Desktop</AdminButton>
          <AdminButton size="sm" variant={mode === 'mobile' ? 'primary' : 'secondary'} aria-pressed={mode === 'mobile'} onClick={() => setMode('mobile')}>Mobile</AdminButton>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-[#4A4A46]">
          {mode === 'mobile' ? 'Device width' : 'Screen width'}
          <select className="rounded border border-black/15 bg-white px-2 py-1" value={deviceWidth}
            onChange={e => (mode === 'mobile' ? setMobileWidth : setDesktopWidth)(Number(e.target.value))}
            aria-label={mode === 'mobile' ? 'Mobile preview viewport width' : 'Desktop preview viewport width'}>
            {widths.map(w => <option value={w} key={w}>{w}px</option>)}
          </select>
        </label>
        <div className="flex items-center gap-3">
          <button ref={fullBtn} type="button" onClick={() => setFull(f => !f)} aria-pressed={full}
            className="min-h-[32px] text-[11px] font-medium underline underline-offset-2 text-[#171717]">
            {full ? 'Exit full screen' : 'Full screen'}
          </button>
          <a href={`/admin/products/${productId}/preview`} target="_blank" rel="noopener noreferrer" className="text-[11px] underline underline-offset-2 text-[#4A4A46]">Open saved draft in new tab</a>
        </div>
      </div>
      {/* Pane: fills the column; the frame inside is a real-width storefront scaled to fit. */}
      <div ref={pane}
        className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-[12px] border border-black/[0.10] bg-[#E8E5E0]"
        style={full ? undefined : { height: 'min(78vh, 920px)', flex: 'none' }}>
        <div className="relative mx-auto overflow-hidden bg-white shadow-sm" style={{ width: g.boxWidth, height: g.boxHeight }}>
          <iframe ref={frame} title={`Product preview, ${mode === 'mobile' ? deviceWidth + 'px mobile' : deviceWidth + 'px desktop'}`}
            src={`/admin/products/${productId}/preview`}
            className="absolute left-0 top-0 block border-0 bg-white"
            style={{ width: g.frameWidth, height: g.frameHeight, transform: `scale(${g.scale})`, transformOrigin: '0 0' }} />
        </div>
      </div>
      <p className="mt-1 text-[10px] text-[#8A8A85]">
        Rendered at a real {deviceWidth}px-wide screen{g.scale < 1 ? ` and scaled to ${Math.round(g.scale * 100)}% to fit` : ''}, so breakpoints match the live site. Includes unsaved edits; the new tab shows the last saved draft. Adding to the bag is off.
      </p>
    </div>
  )
}
