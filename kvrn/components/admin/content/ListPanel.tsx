'use client'
// List of every item of one content kind, with search, a status filter and "New".

import { useCallback, useEffect, useState } from 'react'
import { AdminButton, AdminEmpty, AdminError, AdminLoading, AdminTable, AdminTr, AdminTh, AdminTd, adminInputClass } from '@/components/admin/ui/AdminUI'
import { api, BASE, type Kind } from './api'
import { entityStatusBadge } from './ui'

interface Row {
  id: string; status: string; slug: string | null; title: string; hasDraft: boolean; isLive: boolean
  updatedAt: string; updatedBy: string | null; extra?: { productCount?: number; usageCount?: number }
}

const NOUN: Partial<Record<Kind, string>> = { policies: 'policy', 'size-guides': 'size guide', blocks: 'content block', pages: 'page' }
const FILTERS = [
  { value: '', label: 'All' }, { value: 'published', label: 'Live' }, { value: 'draft', label: 'Draft' },
  { value: 'unpublished', label: 'Unpublished' }, { value: 'archived', label: 'Archived' },
]

export function ListPanel({ kind, onOpen, refreshKey }: { kind: Kind; onOpen: (id: string) => void; refreshKey: number }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (status) params.set('status', status)
    const r = await api<Row[]>('GET', `${BASE}/${kind}?${params}`)
    if (!r.ok) { setErr(r.error ?? 'Could not load the list.'); return }
    setErr(null); setRows(r.data!)
  }, [kind, q, status])

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q, refreshKey])

  const noun = NOUN[kind] ?? 'item'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[180px] flex-1 text-[11px] text-[#6B6B66]">
          <span className="sr-only">Search</span>
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${noun}s…`} className={adminInputClass} />
        </label>
        <label className="text-[11px] text-[#6B6B66]">
          <span className="sr-only">Status</span>
          <select value={status} onChange={e => setStatus(e.target.value)} className={adminInputClass} aria-label="Filter by status">
            {FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <AdminButton variant="primary" onClick={() => onOpen('new')}>New {noun}</AdminButton>
      </div>

      {err && <AdminError message={err} onRetry={load} />}
      {!err && rows === null && <AdminLoading />}
      {rows && rows.length === 0 && (
        <AdminEmpty title={q || status ? 'Nothing matches.' : `No ${noun}s yet.`} description={q || status ? 'Try a different search or filter.' : `Create the first ${noun} to get started.`}
          action={!q && !status ? <AdminButton variant="primary" onClick={() => onOpen('new')}>New {noun}</AdminButton> : undefined} />
      )}
      {rows && rows.length > 0 && (
        <AdminTable stack caption={`${noun}s`}>
          <thead><AdminTr>
            <AdminTh>Name</AdminTh><AdminTh>Status</AdminTh>
            {kind === 'size-guides' && <AdminTh>Products</AdminTh>}
            {kind === 'blocks' && <AdminTh>Used on</AdminTh>}
            <AdminTh>Updated</AdminTh>
          </AdminTr></thead>
          <tbody>
            {rows.map(r => (
              <AdminTr key={r.id} className="hover:bg-black/[0.02]">
                <AdminTd className="max-sm:!block max-sm:!text-left">
                  <button type="button" onClick={() => onOpen(r.id)} className="text-left font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40">
                    {r.title || '(untitled)'}
                  </button>
                  {r.slug && <div className="text-[11px] text-[#8A8A85]">/{r.slug}</div>}
                </AdminTd>
                <AdminTd label="Status">{entityStatusBadge(r.status, r.hasDraft, r.isLive)}</AdminTd>
                {kind === 'size-guides' && <AdminTd label="Products">{r.extra?.productCount ?? 0}</AdminTd>}
                {kind === 'blocks' && <AdminTd label="Used on">{r.extra?.usageCount ?? 0} page{(r.extra?.usageCount ?? 0) === 1 ? '' : 's'}</AdminTd>}
                <AdminTd label="Updated" className="whitespace-nowrap text-[#6B6B66]">{new Date(r.updatedAt).toLocaleDateString()}</AdminTd>
              </AdminTr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </div>
  )
}
