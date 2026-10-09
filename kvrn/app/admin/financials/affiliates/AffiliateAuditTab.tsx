'use client'
// Audit: recent affiliate-program changes and email delivery status (no addresses or message bodies).

import { useCallback, useEffect, useState } from 'react'
import {
  AdminButton, AdminEmpty, AdminError, AdminLoading, AdminNotice, AdminSectionHeader, AdminTable, AdminTd, AdminTh, StatusBadge,
} from '@/components/admin/ui/AdminUI'
import { emailStatusBadge, formatDateTime } from '@/lib/affiliate-program-ui'
import { adminApi } from './api'

export function AffiliateAuditTab() {
  const [entries, setEntries] = useState<any[] | null>(null)
  const [emails, setEmails] = useState<any[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [a, e] = await Promise.all([adminApi('/api/admin/affiliates/audit'), adminApi('/api/admin/affiliates/emails')])
    if (!a.ok) { setErr(a.error); return }
    setErr(null); setEntries(a.data.entries); if (e.ok) setEmails(e.data.emails)
  }, [])
  useEffect(() => { void load() }, [load])

  const retry = async () => {
    setBusy(true)
    const r = await adminApi('/api/admin/affiliates/emails', { body: {} })
    setBusy(false)
    setFlash(r.ok ? `Processed ${r.data.processed}: ${r.data.sent} sent, ${r.data.failed} failed.` : (r.error ?? 'Could not retry.'))
    await load()
  }
  const failed = emails.filter(e => e.status === 'failed').length

  return (
    <div className="space-y-8">
      <section>
        <AdminSectionHeader title="Emails" actions={<AdminButton size="sm" loading={busy} onClick={() => void retry()}>Retry due emails</AdminButton>} info="Status only. Addresses and message text are not shown here. Emails that fail are retried automatically a few times." />
        {flash && <AdminNotice className="mb-3">{flash}</AdminNotice>}
        {failed > 0 && <AdminNotice tone="danger" className="mb-3" title={`${failed} email${failed === 1 ? '' : 's'} failed to send`}>Check the email provider settings, then retry.</AdminNotice>}
        {emails.length === 0 ? <AdminEmpty title="No program emails yet" /> : (
          <AdminTable caption="Program emails" stack>
            <thead><tr><AdminTh>Type</AdminTh><AdminTh>Status</AdminTh><AdminTh>Attempts</AdminTh><AdminTh>Queued</AdminTh><AdminTh>Last problem</AdminTh></tr></thead>
            <tbody>
              {emails.map(e => { const b = emailStatusBadge(e.status); return (
                <tr key={e.id}><AdminTd>{String(e.kind).replace(/_/g, ' ')}</AdminTd><AdminTd><StatusBadge status={b.status} label={b.label} /></AdminTd><AdminTd>{e.attempts}</AdminTd><AdminTd>{formatDateTime(e.createdAt)}</AdminTd><AdminTd>{e.lastError ?? '—'}</AdminTd></tr>
              ) })}
            </tbody>
          </AdminTable>
        )}
      </section>
      <section>
        <AdminSectionHeader title="Changes" info="Every approval, rejection, status change, setting and document publish is recorded with who did it. The log holds no tax, identity or banking details." />
        {err && <AdminError message={err} onRetry={() => void load()} />}
        {!entries && !err && <AdminLoading />}
        {entries && entries.length === 0 && <AdminEmpty title="No entries yet" />}
        {entries && entries.length > 0 && (
          <AdminTable caption="Audit log" stack>
            <thead><tr><AdminTh>When</AdminTh><AdminTh>Who</AdminTh><AdminTh>Action</AdminTh><AdminTh>Record</AdminTh></tr></thead>
            <tbody>
              {entries.map((e, i) => <tr key={i}><AdminTd>{formatDateTime(e.at)}</AdminTd><AdminTd><span className="break-all">{e.actor}</span></AdminTd><AdminTd><span className="font-mono text-[11px]">{e.action}</span></AdminTd><AdminTd><span className="text-[11px] text-[#6B6B66]">{e.resource}</span></AdminTd></tr>)}
            </tbody>
          </AdminTable>
        )}
      </section>
    </div>
  )
}
