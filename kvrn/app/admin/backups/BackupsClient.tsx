'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  BACKUP_LABEL, OVERALL_LABEL, VERIFICATION_LABEL, DRILL_LABEL,
  type BackupDashboard, type BackupInput, type VerificationInput, type DrillInput,
} from '@/lib/backup-records'

const field = { display: 'block', width: '100%', padding: '10px', border: '1px solid #666', borderRadius: 5, marginTop: 5 } as const
const section = { border: '1px solid #555', borderRadius: 8, padding: 20, marginTop: 20 } as const
function instant() { return new Date().toISOString() }

export function BackupsClient() {
  const [data, setData] = useState<BackupDashboard | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [backup, setBackup] = useState<BackupInput>({ backupAt: instant(), type: 'logical' })
  const [verification, setVerification] = useState<VerificationInput>({ backupId: '', verifiedAt: instant(), result: 'passed' })
  const [drill, setDrill] = useState<DrillInput>({ drillAt: instant(), result: 'passed' })

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/backups', { cache: 'no-store' })
      if (!r.ok) throw Error('Backup records are unavailable.')
      setData(await r.json() as BackupDashboard)
    } catch { setError('Backup records unavailable. Nothing is assumed healthy.') }
  }, [])
  useEffect(() => { void reload() }, [reload])

  async function record(event: FormEvent, endpoint: string, value: unknown) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
      if (!res.ok) throw Error('Record could not be saved. Check dates and references.')
      await reload()
    } catch { setError('Record could not be saved; do not assume it was recorded. Refresh before trying again.') }
    finally { setBusy(false) }
  }

  return <main style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
    <h1>Backup and recovery evidence</h1>
    <p>This page does not create a backup and does not restore anything. It records evidence from external backup and restore procedures.</p>
    <p>Runbooks: kvrn/DISASTER-RECOVERY.md · kvrn/DISASTER-RECOVERY-CHECKLIST.md · kvrn/DISASTER-RECOVERY-DRILL.md</p>
    <button type="button" onClick={() => { setError(''); void reload() }} disabled={busy}>Refresh evidence</button>
    {error && <p role="alert">{error}</p>}
    <section style={section} aria-label="Current evidence">
      <h2>Readiness: {data ? OVERALL_LABEL[data.readiness.overall.state] : 'UNKNOWN'}</h2>
      {data?.readiness.overall.state === 'verified' && <p>The latest backup has itself been restore-tested (passed), and current drill evidence is recorded.</p>}
      <p>Backup: {data ? BACKUP_LABEL[data.readiness.backup.state] : 'UNKNOWN'}</p>
      <p>Restore verification: {data ? VERIFICATION_LABEL[data.readiness.restoreVerification.state] : 'UNKNOWN'}</p>
      <p>Drill: {data ? DRILL_LABEL[data.readiness.drill.state] : 'UNKNOWN'}</p>
      {data?.readiness.overall.reasons.map((reason, i) => <p key={i}>{reason}</p>)}
    </section>
    <section style={section}><h2>Record external backup</h2>
      <form onSubmit={e => void record(e, '/api/admin/backups', backup)}>
        <label>Backup completed at (ISO-8601 UTC)<input required style={field} value={backup.backupAt} onChange={e => setBackup({ ...backup, backupAt: e.target.value })}/></label>
        <label>Type<select style={field} value={backup.type} onChange={e => setBackup({ ...backup, type: e.target.value as BackupInput['type'] })}><option value="logical">Logical dump</option><option value="provider_snapshot">Provider snapshot</option><option value="pitr_marker">PITR marker</option><option value="other">Other</option></select></label>
        <label>Reference (filename or identifier, no full path)<input style={field} value={backup.reference ?? ''} onChange={e => setBackup({ ...backup, reference: e.target.value })}/></label>
        <label>SHA-256 (optional)<input style={field} value={backup.sha256 ?? ''} onChange={e => setBackup({ ...backup, sha256: e.target.value })}/></label>
        <button disabled={busy} type="submit">Record completed backup evidence</button>
      </form>
    </section>
    <section style={section}><h2>Record external restore test</h2>
      <form onSubmit={e => void record(e, '/api/admin/backups/verify', verification)}>
        <label>Applies to: <select required style={field} value={verification.backupId} onChange={e => setVerification({ ...verification, backupId: e.target.value })}>
          <option value="">Select exact recorded backup</option>
          {data?.backups.map(b => <option key={b.id} value={b.id}>{b.backupAt} — {b.reference ?? b.id}</option>)}
        </select></label>
        <label>Verified at (ISO-8601 UTC)<input required style={field} value={verification.verifiedAt} onChange={e => setVerification({ ...verification, verifiedAt: e.target.value })}/></label>
        <label>Result<select style={field} value={verification.result} onChange={e => setVerification({ ...verification, result: e.target.value as VerificationInput['result'] })}><option value="passed">Passed</option><option value="failed">Failed</option></select></label>
        <button disabled={busy || !verification.backupId} type="submit">Record restore-test evidence</button>
      </form>
    </section>
    <section style={section}><h2>Record external recovery drill</h2>
      <form onSubmit={e => void record(e, '/api/admin/backups/drills', drill)}>
        <label>Drill completed at (ISO-8601 UTC)<input required style={field} value={drill.drillAt} onChange={e => setDrill({ ...drill, drillAt: e.target.value })}/></label>
        <label>Result<select style={field} value={drill.result} onChange={e => setDrill({ ...drill, result: e.target.value as DrillInput['result'] })}><option value="passed">Passed</option><option value="passed_with_issues">Passed with issues</option><option value="failed">Failed</option></select></label>
        <button disabled={busy} type="submit">Record drill evidence</button>
      </form>
    </section>
    <section style={section}><h2>Recorded backups</h2>
      {data?.backups.length ? data.backups.map(b => <div key={b.id} style={{ padding: 12, borderBottom: '1px solid #555' }}>
        <strong>{b.reference ?? b.id}</strong> · {b.backupAt} · {b.type} · {b.verification.state}
      </div>) : <p>No recorded backups. Status is unknown.</p>}
    </section>
    <section style={section}><h2>Recorded recovery drills</h2>
      {data?.drills.length ? data.drills.map(d => <p key={d.id}>{d.drillAt} · {d.result}</p>) : <p>No recorded drills.</p>}
    </section>
  </main>
}
