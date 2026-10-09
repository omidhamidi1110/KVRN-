'use client'
// The editor shell shared by every versioned content kind (policies, size guides, blocks, FAQ,
// pages, About, Contact, size-guide page text, announcement, navigation, footer).
//
// Draft / Preview / Publish / Versions / Rollback:
//   * edits autosave to a DRAFT (the public site never sees a draft)
//   * a stale save (someone else saved first) is a visible conflict — nothing is overwritten
//   * Publish saves, validates again on the server, then makes the draft live and refreshes the site
//   * if the site refresh fails the change is still saved and the failure is shown with a retry

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AdminButton, AdminCard, AdminLoading, AdminError, AdminNotice, AdminTabs, useConfirm, InfoTip,
} from '@/components/admin/ui/AdminUI'
import { api, BASE, SINGLETON, type Kind, type ApiResult } from './api'
import { ErrorNotice, InvalidationNotice, entityStatusBadge } from './ui'
import { FORMS, NEW_SNAPSHOT } from './forms'
import { TranslationsPanel } from './TranslationsPanel'
import { VersionsPanel } from './VersionsPanel'
import type { BlockChoice } from './RichTextEditor'
import { snapshotTitle, LEGACY_POLICY_PATHS } from '@/lib/content-schemas'

type Tab = 'edit' | 'translations' | 'history'
type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'
const AUTOSAVE_MS = 1500

interface Loaded {
  id: string; exists: boolean; revision: number; status: string; hasDraft: boolean; isLive: boolean
  snapshot: any; published: any; path: string | null; updatedAt?: string; updatedBy?: string | null; publishedAt?: string | null
  placeholderSeed?: boolean; ownerDraftAvailable?: boolean
}

const LABEL: Record<Kind, string> = {
  policies: 'policy', 'size-guides': 'size guide', blocks: 'content block', faq: 'FAQ', pages: 'page', about: 'About page',
  contact: 'Contact page', 'support-pages': 'Size Guide page text', announcement: 'announcement bar', navigation: 'navigation', footer: 'footer',
}

