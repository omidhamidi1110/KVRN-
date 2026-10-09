'use client'
// Translations of one piece of content: completeness per language, editing, and publishing.
//
//   * Only PUBLISHED translations are ever shown to shoppers; everything else falls back to English.
//   * A translation written against older English text is flagged "out of date".
//   * Machine-generated text can never be published until a person rewrites it.
//   * Legal pages publish a language only after an explicit acknowledgement.

import { useDraftHistory } from '@/lib/admin/use-draft-history'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminButton, AdminLoading, AdminNotice, AdminError, StatusBadge, adminInputClass, useConfirm } from '@/components/admin/ui/AdminUI'
import { api, type ApiResult } from './api'
import { ErrorNotice, InvalidationNotice, textareaClass, cx } from './ui'
import { RichTextEditor } from './RichTextEditor'
import { sourceHash } from '@/lib/translations'
import { LANGUAGES } from '@/context/I18nContext'
import type { RichText } from '@/lib/content-richtext'

interface Row { locale: string; field: string; value: string; status: 'draft' | 'needs_review' | 'published'; source_hash: string | null; machine_generated: boolean }
interface Overview {
  id: string; legal: boolean; locales: string[]; source: Record<string, string>; rows: Row[]
  completeness: Array<{ locale: string; total: number; translated: number; stale: number; missing: number; complete: boolean }>
}

const PREFIX: Record<string, string> = {
  q: 'Question', a: 'Answer', cat: 'Category', link: 'Link label', msg: 'Message', group: 'Group heading', tag: 'Tagline',
  para: 'Paragraph', ap: 'Approach', note: 'Note', col: 'Column', social: 'Social label', seoTitle: 'Search title',
}
export function fieldLabel(f: string): string {
  if (f.startsWith('seo')) return ({ seoTitle: 'Search title', seoDescription: 'Search description', seoShareTitle: 'Share title' } as Record<string, string>)[f] ?? f
  const [p, ...rest] = f.split('.')
  if (PREFIX[p] && rest.length) return `${PREFIX[p]} (${rest.join(' ')})`
  return f.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())
}
const isRich = (v: string) => v.startsWith('{"v":1')
const langName = (c: string) => LANGUAGES.find(l => l.code === c)?.label ?? c

function parseRich(v: string): RichText { try { const j = JSON.parse(v); return j && j.v === 1 && Array.isArray(j.blocks) ? j : { v: 1, blocks: [] } } catch { return { v: 1, blocks: [] } } }

