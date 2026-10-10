'use client'
// Collections: list + editor (details, hero image, SEO, ordered products, translations).
//
// Collections have no draft: saving changes the live page, so Save is explicit and every save
// carries the version the editor loaded (a stale save is a visible conflict, never an overwrite).

import { useDraftHistory } from '@/lib/admin/use-draft-history'
import { useCallback, useEffect, useState } from 'react'
import {
  AdminButton, AdminCard, AdminEmpty, AdminError, AdminLoading, AdminNotice, AdminSectionHeader, AdminTabs, AdminTable, AdminTh, AdminTd,
  StatusBadge, adminInputClass, useConfirm, AdminFieldGrid } from '@/components/admin/ui/AdminUI'
import { api, BASE, type ApiResult } from './api'
import { ErrorNotice, InvalidationNotice, MediaField, SeoForm, TextInput, Toggle } from './ui'
import { TranslationsPanel } from './TranslationsPanel'
import type { SeoFields } from '@/lib/content-schemas'

interface Row { id: string; slug: string; name: string; isActive: boolean; sortOrder: number; archived: boolean; productCount: number; version: number }
interface Detail {
  id: string; slug: string; name: string; description: string; heroMediaId: string | null; isActive: boolean; sortOrder: number
  seo: SeoFields; archived: boolean; version: number; products: Array<{ id: string; name: string; slug: string; active: boolean; productCode: string }>
}
interface Prod { id: string; name: string; slug: string; active: boolean; productCode: string }

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

export function CollectionsPanel({ initialId, onOpenChange }: { initialId: string | null; onOpenChange: (id: string | null) => void }) {
  const [openId, setOpenId] = useState<string | null>(initialId)
  const [refresh, setRefresh] = useState(0)
  const open = (id: string | null) => { setOpenId(id); onOpenChange(id) }
  return openId
    ? <CollectionEditor id={openId} onClose={() => { open(null); setRefresh(n => n + 1) }} onCreated={id => { open(id); setRefresh(n => n + 1) }} />
    : <CollectionList onOpen={open} refreshKey={refresh} />
}

function CollectionList({ onOpen, refreshKey }: { onOpen: (id: string) => void; refreshKey: number }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [archived, setArchived] = useState(false)
  const load = useCallback(async () => {
    const p = new URLSearchParams(); if (q.trim()) p.set('q', q.trim()); if (archived) p.set('archived', '1')
    const r = await api<Row[]>('GET', `${BASE}/collections?${p}`)
    if (!r.ok) { setErr(r.error ?? 'Could not load collections.'); return }
    setErr(null); setRows(r.data!)
  }, [q, archived])
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q, refreshKey])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <input type="search" aria-label="Search collections" value={q} onChange={e => setQ(e.target.value)} placeholder="Search collections…" className={`${adminInputClass} min-w-[180px] flex-1`} />
        <Toggle label="Show archived" checked={archived} onChange={setArchived} />
        <AdminButton variant="primary" onClick={() => onOpen('new')}>New collection</AdminButton>
      </div>
      {err && <AdminError message={err} onRetry={load} />}
      {!err && rows === null && <AdminLoading />}
      {rows && rows.length === 0 && <AdminEmpty title={archived ? 'No archived collections.' : 'No collections yet.'} description={archived ? undefined : 'Create a collection to group products on its own page.'} />}
      {rows && rows.length > 0 && (
        <AdminTable caption="Collections" stack>
          <thead><tr><AdminTh>Name</AdminTh><AdminTh>Status</AdminTh><AdminTh>Products</AdminTh><AdminTh>Order</AdminTh></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-black/[0.02]">
                <AdminTd>
                  <button type="button" onClick={() => onOpen(r.id)} className="text-left font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40">{r.name}</button>
                  <div className="text-[11px] text-[#8A8A85]">/collections/{r.slug}</div>
                </AdminTd>
                <AdminTd>{r.archived ? <StatusBadge status="Archived" /> : r.isActive ? <StatusBadge status="Live" /> : <StatusBadge status="Inactive" label="Hidden" />}</AdminTd>
                <AdminTd>{r.productCount}</AdminTd>
                <AdminTd>{r.sortOrder}</AdminTd>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </div>
  )
}

