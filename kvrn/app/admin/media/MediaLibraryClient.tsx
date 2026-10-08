'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AdminPageHeader, AdminCard, AdminButton, AdminNotice, AdminField, AdminLoading, AdminEmpty, AdminError,
  AdminTabs, StatusBadge, adminInputClass,
} from '@/components/admin/ui/AdminUI'
import { uploadImage } from '@/components/admin/media/image-resize'
import type { MediaAssetDTO } from '@/lib/media-storage'

type Asset = MediaAssetDTO & { usageCount?: number }
type Usage = { owner_type: string; owner_id: string; slot: string; scope: string }

export function MediaLibraryClient() {
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<Asset[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<Asset | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await fetch(`/api/admin/media?status=${tab}&limit=60&search=${encodeURIComponent(q)}`)
      if (!r.ok) throw new Error()
      setItems((await r.json()).data)
    } catch { setErr('Could not load media.') }
  }, [tab, q])
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q])

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true); setMsg(null)
    let ok = 0, reused = 0; const errors: string[] = []
    for (const f of Array.from(files)) {
      const r = await uploadImage(f)
      if (r.ok) { ok++; if (r.reused) reused++ } else errors.push(`${f.name}: ${r.error}`)
    }
    setBusy(false); if (fileRef.current) fileRef.current.value = ''
    setMsg(errors.length
      ? { tone: 'danger', text: errors.join(' · ') }
      : { tone: 'success', text: `${ok} uploaded${reused ? ` (${reused} already in the library)` : ''}.` })
    load()
  }

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6">
      <AdminPageHeader title="Media" description="Images used across the store."
        info={<>Images are stored once and reused everywhere. The same file uploaded twice is not duplicated. Archive an image to stop offering it; images still used on live pages stay served.</>}
        actions={<>
          <input ref={fileRef} type="file" multiple accept="image/webp,image/jpeg,image/png,image/avif,image/gif" className="sr-only" id="media-upload" onChange={e => onFiles(e.target.files)} />
          <AdminButton variant="primary" loading={busy} onClick={() => fileRef.current?.click()}>Upload images</AdminButton>
        </>} />
      {msg && <AdminNotice tone={msg.tone} className="mb-4">{msg.text}</AdminNotice>}
      <AdminTabs ariaLabel="Media status" value={tab} onChange={setTab}
        tabs={[{ id: 'active', label: 'Library' }, { id: 'archived', label: 'Archived' }]} />
      <div className="mb-4 max-w-[320px]">
        <input aria-label="Search media" placeholder="Search name, alt text or tag" value={q} onChange={e => setQ(e.target.value)} className={adminInputClass} />
      </div>
      {err && <AdminError message={err} onRetry={load} />}
      {!items && !err && <AdminLoading />}
      {items && items.length === 0 && <AdminEmpty title={tab === 'active' ? 'No images yet' : 'Nothing archived'} />}
      {items && items.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          {items.map(a => (
            <li key={a.id}>
              <button type="button" onClick={() => setSel(a)} className="block w-full overflow-hidden rounded-[12px] border border-black/[0.08] bg-white text-left hover:border-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={(a.variants.find(v => v.width >= 400) ?? a.variants[0])?.url ?? a.url} alt={a.altText ?? ''} loading="lazy" className="aspect-square w-full bg-[#FAFAF8] object-cover" />
                <span className="block truncate px-2.5 pt-2 text-[11px] text-[#171717]">{a.filename}</span>
                <span className="flex items-center gap-1.5 px-2.5 pb-2 pt-0.5 text-[10px] text-[#8A8A85]">
                  {a.usageCount ? `Used ${a.usageCount}×` : 'Unused'}{!a.altText && <span className="text-[#92400E]">· No alt text</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sel && <Detail asset={sel} onClose={() => setSel(null)} onChanged={() => { setSel(null); load() }} />}
    </div>
  )
}

function Detail({ asset, onClose, onChanged }: { asset: Asset; onClose: () => void; onChanged: () => void }) {
  const [alt, setAlt] = useState(asset.altText ?? '')
  const [title, setTitle] = useState(asset.title ?? '')
  const [tags, setTags] = useState(asset.tags.join(', '))
  const [usages, setUsages] = useState<Usage[] | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(`/api/admin/media/${asset.id}`).then(r => r.json()).then(j => setUsages(j.usages ?? [])).catch(() => setUsages([]))
  }, [asset.id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function patch(body: Record<string, unknown>) {
    setBusy(true); setMsg(null)
    const r = await fetch(`/api/admin/media/${asset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (r.status === 409 && j.code === 'IN_USE') {
      if (confirm('This image is used on live pages. It will keep being served, but won’t be offered for new use. Archive anyway?')) return patch({ ...body, confirmInUse: true })
      return
    }
    if (!r.ok) { setMsg(j.error ?? 'Failed.'); return }
    if (body.status) onChanged(); else setMsg('Saved.')
  }
  async function del() {
    if (!confirm('Delete this image permanently? This cannot be undone.')) return
    setBusy(true)
    const r = await fetch(`/api/admin/media/${asset.id}`, { method: 'DELETE' })
    const j = await r.json().catch(() => ({})); setBusy(false)
    if (!r.ok) { setMsg(j.error ?? 'Failed.'); return }
    onChanged()
  }

  return (
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <aside role="dialog" aria-modal="true" aria-label="Image details" className="h-full w-full max-w-[400px] overflow-y-auto bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">{asset.filename}</h2>
          <AdminButton size="sm" onClick={onClose}>Close</AdminButton>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset.url} alt={asset.altText ?? ''} className="mb-3 w-full rounded-[10px] border border-black/[0.08] bg-[#FAFAF8]" />
        <p className="mb-4 text-[11px] text-[#6B6B66]">{asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}{(asset.byteSize / 1024).toFixed(0)} KB · {asset.variants.length} renditions <StatusBadge status={asset.status === 'active' ? 'Active' : 'Archived'} /></p>
        <div className="space-y-3">
          <AdminField label="Alt text" htmlFor="m-alt" info={<>Describes the image for screen readers and search. Required for good accessibility.</>}>
            <input id="m-alt" className={adminInputClass} value={alt} onChange={e => setAlt(e.target.value)} maxLength={500} />
          </AdminField>
          <AdminField label="Title" htmlFor="m-title"><input id="m-title" className={adminInputClass} value={title} onChange={e => setTitle(e.target.value)} maxLength={200} /></AdminField>
          <AdminField label="Tags" htmlFor="m-tags" hint="Comma separated."><input id="m-tags" className={adminInputClass} value={tags} onChange={e => setTags(e.target.value)} /></AdminField>
        </div>
        {msg && <AdminNotice className="mt-3" tone={msg === 'Saved.' ? 'success' : 'danger'}>{msg}</AdminNotice>}
        <div className="mt-4 flex flex-wrap gap-2">
          <AdminButton variant="primary" loading={busy} onClick={() => patch({ altText: alt, title, tags: tags.split(',').map(t => t.trim()).filter(Boolean) })}>Save</AdminButton>
          {asset.status === 'active'
            ? <AdminButton onClick={() => patch({ status: 'archived' })} disabled={busy}>Archive</AdminButton>
            : <AdminButton onClick={() => patch({ status: 'active' })} disabled={busy}>Restore</AdminButton>}
          <AdminButton variant="danger" onClick={del} disabled={busy || (usages?.length ?? 1) > 0}>Delete</AdminButton>
        </div>
        <div className="mt-5">
          <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8A8A85]">Where it’s used</h3>
          {!usages ? <AdminLoading /> : usages.length === 0
            ? <p className="text-[12px] text-[#6B6B66]">Nowhere. Safe to delete.</p>
            : <ul className="space-y-1 text-[12px]">{usages.map((u, i) => <li key={i}>{u.owner_type} · {u.owner_id.slice(0, 24)} · {u.slot} <span className="text-[#8A8A85]">({u.scope})</span></li>)}</ul>}
        </div>
      </aside>
    </div>
  )
}
