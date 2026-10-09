'use client'
// Small shared form pieces for the content editors (built on the shared Admin primitives).

import { useEffect, useState, type ReactNode } from 'react'
import { AdminButton, AdminField, AdminNotice, StatusBadge, adminInputClass, type StatusLabel } from '@/components/admin/ui/AdminUI'
import { MediaPicker, type PickedMedia } from '@/components/admin/media/MediaPicker'
import { api, type Invalidation, type ApiResult, detailList } from './api'
import type { SeoFields } from '@/lib/content-schemas'

export const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(' ')
export const textareaClass = cx(adminInputClass, '!h-auto min-h-[72px] py-2 leading-[1.5]')

export function TextInput({ label, value, onChange, hint, info, max, placeholder, multiline, rows = 3, error, id, disabled, type = 'text', className }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; info?: ReactNode; max?: number
  placeholder?: string; multiline?: boolean; rows?: number; error?: string | null; id?: string; disabled?: boolean; type?: string; className?: string
}) {
  const fid = id ?? `f-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <AdminField label={label} htmlFor={fid} hint={hint ?? (max ? `${value.length}/${max}` : undefined)} info={info} error={error} className={className}>
      {multiline
        ? <textarea id={fid} rows={rows} value={value} maxLength={max} placeholder={placeholder} disabled={disabled} onChange={e => onChange(e.target.value)} className={textareaClass} />
        : <input id={fid} type={type} value={value} maxLength={max} placeholder={placeholder} disabled={disabled} onChange={e => onChange(e.target.value)} className={adminInputClass} />}
    </AdminField>
  )
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[12px] text-[#171717]">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="mt-[3px] h-4 w-4 accent-[#171717]" />
      <span>{label}{hint && <span className="block text-[11px] text-[#8A8A85]">{hint}</span>}</span>
    </label>
  )
}

export function Select<T extends string>({ label, value, onChange, options, hint }: {
  label: string; value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; hint?: string
}) {
  const fid = `s-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <AdminField label={label} htmlFor={fid} hint={hint}>
      <select id={fid} value={value} onChange={e => onChange(e.target.value as T)} className={adminInputClass}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </AdminField>
  )
}

/** A list of items with move up / move down / remove and an add button. */
export function ListEditor<T>({ items, onChange, render, makeNew, addLabel, max, empty, itemLabel }: {
  items: T[]; onChange: (items: T[]) => void; render: (item: T, update: (patch: Partial<T>) => void, index: number) => ReactNode
  makeNew: () => T; addLabel: string; max?: number; empty?: string; itemLabel?: (item: T, index: number) => string
}) {
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return
    const next = items.slice(); const [x] = next.splice(from, 1); next.splice(to, 0, x); onChange(next)
  }
  return (
    <div className="space-y-3">
      {items.length === 0 && empty && <p className="text-[12px] text-[#8A8A85]">{empty}</p>}
      {items.map((it, i) => (
        <div key={i} className="rounded-[12px] border border-black/[0.10] bg-[#FAFAF8] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">{itemLabel ? itemLabel(it, i) : `Item ${i + 1}`}</span>
            <div className="flex gap-1">
              <AdminButton size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>Up</AdminButton>
              <AdminButton size="sm" variant="ghost" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, i + 1)}>Down</AdminButton>
              <AdminButton size="sm" variant="ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>Remove</AdminButton>
            </div>
          </div>
          {render(it, patch => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}
        </div>
      ))}
      {(max === undefined || items.length < max) && <AdminButton size="sm" onClick={() => onChange([...items, makeNew()])}>{addLabel}</AdminButton>}
    </div>
  )
}

// ── Status ────────────────────────────────────────────────────────────────────

export function entityStatusBadge(status: string, hasDraft: boolean, isLive: boolean, placeholderSeed = false): ReactNode {
  // The unchanged migration placeholder is stored as "published" but the storefront ignores it (the coded page is shown), so "Live" would mislead.
  if (placeholderSeed && !hasDraft && status === 'published') {
    return <span className="inline-flex flex-wrap items-center gap-1.5"><StatusBadge status="Inactive" label="Placeholder — not live" /></span>
  }
  const map: Record<string, [StatusLabel, string?]> = {
    published: ['Live'], draft: ['Draft'], scheduled: ['Scheduled'], unpublished: ['Inactive', 'Unpublished'], archived: ['Archived'],
  }
  const [label, text] = map[status] ?? ['Unknown']
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge status={label} label={text} />
      {isLive && hasDraft && <StatusBadge status="Pending" label="Unpublished changes" />}
    </span>
  )
}

// ── Cache invalidation + errors (always visible) ──────────────────────────────

