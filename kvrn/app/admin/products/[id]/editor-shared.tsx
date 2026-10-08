'use client'
// Shared types, small controls and image-slot editing used by the Product Editor sections.
import { useRef, useState, type ReactNode } from 'react'
import { AdminButton, AdminField, InfoTip, adminInputClass } from '@/components/admin/ui/AdminUI'
import { MediaPicker, type PickedMedia } from '@/components/admin/media/MediaPicker'
import type { ImageSlot, ProductSnapshot, Focal } from '@/lib/product-model'
import { parseFocal } from '@/lib/product-model'
import type { Issue, CanonicalCommerce } from '@/lib/product-service'
import { objectPositionFor } from '@/lib/product-images'

export type { Issue }
export interface AssetLite { id: string; url: string; width?: number | null; altText?: string | null; filename?: string; status?: string; variants?: Array<{ width: number; url: string }> }
export type Assets = Record<string, AssetLite>

export interface EditorState {
  id: string; productCode: string | null; status: string; revision: number; slug: string | null
  publishAt: string | null; unpublishAt: string | null; publishedAt: string | null
  draftVersionNo: number | null; publishedVersionNo: number | null; hasDraft: boolean
  snapshot: ProductSnapshot; published: ProductSnapshot | null
  canonical: CanonicalCommerce; blockers: Issue[]; warnings: Issue[]
  history: Array<{ version_no: number; state: string; change_note: string | null; rolled_back_from: number | null; created_by: string | null; created_at: string; published_by: string | null; published_at: string | null }>
  assets: Assets; collections: Array<{ id: string; slug: string; name: string }>
  defaults: { shippingReturns: { lines: string[]; linkLabel: string; href: string } }
}

export interface Options {
  collections: Array<{ id: string; slug: string; name: string; is_active: boolean }>
  pairs: Array<{ id: string; product_code: string | null; product_type: string | null; name: string; status: string }>
  types: string[]
}

/** Edit the snapshot immutably: `update(s => { s.name = 'x' })`. */
export type Update = (fn: (s: ProductSnapshot) => void) => void

export interface SectionProps {
  snap: ProductSnapshot
  update: Update
  state: EditorState
  options: Options | null
  assets: Assets
  addAsset: (a: PickedMedia) => void
  issues: Issue[]
  locked: boolean
}

export const textareaClass =
  'w-full rounded-[9px] border border-black/[0.14] bg-white px-3 py-2 text-[12px] leading-[1.5] text-[#171717] placeholder:text-[#A5A5A0] focus:border-[#171717] focus:outline-none focus:ring-1 focus:ring-[#171717] disabled:bg-black/[0.03]'

/** Which editor tab a validation field belongs to. */
export type TabId = 'basics' | 'media' | 'variants' | 'content' | 'pairing' | 'price' | 'seo' | 'publish' | 'history'
export function tabForField(field: string): TabId {
  if (/^(name|slug|productType|eyebrow|founderNote|shortDescription|fitNote|productCode)/.test(field)) return 'basics'
  if (/^(media|colors\.\d+\.media)/.test(field) || /(^|\.)(hero|gallery)/.test(field)) return 'media'
  if (/^(colors|commerce\.variants)/.test(field)) return 'variants'
  if (/^(description|constructionDetails|features|specs|sections|shippingReturns|sizeGuide)/.test(field)) return 'content'
  if (/^(completeTheSet|bundle)/.test(field)) return 'pairing'
  if (/^commerce|^shop/.test(field)) return 'price'
  if (/^seo/.test(field)) return 'seo'
  return 'publish'
}

export function IssueList({ issues, tone = 'danger' }: { issues: Issue[]; tone?: 'danger' | 'warning' }) {
  if (!issues.length) return null
  const cls = tone === 'danger' ? 'text-[#B91C1C]' : 'text-[#92400E]'
  return (
    <ul className={`mt-1 space-y-0.5 text-[11px] ${cls}`}>
      {issues.map((i, k) => <li key={`${i.code}-${i.field}-${k}`}>{i.message}</li>)}
    </ul>
  )
}

export function Toggle({ checked, onChange, label, disabled, info }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; info?: ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-[#171717]">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} className="h-4 w-4 rounded border-black/30" />
      <span>{label}</span>{info && <InfoTip label={`About ${label}`}>{info}</InfoTip>}
    </label>
  )
}

export function Row({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 | 4 }) {
  const c = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' }[cols]
  return <div className={`grid grid-cols-1 gap-3 ${c}`}>{children}</div>
}

export function CharCount({ value, soft, hard }: { value: string; soft?: number; hard: number }) {
  const n = value.length
  const over = soft !== undefined && n > soft
  return <span className={`text-[10px] ${n > hard ? 'text-[#B91C1C]' : over ? 'text-[#92400E]' : 'text-[#8A8A85]'}`}>{n}/{soft ?? hard}</span>
}

// ── Images ────────────────────────────────────────────────────────────────────

export function slotUrl(slot: ImageSlot | null | undefined, assets: Assets): string | null {
  const r = slot?.ref
  if (!r) return null
  if (r.kind === 'static') return r.src
  const a = assets[r.assetId.toLowerCase()]
  if (!a) return null
  return (a.variants?.find(v => v.width >= 600) ?? a.variants?.[0])?.url ?? a.url
}