export function TranslationsPanel({ base, perFieldPublish }: { base: string; perFieldPublish?: boolean }) {
  const [ov, setOv] = useState<Overview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [locale, setLocale] = useState<string>('')
  const { value: drafts, set: setDrafts, replace: replaceDrafts, undo, redo, canUndo, canRedo } = useDraftHistory<Record<string, string>>({})   // unsaved translation edits
  const [busy, setBusy] = useState<string | null>(null)
  const [last, setLast] = useState<ApiResult | null>(null)
  const [ack, setAck] = useState(false)
  const { confirm, node: confirmNode } = useConfirm()

  const load = useCallback(async () => {
    const r = await api<Overview>('GET', base)
    if (!r.ok) { setErr(r.error ?? 'Could not load translations.'); return }
    setErr(null); setOv(r.data!); setLocale(l => l || r.data!.locales[0] || '')
  }, [base])
  useEffect(() => { load() }, [load])

  const rowsFor = useMemo(() => {
    const m = new Map<string, Row>()
    for (const r of ov?.rows ?? []) m.set(`${r.locale}|${r.field}`, r)
    return m
  }, [ov])

  if (err) return <AdminError message={err} onRetry={load} />
  if (!ov) return <AdminLoading label="Loading translations…" />
  if (ov.locales.length === 0) return <AdminNotice>No translation languages are enabled.</AdminNotice>

  const comp = ov.completeness.find(c => c.locale === locale)
  const fields = Object.keys(ov.source)
  const key = (f: string) => `${locale}|${f}`
  const current = (f: string) => drafts[key(f)] ?? rowsFor.get(key(f))?.value ?? ''

  async function save(field: string, status: 'draft' | 'needs_review' | 'published') {
    setBusy(field)
    const value = current(field)
    const r = value.trim() === ''
      ? await api('DELETE', `${base}?locale=${locale}&field=${encodeURIComponent(field)}`)
      : await api('PUT', base, { locale, field, value, status })
    setBusy(null); setLast(r)
    if (r.ok) { const next = { ...drafts }; delete next[key(field)]; replaceDrafts(next); load() }
  }
  async function langAction(action: 'publish-locale' | 'unpublish-locale') {
    if (action === 'publish-locale' && ov!.legal && !ack) return
    if (action === 'unpublish-locale' && !(await confirm(`Hide the ${langName(locale)} translation from shoppers? They will see English instead.`))) return
    setBusy('lang')
    const r = await api('POST', base, { action, locale, acknowledge: ack })
    setBusy(null); setLast(r)
    if (r.ok) { setAck(false); load() }
  }

  return (
    <div className="space-y-4">
      {confirmNode}
      <div className="flex justify-end gap-2" aria-label="Unsaved translation history">
        <AdminButton size="sm" variant="ghost" disabled={!!busy || !canUndo} onClick={undo}>Undo</AdminButton>
        <AdminButton size="sm" variant="ghost" disabled={!!busy || !canRedo} onClick={redo}>Redo</AdminButton>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Languages">
        {ov.locales.map(l => {
          const c = ov.completeness.find(x => x.locale === l)
          return (
            <button key={l} type="button" role="tab" aria-selected={l === locale} onClick={() => { setLocale(l); setAck(false) }}
              className={cx('rounded-[10px] border px-3 py-1.5 text-left text-[12px]', l === locale ? 'border-[#171717] bg-white' : 'border-black/[0.12] bg-[#FAFAF8] hover:bg-white')}>
              <span className="font-medium">{langName(l)}</span>
              <span className="ml-2 text-[11px] text-[#6B6B66]">{c ? `${c.translated}/${c.total}` : ''}{c && c.stale ? ` · ${c.stale} out of date` : ''}</span>
            </button>
          )
        })}
      </div>

      {comp && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-black/[0.10] bg-white p-3">
          <div className="text-[12px]">
            <StatusBadge status={comp.complete ? 'Ready' : comp.translated > 0 ? 'Partial' : 'Incomplete'} label={comp.complete ? 'Complete' : comp.translated > 0 ? 'Partly translated' : 'Not translated'} />
            <span className="ml-2 text-[#6B6B66]">{comp.translated} of {comp.total} published · {comp.stale} out of date · {comp.missing} missing. Anything missing shows in English.</span>
          </div>
          {!perFieldPublish && (
            <div className="flex flex-wrap items-center gap-2">
              {ov.legal && <label className="flex items-center gap-1.5 text-[11px] text-[#92400E]"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} className="accent-[#171717]" /> I have had this legal translation checked</label>}
              <AdminButton size="sm" variant="primary" loading={busy === 'lang'} disabled={ov.legal && !ack} onClick={() => langAction('publish-locale')}>Publish {langName(locale)}</AdminButton>
              <AdminButton size="sm" onClick={() => langAction('unpublish-locale')}>Unpublish</AdminButton>
            </div>
          )}
        </div>
      )}
      {ov.legal && <AdminNotice tone="warning">Legal pages are not auto-published in other languages. A person must review the translation, then tick the box and publish the language.</AdminNotice>}
      <ErrorNotice result={last} title="That translation was not saved." />
      {last?.ok && <InvalidationNotice result={last.invalidation} />}

      <ul className="space-y-3">
        {fields.map(f => {
          const row = rowsFor.get(key(f))
          const src = ov.source[f]
          const stale = !!row && row.source_hash !== sourceHash(src)
          const val = current(f)
          const dirty = drafts[key(f)] !== undefined
          const status = row?.status
          return (
            <li key={f} className="rounded-[12px] border border-black/[0.10] bg-white p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#4A4A46]">{fieldLabel(f)}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {row?.machine_generated && <StatusBadge status="Review" label="Machine translated" />}
                  {stale && <StatusBadge status="Incomplete" label="English changed" />}
                  {status === 'published' && !stale && <StatusBadge status="Live" label="Published" />}
                  {status === 'needs_review' && <StatusBadge status="Review" label="Needs review" />}
                  {status === 'draft' && <StatusBadge status="Draft" />}
                  {!row && <StatusBadge status="Pending" label="Missing" />}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">English</p>
                  {isRich(src)
                    ? <div className="max-h-56 overflow-auto rounded-[10px] bg-[#FAFAF8] p-2 text-[12px] text-[#4A4A46]">{plain(src)}</div>
                    : <p className="whitespace-pre-wrap rounded-[10px] bg-[#FAFAF8] p-2 text-[12px] text-[#4A4A46]">{src}</p>}
                </div>
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">{langName(locale)}</p>
                  {isRich(src)
                    ? <RichTextEditor value={parseRich(val)} onChange={d => setDrafts(x => ({ ...x, [key(f)]: JSON.stringify(d) }))} label="Translation" compact={false} allowMedia blockChoices={undefined} />
                    : src.length > 90 || src.includes('\n')
                      ? <textarea aria-label={`${fieldLabel(f)} in ${langName(locale)}`} rows={3} value={val} onChange={e => setDrafts(x => ({ ...x, [key(f)]: e.target.value }))} className={textareaClass} />
                      : <input aria-label={`${fieldLabel(f)} in ${langName(locale)}`} value={val} onChange={e => setDrafts(x => ({ ...x, [key(f)]: e.target.value }))} className={adminInputClass} />}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <AdminButton size="sm" disabled={!dirty} loading={busy === f} onClick={() => save(f, 'draft')}>Save draft</AdminButton>
                <AdminButton size="sm" disabled={!dirty && status !== 'draft'} loading={busy === f} onClick={() => save(f, 'needs_review')}>Mark needs review</AdminButton>
                {perFieldPublish && <AdminButton size="sm" variant="primary" disabled={(!dirty && status === 'published') || !val.trim() || !!row?.machine_generated} loading={busy === f} onClick={() => save(f, 'published')}>Publish</AdminButton>}
                {row && <AdminButton size="sm" variant="ghost" onClick={async () => { setBusy(f); const r = await api('DELETE', `${base}?locale=${locale}&field=${encodeURIComponent(f)}`); setBusy(null); setLast(r); if (r.ok) load() }}>Clear</AdminButton>}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function plain(json: string): string {
  try {
    const d = JSON.parse(json) as RichText
    const t = (c: any[]) => c.map(n => n.text).join('')
    return d.blocks.map((b: any) => b.c ? t(b.c) : b.items ? b.items.map((i: any) => Array.isArray(i) ? '• ' + t(i) : '').join('\n') : b.t === 'hr' ? '—' : '').filter(Boolean).join('\n\n')
  } catch { return json }
}
