'use client'
// Site-wide SEO defaults (title, description, social previews, organization data).
// Per-page overrides live in each page's own editor; this is the fallback.

import { useEffect, useState } from 'react'
import { AdminButton, AdminCard, AdminError, AdminLoading, AdminNotice, AdminSectionHeader } from '@/components/admin/ui/AdminUI'
import { api, BASE, type ApiResult } from './api'
import { useDraftHistory } from '@/lib/admin/use-draft-history'
import { ErrorNotice, InvalidationNotice, MediaField, Select, TextInput } from './ui'
import { ListEditor } from './ui'
import type { GlobalSeo } from '@/lib/content-schemas'

export function SeoPanel() {
  const { value: val, set: setVal, replace: replaceVal, undo, redo, canUndo, canRedo } = useDraftHistory<GlobalSeo | null>(null)
  const [revision, setRevision] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  async function load() {
    const r = await api<{ value: GlobalSeo; revision: number }>('GET', `${BASE}/seo`)
    if (!r.ok) { setErr(r.error ?? 'Could not load.'); return }
    setErr(null); replaceVal(r.data!.value); setRevision(r.data!.revision); setDirty(false)
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  if (err) return <AdminError message={err} onRetry={load} />
  if (!val) return <AdminLoading />
  const set = (patch: Partial<GlobalSeo>) => { setVal({ ...val, ...patch }); setDirty(true); setSaved(false) }
  const setOrg = (patch: Partial<GlobalSeo['organization']>) => set({ organization: { ...val.organization, ...patch } })

  async function save() {
    setBusy(true); setSaved(false)
    const r = await api<{ revision: number }>('PUT', `${BASE}/seo`, { value: val, revision })
    setBusy(false); setResult(r)
    if (r.ok) { setRevision(r.data!.revision); setDirty(false); setSaved(true); replaceVal(val) }
  }

  return (
    <div className="space-y-4">
      <AdminNotice tone="info">These are the defaults for every page. A page’s own search title, description and share image override them. Saving applies immediately.</AdminNotice>
      <AdminCard>
        <AdminSectionHeader title="Site" />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Site name" value={val.siteName} onChange={v => set({ siteName: v })} max={60} />
          <TextInput label="Default title" value={val.titleDefault} onChange={v => set({ titleDefault: v })} max={90} hint="Shown for the home page and pages with no title." />
          <TextInput label="Title template" value={val.titleTemplate} onChange={v => set({ titleTemplate: v })} max={120} hint="Use %s where the page title goes, e.g. “%s | KVRN”." />
        </div>
        <div className="mt-3 space-y-3">
          <TextInput label="Default description" value={val.description} onChange={v => set({ description: v })} multiline rows={3} max={320} />
          <TextInput label="Keywords" value={val.keywords.join(', ')} onChange={v => set({ keywords: v.split(',').map(s => s.trim()).filter(Boolean) })} hint="Separate with commas." />
          <MediaField label="Default share image" assetId={val.shareImageId} onChange={id => set({ shareImageId: id, ...(id ? {} : { shareImageUrl: undefined }) })}
            hint="Used in link previews when a page has no image of its own." />
        </div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Social sharing text" />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Facebook / link preview title" value={val.ogTitle} onChange={v => set({ ogTitle: v })} max={120} />
          <TextInput label="Twitter / X title" value={val.twitterTitle} onChange={v => set({ twitterTitle: v })} max={120} />
          <TextInput label="Facebook / link preview description" value={val.ogDescription} onChange={v => set({ ogDescription: v })} multiline rows={2} max={320} />
          <TextInput label="Twitter / X description" value={val.twitterDescription} onChange={v => set({ twitterDescription: v })} multiline rows={2} max={320} />
        </div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Business details" description="Structured data that helps search engines show your business correctly." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Type" value={val.organization.type} onChange={v => setOrg({ type: v })}
            options={[{ value: 'ClothingStore', label: 'Clothing store' }, { value: 'Store', label: 'Store' }, { value: 'Organization', label: 'Organization' }]} />
          <TextInput label="Name" value={val.organization.name} onChange={v => setOrg({ name: v })} max={80} />
          <TextInput label="Website" value={val.organization.url} onChange={v => setOrg({ url: v })} hint="Full https:// link." />
          <TextInput label="Contact email" value={val.organization.email} onChange={v => setOrg({ email: v })} type="email" max={120} />
          <TextInput label="Contact type" value={val.organization.contactType} onChange={v => setOrg({ contactType: v })} max={60} />
          <TextInput label="Languages" value={val.organization.availableLanguage} onChange={v => setOrg({ availableLanguage: v })} max={60} />
        </div>
        <div className="mt-3 space-y-3">
          <TextInput label="Description" value={val.organization.description} onChange={v => setOrg({ description: v })} multiline rows={2} max={400} />
          <ListEditor<{ u: string }> items={val.organization.sameAs.map(u => ({ u }))} addLabel="Add social profile" max={10}
            onChange={items => setOrg({ sameAs: items.map(i => i.u) })} makeNew={() => ({ u: 'https://' })}
            render={(item, update) => <TextInput label="Profile link" value={item.u} onChange={v => update({ u: v })} hint="Full https:// link." />} />
        </div>
      </AdminCard>

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-[12px] border border-black/[0.08] bg-white p-3">
        <AdminButton size="sm" variant="ghost" disabled={busy || !canUndo} onClick={() => { undo(); setDirty(true); setSaved(false) }}>Undo</AdminButton>
        <AdminButton size="sm" variant="ghost" disabled={busy || !canRedo} onClick={() => { redo(); setDirty(true); setSaved(false) }}>Redo</AdminButton>
        <AdminButton variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save and apply</AdminButton>
        <span className="text-[11px] text-[#8A8A85]" aria-live="polite">{saved ? 'Saved.' : dirty ? 'Unsaved changes' : ''}</span>
      </div>
      {result && !result.ok && (result.code === 'stale' || result.code === 'conflict'
        ? <AdminNotice tone="danger" title="Someone else changed this."><p>Nothing was overwritten. <button className="underline" onClick={load}>Load the latest</button> and re-apply your edits.</p></AdminNotice>
        : <ErrorNotice result={result} />)}
      {result?.ok && <InvalidationNotice result={result.invalidation} />}
    </div>
  )
}