/** Pick the crop point by clicking the full image; the small preview shows the real crop. */
export function FocalEditor({ src, value, onChange, label, aspect, fallback, disabled }: {
  src: string | null; value: Focal | null; onChange: (f: Focal | null) => void
  label: string; aspect: string; fallback: string; disabled?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const set = (clientX: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect(); if (!r || !r.width || !r.height) return
    onChange(parseFocal({ x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }))
  }
  const nudge = (dx: number, dy: number) => onChange(parseFocal({ x: (value?.x ?? 0.5) + dx, y: (value?.y ?? 0.5) + dy }))
  return (
    <div>
      <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-[#4A4A46]">
        {label}
        <InfoTip label={`About ${label}`}>Click the image to choose what stays in view when the photo is cropped. “Default” uses the template’s own crop.</InfoTip>
      </p>
      <div className="flex gap-2">
        <div ref={box} role="slider" tabIndex={disabled ? -1 : 0} aria-label={`${label} focal point`}
          aria-valuetext={value ? `${Math.round(value.x * 100)}% across, ${Math.round(value.y * 100)}% down` : 'Default'}
          onPointerDown={e => { if (!disabled) set(e.clientX, e.clientY) }}
          onKeyDown={e => {
            if (disabled) return
            const s = e.shiftKey ? 0.1 : 0.02
            if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-s, 0) } else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(s, 0) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -s) } else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, s) }
          }}
          className="relative w-[120px] shrink-0 cursor-crosshair overflow-hidden rounded-[8px] border border-black/[0.14] bg-[#EDEAE4] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40">
          {src ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={src} alt="" className="block h-auto w-full select-none" draggable={false} /> : <div className="aspect-[3/4]" />}
          {value && <span aria-hidden="true" className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#171717] shadow" style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }} />}
        </div>
        <div className="min-w-0">
          <div className="relative overflow-hidden rounded-[6px] border border-black/[0.14] bg-[#EDEAE4]" style={{ width: 64, aspectRatio: aspect }} aria-label="Crop preview">
            {src && /* eslint-disable-next-line @next/next/no-img-element */ <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: objectPositionFor(value, fallback) }} />}
          </div>
          <p className="mt-1 text-[10px] text-[#8A8A85]">{value ? `${Math.round(value.x * 100)}% · ${Math.round(value.y * 100)}%` : 'Default'}</p>
          {value && !disabled && <button type="button" onClick={() => onChange(null)} className="text-[10px] underline underline-offset-2 text-[#4A4A46]">Use default</button>}
        </div>
      </div>
    </div>
  )
}

/** One image slot: choose / replace / remove, alt text, and separate mobile + desktop focal points. */
export function SlotEditor({ title, slot, onChange, assets, addAsset, desktopFallback, mobileFallback, disabled, issues, extra }: {
  title: string; slot: ImageSlot; onChange: (s: ImageSlot) => void; assets: Assets; addAsset: (a: PickedMedia) => void
  desktopFallback: string; mobileFallback: string; disabled?: boolean; issues?: Issue[]; extra?: ReactNode
}) {
  const [pick, setPick] = useState(false)
  const url = slotUrl(slot, assets)
  const archived = slot.ref?.kind === 'media' && assets[slot.ref.assetId.toLowerCase()]?.status === 'archived'
  return (
    <div className="rounded-[12px] border border-black/[0.08] bg-[#FAFAF8] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-[#171717]">{title}</p>
        <div className="flex items-center gap-1.5">
          {extra}
          <AdminButton size="sm" disabled={disabled} onClick={() => setPick(true)}>{slot.ref ? 'Replace' : 'Choose image'}</AdminButton>
          {slot.ref && <AdminButton size="sm" variant="ghost" disabled={disabled} onClick={() => onChange({ ...slot, ref: null })}>Remove</AdminButton>}
        </div>
      </div>
      {archived && <p className="mb-2 text-[11px] text-[#B91C1C]">This image is archived. Choose another before publishing.</p>}
      {slot.ref ? (
        <div className="space-y-3">
          <AdminField label="Alt text" info="Describes the photo for screen readers and search. Keep it short and specific.">
            <input className={adminInputClass} value={slot.alt} disabled={disabled} maxLength={500}
              onChange={e => onChange({ ...slot, alt: e.target.value })} placeholder="Black hoodie, front view" />
          </AdminField>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FocalEditor src={url} label="Desktop focus" value={slot.focal.desktop} disabled={disabled} aspect="4/5" fallback={desktopFallback}
              onChange={f => onChange({ ...slot, focal: { ...slot.focal, desktop: f } })} />
            <FocalEditor src={url} label="Mobile focus" value={slot.focal.mobile} disabled={disabled} aspect="9/16" fallback={mobileFallback}
              onChange={f => onChange({ ...slot, focal: { ...slot.focal, mobile: f } })} />
          </div>
        </div>
      ) : <p className="text-[11px] text-[#8A8A85]">No image yet.</p>}
      {issues && <IssueList issues={issues} />}
      <MediaPicker open={pick} onClose={() => setPick(false)} title={title}
        onSelect={a => { addAsset(a); onChange({ ...slot, ref: { kind: 'media', assetId: a.id.toLowerCase() }, alt: slot.alt || a.altText || '' }) }} />
    </div>
  )
}
