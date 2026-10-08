'use client'
// app/admin/financials/integrity/IntegrityClient.tsx
//
// Every figure here is derived live from the source rows by the SQL scan.
// RECONCILED means "checked and clean", INCOMPLETE means "a required fact is
// unknown" (never treated as zero), EXCEPTION means "the data contradicts an
// invariant". Advisories are disclosed assumptions and never change a state.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminNotice, AdminButton, AdminStat, AdminStatGrid,
  AdminTable, AdminTh, AdminTd, AdminLoading, AdminEmpty, AdminTag, StatusBadge,
  adminButtonClass, adminSelectClass,
} from '@/components/admin/ui/AdminUI'

type State = 'exception' | 'incomplete' | 'advisory'
type Finding = {
  fingerprint: string; issueCode: string; state: State; domain: string
  entityType: string; entityId: string; entityLabel: string | null; orderId: string | null
  summary: string; evidence: Record<string, unknown>
  resolution: 'automatic' | 'manual_data' | 'manual_review'
  actionPath: string | null; detectedAt: string | null
}
type Summary = {
  scannedAt: string; lastRecordedRunAt: string | null
  entities: { total: number; reconciled: number; incomplete: number; exception: number }
  findings: { exception: number; incomplete: number; advisory: number }
  overall: 'RECONCILED' | 'INCOMPLETE' | 'EXCEPTION'
  byType: Array<{ entityType: string; total: number; reconciled: number; incomplete: number; exception: number }>
  byIssue: Array<{ issueCode: string; state: State; domain: string; resolution: string; count: number }>
}

const RESOLUTION: Record<string, string> = {
  automatic: 'Automatic',
  manual_data: 'Manual — supply data',
  manual_review: 'Manual — investigate',
}

/** Overall / per-finding state shown with the fixed status words. */
function StatePill({ kind }: { kind: string }) {
  switch (kind.toLowerCase()) {
    case 'exception':  return <StatusBadge status="Exception" />
    case 'incomplete': return <StatusBadge status="Incomplete" />
    case 'reconciled': return <StatusBadge status="Reconciled" />
    default:           return <AdminTag>{kind}</AdminTag>
  }
}

/** Cents are shown exactly as stored; a missing value is shown as unknown, never $0. */
function fmtCents(v: unknown): string {
  if (v === null || v === undefined) return 'unknown'
  if (typeof v !== 'number') return String(v)
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  return `${sign}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`
}

function Evidence({ ev }: { ev: Record<string, unknown> }) {
  const entries = Object.entries(ev)
  if (entries.length === 0) return null
  return (
    <div className="text-[11px] leading-[1.6] text-[#4A4A46]">
      {entries.map(([k, v]) => (
        <div key={k} className="break-words">
          <span className="text-[#8A8A85]">{k.replace(/_/g, ' ')}: </span>
          {k.endsWith('_cents') ? fmtCents(v)
            : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? 'none')}
        </div>
      ))}
    </div>
  )
}

