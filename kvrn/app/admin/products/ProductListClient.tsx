'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AdminPage, AdminButton, AdminCard, AdminEmpty, AdminError, AdminField, AdminLoading, AdminNotice, AdminPageHeader, AdminTable, AdminTr, AdminTabs, AdminTd, AdminTh,
  StatusBadge, adminInputClass, useConfirm, InfoTip,
} from '@/components/admin/ui/AdminUI'
import { formatProductPrice } from '@/lib/product-price'
import type { ListItem, DisplayStatus } from '@/lib/product-service'

type Filter = 'all' | DisplayStatus
type BulkAction = 'archive' | 'restore' | 'publish' | 'unpublish' | 'add_collection' | 'remove_collection'
interface BulkResult { id: string; ok: boolean; error?: string; blockers?: Array<{ message: string }> }

const BADGE: Record<DisplayStatus, { s: 'Draft' | 'Scheduled' | 'Live' | 'Archived' | 'Partial'; label: string }> = {
  draft: { s: 'Draft', label: 'Draft' }, scheduled: { s: 'Scheduled', label: 'Scheduled' }, live: { s: 'Live', label: 'Live' },
  sold_out: { s: 'Partial', label: 'Sold out' }, archived: { s: 'Archived', label: 'Archived' },
}

async function api(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } })
  let body: any = null; try { body = await r.json() } catch { /* empty */ }
  return { ok: r.ok, status: r.status, body }
}

