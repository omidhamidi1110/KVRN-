'use client'
// Compliance center: current program documents, saved promotional posts, warning history, review log,
// fraud / abuse flags (heuristics only RAISE a question), paid-ad permission, suspension, and UGC rights.
// History is append-only: nothing here deletes or rewrites a past entry.
import { useCallback, useEffect, useState } from 'react'
import {
  AdminButton, AdminCard, AdminEmpty, AdminError, AdminField, AdminFieldGrid, AdminLoading, AdminNotice, AdminSectionHeader,
  AdminTable, AdminTd, AdminTh, StatusBadge, adminInputClass, useConfirm, type StatusLabel,
} from '@/components/admin/ui/AdminUI'
import { adminApi, day } from '@/lib/affiliate-admin-client'

const ITEM_BADGE: Record<string, StatusLabel> = { compliant: 'Approved', needs_review: 'Review', violation: 'Failed', resolved: 'Resolved' }
const SEV_BADGE: Record<string, StatusLabel> = { notice: 'Pending', warning: 'Review', final: 'Failed' }
const pretty = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—')

export function AffiliateComplianceTab() {
  const [data, setData] = useState<{ documents: any[]; affiliates: any[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await adminApi<{ documents: any[]; affiliates: any[] }>('/api/admin/affiliates/compliance')
    if (r.ok) { setData(r.data); setError(null) } else setError(r.error)
  }, [])
  useEffect(() => { load() }, [load])

  async function scan() {
    setBusy(true); setScanMsg(null)
    const r = await adminApi<{ result: { candidates: number; created: number } }>('/api/admin/affiliates/compliance', { method: 'POST', body: { kind: 'scan', sinceDays: 30 } })
    setBusy(false)
    setScanMsg(r.ok ? `Checked recent orders: ${r.data!.result.created} new item${r.data!.result.created === 1 ? '' : 's'} to review.` : (r.error ?? 'Check failed.'))
    if (r.ok) load()
  }

  if (error) return <AdminError message={error} onRetry={load} />
  if (!data) return <AdminLoading />
  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Current program documents" description="What affiliates agree to today." />
        {data.documents.length === 0 ? <p className="text-[12px] text-[#6B6B66]">No published documents yet.</p> : (
          <ul className="grid gap-2 sm:grid-cols-2">{data.documents.map(d => <li key={d.docType} className="rounded-[10px] border border-black/[0.08] px-3 py-2 text-[12px]"><span className="font-medium">{d.title}</span> <span className="text-[#8A8A85]">v{d.version}</span><div className="text-[11px] text-[#6B6B66]">Effective {day(d.effectiveAt)}</div></li>)}</ul>
        )}
      </AdminCard>

      <AdminSectionHeader title="Affiliates" description="Open items first."
        info="The self-referral check compares each referred order's customer email with the affiliate's own email. A match only raises a question for a human; it never freezes or accuses on its own."
        actions={<AdminButton size="sm" loading={busy} onClick={scan}>Run self-referral check</AdminButton>} />
      {scanMsg && <AdminNotice tone="info">{scanMsg}</AdminNotice>}
      {data.affiliates.length === 0 ? <AdminEmpty title="No affiliates yet" /> : (
        <AdminTable caption="Affiliate compliance" stack>
          <thead><tr><AdminTh>Affiliate</AdminTh><AdminTh>Status</AdminTh><AdminTh>Last review</AdminTh><AdminTh>Posts to review</AdminTh><AdminTh>Open warnings</AdminTh><AdminTh>Open flags</AdminTh><AdminTh /></tr></thead>
          <tbody>
            {[...data.affiliates].sort((a, b) => (b.itemsOpen + b.warningsOpen + b.flagsOpen) - (a.itemsOpen + a.warningsOpen + a.flagsOpen)).map(a => (
              <tr key={a.affiliateId}>
                <AdminTd><div className="font-medium">{a.name}</div><div className="text-[11px] text-[#6B6B66]">{a.code}</div></AdminTd>
                <AdminTd><StatusBadge status={a.status === 'active' ? 'Active' : a.status === 'paused' ? 'Suspended' : 'Terminated'} /></AdminTd>
                <AdminTd>{a.lastReviewAt ? day(a.lastReviewAt) : <span className="text-[#92400E]">Never</span>}</AdminTd>
                <AdminTd>{a.itemsOpen}</AdminTd><AdminTd>{a.warningsOpen}</AdminTd>
                <AdminTd>{a.flagsOpen > 0 ? <StatusBadge status="Unresolved" label={String(a.flagsOpen)} /> : 0}</AdminTd>
                <AdminTd><AdminButton size="sm" onClick={() => setSel(sel === a.affiliateId ? null : a.affiliateId)}>{sel === a.affiliateId ? 'Close' : 'Open'}</AdminButton></AdminTd>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
      {sel && <AffiliateDetail key={sel} affiliateId={sel} onChanged={load} />}
    </div>
  )
}

function AffiliateDetail({ affiliateId, onChanged }: { affiliateId: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null)
  const [ugc, setUgc] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const { confirm, node } = useConfirm()

  const load = useCallback(async () => {
    const [r, u] = await Promise.all([
      adminApi(`/api/admin/affiliates/compliance?affiliateId=${affiliateId}`),
      adminApi(`/api/admin/affiliates/ugc?affiliateId=${affiliateId}`),
    ])
    if (r.ok) { setD(r.data!.detail); setError(null) } else setError(r.error)
    setUgc(u.ok ? u.data!.licenses : [])
  }, [affiliateId])
  useEffect(() => { load() }, [load])

  async function post(path: string, body: Record<string, unknown>, okText: string): Promise<boolean> {
    setBusy(true); setMsg(null)
    const r = await adminApi(path, { method: 'POST', body: { affiliateId, ...body } })
    setBusy(false)
    if (r.ok) { setMsg({ tone: 'success', text: okText }); await load(); onChanged(); return true }
    setMsg({ tone: 'danger', text: r.error ?? 'Failed.' }); return false
  }
  const comp = (body: Record<string, unknown>, okText: string) => post('/api/admin/affiliates/compliance', body, okText)

  if (error) return <AdminError message={error} onRetry={load} />
  if (!d) return <AdminLoading />
  return (
    <AdminCard>
      {node}
      {msg && <AdminNotice tone={msg.tone} className="mb-3">{msg.text}</AdminNotice>}
      {d.profile === null && <AdminNotice tone="warning" className="mb-3" title="No affiliate profile on file.">Paid-ad permission and portal controls need a profile.</AdminNotice>}

      <Posts items={d.items} busy={busy} onAdd={v => comp({ kind: 'item_add', ...v }, 'Post saved.')} onStatus={(itemId, status, note) => comp({ kind: 'item_status', itemId, status, note }, 'Post updated.')} />
      <Warnings warnings={d.warnings} items={d.items} busy={busy} onIssue={v => comp({ kind: 'warning_issue', ...v }, 'Warning recorded.')} onResolve={(warningId, note) => comp({ kind: 'warning_resolve', warningId, note }, 'Warning resolved.')} />
      <Flags flags={d.flags} busy={busy} onOpen={v => comp({ kind: 'flag_open', ...v }, 'Flag opened.')}
        onUpdate={async (flagId, v) => { if (v.freeze === true && !(await confirm('Freezing blocks payouts for this affiliate until the flag is resolved. No commission is changed. Continue?'))) return; await comp({ kind: 'flag_update', flagId, ...v }, 'Flag updated.') }} />

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div>
          <AdminSectionHeader title="Paid advertising" info="Controls whether this affiliate may run paid ads using KVRN content. Shown to them in their portal." />
          <PaidAds current={d.profile?.paidAdsPolicy ?? null} disabled={!d.profile} busy={busy} onSave={(policy, note) => comp({ kind: 'paid_ads', policy, note }, 'Paid-ad permission saved.')} />
        </div>
        <div>
          <AdminSectionHeader title="Review log" />
          <ReviewLog reviews={d.reviews} busy={busy} onRecord={(outcome, note) => comp({ kind: 'review', outcome, note }, 'Review recorded.')} />
        </div>
      </div>

      <Ugc licenses={ugc} busy={busy}
        onGrant={v => post('/api/admin/affiliates/ugc', { kind: 'grant', ...v }, 'License recorded.')}
        onRevoke={async (licenseId, reason) => { if (await confirm('Revoke this license? This cannot be undone; record a new one to restore rights.')) await post('/api/admin/affiliates/ugc', { kind: 'revoke', licenseId, reason }, 'License revoked.') }} />

      <div className="mt-6 border-t border-black/[0.08] pt-4">
        <AdminSectionHeader title="Suspend for compliance" info="Pauses the affiliate code from now on (history and earned commissions are untouched) and, optionally, signs them out. Payouts stop until an Admin reinstates them." />
        <Suspend busy={busy} onSuspend={async (reason, revokePortal) => { if (await confirm('Suspend this affiliate now? Their code stops earning on new orders.')) await comp({ kind: 'suspend', reason, revokePortal }, 'Affiliate suspended.') }} />
      </div>
    </AdminCard>
  )
}

function Posts({ items, busy, onAdd, onStatus }: { items: any[]; busy: boolean; onAdd: (v: { url: string; platform: string; title: string; note: string }) => void; onStatus: (id: string, status: string, note: string) => void }) {
  const [url, setUrl] = useState(''); const [platform, setPlatform] = useState(''); const [title, setTitle] = useState(''); const [note, setNote] = useState('')
  return (
    <section>
      <AdminSectionHeader title="Saved posts" info="Promotional posts you want to keep an eye on. Links must be https. Notes here are internal only." />
      <AdminFieldGrid cols={4}>
        <AdminField label="Link" htmlFor="ci-url" className="md:col-span-2"><input id="ci-url" className={adminInputClass} placeholder="https://" maxLength={500} value={url} onChange={e => setUrl(e.target.value)} /></AdminField>
        <AdminField label="Platform" htmlFor="ci-pl"><input id="ci-pl" className={adminInputClass} maxLength={40} value={platform} onChange={e => setPlatform(e.target.value)} /></AdminField>
        <AdminField label="Title" htmlFor="ci-t"><input id="ci-t" className={adminInputClass} maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></AdminField>
        <AdminField label="Internal note" htmlFor="ci-n"><input id="ci-n" className={adminInputClass} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></AdminField>
      </AdminFieldGrid>
      <AdminButton className="mt-2" size="sm" variant="primary" loading={busy} disabled={url.trim().length < 8} onClick={() => { onAdd({ url, platform, title, note }); setUrl(''); setPlatform(''); setTitle(''); setNote('') }}>Save post</AdminButton>
      {items.length === 0 ? <p className="mt-3 text-[12px] text-[#6B6B66]">No saved posts.</p> : (
        <ul className="mt-3 divide-y divide-black/[0.06]">{items.map(i => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12px]">
            <div className="min-w-0"><a href={i.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="break-all underline underline-offset-2">{i.title || i.url}</a>
              <div className="text-[11px] text-[#6B6B66]">{i.platform ?? 'link'} · added {day(i.createdAt)}{i.reviewedAt ? ` · reviewed ${day(i.reviewedAt)} by ${i.reviewedBy}` : ''}{i.note ? ` · ${i.note}` : ''}</div></div>
            <div className="flex items-center gap-2"><StatusBadge status={ITEM_BADGE[i.status] ?? 'Unknown'} label={pretty(i.status)} />
              <select aria-label="Change status" className="h-8 rounded-[9px] border border-black/[0.14] bg-white px-2 text-[11px]" value="" disabled={busy} onChange={e => e.target.value && onStatus(i.id, e.target.value, '')}>
                <option value="">Set…</option><option value="compliant">Compliant</option><option value="needs_review">Needs review</option><option value="violation">Violation</option><option value="resolved">Resolved</option></select></div>
          </li>))}</ul>
      )}
    </section>
  )
}

function Warnings({ warnings, items, busy, onIssue, onResolve }: { warnings: any[]; items: any[]; busy: boolean; onIssue: (v: any) => void; onResolve: (id: string, note: string) => void }) {
  const [severity, setSeverity] = useState('notice'); const [category, setCategory] = useState('disclosure'); const [summary, setSummary] = useState(''); const [internalNote, setInternalNote] = useState(''); const [notify, setNotify] = useState(true); const [itemId, setItemId] = useState('')
  return (
    <section className="mt-6">
      <AdminSectionHeader title="Warnings" info="The message is what the affiliate sees (and is emailed when 'Notify' is on). The internal note is never shown to them. Warnings are never deleted; resolving one keeps the record." />
      <AdminFieldGrid cols={4}>
        <AdminField label="Severity" htmlFor="w-sev"><select id="w-sev" className={adminInputClass} value={severity} onChange={e => setSeverity(e.target.value)}><option value="notice">Notice</option><option value="warning">Warning</option><option value="final">Final</option></select></AdminField>
        <AdminField label="Category" htmlFor="w-cat"><select id="w-cat" className={adminInputClass} value={category} onChange={e => setCategory(e.target.value)}>{['disclosure', 'brand', 'paid_ads', 'email_sms', 'claims', 'self_referral', 'other'].map(c => <option key={c} value={c}>{pretty(c)}</option>)}</select></AdminField>
        <AdminField label="Related post" htmlFor="w-item" className="md:col-span-2"><select id="w-item" className={adminInputClass} value={itemId} onChange={e => setItemId(e.target.value)}><option value="">None</option>{items.map(i => <option key={i.id} value={i.id}>{(i.title || i.url).slice(0, 60)}</option>)}</select></AdminField>
        <AdminField label="Message to the affiliate" htmlFor="w-sum" className="md:col-span-2"><input id="w-sum" className={adminInputClass} maxLength={500} value={summary} onChange={e => setSummary(e.target.value)} /></AdminField>
        <AdminField label="Internal note" htmlFor="w-int" className="md:col-span-2"><input id="w-int" className={adminInputClass} maxLength={1000} value={internalNote} onChange={e => setInternalNote(e.target.value)} /></AdminField>
      </AdminFieldGrid>
      <label className="mt-2 flex items-center gap-2 text-[12px]"><input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} /> Notify the affiliate</label>
      <AdminButton className="mt-2" size="sm" variant="primary" loading={busy} disabled={summary.trim().length < 3} onClick={() => { onIssue({ severity, category, summary, internalNote, notifyAffiliate: notify, itemId: itemId || null }); setSummary(''); setInternalNote('') }}>Record warning</AdminButton>
      {warnings.length === 0 ? <p className="mt-3 text-[12px] text-[#6B6B66]">No warnings issued.</p> : (
        <ul className="mt-3 divide-y divide-black/[0.06]">{warnings.map(w => (
          <li key={w.id} className="py-2 text-[12px]">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><StatusBadge status={SEV_BADGE[w.severity] ?? 'Pending'} label={w.severity} /> <span className="ml-2">{pretty(w.category)} · {day(w.issuedAt)} · {w.issuedBy}</span></div>
              {w.status === 'open' ? <AdminButton size="sm" disabled={busy} onClick={() => onResolve(w.id, '')}>Resolve</AdminButton> : <StatusBadge status="Resolved" />}</div>
            <div className="mt-1">{w.summary}</div>
            {w.internalNote && <div className="text-[11px] text-[#6B6B66]">Internal: {w.internalNote}</div>}
            {w.status === 'resolved' && <div className="text-[11px] text-[#6B6B66]">Resolved {day(w.resolvedAt)} by {w.resolvedBy}{w.resolutionNote ? ` — ${w.resolutionNote}` : ''}</div>}
          </li>))}</ul>
      )}
    </section>
  )
}

function Flags({ flags, busy, onOpen, onUpdate }: { flags: any[]; busy: boolean; onOpen: (v: any) => void; onUpdate: (id: string, v: { status?: string; note?: string; freeze?: boolean }) => void }) {
  const [signal, setSignal] = useState('other'); const [note, setNote] = useState(''); const [closeNote, setCloseNote] = useState('')
  return (
    <section className="mt-6">
      <AdminSectionHeader title="Fraud and abuse flags" info="Automatic checks only raise a question. Freezing is your decision: it blocks payouts for this affiliate but never edits a commission or the ledger. Resolving or dismissing needs a written note." />
      <AdminFieldGrid cols={4}>
        <AdminField label="Signal" htmlFor="f-sig"><select id="f-sig" className={adminInputClass} value={signal} onChange={e => setSignal(e.target.value)}>{['customer_email_matches_affiliate', 'customer_email_similar_to_affiliate', 'suspected_coupon_leakage', 'suspected_cookie_stuffing', 'suspected_duplicate_account', 'suspected_manipulated_attribution', 'other'].map(s => <option key={s} value={s}>{pretty(s)}</option>)}</select></AdminField>
        <AdminField label="Note" htmlFor="f-note" className="md:col-span-2"><input id="f-note" className={adminInputClass} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></AdminField>
        <div className="flex items-end"><AdminButton size="sm" variant="primary" loading={busy} onClick={() => { onOpen({ signal, note }); setNote('') }}>Open flag</AdminButton></div>
      </AdminFieldGrid>
      {flags.length === 0 ? <p className="mt-3 text-[12px] text-[#6B6B66]">No flags.</p> : (
        <ul className="mt-3 divide-y divide-black/[0.06]">{flags.map(f => {
          const open = f.status === 'open' || f.status === 'investigating'
          return (
            <li key={f.id} className="py-2 text-[12px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><StatusBadge status={open ? (f.severity === 'high' ? 'Unresolved' : 'Review') : 'Resolved'} label={f.status} /> <span className="ml-2 font-medium">{pretty(f.signal)}</span> <span className="text-[#6B6B66]">· {f.source} · {day(f.createdAt)}{f.orderNumber ? ` · order ${f.orderNumber}` : ''}</span>{f.freezeCommissions && <span className="ml-2"><StatusBadge status="Held" label="payouts frozen" /></span>}</div>
                {open && (
                  <div className="flex flex-wrap items-center gap-2">
                    <AdminButton size="sm" disabled={busy} onClick={() => onUpdate(f.id, { status: 'investigating' })}>Investigate</AdminButton>
                    <AdminButton size="sm" disabled={busy} onClick={() => onUpdate(f.id, { freeze: !f.freezeCommissions })}>{f.freezeCommissions ? 'Unfreeze' : 'Freeze payouts'}</AdminButton>
                    <input aria-label="Outcome note" className="h-8 w-44 rounded-[9px] border border-black/[0.14] px-2 text-[11px]" placeholder="Outcome note" value={closeNote} onChange={e => setCloseNote(e.target.value)} />
                    <AdminButton size="sm" disabled={busy || closeNote.trim().length < 5} onClick={() => { onUpdate(f.id, { status: 'resolved', note: closeNote }); setCloseNote('') }}>Resolve</AdminButton>
                    <AdminButton size="sm" disabled={busy || closeNote.trim().length < 5} onClick={() => { onUpdate(f.id, { status: 'dismissed', note: closeNote }); setCloseNote('') }}>Dismiss</AdminButton>
                  </div>)}
              </div>
              {f.note && <div className="text-[11px] text-[#6B6B66]">{f.note}</div>}
              {f.resolutionNote && <div className="text-[11px] text-[#6B6B66]">Outcome: {f.resolutionNote}</div>}
            </li>)
        })}</ul>
      )}
    </section>
  )
}

function PaidAds({ current, disabled, busy, onSave }: { current: string | null; disabled: boolean; busy: boolean; onSave: (policy: string, note: string) => void }) {
  const [policy, setPolicy] = useState(current ?? 'not_permitted'); const [note, setNote] = useState('')
  return (
    <div className="flex flex-wrap items-end gap-2">
      <AdminField label="Permission" htmlFor="pa-pol"><select id="pa-pol" className={adminInputClass} disabled={disabled} value={policy} onChange={e => setPolicy(e.target.value)}><option value="not_permitted">Not permitted</option><option value="written_approval">Written approval required</option><option value="approved">Approved</option></select></AdminField>
      <AdminField label="Note" htmlFor="pa-note"><input id="pa-note" className={adminInputClass} disabled={disabled} maxLength={200} value={note} onChange={e => setNote(e.target.value)} /></AdminField>
      <AdminButton size="sm" variant="primary" loading={busy} disabled={disabled || policy === current} onClick={() => onSave(policy, note)}>Save</AdminButton>
    </div>
  )
}

function ReviewLog({ reviews, busy, onRecord }: { reviews: any[]; busy: boolean; onRecord: (outcome: string, note: string) => void }) {
  const [outcome, setOutcome] = useState('no_issues'); const [note, setNote] = useState('')
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <AdminField label="Outcome" htmlFor="rv-o"><select id="rv-o" className={adminInputClass} value={outcome} onChange={e => setOutcome(e.target.value)}><option value="no_issues">No issues</option><option value="issues_found">Issues found</option><option value="follow_up">Follow up</option></select></AdminField>
        <AdminField label="Note" htmlFor="rv-n"><input id="rv-n" className={adminInputClass} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></AdminField>
        <AdminButton size="sm" variant="primary" loading={busy} onClick={() => { onRecord(outcome, note); setNote('') }}>Record review</AdminButton>
      </div>
      {reviews.length === 0 ? <p className="mt-2 text-[12px] text-[#6B6B66]">Never reviewed.</p> : <ul className="mt-2 space-y-0.5 text-[12px]">{reviews.map((r, i) => <li key={i}>{day(r.at)} · {pretty(r.outcome)} · {r.by}{r.note ? ` — ${r.note}` : ''}</li>)}</ul>}
    </div>
  )
}

const RIGHTS: Array<[string, string]> = [['organic', 'Organic social'], ['website', 'Website'], ['email', 'Email'], ['paid_ads', 'Paid ads'], ['whitelisting', 'Whitelisting'], ['editing', 'Editing'], ['likeness', 'Name and likeness']]
function Ugc({ licenses, busy, onGrant, onRevoke }: { licenses: any[] | null; busy: boolean; onGrant: (v: any) => Promise<boolean>; onRevoke: (id: string, reason: string) => void }) {
  const [rights, setRights] = useState<Record<string, boolean>>({})
  const [version, setVersion] = useState('v1'); const [territory, setTerritory] = useState('Worldwide'); const [months, setMonths] = useState('')
  const [evidence, setEvidence] = useState(''); const [comp, setComp] = useState(''); const [reason, setReason] = useState('')
  return (
    <section className="mt-6 border-t border-black/[0.08] pt-4">
      <AdminSectionHeader title="Content rights (UGC)" info="Being an affiliate, or receiving product, gives KVRN no right to reuse their content. A right exists only when you record a license here. Licenses cannot be edited; revoke and record a new one." />
      <AdminNotice tone="info">Nothing is granted by default.</AdminNotice>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">{RIGHTS.map(([k, label]) => <label key={k} className="flex items-center gap-1.5 text-[12px]"><input type="checkbox" checked={!!rights[k]} onChange={e => setRights({ ...rights, [k]: e.target.checked })} />{label}</label>)}</div>
      <AdminFieldGrid cols={4}>
        <AdminField label="Version" htmlFor="u-v"><input id="u-v" className={adminInputClass} maxLength={40} value={version} onChange={e => setVersion(e.target.value)} /></AdminField>
        <AdminField label="Territory" htmlFor="u-t"><input id="u-t" className={adminInputClass} maxLength={80} value={territory} onChange={e => setTerritory(e.target.value)} /></AdminField>
        <AdminField label="Months" htmlFor="u-m" hint="Blank = no end"><input id="u-m" className={adminInputClass} inputMode="numeric" value={months} onChange={e => setMonths(e.target.value.replace(/\D/g, ''))} /></AdminField>
        <AdminField label="Agreement reference" htmlFor="u-e" hint="Where the signed copy lives"><input id="u-e" className={adminInputClass} maxLength={200} value={evidence} onChange={e => setEvidence(e.target.value)} /></AdminField>
        <AdminField label="Compensation" htmlFor="u-c"><input id="u-c" className={adminInputClass} maxLength={500} value={comp} onChange={e => setComp(e.target.value)} /></AdminField>
      </AdminFieldGrid>
      <AdminButton className="mt-2" size="sm" variant="primary" loading={busy} disabled={!Object.values(rights).some(Boolean)}
        onClick={async () => { const ok = await onGrant({ licenseVersion: version, rights, territory, durationMonths: months ? Number(months) : null, evidenceRef: evidence || null, compensationNote: comp || null, channels: [] }); if (ok) setRights({}) }}>Record license</AdminButton>
      {licenses === null ? <AdminLoading /> : licenses.length === 0 ? <p className="mt-3 text-[12px] text-[#6B6B66]">No licenses. No content rights.</p> : (
        <ul className="mt-3 divide-y divide-black/[0.06]">{licenses.map(l => (
          <li key={l.id} className="py-2 text-[12px]">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><StatusBadge status={l.active ? 'Active' : l.revokedAt ? 'Inactive' : 'Scheduled'} label={l.revokedAt ? 'revoked' : l.active ? 'active' : 'not active'} /> <span className="ml-2">{l.licenseVersion} · {l.territory} · from {day(l.startsAt)}{l.expiresAt ? ` to ${day(l.expiresAt)}` : ''}</span></div>
              {!l.revokedAt && <div className="flex items-center gap-2"><input aria-label="Revoke reason" className="h-8 w-40 rounded-[9px] border border-black/[0.14] px-2 text-[11px]" placeholder="Reason" value={reason} onChange={e => setReason(e.target.value)} /><AdminButton size="sm" variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => onRevoke(l.id, reason)}>Revoke</AdminButton></div>}</div>
            <div className="text-[11px] text-[#6B6B66]">{Object.entries(l.rights).filter(([, v]) => v).map(([k]) => pretty(k)).join(', ')} · granted {day(l.grantedAt)} by {l.grantedBy}{l.evidenceRef ? ` · ref ${l.evidenceRef}` : ''}{l.revokedAt ? ` · revoked ${day(l.revokedAt)}: ${l.revokeReason ?? ''}` : ''}</div>
          </li>))}</ul>
      )}
    </section>
  )
}

function Suspend({ busy, onSuspend }: { busy: boolean; onSuspend: (reason: string, revokePortal: boolean) => void }) {
  const [reason, setReason] = useState(''); const [revoke, setRevoke] = useState(true)
  return (
    <div className="flex flex-wrap items-end gap-3">
      <AdminField label="Reason" htmlFor="s-r"><input id="s-r" className={adminInputClass} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} /></AdminField>
      <label className="flex items-center gap-1.5 pb-2 text-[12px]"><input type="checkbox" checked={revoke} onChange={e => setRevoke(e.target.checked)} /> Also revoke portal access</label>
      <AdminButton size="sm" variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => onSuspend(reason, revoke)}>Suspend</AdminButton>
    </div>
  )
}
