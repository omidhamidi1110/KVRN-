'use client'
// app/admin/financials/integrity/IntegrityClient.tsx
//
// Every figure here is derived live from the authoritative rows by the SQL scan.
// RECONCILED means "checked and clean", INCOMPLETE means "a required fact is
// unknown" (never treated as zero), EXCEPTION means "the data contradicts an
// invariant". Advisories are disclosed assumptions and never change a state.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { FONT, BORDER, SectionTitle } from '@/components/admin/FinancialUI'

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

const TONE: Record<string, { bg: string; bd: string; fg: string }> = {
  EXCEPTION:  { bg: '#FEF2F2', bd: '#FECACA', fg: '#B91C1C' },
  exception:  { bg: '#FEF2F2', bd: '#FECACA', fg: '#B91C1C' },
  INCOMPLETE: { bg: '#FFFBEB', bd: '#FDE68A', fg: '#92400E' },
  incomplete: { bg: '#FFFBEB', bd: '#FDE68A', fg: '#92400E' },
  RECONCILED: { bg: '#F0FDF4', bd: '#BBF7D0', fg: '#166534' },
  advisory:   { bg: '#F9FAFB', bd: '#E5E7EB', fg: '#6B7280' },
}

const RESOLUTION: Record<string, string> = {
  automatic: 'Automatic',
  manual_data: 'Manual — supply data',
  manual_review: 'Manual — investigate',
}

