'use client'
// app/admin/backups/BackupsClient.tsx
//
// Backup / recovery READINESS, from what an admin has recorded. This page does not create a
// backup, read one, contact Neon, or restore anything - it shows recorded metadata and the age of
// that evidence. Every status word comes from lib/backup-records.ts so the page cannot be friendlier
// than the evidence: unknown is never green, and a missing value is a dash, never zero.

import { useCallback, useEffect, useState } from 'react'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminNotice, AdminButton, AdminField, AdminStatGrid,
  AdminTable, AdminTh, AdminTd, AdminTag, AdminLoading, AdminEmpty, adminInputClass, adminSelectClass, adminTextareaClass,
} from '@/components/admin/ui/AdminUI'
import {
  BACKUP_TYPES, BACKUP_TYPE_LABEL, DRILL_RESULTS, VERIFICATION_RESULTS,
  OVERALL_LABEL, BACKUP_LABEL, VERIFICATION_LABEL, DRILL_LABEL, LIMITS,
  type BackupDashboard, type BackupType, type EvidenceState, type OverallState,
  type DrillResult, type VerificationResult,
} from '@/lib/backup-records'

// ── presentation helpers ─────────────────────────────────────────────────────

type Tone = 'good' | 'neutral' | 'warn' | 'bad' | 'unknown'
const TAG_TONE = { good: 'success', neutral: 'info', warn: 'warning', bad: 'danger', unknown: 'neutral' } as const
const evTone = (s: EvidenceState, ok: 'good' | 'neutral') => (s === 'current' ? ok : s === 'stale' ? 'warn' : s === 'failed' ? 'bad' : 'unknown') as Tone
const overallTone = (s: OverallState) => ({ verified: 'good', recorded: 'neutral', stale: 'warn', failed: 'bad', unknown: 'unknown' } as const)[s]

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <AdminTag tone={TAG_TONE[tone]}>{children}</AdminTag>
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

/** datetime-local value (the browser's local time) -> UTC ISO, or '' when empty/invalid. */
const localToIso = (v: string) => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? d.toISOString() : '' }
const nowLocalValue = () => { const d = new Date(); d.setSeconds(0, 0); const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }

function SummaryCard({ title, tone, label, at, age, noTime, children }: {
  title: string; tone: Tone; label: string; at: string | null; age: number | null
  /** The overall card summarises several pieces of evidence, so it has no single time of its own. */
  noTime?: boolean; children?: React.ReactNode
}) {
  return (
    <div className="min-w-0 rounded-[14px] border border-black/[0.08] bg-white px-4 py-3.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">{title}</p>
      <p className="mt-2"><Badge tone={tone}>{label}</Badge></p>
      {!noTime && <p className="mt-2 text-[12px]">{at ? utc(at) : 'Nothing recorded'}</p>}
      {!noTime && <p className="mt-0.5 text-[11px] text-[#6B6B66]">{at ? ago(age) : 'Unknown, not zero.'}</p>}
      {children}
    </div>
  )
}

