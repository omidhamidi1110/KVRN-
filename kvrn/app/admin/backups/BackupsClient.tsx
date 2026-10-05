'use client'
// app/admin/backups/BackupsClient.tsx
//
// Backup / recovery READINESS, from what an admin has recorded. This page does not create a
// backup, read one, contact Neon, or restore anything - it shows recorded metadata and the age of
// that evidence. Every status word comes from lib/backup-records.ts so the page cannot be friendlier
// than the evidence: unknown is never green, and a missing value is a dash, never zero.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FONT, BORDER, SectionTitle } from '@/components/admin/FinancialUI'
import {
  BACKUP_TYPES, BACKUP_TYPE_LABEL, DRILL_RESULTS, VERIFICATION_RESULTS,
  OVERALL_LABEL, BACKUP_LABEL, VERIFICATION_LABEL, DRILL_LABEL, LIMITS,
  type BackupDashboard, type BackupType, type EvidenceState, type OverallState,
  type DrillResult, type VerificationResult,
} from '@/lib/backup-records'

// ── presentation helpers ─────────────────────────────────────────────────────

const TONE: Record<'good' | 'neutral' | 'warn' | 'bad' | 'unknown', { fg: string; bg: string; bd: string }> = {
  good:    { fg: '#166534', bg: '#F0FDF4', bd: '#BBF7D0' },
  neutral: { fg: '#1E40AF', bg: '#EFF6FF', bd: '#BFDBFE' },
  warn:    { fg: '#92400E', bg: '#FFFBEB', bd: '#FDE68A' },
  bad:     { fg: '#991B1B', bg: '#FEF2F2', bd: '#FECACA' },
  unknown: { fg: '#4B5563', bg: '#F3F4F6', bd: '#D1D5DB' },
}
const evTone = (s: EvidenceState, ok: 'good' | 'neutral') => (s === 'current' ? ok : s === 'stale' ? 'warn' : s === 'failed' ? 'bad' : 'unknown') as keyof typeof TONE
const overallTone = (s: OverallState) => ({ verified: 'good', recorded: 'neutral', stale: 'warn', failed: 'bad', unknown: 'unknown' } as const)[s]

function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  const t = TONE[tone]
  return <span style={{ display: 'inline-block', fontSize: 10, letterSpacing: '0.08em', fontWeight: 600, padding: '3px 8px',
                        color: t.fg, background: t.bg, border: `1px solid ${t.bd}` }}>{children}</span>
}

