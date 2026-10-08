'use client'
import { useState } from 'react'
import { AdminCard, AdminSectionHeader, AdminButton, AdminNotice, AdminField, StatusBadge, adminInputClass, InfoTip } from '@/components/admin/ui/AdminUI'
import { type EditorState, type Issue, type TabId, tabForField, IssueList } from '../editor-shared'

export type Act = 'publish' | 'unpublish' | 'archive' | 'restore' | 'duplicate' | 'schedule' | 'clear-schedule'

const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }

export function PublishingSection({ state, blockers, warnings, busy, saving, onAct, onJump, publishedSlug }: {
  state: EditorState; blockers: Issue[]; warnings: Issue[]; busy: boolean; saving: boolean
  onAct: (a: Act, extra?: { publishAt?: string | null; unpublishAt?: string | null }) => void
  onJump: (t: TabId) => void; publishedSlug: string | null
}) {
  const [pubAt, setPubAt] = useState(toLocalInput(state.publishAt))
  const [unpubAt, setUnpubAt] = useState(toLocalInput(state.unpublishAt))
  const live = state.status === 'published'
  const archived = state.status === 'archived'
  const scheduled = state.status === 'scheduled'
  const overdue = scheduled && state.publishAt && new Date(state.publishAt).getTime() <= Date.now()
  const badge = archived ? 'Archived' : scheduled ? 'Scheduled' : live ? 'Live' : 'Draft'
  const iso = (v: string) => (v ? new Date(v).toISOString() : null)
  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Publishing" actions={<StatusBadge status={badge} />}
          info="Publishing makes the saved draft live in one step: content, price and sizes change together or not at all." />
        {live && publishedSlug && <p className="mb-3 text-[12px]"><a className="underline underline-offset-2" href={`/products/${publishedSlug}`} target="_blank" rel="noreferrer">View live page</a></p>}
        {state.hasDraft && live && <AdminNotice tone="info" className="mb-3">You have changes that are not live yet.</AdminNotice>}
        {overdue && <AdminNotice tone="danger" title="Scheduled time has passed" className="mb-3">It hasn’t gone live. Check the list below, fix it, then publish now.</AdminNotice>}
        {blockers.length > 0 ? (
          <AdminNotice tone="danger" title={`Fix ${blockers.length} ${blockers.length === 1 ? 'thing' : 'things'} before publishing`} className="mb-3">
            <ul className="mt-1 space-y-1">
              {blockers.map((b, i) => (
                <li key={`${b.code}-${i}`}><button type="button" className="text-left underline underline-offset-2" onClick={() => onJump(tabForField(b.field))}>{b.message}</button></li>
              ))}
            </ul>
          </AdminNotice>
        ) : !archived && <AdminNotice tone="success" className="mb-3">Ready to publish.</AdminNotice>}
        {warnings.length > 0 && <div className="mb-3"><p className="text-[11px] font-medium text-[#92400E]">Worth a look</p><IssueList issues={warnings} tone="warning" /></div>}
        <div className="flex flex-wrap gap-2">
          {!archived && <AdminButton variant="primary" loading={busy} disabled={busy || saving || blockers.length > 0} onClick={() => onAct('publish')}>{live ? 'Publish changes' : 'Publish now'}</AdminButton>}
          {live && <AdminButton disabled={busy} onClick={() => onAct('unpublish')}>Unpublish</AdminButton>}
          {!archived && <AdminButton variant="danger" disabled={busy} onClick={() => onAct('archive')}>Archive</AdminButton>}
          {archived && <AdminButton variant="primary" disabled={busy} onClick={() => onAct('restore')}>Restore</AdminButton>}
          <AdminButton disabled={busy} onClick={() => onAct('duplicate')}>Duplicate</AdminButton>
        </div>
      </AdminCard>

      {!archived && (
        <AdminCard>
          <AdminSectionHeader title="Schedule" description="Go live or come down at a set time."
            info="Times use your browser’s time zone. A scheduled product must pass the same checks as publishing now; if something breaks before then it stays scheduled and shows as overdue." />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {!live && (
              <AdminField label="Publish at" htmlFor="sch-pub">
                <input id="sch-pub" type="datetime-local" className={adminInputClass} value={pubAt} onChange={e => setPubAt(e.target.value)} />
              </AdminField>
            )}
            <AdminField label="Unpublish at (optional)" htmlFor="sch-unpub">
              <input id="sch-unpub" type="datetime-local" className={adminInputClass} value={unpubAt} onChange={e => setUnpubAt(e.target.value)} />
            </AdminField>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <AdminButton disabled={busy || saving || (!live && !pubAt) || (live && !unpubAt)} onClick={() => onAct('schedule', { publishAt: live ? null : iso(pubAt), unpublishAt: iso(unpubAt) })}>Save schedule</AdminButton>
            {(state.publishAt || state.unpublishAt) && <AdminButton variant="ghost" disabled={busy} onClick={() => { setPubAt(''); setUnpubAt(''); onAct('clear-schedule') }}>Clear schedule</AdminButton>}
          </div>
          {(state.publishAt || state.unpublishAt) && (
            <p className="mt-2 text-[11px] text-[#6B6B66]">
              {state.publishAt && <>Publishes {new Date(state.publishAt).toLocaleString()}. </>}
              {state.unpublishAt && <>Unpublishes {new Date(state.unpublishAt).toLocaleString()}.</>}
              <InfoTip label="About schedules">Past orders are never changed when a scheduled publish applies a new price.</InfoTip>
            </p>
          )}
        </AdminCard>
      )}
    </div>
  )
}
