'use client'
// Payout readiness: identity / tax / payout-method status, provider account reference (masked), portal access,
// the payout gate (blockers stay visible) and payout attempts (failed + retry).
// No bank, tax, ID or date-of-birth data is entered or shown here — only statuses and short display references.
import { useCallback, useEffect, useState } from 'react'
import {
  AdminButton, AdminCard, AdminEmpty, AdminError, AdminField, AdminFieldGrid, AdminLoading, AdminNotice, AdminSectionHeader,
  AdminTable, AdminTd, AdminTh, InfoTip, StatusBadge, adminInputClass, useConfirm, type StatusLabel,
} from '@/components/admin/ui/AdminUI'
import { adminApi, day, idemKey, usd } from '@/lib/affiliate-admin-client'

const DOMAINS: Array<{ id: 'kyc' | 'tax' | 'payout_method'; label: string; options: string[] }> = [
  { id: 'kyc', label: 'Identity', options: ['not_started', 'pending', 'verified', 'problem'] },
  { id: 'tax', label: 'Tax', options: ['not_started', 'pending', 'complete', 'problem'] },
  { id: 'payout_method', label: 'Payout method', options: ['not_started', 'pending', 'ready', 'failed'] },
]
const pretty = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : 'unknown')
function badge(s: string | null | undefined): StatusLabel {
  switch (s) {
    case 'verified': case 'complete': case 'ready': return 'Ready'
    case 'pending': return 'Pending'
    case 'problem': case 'failed': return 'Failed'
    default: return 'Unknown'
  }
}
const statusBadge = (s: string | null | undefined) => <StatusBadge status={badge(s)} label={pretty(s)} />

export function AffiliatePayoutReadinessTab() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await adminApi<{ affiliates: any[] }>('/api/admin/affiliates/payout-readiness')
    if (r.ok) { setRows(r.data!.affiliates); setError(null) } else setError(r.error)
  }, [])
  useEffect(() => { load() }, [load])

  if (error) return <AdminError message={error} onRetry={load} />
  if (!rows) return <AdminLoading />
  return (
    <div className="space-y-4">
      <AdminNotice tone="info" title="Payouts are blocked until every item is ready.">
        Identity, tax and payout method must be confirmed, terms accepted and nothing under review. Sensitive details live with the payout provider, never here.
      </AdminNotice>
      {rows.length === 0 ? <AdminEmpty title="No affiliates yet" /> : (
        <AdminTable caption="Affiliate payout readiness" stack>
          <thead><tr><AdminTh>Affiliate</AdminTh><AdminTh>Identity</AdminTh><AdminTh>Tax</AdminTh><AdminTh>Payout method</AdminTh><AdminTh>Portal</AdminTh><AdminTh className="text-right">Payable</AdminTh><AdminTh /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.affiliateId}>
                <AdminTd><div className="font-medium">{r.name}</div><div className="text-[11px] text-[#6B6B66]">{r.code}{!r.hasProfile && ' · no profile'}</div></AdminTd>
                <AdminTd>{r.hasProfile ? statusBadge(r.kycStatus) : <StatusBadge status="Unknown" />}</AdminTd>
                <AdminTd>{r.hasProfile ? statusBadge(r.taxStatus) : <StatusBadge status="Unknown" />}</AdminTd>
                <AdminTd>{r.hasProfile ? statusBadge(r.payoutMethodStatus) : <StatusBadge status="Unknown" />}</AdminTd>
                <AdminTd>{r.portalAccess ? pretty(r.portalAccess) : '—'}{r.requiresReacceptance && <div className="text-[11px] text-[#92400E]">terms pending</div>}</AdminTd>
                <AdminTd className="text-right">{usd(r.payableCents)}{r.incompleteCount > 0 && <div className="text-[11px] text-[#92400E]">{r.incompleteCount} unresolved</div>}{r.frozenFlags > 0 && <div className="text-[11px] text-[#991B1B]">frozen</div>}</AdminTd>
                <AdminTd><AdminButton size="sm" onClick={() => setSel(sel === r.affiliateId ? null : r.affiliateId)}>{sel === r.affiliateId ? 'Close' : 'Manage'}</AdminButton></AdminTd>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
      {sel && <Detail key={sel} affiliateId={sel} onChanged={load} />}
    </div>
  )
}

