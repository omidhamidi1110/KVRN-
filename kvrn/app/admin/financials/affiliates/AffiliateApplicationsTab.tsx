'use client'
// Applications: review queue, application detail with approve / reject / request-info, and invitations.
// An invitation only pre-fills the form. Nothing is ever approved automatically.

import { useCallback, useEffect, useState } from 'react'
import {
  AdminButton, AdminCard, AdminEmpty, AdminError, AdminField, AdminLoading, AdminNotice, AdminSectionHeader,
  AdminTable, AdminTd, AdminTh, InfoTip, StatusBadge, adminInputClass, useConfirm,
} from '@/components/admin/ui/AdminUI'
import { safeExternalHref } from '@/lib/affiliate-application-input'
import {
  applicationStatusBadge, availableApplicationActions, approvalFormToConfig, defaultApprovalForm, duplicateFlagLabel,
  duplicateFlagTone, emailStatusBadge, formatDate, formatDateTime, readinessMessage, type ApprovalForm,
} from '@/lib/affiliate-program-ui'
import { adminApi } from './api'

const DOC_LABEL: Record<string, string> = {
  program_terms: 'Program terms', disclosure_policy: 'Disclosure policy', privacy_notice: 'Privacy notice', brand_rules: 'Brand rules', ugc_license: 'Content license',
}