const note = 'mt-1.5 text-[11px] text-[#6B6B66]'

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
  const ignoredCount = data ? data.ignored.backups + data.ignored.verifications + data.ignored.drills : 0
  const toggle = (p: Exclude<Panel, null>) => { setNotice(null); setPanel(panel === p ? null : p) }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Backups"
        description="Backup and recovery status."
        info={<>
          <p>Readiness is based on what you record here. KVRN&rsquo;s website cannot run <code>pg_dump</code>,
          cannot see your Neon backups, and cannot restore anything &mdash; so it shows only the evidence you enter.
          No evidence means <strong>unknown</strong>, never healthy.</p>
          <p className="mt-2"><strong>Verified</strong> means you recorded a restore test as completed.
          <strong> Stale</strong> means the latest evidence is older than its limit.</p>
        </>}
      />

      <AdminNotice className="mb-5">
        <strong>Recording a backup does not create one.</strong> It saves details of a backup you made elsewhere.
      </AdminNotice>

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {notice && <AdminNotice tone="success" className="mb-4">{notice}</AdminNotice>}
      {loading && !data && <AdminLoading />}

      {data && rd && (
        <div className="space-y-6">
          <section>
            <AdminSectionHeader
              title="Readiness"
              info={`Evidence older than its limit is stale: backup ${data.thresholds.backup} days, restore test ${data.thresholds.restoreVerification} days, DR drill ${data.thresholds.drill} days (measured from when the backup, test or drill happened).`}
            />
            <AdminStatGrid min={230}>
              <SummaryCard title="Overall readiness" tone={overallTone(rd.overall.state)} label={OVERALL_LABEL[rd.overall.state]}
                           at={null} age={null} noTime>
                <p className={note}>See the reasons below.</p>
              </SummaryCard>
              <SummaryCard title="Latest backup recorded" tone={evTone(rd.backup.state, 'neutral')} label={BACKUP_LABEL[rd.backup.state]}
                           at={rd.backup.at} age={rd.backup.ageDays}>
                {rd.backup.type && (
                  <p className={note}>
                    {BACKUP_TYPE_LABEL[rd.backup.type]} · {rd.backup.verification === 'verified' ? 'this backup was restore-tested'
                      : rd.backup.verification === 'failed' ? 'its restore test FAILED' : 'not yet restore-tested'}
                  </p>
                )}
              </SummaryCard>
              <SummaryCard title="Latest restore test" tone={evTone(rd.restoreVerification.state, 'good')}
                           label={VERIFICATION_LABEL[rd.restoreVerification.state]}
                           at={rd.restoreVerification.at} age={rd.restoreVerification.ageDays}>
                {rd.restoreVerification.backupId && (
                  <p className={note}>
                    Applies to: {backupLabel(data.backups, rd.restoreVerification.backupId)}
                    {rd.restoreVerification.backupId !== rd.backup.backupId && ' (not the latest backup)'}
                  </p>
                )}
              </SummaryCard>
              <SummaryCard title="Latest DR drill" tone={evTone(rd.drill.state, 'neutral')} label={DRILL_LABEL[rd.drill.state]}
                           at={rd.drill.at} age={rd.drill.ageDays}>
                {rd.drill.result && <p className={note}>Result: {DRILL_RESULT_LABEL[rd.drill.result]}</p>}
              </SummaryCard>
            </AdminStatGrid>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-[12px] leading-[1.5]">
              {rd.overall.reasons.length === 0 && <li>The latest backup has itself been restore-tested (passed); restore test and DR drill are current.</li>}
              {rd.overall.reasons.map(r => <li key={r}>{r}</li>)}
              {rd.overall.notes.map(n => <li key={n} className="text-[#6B6B66]">{n}</li>)}
            </ul>
          </section>

          <div className="flex flex-wrap gap-2">
            <AdminButton variant={panel === 'backup' ? 'secondary' : 'primary'} onClick={() => toggle('backup')}>
              {panel === 'backup' ? 'Cancel' : 'Record a backup'}
            </AdminButton>
            <AdminButton variant={panel === 'verify' ? 'secondary' : 'primary'} disabled={data.backups.length === 0} onClick={() => toggle('verify')}>
              {panel === 'verify' ? 'Cancel' : 'Record a restore test'}
            </AdminButton>
            <AdminButton variant={panel === 'drill' ? 'secondary' : 'primary'} onClick={() => toggle('drill')}>
              {panel === 'drill' ? 'Cancel' : 'Record a DR drill'}
            </AdminButton>
          </div>

          {panel === 'backup' && <BackupForm onDone={() => after('Backup metadata recorded. No backup was created by this action.')} />}
          {panel === 'verify' && <VerifyForm backups={data.backups} onDone={() => after('Restore test recorded. No restore was performed by this action.')} />}
          {panel === 'drill' && <DrillForm onDone={() => after('DR drill recorded. No recovery step was executed by this action.')} />}

          <section>
            <AdminSectionHeader title="Recorded backups" info="Newest restore point first. A dash means that detail was not recorded (unknown), not zero." />
            <AdminTable caption="Recorded backups" minWidth={860}>
              <thead><tr>
                {['Restore point (UTC)', 'Type', 'Reference', 'Size', 'SHA-256', 'Restore test', 'Recorded by'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {data.backups.length === 0 && (
                  <tr><AdminTd colSpan={7}><AdminEmpty title="No backups recorded yet." description="Backup status is unknown." /></AdminTd></tr>
                )}
                {data.backups.map(b => (
                  <tr key={b.id}>
                    <AdminTd>{utc(b.backupAt)}<div className="text-[10px] text-[#8A8A85]">recorded {utc(b.recordedAt)}</div></AdminTd>
                    <AdminTd>{BACKUP_TYPE_LABEL[b.type]}</AdminTd>
                    <AdminTd>{b.reference ?? '—'}{b.notes && <div className="text-[11px] text-[#6B6B66]">{b.notes}</div>}</AdminTd>
                    <AdminTd>{bytes(b.sizeBytes)}</AdminTd>
                    <AdminTd className="max-w-[190px] break-all font-mono text-[11px]">{b.sha256 ?? '—'}</AdminTd>
                    <AdminTd>
                      {b.verification.state === 'verified' && <><Badge tone="good">VERIFIED</Badge><div className="mt-0.5 text-[11px] text-[#6B6B66]">{utc(b.verification.latest!.verifiedAt)}</div></>}
                      {b.verification.state === 'failed' && <><Badge tone="bad">FAILED</Badge><div className="mt-0.5 text-[11px] text-[#6B6B66]">{utc(b.verification.latest!.verifiedAt)}</div></>}
                      {b.verification.state === 'not_verified' && <Badge tone="unknown">NOT YET VERIFIED</Badge>}
                      {b.verification.latest?.notes && <div className="mt-0.5 text-[11px] text-[#6B6B66]">{b.verification.latest.notes}</div>}
                    </AdminTd>
                    <AdminTd>{b.recordedBy}</AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </section>

          <section>
            <AdminSectionHeader title="DR drill history" info="Drills recorded as completed outside the app. Recording one does not run any recovery step." />
            <AdminTable caption="DR drill history" minWidth={640}>
              <thead><tr>
                {['Drill (UTC)', 'Result', 'Runbook reference', 'Notes', 'Recorded by'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {data.drills.length === 0 && (
                  <tr><AdminTd colSpan={5}><AdminEmpty title="No DR drill recorded yet." description="Drill status is unknown." /></AdminTd></tr>
                )}
                {data.drills.map(d => (
                  <tr key={d.id}>
                    <AdminTd>{utc(d.drillAt)}</AdminTd>
                    <AdminTd><Badge tone={d.result === 'passed' ? 'good' : d.result === 'failed' ? 'bad' : 'warn'}>{DRILL_RESULT_LABEL[d.result].toUpperCase()}</Badge></AdminTd>
                    <AdminTd>{d.runbookRef ?? '—'}</AdminTd>
                    <AdminTd>{d.notes ?? '—'}</AdminTd>
                    <AdminTd>{d.recordedBy}</AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </section>

          {ignoredCount > 0 && (
            <AdminNotice tone="warning">
              {ignoredCount} audit entr{ignoredCount === 1 ? 'y' : 'ies'} looked like backup
              records but were malformed or pointed at no recorded backup, and were ignored.
            </AdminNotice>
          )}
        </div>
      )}

      <div className="mt-6 space-y-6">
        <section>
          <AdminSectionHeader
            title="Who is responsible for what"
            info={<>
              <p><strong>Recorded in KVRN</strong> (this page): the details you type in &mdash; when a backup was taken, its type, an optional file
              label, size and SHA-256, and when you restore-tested it or ran a drill. Entries are appended and never edited.</p>
              <p className="mt-2"><strong>Outside KVRN</strong> (you or the provider): Neon&rsquo;s own backups, point-in-time restore and branches
              (<em>unknown until you verify them in the Neon console and record what you found</em>); running <code>pg_dump</code>;
              performing a restore; Stripe, Cloudflare and GitHub data. KVRN cannot see any of these.</p>
            </>}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminCard><p className="text-[12px]"><strong>Recorded in KVRN:</strong> the details you enter here.</p></AdminCard>
            <AdminCard><p className="text-[12px]"><strong>Outside KVRN:</strong> Neon backups, <code>pg_dump</code> and restores &mdash; unknown until you check and record them.</p></AdminCard>
          </div>
        </section>

        <section>
          <AdminSectionHeader
            title="Recovery documents"
            info="Read these in the repository (inside the app folder kvrn/). They are not served by the website, so there is no link."
          />
          <AdminCard className="space-y-1.5 text-[12px] leading-[1.6]">
            <div><code>kvrn/DISASTER-RECOVERY.md</code> &mdash; the runbook; section D covers database backup and restore.</div>
            <div><code>kvrn/DISASTER-RECOVERY-CHECKLIST.md</code> &mdash; the step-by-step checklist to use during an incident.</div>
            <div><code>kvrn/DISASTER-RECOVERY-DRILL.md</code> &mdash; how to rehearse recovery safely, without touching production.</div>
          </AdminCard>
        </section>
      </div>
    </AdminPage>
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

function FormShell({ title, onSubmit, busy, err, children }: {
  title: string; onSubmit: () => void; busy: boolean; err: string | null; children: React.ReactNode
}) {
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit() }}>
      <AdminCard>
        <AdminSectionHeader title={title} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
        {err && <p role="alert" className="mt-3 text-[12px] text-[#B91C1C]">{err}</p>}
        <div className="mt-4">
          <AdminButton type="submit" variant="primary" disabled={busy} loading={busy}>Save record</AdminButton>
        </div>
      </AdminCard>
    </form>
  )
}
const FULL = 'sm:col-span-2 lg:col-span-3'
function WhenField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <AdminField label={label} hint="Your local time; saved as UTC.">
      <div className="flex gap-1.5">
        <input type="datetime-local" required value={value} onChange={e => onChange(e.target.value)} className={adminInputClass} />
        <AdminButton size="sm" onClick={() => onChange(nowLocalValue())}>Now</AdminButton>
      </div>
    </AdminField>
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
      <AdminNotice className={FULL}>
        This does not create a backup. It records details of a backup created externally. Never paste passwords, connection strings or links.
      </AdminNotice>
      <WhenField label="Backup / restore point time *" value={f.when} onChange={v => setF({ ...f, when: v })} />
      <AdminField label="Type *">
        <select value={f.type} onChange={set('type')} className={adminSelectClass}>
          {BACKUP_TYPES.map(t => <option key={t} value={t}>{BACKUP_TYPE_LABEL[t]}</option>)}
        </select>
      </AdminField>
      <AdminField label="File name or reference label" hint="e.g. kvrn-prod-2026-10-04.dump — no paths or links.">
        <input value={f.reference} onChange={set('reference')} maxLength={LIMITS.reference} className={adminInputClass} />
      </AdminField>
      <AdminField label="Size in bytes" hint="Leave empty if unknown.">
        <input inputMode="numeric" value={f.sizeBytes} onChange={set('sizeBytes')} className={adminInputClass} />
      </AdminField>
      <AdminField label="SHA-256" hint="64 hex characters, from sha256sum. Leave empty if none.">
        <input value={f.sha256} onChange={set('sha256')} maxLength={64} className={`${adminInputClass} font-mono`} />
      </AdminField>
      <AdminField label="Notes" hint="Non-secret only." className={FULL}>
        <textarea value={f.notes} onChange={set('notes')} maxLength={LIMITS.notes} rows={2} className={adminTextareaClass} />
      </AdminField>
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
      <AdminNotice className={FULL}>
        This does not restore anything. It records that you restored this backup somewhere safe (never production) and what happened.
      </AdminNotice>
      <AdminField label="Backup tested *">
        <select value={f.backupId} onChange={e => setF({ ...f, backupId: e.target.value })} className={adminSelectClass}>
          {backups.map(b => <option key={b.id} value={b.id}>{utc(b.backupAt)} — {b.reference ?? BACKUP_TYPE_LABEL[b.type]}</option>)}
        </select>
      </AdminField>
      <WhenField label="Restore test time *" value={f.when} onChange={v => setF({ ...f, when: v })} />
      <AdminField label="Result *">
        <select value={f.result} onChange={e => setF({ ...f, result: e.target.value as VerificationResult })} className={adminSelectClass}>
          {VERIFICATION_RESULTS.map(r => <option key={r} value={r}>{r === 'passed' ? 'Passed — restored and checked' : 'Failed'}</option>)}
        </select>
      </AdminField>
      <AdminField label="Notes" hint="Non-secret only." className={FULL}>
        <textarea value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} maxLength={LIMITS.notes} rows={2} className={adminTextareaClass} />
      </AdminField>
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
      <AdminNotice className={FULL}>
        This records a drill you ran outside the app (see DISASTER-RECOVERY-DRILL.md). It executes nothing.
      </AdminNotice>
      <WhenField label="Drill time *" value={f.when} onChange={v => setF({ ...f, when: v })} />
      <AdminField label="Result *">
        <select value={f.result} onChange={e => setF({ ...f, result: e.target.value as DrillResult })} className={adminSelectClass}>
          {DRILL_RESULTS.map(r => <option key={r} value={r}>{DRILL_RESULT_LABEL[r]}</option>)}
        </select>
      </AdminField>
      <AdminField label="Runbook version / commit" hint="Optional, e.g. 97c761a.">
        <input value={f.runbookRef} onChange={e => setF({ ...f, runbookRef: e.target.value })} maxLength={LIMITS.runbookRef} className={adminInputClass} />
      </AdminField>
      <AdminField label="Notes" hint="Non-secret only." className={FULL}>
        <textarea value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} maxLength={LIMITS.notes} rows={2} className={adminTextareaClass} />
      </AdminField>
    </FormShell>
  )
}
