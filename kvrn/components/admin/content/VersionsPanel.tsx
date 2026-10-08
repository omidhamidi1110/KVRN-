'use client'
// Version history with preview and rollback. Rolling back publishes a NEW version that carries
// the older content, so history is never rewritten.

import { useCallback, useEffect, useState } from 'react'
import { AdminButton, AdminLoading, AdminError, AdminTable, AdminTh, AdminTd, StatusBadge, AdminNotice, useConfirm } from '@/components/admin/ui/AdminUI'
import { api, BASE, type ApiResult } from './api'
import { ErrorNotice, InvalidationNotice } from './ui'
import { RichPreview } from './RichTextEditor'
import { translatableFields } from '@/lib/content-schemas'
import type { Kind } from './api'

interface V { version_no: number; state: string; change_note: string | null; rolled_back_from: number | null; created_by: string | null; created_at: string; published_by: string | null; published_at: string | null }
const STATE: Record<string, [any, string]> = { published: ['Live', 'Live'], draft: ['Draft', 'Draft'], superseded: ['Archived', 'Earlier'], scheduled: ['Scheduled', 'Scheduled'] }
const when = (s: string | null) => s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'

export function VersionsPanel({ kind, id, revision, onRolledBack }: { kind: Kind; id: string; revision: number; onRolledBack: () => void }) {
  const [rows, setRows] = useState<V[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [view, setView] = useState<{ no: number; snapshot: any } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [last, setLast] = useState<ApiResult | null>(null)
  const { confirm, node } = useConfirm()
  const url = `${BASE}/${kind}/${id}/versions`

  const load = useCallback(async () => {
    const r = await api<V[]>('GET', url)
    if (!r.ok) setErr(r.error ?? 'Could not load versions.'); else { setErr(null); setRows(r.data!) }
  }, [url])
  useEffect(() => { load() }, [load])

  async function open(no: number) {
    const r = await api('GET', `${url}?version=${no}`)
    if (r.ok) setView({ no, snapshot: r.data.snapshot }); else setLast(r)
  }
  async function rollback(no: number) {
    if (!(await confirm(`Publish version ${no} again as the live version? The current live version stays in the history.`))) return
    setBusy(no)
    const r = await api('POST', `${BASE}/${kind}/${id}`, { action: 'rollback', versionNo: no, revision })
    setBusy(null); setLast(r)
    if (r.ok) { setView(null); load(); onRolledBack() }
  }

  if (err) return <AdminError message={err} onRetry={load} />
  if (!rows) return <AdminLoading label="Loading history…" />
  return (
    <div className="space-y-3">
      {node}
      <ErrorNotice result={last} title="Could not restore that version." />
      {last?.ok && <><AdminNotice tone="success">Restored. It is now the live version.</AdminNotice><InvalidationNotice result={last.invalidation} /></>}
      <AdminTable caption="Version history">
        <thead><tr><AdminTh>Version</AdminTh><AdminTh>State</AdminTh><AdminTh>Saved</AdminTh><AdminTh>By</AdminTh><AdminTh>Note</AdminTh><AdminTh /></tr></thead>
        <tbody>
          {rows.map(v => {
            const [st, lbl] = STATE[v.state] ?? ['Unknown', v.state]
            return (
              <tr key={v.version_no}>
                <AdminTd>v{v.version_no}</AdminTd>
                <AdminTd><StatusBadge status={st} label={lbl} /></AdminTd>
                <AdminTd>{when(v.published_at ?? v.created_at)}</AdminTd>
                <AdminTd>{v.published_by ?? v.created_by ?? '—'}</AdminTd>
                <AdminTd>{v.rolled_back_from ? `Restored from v${v.rolled_back_from}` : (v.change_note ?? '')}</AdminTd>
                <AdminTd className="whitespace-nowrap text-right">
                  <AdminButton size="sm" variant="ghost" onClick={() => open(v.version_no)}>View</AdminButton>
                  {v.state !== 'published' && v.state !== 'draft' && <AdminButton size="sm" loading={busy === v.version_no} onClick={() => rollback(v.version_no)}>Restore</AdminButton>}
                </AdminTd>
              </tr>
            )
          })}
        </tbody>
      </AdminTable>
      {view && (
        <div className="rounded-[12px] border border-black/[0.10] bg-white p-3">
          <div className="mb-2 flex items-center justify-between"><p className="text-[12px] font-medium">Version {view.no} (read-only)</p><AdminButton size="sm" variant="ghost" onClick={() => setView(null)}>Close</AdminButton></div>
          <SnapshotView kind={kind} snapshot={view.snapshot} />
        </div>
      )}
    </div>
  )
}

function SnapshotView({ kind, snapshot }: { kind: Kind; snapshot: any }) {
  const body = snapshot?.body ?? snapshot?.content
  if (body?.blocks) return <RichPreview doc={body} variant="plain" />
  const fields = translatableFields(kind, snapshot)
  return (
    <dl className="space-y-2 text-[12px]">
      {Object.entries(fields).slice(0, 40).map(([k, v]) => (
        <div key={k}><dt className="text-[10px] uppercase tracking-[0.08em] text-[#8A8A85]">{k}</dt><dd className="whitespace-pre-wrap text-[#171717]">{v.startsWith('{"v":1') ? '(formatted text)' : v}</dd></div>
      ))}
    </dl>
  )
}
