'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AdminPage, AdminButton, AdminError, AdminLoading, AdminNotice, AdminTabs, StatusBadge, useConfirm } from '@/components/admin/ui/AdminUI'
import type { PickedMedia } from '@/components/admin/media/MediaPicker'
import type { ProductSnapshot } from '@/lib/product-model'
import { contentGuidance } from '@/lib/product-model'
import { type EditorState, type Options, type Issue, type Assets, type TabId, tabForField } from './editor-shared'
import { BasicsSection } from './sections/BasicsSection'
import { MediaSection } from './sections/MediaSection'
import { VariantsSection } from './sections/VariantsSection'
import { ContentSection } from './sections/ContentSection'
import { PairingSection } from './sections/PairingSection'
import { PricingSection } from './sections/PricingSection'
import { SeoSection } from './sections/SeoSection'
import { PublishingSection, type Act } from './sections/PublishingSection'
import { HistorySection } from './sections/HistorySection'
import { PreviewPane } from './PreviewPane'

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'
const AUTOSAVE_MS = 1200

async function api(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  let body: any = null
  try { body = await r.json() } catch { /* empty */ }
  return { ok: r.ok, status: r.status, body }
}

export function ProductEditorClient({ id }: { id: string }) {
  const router = useRouter()
  const { confirm, node: confirmNode } = useConfirm()
  const [state, setState] = useState<EditorState | null>(null)
  const [snap, setSnap] = useState<ProductSnapshot | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [assets, setAssets] = useState<Assets>({})
  const [blockers, setBlockers] = useState<Issue[]>([])
  const [warnings, setWarnings] = useState<Issue[]>([])
  const [save, setSave] = useState<SaveState>('idle')
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('basics')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null)

  const snapRef = useRef<ProductSnapshot | null>(null)
  const revRef = useRef(0)
  const dirtyRef = useRef(false)
  const inFlight = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conflictRef = useRef(false)
  const undoHistory = useRef<ProductSnapshot[]>([])
  const redoHistory = useRef<ProductSnapshot[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)

  const load = useCallback(async () => {
    const r = await api(`/api/admin/products/${id}`)
    if (!r.ok) { setLoadErr(r.body?.error ?? 'Could not load this product.'); return }
    const d: EditorState = r.body.data
    setState(d); setSnap(d.snapshot); snapRef.current = d.snapshot; revRef.current = d.revision
    setAssets(d.assets); setBlockers(d.blockers); setWarnings(d.warnings)
    dirtyRef.current = false; conflictRef.current = false; setSave('idle'); setSaveErrors([]); setLoadErr(null)
    undoHistory.current = []; redoHistory.current = []; setHistoryVersion(n => n + 1)
  }, [id])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void (async () => { const r = await api(`/api/admin/products/options?exclude=${id}`); if (r.ok) setOptions(r.body) })()
  }, [id])

  // ── autosave ────────────────────────────────────────────────────────────────
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (inFlight.current) { await inFlight.current }
    if (conflictRef.current) return false
    if (!dirtyRef.current) return true
    const run = (async (): Promise<boolean> => {
      for (let guard = 0; guard < 5 && dirtyRef.current; guard++) {
        const sent = snapRef.current!
        setSave('saving')
        const r = await api(`/api/admin/products/${id}`, { method: 'PUT', body: JSON.stringify({ snapshot: sent, revision: revRef.current }) })
        if (r.ok) {
          revRef.current = r.body.revision
          setBlockers(r.body.blockers ?? []); setWarnings(r.body.warnings ?? [])
          setSaveErrors([])
          if (snapRef.current === sent) { dirtyRef.current = false; setSave('saved') }
        } else if (r.status === 409) {
          conflictRef.current = true; setSave('conflict'); return false
        } else {
          setSave('error'); setSaveErrors(r.body?.errors ?? [r.body?.error ?? 'Could not save.']); return false
        }
      }
      return !dirtyRef.current
    })()
    inFlight.current = run
    try { return await run } finally { inFlight.current = null }
  }, [id])

  const update = useCallback((fn: (s: ProductSnapshot) => void) => {
    const prev = snapRef.current; if (!prev) return
    const next = structuredClone(prev); fn(next)
    undoHistory.current = [...undoHistory.current, prev].slice(-30)
    redoHistory.current = []
    setHistoryVersion(n => n + 1)
    snapRef.current = next; dirtyRef.current = true
    setSnap(next); setSave(s => (s === 'saving' || s === 'conflict' ? s : 'dirty'))
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush() }, AUTOSAVE_MS)
  }, [flush])

  // Undo/Redo edits the VERSIONED PRODUCT DRAFT only; it never reverses inventory,
  // orders, payments, publication actions or previously committed finance events.
  const travel = useCallback((direction: 'undo' | 'redo') => {
    if (conflictRef.current || !snapRef.current) return
    const from = direction === 'undo' ? undoHistory : redoHistory
    const to = direction === 'undo' ? redoHistory : undoHistory
    const next = from.current.pop()
    if (!next) return
    to.current = [...to.current, snapRef.current].slice(-30)
    snapRef.current = next
    dirtyRef.current = true
    setSnap(next)
    setSave('dirty')
    setHistoryVersion(n => n + 1)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush() }, AUTOSAVE_MS)
  }, [flush])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (dirtyRef.current || inFlight.current || conflictRef.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const addAsset = useCallback((a: PickedMedia) => {
    setAssets(p => ({ ...p, [a.id.toLowerCase()]: { id: a.id, url: a.url, width: a.width, altText: a.altText, filename: a.filename, status: a.status, variants: a.variants } }))
  }, [])

  // ── actions ────────────────────────────────────────────────────────────────
  const act = useCallback(async (a: Act, extra?: { publishAt?: string | null; unpublishAt?: string | null }) => {
    if (!state) return
    setNotice(null)
    const messages: Partial<Record<Act, string>> = {
      publish: state.status === 'published' ? 'Publish these changes? The live page, price and sizes update together.' : 'Publish this product? It goes live in the shop and can be bought straight away.',
      unpublish: 'Unpublish this product? It disappears from the shop and customers can’t buy it.',
      archive: 'Archive this product? It is taken off the shop and hidden from the list until restored.',
    }
    if (messages[a] && !(await confirm(messages[a]!))) return
    setBusy(true)
    try {
      if (!(await flush())) { setNotice({ tone: 'danger', text: 'Fix the save problem first.' }); return }
      const action = a === 'clear-schedule' ? 'schedule' : a
      const payload: Record<string, unknown> = { action, revision: revRef.current }
      if (a === 'schedule') { payload.publishAt = extra?.publishAt ?? null; payload.unpublishAt = extra?.unpublishAt ?? null }
      if (a === 'clear-schedule') { payload.publishAt = null; payload.unpublishAt = null }
      const r = await api(`/api/admin/products/${id}/action`, { method: 'POST', body: JSON.stringify(payload) })
      if (r.status === 409) { conflictRef.current = true; setSave('conflict'); return }
      if (!r.ok) {
        if (r.status === 422 && r.body?.blockers) { setBlockers(r.body.blockers); setWarnings(r.body.warnings ?? []); setTab('publish') }
        setNotice({ tone: 'danger', text: r.body?.error ?? 'That did not work.' }); return
      }
      if (a === 'duplicate') { router.push(`/admin/products/${r.body.id}`); return }
      const ci = r.body.cacheInvalidation
      await load()
      setNotice(ci && ci.ok === false
        ? { tone: 'warning', text: `Saved, but the live site may take a moment to update (${ci.error ?? 'cache refresh failed'}). Check System → cache.` }
        : { tone: 'success', text: ({ publish: 'Published.', unpublish: 'Unpublished.', archive: 'Archived.', restore: 'Restored. It stays off the shop until you publish.', schedule: 'Schedule saved.', 'clear-schedule': 'Schedule cleared.', duplicate: '' } as Record<Act, string>)[a] })
    } finally { setBusy(false) }
  }, [state, confirm, flush, id, load, router])

  const rollback = useCallback(async (versionNo: number) => {
    if (!(await confirm(`Restore the content of version ${versionNo}? Price, sizes and stock stay as they are now.`))) return
    setBusy(true); setNotice(null)
    try {
      if (!(await flush())) return
      const r = await api(`/api/admin/products/${id}/action`, { method: 'POST', body: JSON.stringify({ action: 'rollback', versionNo, revision: revRef.current }) })
      if (r.status === 409) { conflictRef.current = true; setSave('conflict'); return }
      if (!r.ok) { setNotice({ tone: 'danger', text: r.body?.error ?? 'Could not restore that version.' }); return }
      await load()
      setNotice(r.body.cacheInvalidation?.ok === false
        ? { tone: 'warning', text: 'Restored, but the live site may take a moment to update.' } : { tone: 'success', text: `Version ${versionNo} restored as a new version.` })
    } finally { setBusy(false) }
  }, [confirm, flush, id, load])

  const setCollections = useCallback(async (ids: string[]) => {
    const r = await api(`/api/admin/products/${id}/collections`, { method: 'PUT', body: JSON.stringify({ collectionIds: ids }) })
    if (!r.ok) { setNotice({ tone: 'danger', text: r.body?.error ?? 'Could not update collections.' }); return }
    const byId = new Map((options?.collections ?? []).map(c => [c.id, c] as const))
    setState(p => p ? { ...p, collections: ids.map(i => byId.get(i)).filter(Boolean).map(c => ({ id: c!.id, slug: c!.slug, name: c!.name })) } : p)
    if (r.body.cacheInvalidation?.ok === false) setNotice({ tone: 'warning', text: 'Collections updated, but the live site may take a moment to update.' })
  }, [id, options])

  // ── derived ────────────────────────────────────────────────────────────────
  const issues = useMemo(() => [...blockers, ...warnings], [blockers, warnings])
  const guidance = useMemo(() => (snap ? contentGuidance(snap).map(g => ({ code: 'GUIDE', field: g.field, message: g.message })) : []), [snap])
  const tabCounts = useMemo(() => {
    const c: Partial<Record<TabId, number>> = {}
    for (const b of blockers) { const t = tabForField(b.field); c[t] = (c[t] ?? 0) + 1 }
    return c
  }, [blockers])

  if (loadErr) return <AdminError message={loadErr} onRetry={() => void load()} />
  if (!state || !snap) return <AdminLoading label="Loading product…" />

  const locked = state.status === 'archived' || save === 'conflict'
  const badge = state.status === 'archived' ? 'Archived' : state.status === 'scheduled' ? 'Scheduled' : state.status === 'published' ? 'Live' : 'Draft'
  const saveLabel = { idle: '', dirty: 'Unsaved changes', saving: 'Saving…', saved: 'Saved', error: 'Not saved', conflict: 'Not saved' }[save]
  const section = { snap, update, state, options, assets, addAsset, issues: [...issues, ...guidance], locked }

  return (
    <AdminPage width="wide">
      {confirmNode}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href="/admin/products" onClick={e => { if ((dirtyRef.current || conflictRef.current) && !window.confirm('You have unsaved changes. Leave anyway?')) e.preventDefault() }}
            className="text-[11px] text-[#6B6B66] underline underline-offset-2">← Products</Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-[20px] font-medium tracking-[-0.01em]">{snap.name || 'Untitled product'} <StatusBadge status={badge} /></h1>
        </div>
        <div className="flex items-center gap-3">
          <span role="status" aria-live="polite" className={`text-[11px] ${save === 'error' || save === 'conflict' ? 'text-[#B91C1C]' : 'text-[#8A8A85]'}`}>{saveLabel}</span>
          <div className="flex items-center gap-1" aria-label="Product draft editing history" data-history-version={historyVersion}>
            <AdminButton size="sm" variant="ghost" disabled={locked || busy || undoHistory.current.length === 0} onClick={() => travel('undo')}>Undo</AdminButton>
            <AdminButton size="sm" variant="ghost" disabled={locked || busy || redoHistory.current.length === 0} onClick={() => travel('redo')}>Redo</AdminButton>
          </div>
          {!locked && save !== 'idle' && save !== 'saved' && <AdminButton size="sm" onClick={() => void flush()} disabled={save === 'saving'}>Save now</AdminButton>}
          <AdminButton variant="primary" disabled={busy || save === 'conflict'} onClick={() => setTab('publish')}>{state.status === 'published' ? 'Publish changes' : 'Publish'}</AdminButton>
        </div>
      </header>

      {save === 'conflict' && (
        <AdminNotice tone="danger" title="This product was changed somewhere else" className="mb-3">
          Your latest edits were not saved so nothing was overwritten.{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(snapRef.current, null, 2))}>Copy my changes</button>{' · '}
          <button type="button" className="underline underline-offset-2" onClick={() => void load()}>Reload the latest</button>
        </AdminNotice>
      )}
      {save === 'error' && saveErrors.length > 0 && (
        <AdminNotice tone="danger" title="Couldn’t save" className="mb-3"><ul>{saveErrors.map((e, i) => <li key={i}>{e}</li>)}</ul></AdminNotice>
      )}
      {state.status === 'archived' && <AdminNotice tone="info" className="mb-3">This product is archived. Restore it to edit.</AdminNotice>}
      {notice && <AdminNotice tone={notice.tone} className="mb-3">{notice.text}</AdminNotice>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0">
          <AdminTabs<TabId> ariaLabel="Product sections" value={tab} onChange={setTab} tabs={[
            { id: 'basics', label: 'Basics', count: tabCounts.basics }, { id: 'media', label: 'Images', count: tabCounts.media },
            { id: 'variants', label: 'Colours & sizes', count: tabCounts.variants }, { id: 'content', label: 'Content', count: tabCounts.content },
            { id: 'pairing', label: 'Complete the Set', count: tabCounts.pairing }, { id: 'price', label: 'Price & shipping', count: tabCounts.price },
            { id: 'seo', label: 'SEO', count: tabCounts.seo }, { id: 'publish', label: 'Publish', count: blockers.length || undefined }, { id: 'history', label: 'History' },
          ]} />
          {tab === 'basics' && <BasicsSection {...section} />}
          {tab === 'media' && <MediaSection {...section} />}
          {tab === 'variants' && <VariantsSection {...section} />}
          {tab === 'content' && <ContentSection {...section} />}
          {tab === 'pairing' && <PairingSection {...section} />}
          {tab === 'price' && <PricingSection {...section} onCollections={setCollections} />}
          {tab === 'seo' && <SeoSection {...section} />}
          {tab === 'publish' && <PublishingSection state={state} blockers={blockers} warnings={warnings} busy={busy} saving={save === 'saving' || save === 'dirty'} onAct={(a, x) => void act(a, x)} onJump={setTab} publishedSlug={state.published?.slug ?? state.slug} />}
          {tab === 'history' && <HistorySection state={state} busy={busy} onRollback={v => void rollback(v)} />}
        </div>
        <aside className="min-w-0 xl:sticky xl:top-4 xl:h-[calc(100vh-120px)]" aria-label="Preview">
          <PreviewPane productId={id} snapshot={snap} assets={assets} canonicalPriceCents={state.canonical.priceCents}
            variants={state.canonical.variants.map(v => ({ sku: v.sku, size: v.size, sizeSort: v.sizeSort, colorCode: v.colorCode, active: v.active }))} />
        </aside>
      </div>
    </AdminPage>
  )
}