export function EntityEditor({ kind, id, onClose, onCreated, onChanged }: {
  kind: Kind; id: string; onClose?: () => void; onCreated: (id: string) => void; onChanged?: () => void
}) {
  const isNew = id === 'new'
  const apiId = isNew ? '' : id
  const url = `${BASE}/${kind}/${apiId}`
  const singleton = !!SINGLETON[kind]
  const legacyPolicy = kind === 'policies' && !!LEGACY_POLICY_PATHS[id]
  const { confirm, node: confirmNode } = useConfirm()

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<any>(null)
  const [revision, setRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [result, setResult] = useState<ApiResult | null>(null)      // last failed/succeeded action
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('edit')
  const [busy, setBusy] = useState<string | null>(null)
  const [choices, setChoices] = useState<BlockChoice[] | undefined>(undefined)
  const [usage, setUsage] = useState<any[] | null>(null)

  // Always-current values for async callbacks.
  const ref = useRef({ draft, revision, dirty })
  ref.current = { draft, revision, dirty }
  const inFlight = useRef<Promise<boolean> | null>(null)

  const load = useCallback(async () => {
    if (isNew) {
      const make = NEW_SNAPSHOT[kind]
      setLoaded({ id: 'new', exists: false, revision: 0, status: 'draft', hasDraft: false, isLive: false, snapshot: make ? make() : {}, published: null, path: null })
      setDraft(make ? make() : {}); setRevision(0); setDirty(false); return
    }
    const r = await api<Loaded>('GET', url)
    if (!r.ok) { setLoadErr(r.error ?? 'Could not load this.'); return }
    setLoadErr(null); setLoaded(r.data!); setDraft(r.data!.snapshot); setRevision(r.data!.revision); setDirty(false); setSaveState('idle')
  }, [isNew, kind, url])
  useEffect(() => { load() }, [load])

  // Reusable blocks the editor can insert (published ones only).
  useEffect(() => {
    if (kind !== 'policies' && kind !== 'pages') return
    api<any[]>('GET', `${BASE}/blocks?status=published`).then(r => { if (r.ok) setChoices(r.data!.map(b => ({ id: b.id, name: b.title }))) })
  }, [kind])

  // Usage (blocks: pages that embed it; size guides: products that show it).
  const loadUsage = useCallback(async () => {
    if (isNew || (kind !== 'blocks' && kind !== 'size-guides')) return
    const r = await api<any[]>('GET', `${url}/usage`); if (r.ok) setUsage(r.data!)
  }, [isNew, kind, url])
  useEffect(() => { loadUsage() }, [loadUsage])

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) await inFlight.current
    if (!ref.current.dirty) return true
    const run = (async () => {
      setSaveState('saving')
      const snap = ref.current.draft
      const r = await api<{ revision: number }>('PUT', url, { snapshot: snap, revision: ref.current.revision })
      if (r.ok) {
        setRevision(r.data!.revision)
        if (ref.current.draft === snap) setDirty(false)
        setSaveState('saved'); setSavedAt(new Date()); setResult(null)
        return true
      }
      setResult(r)
      setSaveState(r.code === 'stale' ? 'conflict' : 'error')
      return false
    })()
    inFlight.current = run
    try { return await run } finally { inFlight.current = null }
  }, [url])

  // Autosave (existing items only; a new item is created explicitly).
  useEffect(() => {
    if (isNew || !dirty || saveState === 'conflict') return
    const t = setTimeout(() => { saveNow() }, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [draft, dirty, isNew, saveState, saveNow])

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (ref.current.dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  const edit = (v: any) => { setDraft(v); setDirty(true); if (saveState === 'saved' || saveState === 'error') setSaveState('idle'); setNotice(null) }

  async function create() {
    setBusy('create'); setResult(null)
    const r = await api<{ id: string; revision: number }>('POST', `${BASE}/${kind}`, { snapshot: draft })
    setBusy(null)
    if (!r.ok) { setResult(r); return }
    onChanged?.(); onCreated(r.data!.id)
  }

  async function act(action: 'publish' | 'unpublish' | 'archive' | 'restore' | 'duplicate', extra: Record<string, unknown> = {}) {
    setBusy(action); setResult(null); setNotice(null)
    if ((action === 'publish' || action === 'duplicate') && !(await saveNow())) { setBusy(null); return }
    const r = await api<any>('POST', url, { action, revision: ref.current.revision, ...extra })
    setBusy(null)
    if (!r.ok) {
      if (action === 'archive' && r.code === 'in_use') {
        const detail = (r.details as any[] | undefined)?.length ? ` It is used by ${(r.details as any[]).length} item(s).` : ''
        if (await confirm(`${r.error}${detail} Archive it anyway? Those places will keep working but lose this content.`)) return act('archive', { force: true })
      }
      setResult(r); return
    }
    setResult(r)
    if (action === 'duplicate') { onChanged?.(); onCreated(r.data.id); return }
    setNotice(({ publish: 'Published. The live page now shows this version.', unpublish: 'Unpublished. The page is no longer public.', archive: 'Archived.', restore: 'Restored as an unpublished draft. Review it, then publish.' } as Record<string, string>)[action])
    await load(); loadUsage(); onChanged?.()
  }

  // Terms / privacy only: put the owner's October 6 text into the DRAFT (never publishes).
  async function loadOwnerDraft() {
    if ((dirty || loaded?.hasDraft) && !(await confirm('Replace the text of your current draft with the owner’s October 6 draft? Your draft’s earlier saves stay in History.'))) return
    setBusy('ownerDraft'); setResult(null)
    if (dirty && !(await saveNow())) { setBusy(null); return }
    const r = await api<{ revision: number }>('POST', `${BASE}/policies/${encodeURIComponent(id)}/owner-draft`, { revision: ref.current.revision })
    setBusy(null)
    if (!r.ok) { setResult(r); return }
    await load()
    onChanged?.()
    setNotice('October 6 draft loaded as an unpublished draft. Nothing is public yet: review it, get owner approval and legal review, then publish.')
  }

  async function unpublish() {
    const warn = usage && usage.length && kind === 'blocks' ? ` Pages that use this block (${usage.length}) will lose it, so it cannot be unpublished while a live page uses it.` : ''
    if (await confirm(`Take this ${LABEL[kind]} offline? Visitors will no longer see it.${warn}`)) act('unpublish')
  }
  async function archive() {
    if (await confirm(`Archive this ${LABEL[kind]}? It is hidden from the public site and can be restored later.`)) act('archive')
  }

  const Form = FORMS[kind]
  const title = useMemo(() => (draft ? snapshotTitle(kind, draft) || (isNew ? `New ${LABEL[kind]}` : LABEL[kind]) : ''), [draft, kind, isNew])
  if (loadErr) return <AdminError message={loadErr} onRetry={load} />
  if (!loaded || draft === null) return <AdminLoading label="Loading…" />

  const archived = loaded.status === 'archived'
  const live = loaded.isLive
  const dirtyText = saveState === 'saving' ? 'Saving…' : saveState === 'conflict' ? 'Not saved — conflict' : saveState === 'error' ? 'Not saved' :
    dirty ? 'Unsaved changes' : savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : loaded.hasDraft ? 'Draft saved' : ''
  const canArchive = !singleton && !legacyPolicy && kind !== 'support-pages' && !isNew
  const canUnpublish = live && !singleton && !legacyPolicy
  const canDup = !singleton && kind !== 'support-pages' && !isNew

  return (
    <div className="space-y-4">
      {confirmNode}
      <AdminCard className="sticky top-0 z-20 !p-3 sm:!px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {onClose && <AdminButton size="sm" variant="ghost" onClick={async () => { if (dirty && !(await confirm('You have unsaved changes. Leave without saving?'))) return; onClose() }}>Back</AdminButton>}
              <h2 className="truncate text-[15px] font-medium text-[#171717]">{title}</h2>
              {!isNew && entityStatusBadge(loaded.status, loaded.hasDraft, live, !!loaded.placeholderSeed)}
            </div>
            <p className="mt-0.5 text-[11px]" aria-live="polite" style={{ color: saveState === 'error' || saveState === 'conflict' ? '#B91C1C' : '#8A8A85' }}>
              {isNew ? 'Not created yet' : dirtyText}
              {live && loaded.path && <> · <a href={loaded.path} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">View live page</a></>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isNew
              ? <AdminButton variant="primary" loading={busy === 'create'} onClick={create}>Create draft</AdminButton>
              : <>
                  {canDup && <AdminButton size="sm" loading={busy === 'duplicate'} disabled={archived} onClick={() => act('duplicate')}>Duplicate</AdminButton>}
                  {canUnpublish && <AdminButton size="sm" loading={busy === 'unpublish'} onClick={unpublish}>Unpublish</AdminButton>}
                  {canArchive && !archived && <AdminButton size="sm" variant="danger" loading={busy === 'archive'} onClick={archive}>Archive</AdminButton>}
                  {archived && <AdminButton size="sm" variant="primary" loading={busy === 'restore'} onClick={() => act('restore')}>Restore</AdminButton>}
                  {!archived && <AdminButton variant="primary" loading={busy === 'publish'} disabled={!dirty && !loaded.hasDraft && live} onClick={() => act('publish')}>{live ? 'Publish changes' : 'Publish'}</AdminButton>}
                </>}
          </div>
        </div>
      </AdminCard>

      {saveState === 'conflict' && (
        <AdminNotice tone="danger" title="Someone else changed this while you were editing.">
          <p>Your latest edits were not saved, so nothing was overwritten.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <AdminButton size="sm" onClick={() => navigator.clipboard?.writeText(JSON.stringify(draft, null, 2))}>Copy my version</AdminButton>
            <AdminButton size="sm" variant="primary" onClick={load}>Load the latest version</AdminButton>
          </div>
        </AdminNotice>
      )}
      {notice && <AdminNotice tone="success">{notice}</AdminNotice>}
      {result && !result.ok && saveState !== 'conflict' && <ErrorNotice result={result} title={result.code === 'invalid' ? 'Some fields need attention.' : 'That did not work.'} />}
      {result?.ok && <InvalidationNotice result={result.invalidation} />}
      {archived && <AdminNotice tone="info">This is archived and hidden from the public site. Restore it to edit.</AdminNotice>}
      {legacyPolicy && <AdminNotice tone="info">This legal page is always part of the storefront, so it cannot be unpublished or archived. Edit it and publish the changes.</AdminNotice>}
      {loaded.placeholderSeed && (
        <AdminNotice tone="warning" title="This is the original placeholder text installed by the migration.">
          <p>The public page currently shows the version built into the site’s code (for Terms and Privacy that is the owner’s October 6 copy), not this text. Publishing this placeholder unchanged is blocked so it cannot replace that copy by accident.{loaded.ownerDraftAvailable ? '' : ' Edit the text first; it is published only after owner approval and legal review.'}</p>
        </AdminNotice>
      )}
      {loaded.ownerDraftAvailable && !isNew && (
        <AdminNotice tone="info" title="Owner’s October 6 draft">
          <p>Loads the October 6 text into this draft exactly as supplied (headings and bullets become formatted blocks). It is not published, and it still needs owner approval and legal review.</p>
          <div className="mt-2"><AdminButton size="sm" variant={loaded.placeholderSeed ? 'primary' : 'secondary'} loading={busy === 'ownerDraft'} disabled={archived} onClick={loadOwnerDraft}>Load October 6 draft</AdminButton></div>
        </AdminNotice>
      )}
      {kind === 'blocks' && usage && usage.length > 0 && (
        <AdminNotice tone="warning" title={`Used by ${usage.length} page${usage.length === 1 ? '' : 's'}`}>
          <ul className="list-disc pl-4">{usage.slice(0, 8).map((u, i) => <li key={i}>{u.owner_type} {u.slug ? `/${u.slug}` : u.owner_id} ({u.scope === 'published' ? 'live' : 'draft'})</li>)}</ul>
          <p className="mt-1">Publishing a change here updates all of them.</p>
        </AdminNotice>
      )}
      {kind === 'size-guides' && usage && usage.length > 0 && (
        <AdminNotice tone="warning" title={`Shown on ${usage.length} product${usage.length === 1 ? '' : 's'}`}>
          <p>{usage.slice(0, 6).map((u: any) => u.name).join(', ')}{usage.length > 6 ? '…' : ''}. Publishing a change updates all of them. To change one product only, use “Duplicate and edit” from the product.</p>
        </AdminNotice>
      )}

      {!isNew && (
        <AdminTabs<Tab> ariaLabel="Editor sections" value={tab} onChange={setTab}
          tabs={[{ id: 'edit', label: 'Edit' }, { id: 'translations', label: 'Translations' }, { id: 'history', label: 'History' }]} />
      )}

      {tab === 'edit' && (
        <fieldset disabled={archived} className="min-w-0 border-0 p-0">
          <legend className="sr-only">Edit {LABEL[kind]}</legend>
          <Form value={draft} onChange={edit} blockChoices={choices} entityId={isNew ? undefined : id} isNew={isNew} />
          {!isNew && <p className="mt-3 flex items-center gap-1 text-[11px] text-[#8A8A85]">Changes save automatically as a draft. Visitors only see them after you publish.
            <InfoTip label="About drafts">Drafts are private. “Publish” checks everything again, then replaces the live page. Earlier versions stay in History, and you can restore any of them.</InfoTip></p>}
        </fieldset>
      )}
      {tab === 'translations' && !isNew && (dirty ? <AdminNotice tone="info">Saving your changes first…</AdminNotice> : <TranslationsPanel base={`${url}/translations`} />)}
      {tab === 'history' && !isNew && <VersionsPanel kind={kind} id={id} revision={revision} onRolledBack={load} />}
    </div>
  )
}