export function ProductListClient() {
  const router = useRouter()
  const { confirm, node: confirmNode } = useConfirm()
  const [items, setItems] = useState<ListItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<'updated' | 'name' | 'price' | 'status'>('updated')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null)
  const [results, setResults] = useState<{ action: string; rows: BulkResult[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [collections, setCollections] = useState<Array<{ id: string; name: string }>>([])
  const [collectionId, setCollectionId] = useState('')

  const load = useCallback(async () => {
    setErr(null)
    const r = await api(`/api/admin/products?sort=${sort}&q=${encodeURIComponent(q)}`)
    if (!r.ok) { setErr(r.body?.error ?? 'Could not load products.'); return }
    setItems(r.body.items)
  }, [q, sort])

  useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t) }, [load, q])
  useEffect(() => { void (async () => { const r = await api('/api/admin/products/options'); if (r.ok) setCollections(r.body.collections) })() }, [])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items?.length ?? 0 }
    for (const i of items ?? []) c[i.displayStatus] = (c[i.displayStatus] ?? 0) + 1
    return c
  }, [items])
  const shown = useMemo(() => (items ?? []).filter(i => filter === 'all' || i.displayStatus === filter), [items, filter])
  const allPicked = shown.length > 0 && shown.every(i => picked.has(i.id))
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })

  async function rowAction(item: ListItem, action: 'duplicate' | 'archive' | 'restore') {
    if (action === 'archive' && !(await confirm(`Archive “${item.name}”? It is taken off the shop until restored.`))) return
    setBusy(true); setNotice(null)
    const r = await api(`/api/admin/products/${item.id}/action`, { method: 'POST', body: JSON.stringify({ action, revision: item.revision }) })
    setBusy(false)
    if (!r.ok) { setNotice({ tone: 'danger', text: r.body?.error ?? 'That did not work.' }); return }
    if (action === 'duplicate') { router.push(`/admin/products/${r.body.id}`); return }
    setNotice(r.body.cacheInvalidation?.ok === false ? { tone: 'warning', text: 'Done, but the live site may take a moment to update.' } : { tone: 'success', text: action === 'archive' ? 'Archived.' : 'Restored.' })
    void load()
  }

  async function bulk(action: BulkAction) {
    const chosen = (items ?? []).filter(i => picked.has(i.id))
    if (!chosen.length) return
    let confirmText: string | null = null
    if (action === 'publish' || action === 'unpublish') {
      const word = action.toUpperCase()
      const typed = window.prompt(`${action === 'publish' ? 'Publish' : 'Unpublish'} ${chosen.length} product${chosen.length > 1 ? 's' : ''}? Each one is checked separately. Type ${word} to confirm.`)
      if (typed === null) return
      confirmText = typed
    } else if (action === 'archive' && !(await confirm(`Archive ${chosen.length} product${chosen.length > 1 ? 's' : ''}?`))) return
    setBusy(true); setNotice(null); setResults(null)
    const r = await api('/api/admin/products/bulk', { method: 'POST', body: JSON.stringify({
      action, items: chosen.map(i => ({ id: i.id, revision: i.revision })), confirm: confirmText, collectionId: collectionId || null,
    }) })
    setBusy(false)
    if (!r.ok) { setNotice({ tone: 'danger', text: r.body?.error ?? 'That did not work.' }); return }
    setResults({ action, rows: r.body.results })
    setNotice({ tone: r.body.failed ? 'warning' : 'success', text: `${r.body.succeeded} done, ${r.body.failed} not done.` })
    setPicked(new Set()); void load()
  }

  const nameOf = (id: string) => items?.find(i => i.id === id)?.name ?? id

  return (
    <AdminPage width="wide">
      {confirmNode}
      <AdminPageHeader title="Products" description="Create, edit and publish products."
        actions={<><Link href="/admin/products/defaults" className="text-[12px] underline underline-offset-2 text-[#4A4A46]">Defaults</Link><Link href="/admin/products/new" className="inline-flex h-9 items-center rounded-[9px] bg-[#171717] px-4 text-[12px] font-medium text-white hover:bg-black">New product</Link></>} />
      {notice && <AdminNotice tone={notice.tone} className="mb-3">{notice.text}</AdminNotice>}
      {results && results.rows.some(r => !r.ok) && (
        <AdminNotice tone="warning" title="Some products were not changed" className="mb-3">
          <ul className="mt-1 space-y-1">
            {results.rows.filter(r => !r.ok).map(r => (
              <li key={r.id}><strong className="font-medium">{nameOf(r.id)}:</strong> {r.error}{r.blockers?.length ? ` ${r.blockers.map(b => b.message).join(' ')}` : ''}</li>
            ))}
          </ul>
        </AdminNotice>
      )}

      <AdminTabs<Filter> variant="ai" ariaLabel="Product status" value={filter} onChange={setFilter} tabs={[
        { id: 'all', label: 'All', count: counts.all }, { id: 'draft', label: 'Draft', count: counts.draft ?? 0 }, { id: 'scheduled', label: 'Scheduled', count: counts.scheduled ?? 0 },
        { id: 'live', label: 'Live', count: counts.live ?? 0 }, { id: 'sold_out', label: 'Sold out', count: counts.sold_out ?? 0 }, { id: 'archived', label: 'Archived', count: counts.archived ?? 0 },
      ]} />

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <AdminField label="Search" htmlFor="pl-q" className="min-w-0 basis-[200px] flex-1"><input id="pl-q" className={adminInputClass} placeholder="Name, URL or code" value={q} onChange={e => setQ(e.target.value)} /></AdminField>
        <AdminField label="Sort" htmlFor="pl-sort">
          <select id="pl-sort" className={adminInputClass} value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
            <option value="updated">Recently edited</option><option value="name">Name</option><option value="price">Price</option><option value="status">Status</option>
          </select>
        </AdminField>
      </div>

      {picked.size > 0 && (
        <AdminCard className="mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-2 text-[12px] font-medium">{picked.size} selected <InfoTip label="About bulk actions">Publish and unpublish check every product on its own and need you to type a confirmation. Price and stock can’t be changed in bulk.</InfoTip></p>
            <AdminButton size="sm" disabled={busy} onClick={() => void bulk('archive')}>Archive</AdminButton>
            <AdminButton size="sm" disabled={busy} onClick={() => void bulk('restore')}>Restore</AdminButton>
            <AdminButton size="sm" disabled={busy} onClick={() => void bulk('publish')}>Publish…</AdminButton>
            <AdminButton size="sm" disabled={busy} onClick={() => void bulk('unpublish')}>Unpublish…</AdminButton>
            <select aria-label="Collection" className={`${adminInputClass} !h-8 !w-[170px]`} value={collectionId} onChange={e => setCollectionId(e.target.value)}>
              <option value="">Collection…</option>{collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <AdminButton size="sm" disabled={busy || !collectionId} onClick={() => void bulk('add_collection')}>Add</AdminButton>
            <AdminButton size="sm" disabled={busy || !collectionId} onClick={() => void bulk('remove_collection')}>Remove</AdminButton>
            <AdminButton size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</AdminButton>
          </div>
        </AdminCard>
      )}

      {err ? <AdminError message={err} onRetry={() => void load()} /> : !items ? <AdminLoading /> : shown.length === 0 ? (
        <AdminEmpty title={items.length ? 'No products match' : 'No products yet'} description={items.length ? 'Try another filter.' : 'Create your first product.'} action={items.length ? undefined : <Link href="/admin/products/new" className="text-[12px] underline">New product</Link>} />
      ) : (
        <AdminTable stack compact caption="Products">
          <thead><AdminTr>
            <AdminTh><input type="checkbox" aria-label="Select all" checked={allPicked} onChange={e => setPicked(e.target.checked ? new Set(shown.map(i => i.id)) : new Set())} /></AdminTh>
            <AdminTh>Product</AdminTh><AdminTh>Status</AdminTh><AdminTh>Price</AdminTh><AdminTh>Checks</AdminTh><AdminTh>Edited</AdminTh><AdminTh />
          </AdminTr></thead>
          <tbody>
            {shown.map(i => (
              <AdminTr key={i.id}>
                <AdminTd label="Select"><input type="checkbox" aria-label={`Select ${i.name}`} checked={picked.has(i.id)} onChange={() => toggle(i.id)} /></AdminTd>
                <AdminTd className="max-sm:!block max-sm:!text-left">
                  <div className="flex items-center gap-3">
                    {i.thumb ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={i.thumb} alt="" className="h-12 w-10 rounded-[6px] border border-black/10 object-cover" /> : <span className="h-12 w-10 rounded-[6px] border border-dashed border-black/20" aria-hidden="true" />}
                    <div className="min-w-0">
                      <Link href={`/admin/products/${i.id}`} className="font-medium underline-offset-2 hover:underline">{i.name}</Link>
                      <p className="break-all text-[11px] text-[#8A8A85]">{i.productCode ?? '—'} · /products/{i.slug || '…'}</p>
                    </div>
                  </div>
                </AdminTd>
                <AdminTd label="Status">
                  <StatusBadge status={BADGE[i.displayStatus].s} label={BADGE[i.displayStatus].label} />
                  {i.hasUnpublishedChanges && <p className="mt-1 text-[10px] text-[#92400E]">Unpublished changes</p>}
                  {i.overdue && <p className="mt-1 text-[10px] font-medium text-[#B91C1C]">Overdue: not live</p>}
                  {i.publishAt && i.displayStatus === 'scheduled' && !i.overdue && <p className="mt-1 text-[10px] text-[#8A8A85]">{new Date(i.publishAt).toLocaleString()}</p>}
                </AdminTd>
                <AdminTd label="Price">{formatProductPrice(i.priceCents)}</AdminTd>
                <AdminTd label="Checks">
                  {i.blockerCount === null ? <span className="text-[11px] text-[#8A8A85]">—</span>
                    : i.blockerCount > 0 ? <Link href={`/admin/products/${i.id}`} className="text-[11px] font-medium text-[#B91C1C]">{i.blockerCount} to fix</Link>
                    : <span className="text-[11px] text-[#166534]">Ready</span>}
                  {i.warningCount ? <span className="ml-1 text-[10px] text-[#92400E]">{i.warningCount} tips</span> : null}
                </AdminTd>
                <AdminTd label="Edited" className="whitespace-nowrap text-[11px] text-[#6B6B66]">{new Date(i.updatedAt).toLocaleDateString()}</AdminTd>
                <AdminTd className="max-sm:!justify-start max-sm:!text-left">
                  <div className="flex flex-wrap justify-end gap-1 max-sm:justify-start">
                    {(i.displayStatus === 'live' || i.displayStatus === 'sold_out') && <a href={`/products/${i.slug}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-[9px] px-2 text-[11px] underline underline-offset-2">View live</a>}
                    {(i.displayStatus === 'live' || i.displayStatus === 'sold_out') && <AdminButton size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/products/${i.slug}`); setNotice({ tone: 'success', text: 'Link copied.' }) }}>Copy URL</AdminButton>}
                    <AdminButton size="sm" variant="ghost" disabled={busy} onClick={() => void rowAction(i, 'duplicate')}>Duplicate</AdminButton>
                    {i.displayStatus === 'archived'
                      ? <AdminButton size="sm" variant="ghost" disabled={busy} onClick={() => void rowAction(i, 'restore')}>Restore</AdminButton>
                      : <AdminButton size="sm" variant="ghost" disabled={busy} onClick={() => void rowAction(i, 'archive')}>Archive</AdminButton>}
                  </div>
                </AdminTd>
              </AdminTr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  )
}