function Pill({ kind, children }: { kind: string; children: React.ReactNode }) {
  const c = TONE[kind] ?? TONE.advisory
  return (
    <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
                   padding: '3px 8px', background: c.bg, border: `1px solid ${c.bd}`, color: c.fg,
                   whiteSpace: 'nowrap' }}>
      {children}
    </span>
  )
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
    <div style={{ fontSize: 11, color: '#4B5563', lineHeight: 1.6 }}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <span style={{ color: '#9CA3AF' }}>{k.replace(/_/g, ' ')}: </span>
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

  const domains = summary ? [...new Set(summary.byIssue.map(i => i.domain))].sort() : []
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

  return (
    <div style={{ fontFamily: FONT, color: '#111827', padding: '24px 28px', maxWidth: 1280 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Reconciliation</h1>
          <p style={{ fontSize: 13, color: '#6B7280', margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5 }}>
            Every money path is re-checked from the source rows each time. <b>Reconciled</b> means
            checked and clean; <b>Incomplete</b> means a required fact is unknown (never counted as
            zero); <b>Exception</b> means the data contradicts an invariant.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={load} disabled={loading}
                  style={{ padding: '8px 14px', border: BORDER, background: '#fff', cursor: 'pointer', fontSize: 12 }}>
            Re-check now
          </button>
          <button onClick={recordRun} disabled={running}
                  style={{ padding: '8px 14px', border: '1px solid #111827', background: '#111827', color: '#fff', cursor: 'pointer', fontSize: 12 }}>
            {running ? 'Recording…' : 'Record run to history'}
          </button>
          <a href={`/api/admin/financials/integrity/export?${query()}`}
             style={{ padding: '8px 14px', border: BORDER, background: '#fff', fontSize: 12, color: '#111827', textDecoration: 'none' }}>
            Export CSV
          </a>
        </div>
      </div>

      {err && <div role="alert" style={{ marginTop: 16, padding: 12, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', fontSize: 13 }}>{err}</div>}
      {notice && <div style={{ marginTop: 16, padding: 12, background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#166534', fontSize: 13 }}>{notice}</div>}

      {summary && (
        <>
          <div style={{ marginTop: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill kind={summary.overall}>{summary.overall}</Pill>
            <span style={{ fontSize: 12, color: '#6B7280' }}>
              Checked {when(summary.scannedAt)} · last recorded run {when(summary.lastRecordedRunAt)}
            </span>
          </div>

          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            {[
              ['Entities checked', summary.entities.total, '#111827'],
              ['Reconciled', summary.entities.reconciled, '#166534'],
              ['Incomplete', summary.entities.incomplete, '#92400E'],
              ['Exception', summary.entities.exception, '#B91C1C'],
              ['Advisories', summary.findings.advisory, '#6B7280'],
            ].map(([label, n, color]) => (
              <div key={label as string} style={{ border: BORDER, padding: 14, background: '#fff' }}>
                <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9CA3AF' }}>{label}</div>
                <div style={{ fontSize: 24, fontWeight: 600, color: color as string, marginTop: 4 }}>{n as number}</div>
              </div>
            ))}
          </div>

          <SectionTitle note="Entities with no finding are reconciled.">By entity type</SectionTitle>
          <div style={{ overflowX: 'auto', border: BORDER, background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ textAlign: 'left', color: '#6B7280' }}>
                {['Type', 'Total', 'Reconciled', 'Incomplete', 'Exception'].map(h =>
                  <th key={h} style={{ padding: '9px 12px', fontWeight: 500 }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {summary.byType.map(t => (
                  <tr key={t.entityType} style={{ borderTop: BORDER }}>
                    <td style={{ padding: '9px 12px' }}>{t.entityType.replace(/_/g, ' ')}</td>
                    <td style={{ padding: '9px 12px' }}>{t.total}</td>
                    <td style={{ padding: '9px 12px', color: '#166534' }}>{t.reconciled}</td>
                    <td style={{ padding: '9px 12px', color: t.incomplete ? '#92400E' : undefined }}>{t.incomplete}</td>
                    <td style={{ padding: '9px 12px', color: t.exception ? '#B91C1C' : undefined }}>{t.exception}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SectionTitle>Findings</SectionTitle>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <select aria-label="State" value={state} onChange={e => setState(e.target.value as any)}
                style={{ padding: '6px 10px', border: BORDER, fontSize: 12 }}>
          <option value="">All states</option>
          <option value="exception">Exception</option>
          <option value="incomplete">Incomplete</option>
          <option value="advisory">Advisory</option>
        </select>
        <select aria-label="Domain" value={domain} onChange={e => setDomain(e.target.value)}
                style={{ padding: '6px 10px', border: BORDER, fontSize: 12 }}>
          <option value="">All domains</option>
          {domains.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {loading ? <p style={{ fontSize: 13, color: '#6B7280' }}>Checking…</p>
        : findings.length === 0 ? (
          <p style={{ fontSize: 13, color: '#166534' }}>No findings for this filter.</p>
        ) : (
          <div style={{ overflowX: 'auto', border: BORDER, background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ textAlign: 'left', color: '#6B7280' }}>
                {['State', 'Issue', 'Entity', 'Why', 'Evidence', 'Resolution', 'First seen', ''].map(h =>
                  <th key={h} style={{ padding: '9px 12px', fontWeight: 500 }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {findings.map(f => (
                  <tr key={f.fingerprint} style={{ borderTop: BORDER, verticalAlign: 'top' }}>
                    <td style={{ padding: '9px 12px' }}><Pill kind={f.state}>{f.state}</Pill></td>
                    <td style={{ padding: '9px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{f.issueCode}</td>
                    <td style={{ padding: '9px 12px' }}>
                      <div>{f.entityLabel ?? f.entityId}</div>
                      <div style={{ color: '#9CA3AF', fontSize: 10 }}>{f.entityType.replace(/_/g, ' ')}</div>
                    </td>
                    <td style={{ padding: '9px 12px', maxWidth: 320 }}>{f.summary}</td>
                    <td style={{ padding: '9px 12px', maxWidth: 280 }}><Evidence ev={f.evidence} /></td>
                    <td style={{ padding: '9px 12px' }}>{RESOLUTION[f.resolution] ?? f.resolution}</td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{f.detectedAt ? when(f.detectedAt) : 'not recorded yet'}</td>
                    <td style={{ padding: '9px 12px' }}>
                      {f.actionPath && <Link href={f.actionPath} style={{ color: '#1D4ED8' }}>Open</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