function Detail({ affiliateId, onChanged }: { affiliateId: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const { confirm, node } = useConfirm()

  const load = useCallback(async () => {
    const r = await adminApi(`/api/admin/affiliates/payout-readiness?affiliateId=${affiliateId}`)
    if (r.ok) { setD(r.data); setError(null) } else setError(r.error)
  }, [affiliateId])
  useEffect(() => { load() }, [load])

  async function act(body: Record<string, unknown>, okText: string) {
    setBusy(true); setMsg(null)
    const r = await adminApi('/api/admin/affiliates/payout-readiness', { method: 'POST', body: { affiliateId, ...body } })
    setBusy(false)
    if (r.ok) { setMsg({ tone: 'success', text: okText }); await load(); onChanged() } else setMsg({ tone: 'danger', text: r.error ?? 'Failed.' })
  }

  if (error) return <AdminError message={error} onRetry={load} />
  if (!d) return <AdminLoading />
  const gate = d.gate
  return (
    <AdminCard>
      {node}
      <AdminSectionHeader title="Payout gate" info="The gate decides whether a payout can be created. It never changes amounts. If it cannot be checked, it blocks." />
      {gate.allowed
        ? <AdminNotice tone="success" title="Ready to pay.">Payable now: {usd(gate.snapshot.payableCents)}.</AdminNotice>
        : <AdminNotice tone="danger" title="Payout blocked."><ul className="list-disc pl-4">{gate.blockers.map((b: any) => <li key={b.code}>{b.message}</li>)}</ul></AdminNotice>}
      {gate.warnings.length > 0 && <AdminNotice tone="warning" className="mt-2" title="Heads-up"><ul className="list-disc pl-4">{gate.warnings.map((w: any) => <li key={w.code}>{w.message}</li>)}</ul></AdminNotice>}
      {msg && <AdminNotice tone={msg.tone} className="mt-3">{msg.text}</AdminNotice>}

      <div className="mt-5"><AdminSectionHeader title="Readiness" info="A positive status needs a short note saying how it was confirmed (for example: 'ID checked in provider dashboard'). It is recorded with your name." /></div>
      <div className="grid gap-3 md:grid-cols-3">{DOMAINS.map(dm => <ReadinessEditor key={dm.id} domain={dm} current={dm.id === 'kyc' ? gate.snapshot.kyc : dm.id === 'tax' ? gate.snapshot.tax : gate.snapshot.payoutMethod} busy={busy} onSave={(status, note) => act({ kind: 'readiness', domain: dm.id, status, note }, `${dm.label} updated.`)} />)}</div>

      <div className="mt-5"><AdminSectionHeader title="Provider account" info="Reference and short display details only (brand, last 4). Never enter bank, tax or ID numbers." /></div>
      <AccountEditor accounts={d.detail.accounts} busy={busy} onSave={(v) => act({ kind: 'account', ...v }, 'Account reference saved.')} />

      <div className="mt-5"><AdminSectionHeader title="Portal access" /></div>
      <AccessEditor busy={busy}
        onSave={async (access, reason) => { if (access === 'revoked' && !(await confirm('Revoking access signs this affiliate out everywhere and blocks login. Continue?'))) return; await act({ kind: 'access', access, note: reason }, 'Portal access updated.') }}
        onRevoke={async () => { if (await confirm('Sign this affiliate out of every device?')) await act({ kind: 'sessions', note: 'admin_request' }, 'Sessions revoked.') }} />

      <div className="mt-5"><AdminSectionHeader title="Payouts and attempts" info="A failed payout stays a draft, so its money remains reserved and cannot be paid twice. Retry records a new attempt; void releases the money." /></div>
      {d.detail.payouts.length === 0 ? <p className="text-[12px] text-[#6B6B66]">No payouts yet.</p> : d.detail.payouts.map((p: any) => (
        <PayoutRow key={p.id} p={p} busy={busy} act={act} />
      ))}

      <div className="mt-5"><AdminSectionHeader title="Readiness history" /></div>
      {d.detail.events.length === 0 ? <p className="text-[12px] text-[#6B6B66]">No changes recorded.</p> : (
        <ul className="space-y-1 text-[12px]">{d.detail.events.map((e: any, i: number) => <li key={i}>{day(e.at)} · {pretty(e.domain)}: {pretty(e.from)} → <strong>{pretty(e.to)}</strong> · {e.source}{e.actor ? ` (${e.actor})` : ''}{e.note ? ` — ${e.note}` : ''}</li>)}</ul>
      )}
    </AdminCard>
  )
}

function ReadinessEditor({ domain, current, busy, onSave }: { domain: typeof DOMAINS[number]; current: string | null; busy: boolean; onSave: (status: string, note: string) => void }) {
  const [status, setStatus] = useState(current ?? 'not_started')
  const [note, setNote] = useState('')
  const positive = status === 'verified' || status === 'complete' || status === 'ready'
  return (
    <div className="rounded-[10px] border border-black/[0.08] p-3">
      <AdminField label={domain.label} htmlFor={`rd-${domain.id}`}>
        <select id={`rd-${domain.id}`} className={adminInputClass} value={status} onChange={e => setStatus(e.target.value)}>{domain.options.map(o => <option key={o} value={o}>{pretty(o)}</option>)}</select>
      </AdminField>
      <AdminField label={positive ? 'How was this confirmed? (required)' : 'Note'} htmlFor={`rn-${domain.id}`} className="mt-2">
        <input id={`rn-${domain.id}`} className={adminInputClass} maxLength={300} value={note} onChange={e => setNote(e.target.value)} />
      </AdminField>
      <AdminButton className="mt-2" size="sm" variant="primary" loading={busy} disabled={status === (current ?? 'not_started') || (positive && note.trim().length < 8)} onClick={() => onSave(status, note)}>Save</AdminButton>
    </div>
  )
}

function AccountEditor({ accounts, busy, onSave }: { accounts: any[]; busy: boolean; onSave: (v: { provider: string; providerAccountRef: string; masked: Record<string, string> }) => void }) {
  const cur = accounts[0]
  const [provider, setProvider] = useState(cur?.provider ?? 'manual')
  const [ref, setRef] = useState(cur?.providerAccountRef ?? '')
  const [brand, setBrand] = useState(cur?.masked?.brand ?? '')
  const [last4, setLast4] = useState(cur?.masked?.last4 ?? '')
  return (
    <AdminFieldGrid cols={4}>
      <AdminField label="Provider" htmlFor="pa-prov"><select id="pa-prov" className={adminInputClass} value={provider} onChange={e => setProvider(e.target.value)}><option value="manual">Manual</option><option value="stripe_connect">Stripe Connect</option></select></AdminField>
      <AdminField label="Provider reference" htmlFor="pa-ref" hint="For example acct_…"><input id="pa-ref" className={adminInputClass} maxLength={120} value={ref} onChange={e => setRef(e.target.value)} /></AdminField>
      <AdminField label="Display name" htmlFor="pa-brand" hint="e.g. Bank, PayPal"><input id="pa-brand" className={adminInputClass} maxLength={40} value={brand} onChange={e => setBrand(e.target.value)} /></AdminField>
      <AdminField label="Last 4" htmlFor="pa-l4"><input id="pa-l4" className={adminInputClass} inputMode="numeric" maxLength={4} value={last4} onChange={e => setLast4(e.target.value.replace(/\D/g, ''))} /></AdminField>
      <div className="md:col-span-4"><AdminButton size="sm" variant="primary" loading={busy}
        onClick={() => onSave({ provider, providerAccountRef: ref, masked: { ...(brand ? { brand } : {}), ...(last4 ? { last4 } : {}) } })}>Save reference</AdminButton></div>
    </AdminFieldGrid>
  )
}

function AccessEditor({ busy, onSave, onRevoke }: { busy: boolean; onSave: (access: string, reason: string) => void; onRevoke: () => void }) {
  const [access, setAccess] = useState('enabled')
  const [reason, setReason] = useState('')
  return (
    <div className="flex flex-wrap items-end gap-3">
      <AdminField label="Access" htmlFor="pa-acc"><select id="pa-acc" className={adminInputClass} value={access} onChange={e => setAccess(e.target.value)}><option value="enabled">Enabled</option><option value="read_only">Read-only</option><option value="revoked">Revoked</option></select></AdminField>
      <AdminField label="Reason" htmlFor="pa-rsn"><input id="pa-rsn" className={adminInputClass} maxLength={200} value={reason} onChange={e => setReason(e.target.value)} /></AdminField>
      <AdminButton size="sm" variant="primary" loading={busy} onClick={() => onSave(access, reason)}>Apply</AdminButton>
      <AdminButton size="sm" variant="danger" disabled={busy} onClick={onRevoke}>Sign out everywhere</AdminButton>
    </div>
  )
}

function PayoutRow({ p, busy, act }: { p: any; busy: boolean; act: (b: Record<string, unknown>, ok: string) => void }) {
  const last = p.attempts[p.attempts.length - 1]
  const [key] = useState(idemKey)
  const [ref, setRef] = useState('')
  const [method, setMethod] = useState('')
  const [fnote, setFnote] = useState('')
  const [open, setOpen] = useState(false)
  const tone: StatusLabel = p.status === 'paid' ? 'Paid' : p.status === 'void' ? 'Inactive' : last?.status === 'failed' ? 'Failed' : 'Draft'
  return (
    <div className="mb-2 rounded-[10px] border border-black/[0.08] p-3 text-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><span className="font-medium">{p.payoutNumber}</span> · {day(p.date)} · {usd(p.amountCents)} <StatusBadge status={tone} label={p.status === 'void' ? 'cancelled' : last?.status === 'failed' && p.status === 'draft' ? 'failed — reserved' : p.status} /></div>
        <div className="flex gap-2">
          <a className="underline underline-offset-2" href={`/api/admin/affiliates/payout-readiness/statement?payoutId=${p.id}&format=csv`}>Statement CSV</a>
          {p.status === 'draft' && <AdminButton size="sm" onClick={() => setOpen(!open)}>{open ? 'Close' : last?.status === 'failed' ? 'Retry / record' : 'Record attempt'}</AdminButton>}
        </div>
      </div>
      {p.attempts.length > 0 && <ul className="mt-2 space-y-0.5 text-[#4A4A46]">{p.attempts.map((a: any) => <li key={a.id}>#{a.attemptNo} · {a.provider} · {a.status}{a.failureCode ? ` · ${a.failureCode}` : ''}{a.failureNote ? ` — ${a.failureNote}` : ''}</li>)}</ul>}
      {open && p.status === 'draft' && (
        <div className="mt-3 grid gap-2 md:grid-cols-4">
          {(!last || last.status !== 'initiated') && <div className="md:col-span-4"><AdminButton size="sm" loading={busy} onClick={() => act({ kind: 'attempt', payoutId: p.id, idempotencyKey: `${key}-${p.attempts.length}` }, 'Attempt recorded.')}>Start {p.attempts.length ? 'new ' : ''}attempt</AdminButton></div>}
          {last?.status === 'initiated' && (<>
            <AdminField label="Reference" htmlFor={`pr-${p.id}`}><input id={`pr-${p.id}`} className={adminInputClass} maxLength={120} value={ref} onChange={e => setRef(e.target.value)} /></AdminField>
            <AdminField label="Method" htmlFor={`pm-${p.id}`}><input id={`pm-${p.id}`} className={adminInputClass} maxLength={24} value={method} onChange={e => setMethod(e.target.value)} /></AdminField>
            <AdminField label="If failed: reason" htmlFor={`pf-${p.id}`}><input id={`pf-${p.id}`} className={adminInputClass} maxLength={300} value={fnote} onChange={e => setFnote(e.target.value)} /></AdminField>
            <div className="flex items-end gap-2">
              <AdminButton size="sm" variant="primary" loading={busy} onClick={() => act({ kind: 'attempt_complete', attemptId: last.id, outcome: 'succeeded', reference: ref, method }, 'Marked paid.')}>Money sent</AdminButton>
              <AdminButton size="sm" variant="danger" loading={busy} disabled={fnote.trim().length < 3} onClick={() => act({ kind: 'attempt_complete', attemptId: last.id, outcome: 'failed', failureCode: 'manual_failure', failureNote: fnote }, 'Marked failed.')}>Failed</AdminButton>
            </div>
          </>)}
        </div>
      )}
    </div>
  )
}