const utc = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '—')
const ago = (d: number | null) => (d === null ? '' : d < 1 ? 'today' : `${Math.floor(d)} day${Math.floor(d) === 1 ? '' : 's'} ago`)
function bytes(n: number | null) {
  if (n === null) return '—'
  if (n < 1000) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB', 'PB']; let v = n, i = -1
  do { v /= 1000; i++ } while (v >= 1000 && i < u.length - 1)
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]} (${n.toLocaleString()} bytes)`
}
/** A safe label for a backup: its reference, else its type and restore-point date; shortened id as a last resort. */
function backupLabel(backups: BackupDashboard['backups'], id: string) {
  const b = backups.find(x => x.id === id)
  return b ? `${b.reference ?? BACKUP_TYPE_LABEL[b.type]} (${b.backupAt.slice(0, 10)})` : `backup ${id.slice(0, 8)}`
}
const DRILL_RESULT_LABEL: Record<DrillResult, string> = { passed: 'Passed', passed_with_issues: 'Passed with issues', failed: 'Failed' }

const INPUT: React.CSSProperties = { display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', fontSize: 12,
                                     border: BORDER, fontFamily: FONT, background: '#fff', boxSizing: 'border-box' }
const BTN: React.CSSProperties = { fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
                                   padding: '9px 16px', background: '#1A1A1A', color: '#fff', border: 'none', cursor: 'pointer' }
const BTN_GHOST: React.CSSProperties = { ...BTN, background: '#fff', color: '#1A1A1A', border: '1px solid #1A1A1A' }
const th: React.CSSProperties = { textAlign: 'left', padding: '9px 10px', fontSize: 9, letterSpacing: '0.1em',
                                  textTransform: 'uppercase', color: '#9B9B9B', borderBottom: BORDER }
const td: React.CSSProperties = { padding: '9px 10px', fontSize: 12, borderBottom: '1px solid #F1EEE8', verticalAlign: 'top' }

/** datetime-local value (the browser's local time) -> UTC ISO, or '' when empty/invalid. */
const localToIso = (v: string) => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? d.toISOString() : '' }
const nowLocalValue = () => { const d = new Date(); d.setSeconds(0, 0); const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }

function SummaryCard({ title, tone, label, at, age, noTime, children }: {
  title: string; tone: keyof typeof TONE; label: string; at: string | null; age: number | null
  /** The overall card summarises several pieces of evidence, so it has no single time of its own. */
  noTime?: boolean; children?: React.ReactNode
}) {
  return (
    <div style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
      <p style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>{title}</p>
      <p style={{ margin: '8px 0 6px' }}><Badge tone={tone}>{label}</Badge></p>
      {!noTime && <p style={{ fontSize: 12, margin: 0 }}>{at ? utc(at) : 'Nothing recorded'}</p>}
      {!noTime && <p style={{ fontSize: 11, color: '#6B6B6B', margin: '2px 0 0' }}>{at ? ago(age) : 'This is unknown, not zero.'}</p>}
      {children}
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

type Panel = null | 'backup' | 'verify' | 'drill'

export function BackupsClient() {
  const [data, setData] = useState<BackupDashboard | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [panel, setPanel] = useState<Panel>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/backups', { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(json.error ?? 'Could not load backup records.'); return }
      setData(json); setErr(null)
    } catch { setErr('Network error. Backup records could not be loaded.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const after = (msg: string) => { setPanel(null); setNotice(msg); void load() }
  const rd = data?.readiness

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1180, fontFamily: FONT }}>
      <h1 style={{ fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>Backups</h1>
      <p style={{ fontSize: 12, color: '#6B6B6B', margin: '0 0 14px', maxWidth: 760, lineHeight: 1.5 }}>
        Backup and recovery readiness, based on what you have recorded here. KVRN&rsquo;s website cannot run
        <code> pg_dump</code>, cannot see your Neon backups, and cannot restore anything — so this page
        shows only the evidence you enter. No evidence means <strong>unknown</strong>, never healthy.
      </p>
      <div style={{ border: '1px solid #BFDBFE', background: '#EFF6FF', color: '#1E3A8A', fontSize: 12, padding: '10px 14px',
                    marginBottom: 20, lineHeight: 1.5, maxWidth: 760 }}>
        <strong>Recording a backup does not create one.</strong> It saves metadata about a backup you made
        elsewhere. <strong>Verified</strong> means you recorded a restore test as completed.
        <strong> Stale</strong> means the latest evidence is older than the limit shown below.
      </div>

      {err && (
        <div role="alert" style={{ fontSize: 12, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA',
                                   padding: '10px 14px', marginBottom: 16 }}>{err}</div>
      )}
      {notice && (
        <div role="status" style={{ fontSize: 12, color: '#166534', background: '#F0FDF4', border: '1px solid #BBF7D0',
                                    padding: '10px 14px', marginBottom: 16 }}>{notice}</div>
      )}
      {loading && !data && <p role="status" style={{ fontSize: 12, color: '#6B6B6B' }}>Loading…</p>}

      {data && rd && (
        <>
          <SectionTitle note={`Evidence older than its limit is stale: backup ${data.thresholds.backup} days, restore test ${data.thresholds.restoreVerification} days, DR drill ${data.thresholds.drill} days (measured from when the backup, test or drill happened).`}>
            Readiness
          </SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 12, marginBottom: 12 }}>
            <SummaryCard title="Overall readiness" tone={overallTone(rd.overall.state)} label={OVERALL_LABEL[rd.overall.state]}
                         at={null} age={null} noTime>
              <p style={{ fontSize: 11, color: '#6B6B6B', margin: '8px 0 0' }}>See the reasons below.</p>
            </SummaryCard>
            <SummaryCard title="Latest backup recorded" tone={evTone(rd.backup.state, 'neutral')} label={BACKUP_LABEL[rd.backup.state]}
                         at={rd.backup.at} age={rd.backup.ageDays}>
              {rd.backup.type && (
                <p style={{ fontSize: 11, color: '#6B6B6B', margin: '6px 0 0' }}>
                  {BACKUP_TYPE_LABEL[rd.backup.type]} · {rd.backup.verification === 'verified' ? 'this backup was restore-tested'
                    : rd.backup.verification === 'failed' ? 'its restore test FAILED' : 'not yet restore-tested'}
                </p>
              )}
            </SummaryCard>
            <SummaryCard title="Latest restore test" tone={evTone(rd.restoreVerification.state, 'good')}
                         label={VERIFICATION_LABEL[rd.restoreVerification.state]}
                         at={rd.restoreVerification.at} age={rd.restoreVerification.ageDays}>
              {rd.restoreVerification.backupId && (
                <p style={{ fontSize: 11, color: '#6B6B6B', margin: '6px 0 0' }}>
                  Applies to: {backupLabel(data.backups, rd.restoreVerification.backupId)}
                  {rd.restoreVerification.backupId !== rd.backup.backupId && ' (not the latest backup)'}
                </p>
              )}
            </SummaryCard>
            <SummaryCard title="Latest DR drill" tone={evTone(rd.drill.state, 'neutral')} label={DRILL_LABEL[rd.drill.state]}
                         at={rd.drill.at} age={rd.drill.ageDays}>
              {rd.drill.result && <p style={{ fontSize: 11, color: '#6B6B6B', margin: '6px 0 0' }}>Result: {DRILL_RESULT_LABEL[rd.drill.result]}</p>}
            </SummaryCard>
          </div>
          <ul style={{ fontSize: 12, margin: '0 0 22px', paddingLeft: 18, lineHeight: 1.6, maxWidth: 820 }}>
            {rd.overall.reasons.length === 0 && <li>The latest backup has itself been restore-tested (passed), and the restore test and DR drill are recorded, passing and within their limits.</li>}
            {rd.overall.reasons.map(r => <li key={r}>{r}</li>)}
            {rd.overall.notes.map(n => <li key={n} style={{ color: '#6B6B6B' }}>{n}</li>)}
          </ul>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <button style={panel === 'backup' ? BTN_GHOST : BTN} onClick={() => { setNotice(null); setPanel(panel === 'backup' ? null : 'backup') }}>
              {panel === 'backup' ? 'Cancel' : 'Record a backup'}
            </button>
            <button style={panel === 'verify' ? BTN_GHOST : BTN} disabled={data.backups.length === 0}
                    onClick={() => { setNotice(null); setPanel(panel === 'verify' ? null : 'verify') }}>
              {panel === 'verify' ? 'Cancel' : 'Record a restore test'}
            </button>
            <button style={panel === 'drill' ? BTN_GHOST : BTN} onClick={() => { setNotice(null); setPanel(panel === 'drill' ? null : 'drill') }}>
              {panel === 'drill' ? 'Cancel' : 'Record a DR drill'}
            </button>
          </div>

          {panel === 'backup' && <BackupForm onDone={() => after('Backup metadata recorded. No backup was created by this action.')} />}
          {panel === 'verify' && <VerifyForm backups={data.backups} onDone={() => after('Restore test recorded. No restore was performed by this action.')} />}
          {panel === 'drill' && <DrillForm onDone={() => after('DR drill recorded. No recovery step was executed by this action.')} />}

          <SectionTitle note="Newest restore point first. A dash means that detail was not recorded (unknown), not zero.">
            Recorded backups
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Restore point (UTC)', 'Type', 'Reference', 'Size', 'SHA-256', 'Restore test', 'Recorded by'].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {data.backups.length === 0 && (
                  <tr><td colSpan={7} style={{ ...td, color: '#6B6B6B' }}>No backups recorded yet — backup status is unknown.</td></tr>
                )}
                {data.backups.map(b => (
                  <tr key={b.id}>
                    <td style={td}>{utc(b.backupAt)}<div style={{ fontSize: 10, color: '#9B9B9B' }}>typed in {utc(b.recordedAt)}</div></td>
                    <td style={td}>{BACKUP_TYPE_LABEL[b.type]}</td>
                    <td style={td}>{b.reference ?? '—'}{b.notes && <div style={{ fontSize: 11, color: '#6B6B6B' }}>{b.notes}</div>}</td>
                    <td style={td}>{bytes(b.sizeBytes)}</td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 10, wordBreak: 'break-all', maxWidth: 190 }}>{b.sha256 ?? '—'}</td>
                    <td style={td}>
                      {b.verification.state === 'verified' && <><Badge tone="good">VERIFIED</Badge><div style={{ fontSize: 10, color: '#6B6B6B' }}>{utc(b.verification.latest!.verifiedAt)}</div></>}
                      {b.verification.state === 'failed' && <><Badge tone="bad">FAILED</Badge><div style={{ fontSize: 10, color: '#6B6B6B' }}>{utc(b.verification.latest!.verifiedAt)}</div></>}
                      {b.verification.state === 'not_verified' && <Badge tone="unknown">NOT YET VERIFIED</Badge>}
                      {b.verification.latest?.notes && <div style={{ fontSize: 11, color: '#6B6B6B' }}>{b.verification.latest.notes}</div>}
                    </td>
                    <td style={td}>{b.recordedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <SectionTitle note="Drills recorded as completed outside the app. Recording one does not run any recovery step.">DR drill history</SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Drill (UTC)', 'Result', 'Runbook reference', 'Notes', 'Recorded by'].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {data.drills.length === 0 && (
                  <tr><td colSpan={5} style={{ ...td, color: '#6B6B6B' }}>No DR drill recorded yet — drill status is unknown.</td></tr>
                )}
                {data.drills.map(d => (
                  <tr key={d.id}>
                    <td style={td}>{utc(d.drillAt)}</td>
                    <td style={td}><Badge tone={d.result === 'passed' ? 'good' : d.result === 'failed' ? 'bad' : 'warn'}>{DRILL_RESULT_LABEL[d.result].toUpperCase()}</Badge></td>
                    <td style={td}>{d.runbookRef ?? '—'}</td>
                    <td style={td}>{d.notes ?? '—'}</td>
                    <td style={td}>{d.recordedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(data.ignored.backups + data.ignored.verifications + data.ignored.drills) > 0 && (
            <p style={{ fontSize: 11, color: '#92400E', margin: '-12px 0 22px' }}>
              {data.ignored.backups + data.ignored.verifications + data.ignored.drills} audit entr
              {data.ignored.backups + data.ignored.verifications + data.ignored.drills === 1 ? 'y' : 'ies'} looked like backup
              records but were malformed or pointed at no recorded backup, and were ignored.
            </p>
          )}
        </>
      )}

      <SectionTitle note="What KVRN records here, and what only you or a provider can know.">Who is responsible for what</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(330px,1fr))', gap: 12, marginBottom: 24 }}>
        <div style={{ border: BORDER, background: '#fff', padding: '12px 16px', fontSize: 12, lineHeight: 1.55 }}>
          <strong>Recorded in KVRN</strong> (this page): the metadata you type in — when a backup was taken, its type, an optional file
          label, size and SHA-256, and when you restore-tested it or ran a drill. Entries are appended and never edited.
        </div>
        <div style={{ border: BORDER, background: '#fff', padding: '12px 16px', fontSize: 12, lineHeight: 1.55 }}>
          <strong>Outside KVRN</strong> (you or the provider): Neon&rsquo;s own backups, point-in-time restore and branches
          (<em>unknown until you verify them in the Neon console and record what you found</em>); running <code>pg_dump</code>;
          performing a restore; Stripe, Cloudflare and GitHub data. KVRN cannot see any of these.
        </div>
      </div>

      <SectionTitle note="Read these in the repository (inside the app folder kvrn/). They are not served by the website, so there is no link.">
        Canonical recovery documents
      </SectionTitle>
      <div style={{ border: BORDER, background: '#fff', padding: '12px 16px', fontSize: 12, lineHeight: 1.7, marginBottom: 40 }}>
        <div><code>kvrn/DISASTER-RECOVERY.md</code> — the runbook; section D covers database backup and restore.</div>
        <div><code>kvrn/DISASTER-RECOVERY-CHECKLIST.md</code> — the step-by-step checklist to use during an incident.</div>
        <div><code>kvrn/DISASTER-RECOVERY-DRILL.md</code> — how to rehearse recovery safely, without touching production.</div>
      </div>
    </div>
  )
}

// ── forms ────────────────────────────────────────────────────────────────────

async function submit(url: string, body: object): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) return null
    const j = await res.json().catch(() => ({}))
    return j.error ?? `Request failed (${res.status}).`
  } catch { return 'Network error. Nothing was recorded.' }
}
const clean = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null))

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label style={{ fontSize: 11, display: 'block' }}>{label}{children}{hint && <span style={{ color: '#9B9B9B', fontSize: 10 }}>{hint}</span>}</label>
}
function FormShell({ title, onSubmit, busy, err, children }: {
  title: string; onSubmit: () => void; busy: boolean; err: string | null; children: React.ReactNode
}) {
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit() }} style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 24 }}>
      <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 12px' }}>{title}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 12 }}>{children}</div>
      {err && <p role="alert" style={{ fontSize: 12, color: '#B91C1C', margin: '12px 0 0' }}>{err}</p>}
      <button type="submit" disabled={busy} style={{ ...BTN, marginTop: 14, opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save record'}</button>
    </form>
  )
}
function WhenField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} hint="Your local time; saved as UTC.">
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="datetime-local" required value={value} onChange={e => onChange(e.target.value)} style={INPUT} />
        <button type="button" onClick={() => onChange(nowLocalValue())} style={{ ...BTN_GHOST, marginTop: 4, padding: '6px 10px' }}>Now</button>
      </div>
    </Field>
  )
}

function BackupForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ when: '', type: 'logical' as BackupType, reference: '', sizeBytes: '', sha256: '', notes: '' })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  async function go() {
    const backupAt = localToIso(f.when)
    if (!backupAt) { setErr('Enter when the backup (restore point) was taken.'); return }
    setBusy(true); setErr(null)
    const e = await submit('/api/admin/backups', clean({ backupAt, type: f.type, reference: f.reference.trim(), sizeBytes: f.sizeBytes.trim(), sha256: f.sha256.trim(), notes: f.notes.trim() }))
    setBusy(false)
    if (e) setErr(e); else onDone()
  }
  return (
    <FormShell title="Record a backup made elsewhere" onSubmit={go} busy={busy} err={err}>
      <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#1E3A8A', background: '#EFF6FF', padding: '8px 12px' }}>
        This does not create a backup. It records metadata for a backup created externally. Never paste passwords, connection strings or links.
      </div>
      <WhenField label="Backup / restore point time *" value={f.when} onChange={v => setF({ ...f, when: v })} />
      <Field label="Type *">
        <select value={f.type} onChange={set('type')} style={INPUT}>
          {BACKUP_TYPES.map(t => <option key={t} value={t}>{BACKUP_TYPE_LABEL[t]}</option>)}
        </select>
      </Field>
      <Field label="File name or reference label" hint="e.g. kvrn-prod-2026-10-04.dump — no paths or links.">
        <input value={f.reference} onChange={set('reference')} maxLength={LIMITS.reference} style={INPUT} />
      </Field>
      <Field label="Size in bytes" hint="Leave empty if unknown.">
        <input inputMode="numeric" value={f.sizeBytes} onChange={set('sizeBytes')} style={INPUT} />
      </Field>
      <Field label="SHA-256" hint="64 hex characters, from sha256sum. Leave empty if none.">
        <input value={f.sha256} onChange={set('sha256')} maxLength={64} style={{ ...INPUT, fontFamily: 'ui-monospace, Menlo, monospace' }} />
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Notes" hint="Non-secret only.">
          <textarea value={f.notes} onChange={set('notes')} maxLength={LIMITS.notes} rows={2} style={INPUT} />
        </Field>
      </div>
    </FormShell>
  )
}

function VerifyForm({ backups, onDone }: { backups: BackupDashboard['backups']; onDone: () => void }) {
  const [f, setF] = useState({ backupId: backups[0]?.id ?? '', when: '', result: 'passed' as VerificationResult, notes: '' })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null)
  async function go() {
    const verifiedAt = localToIso(f.when)
    if (!f.backupId) { setErr('Choose a recorded backup.'); return }
    if (!verifiedAt) { setErr('Enter when the restore test was done.'); return }
    setBusy(true); setErr(null)
    const e = await submit('/api/admin/backups/verify', clean({ backupId: f.backupId, verifiedAt, result: f.result, notes: f.notes.trim() }))
    setBusy(false)
    if (e) setErr(e); else onDone()
  }
  return (
    <FormShell title="Record a restore test" onSubmit={go} busy={busy} err={err}>
      <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#1E3A8A', background: '#EFF6FF', padding: '8px 12px' }}>
        This does not restore anything. It records that you restored this backup somewhere safe (never production) and what happened.
      </div>
      <Field label="Backup tested *">
        <select value={f.backupId} onChange={e => setF({ ...f, backupId: e.target.value })} style={INPUT}>
          {backups.map(b => <option key={b.id} value={b.id}>{utc(b.backupAt)} — {b.reference ?? BACKUP_TYPE_LABEL[b.type]}</option>)}
        </select>
      </Field>
      <WhenField label="Restore test time *" value={f.when} onChange={v => setF({ ...f, when: v })} />
      <Field label="Result *">
        <select value={f.result} onChange={e => setF({ ...f, result: e.target.value as VerificationResult })} style={INPUT}>
          {VERIFICATION_RESULTS.map(r => <option key={r} value={r}>{r === 'passed' ? 'Passed — restored and checked' : 'Failed'}</option>)}
        </select>
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Notes" hint="Non-secret only.">
          <textarea value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} maxLength={LIMITS.notes} rows={2} style={INPUT} />
        </Field>
      </div>
    </FormShell>
  )
}

function DrillForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ when: '', result: 'passed' as DrillResult, runbookRef: '', notes: '' })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null)
  async function go() {
    const drillAt = localToIso(f.when)
    if (!drillAt) { setErr('Enter when the drill was done.'); return }
    setBusy(true); setErr(null)
    const e = await submit('/api/admin/backups/drills', clean({ drillAt, result: f.result, runbookRef: f.runbookRef.trim(), notes: f.notes.trim() }))
    setBusy(false)
    if (e) setErr(e); else onDone()
  }
  return (
    <FormShell title="Record a DR drill" onSubmit={go} busy={busy} err={err}>
      <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#1E3A8A', background: '#EFF6FF', padding: '8px 12px' }}>
        This records a drill you ran outside the app (see DISASTER-RECOVERY-DRILL.md). It executes nothing.
      </div>
      <WhenField label="Drill time *" value={f.when} onChange={v => setF({ ...f, when: v })} />
      <Field label="Result *">
        <select value={f.result} onChange={e => setF({ ...f, result: e.target.value as DrillResult })} style={INPUT}>
          {DRILL_RESULTS.map(r => <option key={r} value={r}>{DRILL_RESULT_LABEL[r]}</option>)}
        </select>
      </Field>
      <Field label="Runbook version / commit" hint="Optional, e.g. 97c761a.">
        <input value={f.runbookRef} onChange={e => setF({ ...f, runbookRef: e.target.value })} maxLength={LIMITS.runbookRef} style={INPUT} />
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Notes" hint="Non-secret only.">
          <textarea value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} maxLength={LIMITS.notes} rows={2} style={INPUT} />
        </Field>
      </div>
    </FormShell>
  )
}
