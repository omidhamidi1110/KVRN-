'use client'
// components/admin/media/MediaPicker.tsx — reusable "choose an image" modal for every editor.
//
//   <MediaPicker open={open} onClose={…} onSelect={asset => …} />
//
// Browse + search the shared Media Library, upload a new image (reusing an existing identical
// file instead of storing a duplicate), and require alt text awareness. Archived images are
// not offered. `onSelect` receives the MediaAssetDTO (lib/media-storage.ts).
import { useCallback, useEffect, useRef, useState } from 'react'
import { AdminButton, AdminNotice, AdminLoading, AdminEmpty, adminInputClass } from '../ui/AdminUI'
import { uploadImage } from './image-resize'
import type { MediaAssetDTO } from '@/lib/media-storage'

export type PickedMedia = MediaAssetDTO

export function MediaPicker({ open, onClose, onSelect, title = 'Choose image' }: {
  open: boolean; onClose: () => void; onSelect: (asset: PickedMedia) => void; title?: string
}) {
  const [items, setItems] = useState<(PickedMedia & { usageCount?: number })[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [upErr, setUpErr] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`/api/admin/media?limit=60&search=${encodeURIComponent(q)}`)
      if (!r.ok) throw new Error()
      setItems((await r.json()).data)
    } catch { setErr('Could not load images.') } finally { setLoading(false) }
  }, [q])

  useEffect(() => { if (open) { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) } }, [open, q, load])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  async function onFiles(files: FileList | null) {
    const f = files?.[0]; if (!f) return
    setUploading(true); setUpErr(null)
    const res = await uploadImage(f)
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
    if (!res.ok) { setUpErr(res.error); return }
    onSelect(res.asset); onClose()
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-3" role="presentation"
         onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
           className="flex max-h-[88vh] w-full max-w-[860px] flex-col rounded-[14px] bg-white shadow-xl outline-none">
        <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.08] p-3">
          <h2 className="mr-auto text-[13px] font-medium">{title}</h2>
          <input aria-label="Search images" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} className={`${adminInputClass} !w-[180px]`} />
          <input ref={fileRef} type="file" accept="image/webp,image/jpeg,image/png,image/avif,image/gif" className="sr-only" id="media-picker-file" onChange={e => onFiles(e.target.files)} />
          <AdminButton variant="primary" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>Upload</AdminButton>
          <AdminButton size="sm" onClick={onClose}>Close</AdminButton>
        </div>
        <div className="overflow-y-auto p-3">
          {upErr && <AdminNotice tone="danger" className="mb-3">{upErr}</AdminNotice>}
          {err && <AdminNotice tone="danger" className="mb-3">{err}</AdminNotice>}
          {loading ? <AdminLoading /> : items.length === 0 ? <AdminEmpty title="No images" description="Upload one to get started." /> : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {items.map(a => (
                <li key={a.id}>
                  <button type="button" onClick={() => { onSelect(a); onClose() }}
                    className="group block w-full overflow-hidden rounded-[10px] border border-black/[0.10] bg-[#FAFAF8] text-left hover:border-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={(a.variants.find(v => v.width >= 400) ?? a.variants[0])?.url ?? a.url} alt={a.altText ?? ''} loading="lazy" className="aspect-square w-full object-cover" />
                    <span className="block truncate px-2 py-1.5 text-[11px] text-[#4A4A46]">{a.filename}</span>
                    {!a.altText && <span className="block px-2 pb-1.5 text-[10px] text-[#92400E]">No alt text</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