export function InvalidationNotice({ result, onRetried }: { result: Invalidation | null | undefined; onRetried?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  if (!result) return null
  if (result.ok) return null
  async function retry() {
    setBusy(true)
    const r = await api('POST', '/api/admin/cache-invalidations', {})
    setBusy(false)
    setDone(r.ok ? 'Retried. If the public page still looks old, wait a minute and reload it.' : (r.error ?? 'Retry failed.'))
    if (r.ok) onRetried?.()
  }
  return (
    <AdminNotice tone="warning" title="Saved, but the public site may still show the old version.">
      <p>{result.error ?? 'The cache could not be refreshed.'} Your change is safe; the refresh will be retried automatically.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <AdminButton size="sm" loading={busy} onClick={retry}>Retry refresh now</AdminButton>
        {done && <span className="text-[11px]">{done}</span>}
      </div>
    </AdminNotice>
  )
}

export function ErrorNotice({ result, title = 'This could not be saved.' }: { result: ApiResult | null; title?: string }) {
  if (!result || result.ok) return null
  const list = detailList(result)
  return (
    <AdminNotice tone="danger" title={title}>
      <p>{result.error}</p>
      {list.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4">{list.slice(0, 12).map((d, i) => <li key={i}>{d}</li>)}</ul>}
    </AdminNotice>
  )
}

// ── Media field ───────────────────────────────────────────────────────────────

export function MediaField({ label, assetId, onChange, hint }: { label: string; assetId?: string | null; onChange: (id: string | undefined) => void; hint?: string }) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<{ url: string; alt: string; missing?: boolean } | null>(null)
  useEffect(() => {
    let live = true
    if (!assetId) { setInfo(null); return }
    api('GET', `${'/api/admin/content/preview-context'}?media=${assetId}`).then(r => {
      if (!live) return
      const m = r.data?.media?.[assetId]
      setInfo(m ? { url: m.url, alt: m.alt } : { url: '', alt: '', missing: true })
    })
    return () => { live = false }
  }, [assetId])
  function onPick(a: PickedMedia) { onChange(a.id); setInfo({ url: a.url, alt: a.altText ?? '' }) }
  return (
    <AdminField label={label} hint={hint}>
      <div className="flex items-center gap-3">
        {assetId && info && !info.missing
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={info.url} alt={info.alt} className="h-16 w-16 rounded-[8px] border border-black/[0.10] object-cover" />
          : <div className="flex h-16 w-16 items-center justify-center rounded-[8px] border border-dashed border-black/[0.2] text-[10px] text-[#8A8A85]">{info?.missing ? 'Missing' : 'None'}</div>}
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <AdminButton size="sm" onClick={() => setOpen(true)}>{assetId ? 'Change image' : 'Choose image'}</AdminButton>
            {assetId && <AdminButton size="sm" variant="ghost" onClick={() => onChange(undefined)}>Remove</AdminButton>}
          </div>
          {info?.missing && <p className="text-[11px] text-[#B91C1C]">This image is missing or archived. Choose another before publishing.</p>}
          {assetId && info && !info.missing && !info.alt && <p className="text-[11px] text-[#92400E]">This image has no alt text. Add it in the Media library.</p>}
        </div>
      </div>
      <MediaPicker open={open} onClose={() => setOpen(false)} onSelect={onPick} />
    </AdminField>
  )
}

// ── SEO ───────────────────────────────────────────────────────────────────────

export function SeoForm({ value, onChange }: { value: SeoFields; onChange: (v: SeoFields) => void }) {
  const set = (patch: Partial<SeoFields>) => {
    const next: any = { ...value, ...patch }
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] === undefined || next[k] === false) delete next[k]
    onChange(next)
  }
  return (
    <div className="space-y-3">
      <TextInput label="Search title" value={value.title ?? ''} onChange={v => set({ title: v })} max={70} hint="Leave blank to use the page title. About 60 characters shows fully in search results." />
      <TextInput label="Search description" value={value.description ?? ''} onChange={v => set({ description: v })} max={200} multiline rows={2} hint="One or two sentences. About 155 characters shows fully." />
      <TextInput label="Share title" value={value.shareTitle ?? ''} onChange={v => set({ shareTitle: v })} max={90} hint="Used when the page is shared on social media. Leave blank to use the search title." />
      <MediaField label="Share image" assetId={value.shareImageId} onChange={id => set({ shareImageId: id })} hint="Shown in link previews. Leave empty to use the site default." />
      <Toggle label="Hide from search engines" checked={!!value.noindex} onChange={v => set({ noindex: v || undefined })} hint="Adds noindex and removes the page from the sitemap." />
    </div>
  )
}