type Tab = 'details' | 'products' | 'translations'

function CollectionEditor({ id, onClose, onCreated }: { id: string; onClose: () => void; onCreated: (id: string) => void }) {
  const isNew = id === 'new'
  const { confirm, node } = useConfirm()
  const { value: d, set: setD, replace: replaceD, undo, redo, canUndo, canRedo } = useDraftHistory<Detail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<ApiResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('details')
  const [slugTouched, setSlugTouched] = useState(false)
  const [origSlug, setOrigSlug] = useState('')
  // product picker
  const [pq, setPq] = useState('')
  const [found, setFound] = useState<Prod[]>([])
  const [productsDirty, setProductsDirty] = useState(false)

  const load = useCallback(async () => {
    if (isNew) {
      replaceD({ id: 'new', slug: '', name: '', description: '', heroMediaId: null, isActive: true, sortOrder: 0, seo: {}, archived: false, version: 0, products: [] })
      return
    }
    const r = await api<Detail>('GET', `${BASE}/collections/${id}`)
    if (!r.ok) { setErr(r.error ?? 'Could not load.'); return }
    setErr(null); replaceD(r.data!); setOrigSlug(r.data!.slug); setDirty(false); setProductsDirty(false)
  }, [id, isNew])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (tab !== 'products') return
    const t = setTimeout(async () => {
      const r = await api<Prod[]>('GET', `${BASE}/collections/product-search?q=${encodeURIComponent(pq)}`)
      if (r.ok) setFound(r.data!)
    }, pq ? 250 : 0)
    return () => clearTimeout(t)
  }, [pq, tab])

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty || productsDirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h)
  }, [dirty, productsDirty])

  if (err) return <AdminError message={err} onRetry={load} />
  if (!d) return <AdminLoading />

  const edit = (patch: Partial<Detail>) => { setD({ ...d, ...patch }); setDirty(true); setNotice(null) }
  const payload = () => ({ slug: d.slug, name: d.name, description: d.description, heroMediaId: d.heroMediaId, isActive: d.isActive, sortOrder: d.sortOrder, seo: d.seo })

  async function done(r: ApiResult, msg: string) {
    setResult(r)
    if (!r.ok) return false
    setNotice(msg); return true
  }

  async function create() {
    setBusy('create'); setResult(null)
    const r = await api<{ id: string }>('POST', `${BASE}/collections`, payload())
    setBusy(null); setResult(r)
    if (r.ok) onCreated(r.data!.id)
  }

  async function save() {
    if (d!.slug !== origSlug && !(await confirm(`The address changes from /collections/${origSlug} to /collections/${d!.slug}. The old address will redirect to the new one. Continue?`))) return
    setBusy('save'); setResult(null)
    const r = await api<{ version: number; redirectCreated: boolean }>('PUT', `${BASE}/collections/${id}`, { collection: payload(), version: d!.version })
    setBusy(null)
    if (await done(r, r.ok && r.data?.redirectCreated ? 'Saved. The old address now redirects to the new one.' : 'Saved. The collection page is updated.')) {
      replaceD({ ...d!, version: r.data!.version }); setOrigSlug(d!.slug); setDirty(false)
    }
  }

  async function saveProducts() {
    setBusy('products'); setResult(null)
    // Details first so a single version is used.
    let version = d!.version
    if (dirty) {
      const s = await api<{ version: number }>('PUT', `${BASE}/collections/${id}`, { collection: payload(), version })
      if (!s.ok) { setBusy(null); setResult(s); return }
      version = s.data!.version; setDirty(false); setOrigSlug(d!.slug)
    }
    const r = await api<{ version: number }>('PUT', `${BASE}/collections/${id}/products`, { productIds: d!.products.map(p => p.id), version })
    setBusy(null)
    if (await done(r, 'Products saved. The collection page shows them in this order.')) { replaceD({ ...d!, version: r.data!.version }); setProductsDirty(false) }
  }

  async function setArchived(archive: boolean) {
    if (archive && !(await confirm('Archive this collection? It disappears from the site and its address stops working. You can restore it later (it will stay hidden until you turn it back on).'))) return
    setBusy('archive'); setResult(null)
    const r = await api<{ version: number }>('POST', `${BASE}/collections/${id}`, { action: archive ? 'archive' : 'restore', version: d!.version })
    setBusy(null)
    if (await done(r, archive ? 'Archived.' : 'Restored. It is hidden until you switch “Show on the site” on.')) await load()
  }

  const moveP = (i: number, to: number) => {
    if (to < 0 || to >= d.products.length) return
    const next = d.products.slice(); const [x] = next.splice(i, 1); next.splice(to, 0, x)
    setD({ ...d, products: next }); setProductsDirty(true)
  }
  const addP = (p: Prod) => { if (d.products.some(x => x.id === p.id)) return; setD({ ...d, products: [...d.products, p] }); setProductsDirty(true) }
  const removeP = (pid: string) => { setD({ ...d, products: d.products.filter(p => p.id !== pid) }); setProductsDirty(true) }

  const archived = d.archived
  return (
    <div className="space-y-4">
      {node}
      <AdminCard className="!p-3 sm:!px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <AdminButton size="sm" variant="ghost" onClick={async () => { if ((dirty || productsDirty) && !(await confirm('You have unsaved changes. Leave without saving?'))) return; onClose() }}>Back</AdminButton>
            <h2 className="truncate text-[15px] font-medium">{d.name || 'New collection'}</h2>
            {!isNew && (archived ? <StatusBadge status="Archived" /> : d.isActive ? <StatusBadge status="Live" /> : <StatusBadge status="Inactive" label="Hidden" />)}
            {(dirty || productsDirty) && <span className="text-[11px] text-[#92400E]">Unsaved changes</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {!archived && <>
              <AdminButton size="sm" variant="ghost" disabled={!!busy || !canUndo} onClick={() => { undo(); setDirty(true); setProductsDirty(true) }}>Undo</AdminButton>
              <AdminButton size="sm" variant="ghost" disabled={!!busy || !canRedo} onClick={() => { redo(); setDirty(true); setProductsDirty(true) }}>Redo</AdminButton>
            </>}
            {isNew
              ? <AdminButton variant="primary" loading={busy === 'create'} onClick={create}>Create collection</AdminButton>
              : archived
                ? <AdminButton variant="primary" loading={busy === 'archive'} onClick={() => setArchived(false)}>Restore</AdminButton>
                : <>
                    {d.isActive && <a href={`/collections/${origSlug}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center px-3 text-[11px] underline underline-offset-2">View live page</a>}
                    <AdminButton size="sm" variant="danger" loading={busy === 'archive'} onClick={() => setArchived(true)}>Archive</AdminButton>
                    <AdminButton variant="primary" loading={busy === 'save'} disabled={!dirty} onClick={save}>Save changes</AdminButton>
                  </>}
          </div>
        </div>
      </AdminCard>

      {notice && <AdminNotice tone="success">{notice}</AdminNotice>}
      {result && !result.ok && (result.code === 'stale' || result.code === 'conflict'
        ? <AdminNotice tone="danger" title="Someone else changed this collection."><p>Nothing was overwritten. <button className="underline" onClick={load}>Load the latest version</button>, then re-apply your edits.</p></AdminNotice>
        : <ErrorNotice result={result} />)}
      {result?.ok && <InvalidationNotice result={result.invalidation} />}
      {!isNew && !archived && <AdminNotice tone="info">Collections have no draft: saving changes the live page straight away. Turn “Show on the site” off to hide a collection while you work.</AdminNotice>}

      {!isNew && <AdminTabs<Tab> ariaLabel="Collection sections" value={tab} onChange={setTab}
        tabs={[{ id: 'details', label: 'Details' }, { id: 'products', label: 'Products', count: d.products.length }, { id: 'translations', label: 'Translations' }]} />}

      {tab === 'details' && (
        <fieldset disabled={archived} className="min-w-0 space-y-4 border-0 p-0">
          <AdminCard>
            <div className="space-y-3">
              <TextInput label="Name" value={d.name} max={100} onChange={v => { edit({ name: v, ...(isNew && !slugTouched ? { slug: slugify(v) } : {}) }) }} />
              <TextInput label="Address" value={d.slug} max={60} onChange={v => { setSlugTouched(true); edit({ slug: slugify(v) }) }}
                hint={`Shown as /collections/${d.slug || 'address'}. Changing it later keeps the old link working with a redirect.`} />
              <TextInput label="Description" value={d.description} multiline rows={4} max={2000} onChange={v => edit({ description: v })} />
              <MediaField label="Hero image" assetId={d.heroMediaId} onChange={v => edit({ heroMediaId: v ?? null })} hint="Shown at the top of the collection page." />
              <AdminFieldGrid cols={2}>
                <Toggle label="Show on the site" checked={d.isActive} onChange={v => edit({ isActive: v })} hint="Off keeps the collection saved but hidden." />
                <TextInput label="Order" type="number" value={String(d.sortOrder)} onChange={v => edit({ sortOrder: Math.min(9999, Math.max(0, parseInt(v, 10) || 0)) })} hint="Lower numbers come first." />
              </AdminFieldGrid>
            </div>
          </AdminCard>
          <AdminCard>
            <AdminSectionHeader title="Search and sharing" />
            <SeoForm value={d.seo} onChange={seo => edit({ seo })} />
          </AdminCard>
        </fieldset>
      )}

      {tab === 'products' && !isNew && (
        <fieldset disabled={archived} className="grid min-w-0 gap-4 border-0 p-0 lg:grid-cols-2">
          <AdminCard>
            <AdminSectionHeader title="In this collection" description="Shoppers see products in this order. Products are linked, not copied." />
            {d.products.length === 0 && <p className="text-[12px] text-[#8A8A85]">No products yet. Add some from the right.</p>}
            <ol className="space-y-2">
              {d.products.map((p, i) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-[10px] border border-black/[0.10] bg-[#FAFAF8] px-3 py-2 text-[12px]">
                  <span className="min-w-0 truncate"><span className="mr-2 text-[#8A8A85]">{i + 1}.</span>{p.name}{!p.active && <span className="ml-2 text-[10px] text-[#92400E]">(hidden product)</span>}</span>
                  <span className="flex shrink-0 gap-1">
                    <AdminButton size="sm" variant="ghost" aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => moveP(i, i - 1)}>Up</AdminButton>
                    <AdminButton size="sm" variant="ghost" aria-label={`Move ${p.name} down`} disabled={i === d.products.length - 1} onClick={() => moveP(i, i + 1)}>Down</AdminButton>
                    <AdminButton size="sm" variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => removeP(p.id)}>Remove</AdminButton>
                  </span>
                </li>
              ))}
            </ol>
            <div className="mt-3"><AdminButton variant="primary" loading={busy === 'products'} disabled={!productsDirty} onClick={saveProducts}>Save products</AdminButton></div>
          </AdminCard>
          <AdminCard>
            <AdminSectionHeader title="Add products" />
            <input type="search" aria-label="Search products" value={pq} onChange={e => setPq(e.target.value)} placeholder="Search by name…" className={adminInputClass} />
            <ul className="mt-3 max-h-[360px] space-y-1.5 overflow-y-auto">
              {found.map(p => {
                const inList = d.products.some(x => x.id === p.id)
                return (
                  <li key={p.id} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="min-w-0 truncate">{p.name}{!p.active && <span className="ml-2 text-[10px] text-[#92400E]">(hidden)</span>}</span>
                    <AdminButton size="sm" disabled={inList} onClick={() => addP(p)}>{inList ? 'Added' : 'Add'}</AdminButton>
                  </li>
                )
              })}
              {found.length === 0 && <li className="text-[12px] text-[#8A8A85]">No products found.</li>}
            </ul>
          </AdminCard>
        </fieldset>
      )}

      {tab === 'translations' && !isNew && (dirty || productsDirty
        ? <AdminNotice tone="info">Save your changes first, then translate.</AdminNotice>
        : <TranslationsPanel base={`${BASE}/collections/${id}/translations`} perFieldPublish />)}
    </div>
  )
}