export function AffiliateApplicationsTab({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [readiness, setReadiness] = useState<any>(null)
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [invites, setInvites] = useState<any[]>([])
  const [showInvite, setShowInvite] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [a, i] = await Promise.all([
      adminApi(`/api/admin/affiliates/applications${filter ? `?status=${filter}` : ''}`),
      adminApi('/api/admin/affiliates/invites'),
    ])
    if (!a.ok) { setErr(a.error); return }
    setErr(null); setRows(a.data.applications); setReadiness(a.data.readiness)
    if (i.ok) setInvites(i.data.invites)
  }, [filter])
  useEffect(() => { void load() }, [load])

  const ready = readinessMessage(readiness)
  const changed = () => { void load(); onChanged?.() }

  return (
    <div className="space-y-5">
      <AdminNotice tone={ready.tone} title={ready.title}>
        {ready.reasons.length > 0 && <ul className="list-disc pl-5">{ready.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
      </AdminNotice>
      {flash && <AdminNotice tone="success">{flash}</AdminNotice>}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <AdminField label="Show" htmlFor="app-filter">
          <select id="app-filter" className={`${adminInputClass} w-48`} value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">All applications</option>
            <option value="pending">New</option>
            <option value="under_review">In review</option>
            <option value="needs_info">Needs info</option>
            <option value="approved_onboarding">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </AdminField>
        <AdminButton variant="primary" onClick={() => setShowInvite(s => !s)}>{showInvite ? 'Close invite' : 'Invite a creator'}</AdminButton>
      </div>

      {showInvite && <InvitePanel onDone={(msg) => { setFlash(msg); setShowInvite(false); changed() }} />}

      {err && <AdminError message={err} onRetry={() => void load()} />}
      {!rows && !err && <AdminLoading />}
      {rows && rows.length === 0 && <AdminEmpty title="No applications" description="Applications appear here after someone applies." />}
      {rows && rows.length > 0 && (
        <AdminTable caption="Applications" stack>
          <thead><tr><AdminTh>Applicant</AdminTh><AdminTh>Audience</AdminTh><AdminTh>Country</AdminTh><AdminTh>Flags</AdminTh><AdminTh>Submitted</AdminTh><AdminTh>Status</AdminTh><AdminTh /></tr></thead>
          <tbody>
            {rows.map(r => {
              const b = applicationStatusBadge(r.status)
              return (
                <tr key={r.id}>
                  <AdminTd>
                    <div className="font-medium">{r.displayName || r.applicantName}</div>
                    <div className="text-[11px] text-[#6B6B66] break-all">{r.email}</div>
                    {r.invited && <span className="text-[10px] uppercase tracking-[0.08em] text-[#6B6B66]">Invited</span>}
                  </AdminTd>
                  <AdminTd>{r.audienceSize != null ? r.audienceSize.toLocaleString('en-US') : '—'}</AdminTd>
                  <AdminTd>{r.country ?? '—'}</AdminTd>
                  <AdminTd>{r.flagCount > 0 ? <StatusBadge status={r.highFlags > 0 ? 'Exception' : 'Review'} label={`${r.flagCount} flag${r.flagCount === 1 ? '' : 's'}`} /> : '—'}</AdminTd>
                  <AdminTd>{formatDate(r.createdAt)}</AdminTd>
                  <AdminTd><StatusBadge status={b.status} label={b.label} /></AdminTd>
                  <AdminTd><AdminButton size="sm" onClick={() => setOpenId(openId === r.id ? null : r.id)}>{openId === r.id ? 'Close' : 'Review'}</AdminButton></AdminTd>
                </tr>
              )
            })}
          </tbody>
        </AdminTable>
      )}
      {openId && <ApplicationDetail key={openId} id={openId} onChanged={changed} onClose={() => setOpenId(null)} />}

      <div>
        <AdminSectionHeader title="Invitations" info="An invitation emails a private link that pre-fills the application. The invitee still applies, accepts every document and is reviewed. Links work once and expire." />
        {invites.length === 0 ? <AdminEmpty title="No invitations yet" /> : (
          <AdminTable caption="Invitations" stack>
            <thead><tr><AdminTh>Email</AdminTh><AdminTh>Name</AdminTh><AdminTh>Status</AdminTh><AdminTh>Email</AdminTh><AdminTh>Expires</AdminTh><AdminTh /></tr></thead>
            <tbody>
              {invites.map(i => <InviteRow key={i.id} inv={i} onChanged={changed} setFlash={setFlash} />)}
            </tbody>
          </AdminTable>
        )}
      </div>
    </div>
  )
}

function InviteRow({ inv, onChanged, setFlash }: { inv: any; onChanged: () => void; setFlash: (s: string) => void }) {
  const [busy, setBusy] = useState(false)
  const { confirm, node } = useConfirm()
  const eb = emailStatusBadge(inv.emailStatus)
  const act = async (action: 'resend' | 'revoke') => {
    if (action === 'revoke' && !(await confirm('Revoke this invitation? The link stops working immediately.'))) return
    setBusy(true)
    const r = await adminApi('/api/admin/affiliates/invites', { body: { action, inviteId: inv.id } })
    setBusy(false)
    setFlash(r.ok ? (action === 'resend' ? (r.data.email === 'sent' ? 'Invitation re-sent.' : 'A new link was created, but the email could not be sent.') : 'Invitation revoked.') : (r.error ?? 'Failed.'))
    onChanged()
  }
  return (
    <tr>
      <AdminTd><span className="break-all">{inv.email}</span></AdminTd>
      <AdminTd>{inv.displayName}</AdminTd>
      <AdminTd><span className="capitalize">{inv.status}</span></AdminTd>
      <AdminTd><StatusBadge status={eb.status} label={eb.label} />{inv.emailStatus === 'held' && <div className="mt-1 text-[11px] text-[#6B6B66]">Not emailed: applications are turned off.</div>}</AdminTd>
      <AdminTd>{formatDate(inv.expiresAt)}</AdminTd>
      <AdminTd>
        {(inv.status === 'open' || inv.status === 'expired') && (
          <div className="flex gap-2">
            <AdminButton size="sm" disabled={busy} onClick={() => void act('resend')}>Resend</AdminButton>
            {inv.status === 'open' && <AdminButton size="sm" variant="danger" disabled={busy} onClick={() => void act('revoke')}>Revoke</AdminButton>}
          </div>
        )}
        {node}
      </AdminTd>
    </tr>
  )
}

function InvitePanel({ onDone }: { onDone: (msg: string) => void }) {
  const [f, setF] = useState({ email: '', displayName: '', social: '', proposedCode: '', rate: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF(p => ({ ...p, [k]: v }))
  const submit = async () => {
    setBusy(true); setErr(null)
    const rate = f.rate.trim() ? Math.round(Number(f.rate) * 100) : null
    const r = await adminApi('/api/admin/affiliates/invites', {
      body: {
        action: 'create',
        invite: {
          email: f.email, displayName: f.displayName, socialUrls: f.social.split(/\s+/).filter(Boolean), proposedCode: f.proposedCode,
          internalNote: f.note, commissionType: rate ? 'percentage' : undefined, commissionRateBps: rate,
        },
      },
    })
    setBusy(false)
    if (!r.ok) { setErr(r.error); return }
    onDone(r.data.email === 'sent' ? 'Invitation sent.' : r.data.email === 'held' ? 'Invitation saved. It was not emailed because applications are turned off.' : 'Invitation saved, but the email could not be sent. Use Resend.')
  }
  return (
    <AdminCard>
      <AdminSectionHeader title="Invite a creator" info="Proposed terms are suggestions shown to you at approval. They are not offered to the creator until you approve." />
      {err && <AdminNotice tone="danger" className="mb-3">{err}</AdminNotice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <AdminField label="Email" htmlFor="inv-email"><input id="inv-email" type="email" className={adminInputClass} value={f.email} onChange={e => set('email', e.target.value)} /></AdminField>
        <AdminField label="Name" htmlFor="inv-name"><input id="inv-name" className={adminInputClass} value={f.displayName} onChange={e => set('displayName', e.target.value)} /></AdminField>
        <AdminField label="Social links" htmlFor="inv-social" hint="Separate with spaces."><input id="inv-social" className={adminInputClass} value={f.social} onChange={e => set('social', e.target.value)} /></AdminField>
        <AdminField label="Proposed code" htmlFor="inv-code"><input id="inv-code" className={adminInputClass} value={f.proposedCode} onChange={e => set('proposedCode', e.target.value.toUpperCase())} /></AdminField>
        <AdminField label="Proposed commission (%)" htmlFor="inv-rate" info="Percent of net merchandise. Entered as a percent and stored in basis points (1% = 100)."><input id="inv-rate" inputMode="decimal" className={adminInputClass} value={f.rate} onChange={e => set('rate', e.target.value)} /></AdminField>
        <AdminField label="Internal note" htmlFor="inv-note" hint="Never sent to the creator."><input id="inv-note" className={adminInputClass} value={f.note} onChange={e => set('note', e.target.value)} /></AdminField>
      </div>
      <div className="mt-4"><AdminButton variant="primary" loading={busy} onClick={() => void submit()}>Create invitation</AdminButton></div>
    </AdminCard>
  )
}

function ApplicationDetail({ id, onChanged, onClose }: { id: string; onChanged: () => void; onClose: () => void }) {
  const [a, setA] = useState<any>(null)
  const [defaults, setDefaults] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<null | 'approve' | 'reject' | 'request_info'>(null)
  const [msg, setMsg] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<ApprovalForm | null>(null)
  const { confirm, node } = useConfirm()

  const load = useCallback(async () => {
    const [r, s] = await Promise.all([adminApi(`/api/admin/affiliates/applications/${id}`), adminApi('/api/admin/affiliates/settings')])
    if (!r.ok) { setErr(r.error); return }
    setA(r.data.application); if (s.ok) setDefaults(s.data.settings.defaults)
  }, [id])
  useEffect(() => { void load() }, [load])

  const run = async (body: Record<string, unknown>, success?: string) => {
    setBusy(true); setErr(null)
    const r = await adminApi(`/api/admin/affiliates/applications/${id}`, { body })
    setBusy(false)
    if (!r.ok) { setErr(r.error); return false }
    setMode(null); setMsg(''); setNote('')
    if (success) setErr(null)
    await load(); onChanged()
    return true
  }

  if (err && !a) return <AdminError message={err} onRetry={() => void load()} />
  if (!a) return <AdminLoading />
  const actions = availableApplicationActions(a.status)
  const badge = applicationStatusBadge(a.status)
  const upd = (k: keyof ApprovalForm, v: any) => setForm(p => (p ? { ...p, [k]: v } : p))

  const startApprove = () => {
    setForm(defaultApprovalForm(
      { preferredCode: a.preferredCode, invite: a.invite },
      defaults ?? { commissionType: 'percentage', commissionRateBps: null, attributionWindowDays: 30, commissionHoldDays: 30, payoutThresholdCents: null, payoutSchedule: null, paidAdsPolicy: 'not_permitted' }))
    setMode('approve')
  }

  return (
    <AdminCard>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-medium">{a.displayName || a.applicantName}</h3>
          <p className="text-[12px] text-[#6B6B66] break-all">{a.email} · submitted {formatDateTime(a.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2"><StatusBadge status={badge.status} label={badge.label} /><AdminButton size="sm" variant="ghost" onClick={onClose}>Close</AdminButton></div>
      </div>
      {err && <AdminNotice tone="danger" className="mt-3">{err}</AdminNotice>}
      {a.anonymizedAt && <AdminNotice className="mt-3">Personal details were removed on {formatDate(a.anonymizedAt)}.</AdminNotice>}

      {a.duplicateFlags.length > 0 && (
        <div className="mt-4 space-y-2">
          {a.duplicateFlags.map((f: any, i: number) => (
            <AdminNotice key={i} tone={duplicateFlagTone(f.severity) === 'danger' ? 'danger' : duplicateFlagTone(f.severity) === 'warning' ? 'warning' : 'info'} title={duplicateFlagLabel(f.kind)} />
          ))}
        </div>
      )}

      <dl className="mt-4 grid gap-x-6 gap-y-3 text-[12px] sm:grid-cols-2">
        <Item k="Legal name" v={a.applicantName} /><Item k="Country" v={[a.stateRegion, a.country].filter(Boolean).join(', ')} />
        <Item k="Audience" v={a.audienceSize != null ? a.audienceSize.toLocaleString('en-US') : '—'} /><Item k="Content" v={a.contentCategory} />
        <Item k="Preferred code" v={a.preferredCode} /><Item k="Heard about us" v={a.heardAbout} />
        <div className="sm:col-span-2">
          <dt className="text-[11px] font-medium text-[#6B6B66]">Social profiles</dt>
          <dd className="mt-0.5 flex flex-col gap-0.5">
            {a.socialLinks.length === 0 ? '—' : a.socialLinks.map((s: any) => {
              const href = safeExternalHref(s.url)
              return href ? <a key={s.key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="break-all underline underline-offset-2">{s.platform}: {s.handle}</a> : <span key={s.key} className="break-all">{s.platform}: {s.handle}</span>
            })}
          </dd>
        </div>
        {a.website && <div className="sm:col-span-2"><dt className="text-[11px] font-medium text-[#6B6B66]">Website</dt><dd className="break-all">{safeExternalHref(a.website) ? <a href={safeExternalHref(a.website)!} target="_blank" rel="noopener noreferrer nofollow ugc" className="underline underline-offset-2">{a.website}</a> : a.website}</dd></div>}
        <div className="sm:col-span-2"><Item k="Why KVRN" v={a.motivation} /></div>
        <div className="sm:col-span-2"><Item k="How they would promote" v={a.promotionPlan} /></div>
        {a.applicantNotes && <div className="sm:col-span-2"><Item k="Applicant notes" v={a.applicantNotes} /></div>}
      </dl>

      <div className="mt-4">
        <h4 className="text-[12px] font-medium">Acceptances</h4>
        <ul className="mt-1 text-[12px] text-[#4A4A46]">
          <li>18 or older: {a.ageAttested ? `confirmed ${formatDate(a.ageAttestedAt)}` : 'not confirmed'}</li>
          <li>Information accurate: {a.accuracyConfirmedAt ? `confirmed ${formatDate(a.accuracyConfirmedAt)}` : 'not confirmed'}</li>
          <li>Electronic signatures: {a.esignConsentedAt ? `agreed ${formatDate(a.esignConsentedAt)}` : 'not agreed'}</li>
          {a.acceptances.map((x: any) => <li key={x.docType}>{DOC_LABEL[x.docType] ?? x.docType} {x.version}: accepted {formatDate(x.acceptedAt)}</li>)}
        </ul>
      </div>

      {a.invite && (
        <AdminNotice className="mt-4" title="Invitation proposal">
          Proposed code {a.invite.proposedCode || '—'}; commission {a.invite.commissionType === 'percentage' && a.invite.commissionRateBps != null ? `${a.invite.commissionRateBps / 100}%` : a.invite.commissionType === 'fixed' && a.invite.commissionFixedCents != null ? `$${(a.invite.commissionFixedCents / 100).toFixed(2)}` : '—'}. These are suggestions and are pre-filled below; nothing was offered to the creator.
        </AdminNotice>
      )}

      {actions.length > 0 && !mode && (
        <div className="mt-5 flex flex-wrap gap-2">
          {actions.includes('approve') && <AdminButton variant="primary" disabled={busy} onClick={startApprove}>Approve…</AdminButton>}
          {actions.includes('under_review') && <AdminButton disabled={busy} onClick={() => void run({ action: 'under_review' })}>Mark in review</AdminButton>}
          {actions.includes('request_info') && <AdminButton disabled={busy} onClick={() => setMode('request_info')}>Ask for more info…</AdminButton>}
          {actions.includes('reject') && <AdminButton variant="danger" disabled={busy} onClick={() => setMode('reject')}>Reject…</AdminButton>}
          {actions.includes('withdraw') && <AdminButton variant="ghost" disabled={busy} onClick={async () => { if (await confirm('Mark this application as withdrawn? No email is sent.')) void run({ action: 'withdraw' }) }}>Withdraw</AdminButton>}
          {actions.includes('anonymize') && <AdminButton variant="danger" disabled={busy} onClick={async () => { if (await confirm('Remove this applicant’s personal details permanently? The decision and audit trail are kept, but name, email, links and answers are erased and cannot be recovered.')) void run({ action: 'anonymize' }) }}>Remove personal details</AdminButton>}
        </div>
      )}

      {mode === 'request_info' && (
        <div className="mt-5 space-y-3">
          <AdminField label="Question for the applicant" htmlFor="ri-msg" hint="Emailed to the applicant. They reply to that email."><textarea id="ri-msg" rows={3} className={`${adminInputClass} h-auto py-2`} value={msg} onChange={e => setMsg(e.target.value)} /></AdminField>
          <div className="flex gap-2"><AdminButton variant="primary" loading={busy} disabled={!msg.trim()} onClick={() => void run({ action: 'request_info', message: msg })}>Send question</AdminButton><AdminButton variant="ghost" onClick={() => setMode(null)}>Cancel</AdminButton></div>
        </div>
      )}

      {mode === 'reject' && (
        <div className="mt-5 space-y-3">
          <AdminNotice tone="warning">The message below is emailed to the applicant. Your internal notes are never included. No affiliate is created.</AdminNotice>
          <AdminField label="Message to the applicant (optional)" htmlFor="rj-msg"><textarea id="rj-msg" rows={3} className={`${adminInputClass} h-auto py-2`} value={msg} onChange={e => setMsg(e.target.value)} /></AdminField>
          <div className="flex gap-2"><AdminButton variant="danger" loading={busy} onClick={async () => { if (await confirm('Reject this application? The applicant is emailed the decision.')) void run({ action: 'reject', message: msg }) }}>Reject application</AdminButton><AdminButton variant="ghost" onClick={() => setMode(null)}>Cancel</AdminButton></div>
        </div>
      )}

      {mode === 'approve' && form && (
        <div className="mt-5 space-y-4 rounded-[12px] border border-black/[0.08] p-4">
          <AdminNotice title="Approving creates the affiliate in onboarding">
            The discount code stays off until you activate. Activation needs the affiliate to have accepted the current terms and disclosure policy (recorded from this application) and the start date to have passed.
          </AdminNotice>
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminField label="Discount code" htmlFor="ap-code" info="Letters, numbers, hyphen or underscore, 2–32 characters. Customers type this at checkout. It cannot clash with an existing discount code."><input id="ap-code" className={adminInputClass} value={form.code} onChange={e => upd('code', e.target.value.toUpperCase())} /></AdminField>
            <AdminField label="Referral link name" htmlFor="ap-slug" hint="Optional. Lowercase letters, numbers, hyphens."><input id="ap-slug" className={adminInputClass} value={form.linkSlug} onChange={e => upd('linkSlug', e.target.value.toLowerCase())} /></AdminField>
            <AdminField label="Commission type" htmlFor="ap-ctype">
              <select id="ap-ctype" className={adminInputClass} value={form.commissionType} onChange={e => upd('commissionType', e.target.value)}><option value="percentage">Percentage</option><option value="fixed">Fixed per order</option></select>
            </AdminField>
            {form.commissionType === 'percentage'
              ? <AdminField label="Commission (%)" htmlFor="ap-rate" info="Percent of net merchandise after customer discounts, excluding shipping and tax. Stored in basis points (1% = 100)."><input id="ap-rate" inputMode="decimal" className={adminInputClass} value={form.ratePercent} onChange={e => upd('ratePercent', e.target.value)} /></AdminField>
              : <AdminField label="Commission ($ per order)" htmlFor="ap-fixed"><input id="ap-fixed" inputMode="decimal" className={adminInputClass} value={form.fixedDollars} onChange={e => upd('fixedDollars', e.target.value)} /></AdminField>}
            <AdminField label="Attribution window (days)" htmlFor="ap-win" info="How long after a click or code use an order can still be credited."><input id="ap-win" inputMode="numeric" className={adminInputClass} value={form.windowDays} onChange={e => upd('windowDays', e.target.value)} /></AdminField>
            <AdminField label="Commission hold (days)" htmlFor="ap-hold" info="Days a commission waits before it can be paid, to cover returns."><input id="ap-hold" inputMode="numeric" className={adminInputClass} value={form.holdDays} onChange={e => upd('holdDays', e.target.value)} /></AdminField>
            <AdminField label="Customer discount" htmlFor="ap-dtype">
              <select id="ap-dtype" className={adminInputClass} value={form.discountType} onChange={e => upd('discountType', e.target.value)}><option value="">None</option><option value="percentage">Percentage</option><option value="fixed_amount">Fixed amount</option></select>
            </AdminField>
            {form.discountType === 'percentage' && <AdminField label="Discount (%)" htmlFor="ap-dpct"><input id="ap-dpct" inputMode="decimal" className={adminInputClass} value={form.discountPercent} onChange={e => upd('discountPercent', e.target.value)} /></AdminField>}
            {form.discountType === 'fixed_amount' && <AdminField label="Discount ($)" htmlFor="ap-dusd"><input id="ap-dusd" inputMode="decimal" className={adminInputClass} value={form.discountDollars} onChange={e => upd('discountDollars', e.target.value)} /></AdminField>}
            <AdminField label="Payout threshold ($)" htmlFor="ap-thr" hint="Optional."><input id="ap-thr" inputMode="decimal" className={adminInputClass} value={form.payoutThresholdDollars} onChange={e => upd('payoutThresholdDollars', e.target.value)} /></AdminField>
            <AdminField label="Payout schedule" htmlFor="ap-sched">
              <select id="ap-sched" className={adminInputClass} value={form.payoutSchedule} onChange={e => upd('payoutSchedule', e.target.value)}><option value="">Not set</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="manual">Manual</option></select>
            </AdminField>
            <AdminField label="Paid ads" htmlFor="ap-ads" info="Whether the affiliate may run paid advertising that uses KVRN’s name or code.">
              <select id="ap-ads" className={adminInputClass} value={form.paidAdsPolicy} onChange={e => upd('paidAdsPolicy', e.target.value)}><option value="not_permitted">Not permitted</option><option value="written_approval">Written approval needed</option><option value="approved">Approved</option></select>
            </AdminField>
            <AdminField label="Start date" htmlFor="ap-start" hint="Optional. Activation waits until this date."><input id="ap-start" type="date" className={adminInputClass} value={form.startAt} onChange={e => upd('startAt', e.target.value)} /></AdminField>
            <AdminField label="End date" htmlFor="ap-end" hint="Optional. The affiliate is terminated automatically after this date."><input id="ap-end" type="date" className={adminInputClass} value={form.endAt} onChange={e => upd('endAt', e.target.value)} /></AdminField>
          </div>
          <AdminField label="Message to the applicant (optional)" htmlFor="ap-msg"><textarea id="ap-msg" rows={2} className={`${adminInputClass} h-auto py-2`} value={form.approvalMessage} onChange={e => upd('approvalMessage', e.target.value)} /></AdminField>
          <AdminField label="Internal note (optional)" htmlFor="ap-note" hint="Never emailed."><textarea id="ap-note" rows={2} className={`${adminInputClass} h-auto py-2`} value={form.internalNote} onChange={e => upd('internalNote', e.target.value)} /></AdminField>
          <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" className="mt-0.5" checked={form.activateNow} onChange={e => upd('activateNow', e.target.checked)} /><span>Activate immediately after approval (only if every requirement is met).</span></label>
          <div className="flex gap-2">
            <AdminButton variant="primary" loading={busy} onClick={() => void run({ action: 'approve', config: approvalFormToConfig(form) })}>Approve and create affiliate</AdminButton>
            <AdminButton variant="ghost" onClick={() => setMode(null)}>Cancel</AdminButton>
          </div>
        </div>
      )}

      <div className="mt-6">
        <h4 className="flex items-center text-[12px] font-medium">Internal notes<InfoTip label="About internal notes">Notes are visible to Admin only. They are never included in any email.</InfoTip></h4>
        <ul className="mt-2 space-y-2 text-[12px]">
          {a.notes.length === 0 && <li className="text-[#6B6B66]">No notes yet.</li>}
          {a.notes.map((n: any) => <li key={n.id} className="rounded-[9px] bg-[#FAFAF8] px-3 py-2"><div className="whitespace-pre-wrap">{n.body}</div><div className="mt-1 text-[10px] text-[#8A8A85]">{n.author} · {formatDateTime(n.createdAt)}</div></li>)}
        </ul>
        <div className="mt-2 flex gap-2">
          <input aria-label="Add an internal note" className={adminInputClass} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note" />
          <AdminButton disabled={busy || !note.trim()} onClick={() => void run({ action: 'add_note', note })}>Add</AdminButton>
        </div>
      </div>

      {a.history.length > 0 && (
        <div className="mt-6">
          <h4 className="text-[12px] font-medium">History</h4>
          <ul className="mt-1 space-y-0.5 text-[11px] text-[#6B6B66]">
            {a.history.map((h: any, i: number) => <li key={i}>{formatDateTime(h.at)} · {h.action} · {h.actor}</li>)}
          </ul>
        </div>
      )}
      {node}
    </AdminCard>
  )
}

function Item({ k, v }: { k: string; v: string | null | undefined }) {
  return <div><dt className="text-[11px] font-medium text-[#6B6B66]">{k}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words">{v || '—'}</dd></div>
}