export function IntegrityClient() {
  const [summary, setSummary]   = useState<Summary | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [state, setState]       = useState<'' | State>('')
  const [domain, setDomain]     = useState('')
  const [loading, setLoading]   = useState(true)
  const [running, setRunning]   = useState(false)
  const [err, setErr]           = useState<string | null>(null)
  const [notice, setNotice]     = useState<string | null>(null)

  const query = useCallback(() => {
    const p = new URLSearchParams()
    if (state) p.set('state', state)
    if (domain) p.set('domain', domain)
    return p.toString()
  }, [state, domain])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res  = await fetch(`/api/admin/financials/integrity?${query()}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setSummary(json.summary); setFindings(json.findings)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [query])

  useEffect(() => { load() }, [load])

  async function recordRun() {
    setRunning(true); setNotice(null); setErr(null)
    try {
      const res  = await fetch('/api/admin/financials/integrity', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Run failed')
      const r = json.run
      setNotice(`Recorded: ${r.new_count} new, ${r.changed_count} changed, ${r.resolved_count} resolved.`)
      await load()
    } catch (e: any) { setErr(e.message) }
    finally { setRunning(false) }
  }

  const thisYear = new Date().getUTCFullYear()
  const taxYears = [thisYear, thisYear - 1, thisYear - 2].map(String)
  const [taxYear, setTaxYear] = useState(taxYears[0])

  const domains = summary ? [...new Set(summary.byIssue.map(i => i.domain))].sort() : []
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

  const stateInfo = (
    <>
      <p><strong className="font-medium">Reconciled</strong>: checked and clean.</p>
      <p className="mt-1.5"><strong className="font-medium">Incomplete</strong>: a required fact is unknown. It is never counted as zero.</p>
      <p className="mt-1.5"><strong className="font-medium">Exception</strong>: the data contradicts an invariant.</p>
      <p className="mt-1.5">Advisories are disclosed assumptions and never change a state.</p>
    </>
  )

  return (
    <AdminPage>
      <AdminPageHeader
        title="Reconciliation"
        description="Money checks against source records."
        info={<><p>Every money path is re-checked from the source rows each time.</p><div className="mt-2">{stateInfo}</div></>}
        actions={
          <>
            <AdminButton onClick={load} disabled={loading}>Re-check now</AdminButton>
            <AdminButton variant="primary" onClick={recordRun} loading={running}>Record run to history</AdminButton>
            <a href={`/api/admin/financials/integrity/export?${query()}`} className={adminButtonClass('secondary', 'md')}>
              Export CSV
            </a>
            {/* Tax-year bookkeeping summary: not a tax return. Server validates the year. */}
            <span className="inline-flex items-center gap-1.5">
              <select value={taxYear} onChange={e => setTaxYear(e.target.value)}
                      aria-label="Tax year" className={`${adminSelectClass} !w-auto`}>
                {taxYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <a href={`/api/admin/financials/tax-export?year=${encodeURIComponent(taxYear)}`}
                 className={adminButtonClass('secondary', 'md')}>
                Tax summary CSV
              </a>
            </span>
          </>
        }
      />

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {notice && <AdminNotice tone="success" className="mb-4">{notice}</AdminNotice>}

      {summary && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <StatePill kind={summary.overall} />
            <span className="text-[12px] text-[#6B6B66]">
              Checked {when(summary.scannedAt)} · last recorded run {when(summary.lastRecordedRunAt)}
            </span>
          </div>

          <AdminStatGrid min={150} className="mb-7">
            <AdminStat label="Entities checked" value={summary.entities.total} />
            <AdminStat label="Reconciled" value={summary.entities.reconciled} tone="positive"
              info="Checked and clean." />
            <AdminStat label="Incomplete" value={summary.entities.incomplete}
              tone={summary.entities.incomplete > 0 ? 'warning' : 'default'}
              info="A required fact is unknown. It is never counted as zero." />
            <AdminStat label="Exception" value={summary.entities.exception}
              tone={summary.entities.exception > 0 ? 'negative' : 'default'}
              info="The data contradicts an invariant." />
            <AdminStat label="Advisories" value={summary.findings.advisory} tone="muted"
              info="Disclosed assumptions. They never change a state." />
          </AdminStatGrid>

          <AdminSectionHeader title="By entity type" description="Entities with no finding are reconciled." />
          <div className="mb-7">
            <AdminTable minWidth={520} caption="Reconciliation by entity type">
              <thead><tr>
                {['Type', 'Total', 'Reconciled', 'Incomplete', 'Exception'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {summary.byType.map(t => (
                  <tr key={t.entityType}>
                    <AdminTd>{t.entityType.replace(/_/g, ' ')}</AdminTd>
                    <AdminTd>{t.total}</AdminTd>
                    <AdminTd className="text-[#166534]">{t.reconciled}</AdminTd>
                    <AdminTd className={t.incomplete ? 'font-medium text-[#92400E]' : 'text-[#6B6B66]'}>{t.incomplete}</AdminTd>
                    <AdminTd className={t.exception ? 'font-medium text-[#B91C1C]' : 'text-[#6B6B66]'}>{t.exception}</AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </div>
        </>
      )}

      <AdminSectionHeader title="Findings" />
      <div className="mb-3 flex flex-wrap gap-2">
        <select aria-label="State" value={state} onChange={e => setState(e.target.value as any)}
                className={`${adminSelectClass} !w-auto`}>
          <option value="">All states</option>
          <option value="exception">Exception</option>
          <option value="incomplete">Incomplete</option>
          <option value="advisory">Advisory</option>
        </select>
        <select aria-label="Domain" value={domain} onChange={e => setDomain(e.target.value)}
                className={`${adminSelectClass} !w-auto`}>
          <option value="">All domains</option>
          {domains.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {loading ? <AdminLoading label="Checking…" />
        : findings.length === 0 ? (
          <AdminEmpty title="No findings for this filter." />
        ) : (
          <AdminTable minWidth={960} caption="Reconciliation findings">
            <thead><tr>
              {['State', 'Issue', 'Entity', 'Why', 'Evidence', 'Resolution', 'First seen'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              <AdminTh><span className="sr-only">Open</span></AdminTh>
            </tr></thead>
            <tbody>
              {findings.map(f => (
                <tr key={f.fingerprint}>
                  <AdminTd><StatePill kind={f.state} /></AdminTd>
                  <AdminTd className="font-mono text-[11px]">{f.issueCode}</AdminTd>
                  <AdminTd>
                    <div>{f.entityLabel ?? f.entityId}</div>
                    <div className="text-[11px] text-[#8A8A85]">{f.entityType.replace(/_/g, ' ')}</div>
                  </AdminTd>
                  <AdminTd className="max-w-[320px]">{f.summary}</AdminTd>
                  <AdminTd className="max-w-[280px]"><Evidence ev={f.evidence} /></AdminTd>
                  <AdminTd>{RESOLUTION[f.resolution] ?? f.resolution}</AdminTd>
                  <AdminTd className="whitespace-nowrap">{f.detectedAt ? when(f.detectedAt) : 'not recorded yet'}</AdminTd>
                  <AdminTd>
                    {f.actionPath && <Link href={f.actionPath} className="font-medium text-[#1D4ED8] underline underline-offset-2">Open</Link>}
                  </AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
    </AdminPage>
  )
}
