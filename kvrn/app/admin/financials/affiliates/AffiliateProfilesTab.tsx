'use client'
// Affiliates: program identity, lifecycle (activate / suspend / terminate / reinstate), settings,
// code changes and new financial terms. Suspending or terminating never changes money history.

import { useCallback, useEffect, useState } from 'react'
import {
  AdminButton, AdminCard, AdminEmpty, AdminError, AdminField, AdminLoading, AdminNotice, AdminSectionHeader,
  AdminTable, AdminTd, AdminTh, InfoTip, StatusBadge, adminInputClass, useConfirm,
} from '@/components/admin/ui/AdminUI'
import {
  PROFILE_ACTION_WARNING, availableProfileActions, bpsToPercent, centsToDollars, dollarsToCents, formatDate, formatTerms,
  percentToBps, programStatusBadge, type ProfileAction,
} from '@/lib/affiliate-program-ui'
import { adminApi } from './api'

const ACTION_LABEL: Record<ProfileAction, string> = { activate: 'Activate', suspend: 'Suspend', terminate: 'Terminate', reinstate: 'Reinstate' }

export function AffiliateProfilesTab({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await adminApi('/api/admin/affiliates/profiles')
    if (!r.ok) { setErr(r.error); return }
    setErr(null); setRows(r.data.profiles)
  }, [])
  useEffect(() => { void load() }, [load])
  const changed = () => { void load(); onChanged?.() }

  return (
    <div className="space-y-5">
      {flash && <AdminNotice tone="success">{flash}</AdminNotice>}
      <div className="flex justify-end">
        <AdminButton variant="primary" onClick={() => setShowCreate(s => !s)}>{showCreate ? 'Close' : 'Add an affiliate manually'}</AdminButton>
      </div>
      {showCreate && <CreateAffiliate onDone={m => { setFlash(m); setShowCreate(false); changed() }} />}
      {err && <AdminError message={err} onRetry={() => void load()} />}
      {!rows && !err && <AdminLoading />}
      {rows && rows.length === 0 && <AdminEmpty title="No affiliates yet" description="Approve an application or add one manually." />}
      {rows && rows.length > 0 && (
        <AdminTable caption="Affiliates">
          <thead><tr><AdminTh>Code</AdminTh><AdminTh>Affiliate</AdminTh><AdminTh>Status</AdminTh><AdminTh>Commission</AdminTh><AdminTh>Terms accepted</AdminTh><AdminTh>Code live</AdminTh><AdminTh /></tr></thead>
          <tbody>
            {rows.map(p => {
              const b = programStatusBadge(p.programStatus)
              return (
                <tr key={p.id}>
                  <AdminTd><span className="font-mono">{p.code}</span></AdminTd>
                  <AdminTd><div className="font-medium">{p.displayName || p.name}</div><div className="text-[11px] text-[#6B6B66] break-all">{p.hasSignInEmail ? p.email : 'No sign-in email set'}</div></AdminTd>
                  <AdminTd><StatusBadge status={b.status} label={b.label} />{p.requiresReacceptance && <div className="mt-1"><StatusBadge status="Review" label="Re-accept needed" /></div>}</AdminTd>
                  <AdminTd>{formatTerms(p.commissionType, p.commissionRateBps, p.commissionFixedCents)}</AdminTd>
                  <AdminTd>{p.acceptedProgramTermsVersion ?? 'None'}</AdminTd>
                  <AdminTd>{p.discountActive && p.linkActive ? 'Yes' : p.discountActive || p.linkActive ? 'Partly' : 'No'}</AdminTd>
                  <AdminTd><AdminButton size="sm" onClick={() => setOpenId(openId === p.id ? null : p.id)}>{openId === p.id ? 'Close' : 'Manage'}</AdminButton></AdminTd>
                </tr>
              )
            })}
          </tbody>
        </AdminTable>
      )}
      {openId && rows && rows.find(r => r.id === openId) && (
        <ProfileDetail key={openId} p={rows.find(r => r.id === openId)} onChanged={changed} setFlash={setFlash} />
      )}
    </div>
  )
}

function CreateAffiliate({ onDone }: { onDone: (m: string) => void }) {
  const [f, setF] = useState({ code: '', name: '', email: '', rate: '', window: '30', hold: '30' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF(p => ({ ...p, [k]: v }))
  const submit = async () => {
    setBusy(true); setErr(null)
    const bps = percentToBps(f.rate)
    if (bps === null || Number.isNaN(bps) || bps <= 0) { setBusy(false); setErr('Enter a commission percentage.'); return }
    const r = await adminApi('/api/admin/affiliates', {
      body: { code: f.code, name: f.name, email: f.email || null, commissionType: 'percentage', commissionRateBps: bps, attributionWindowDays: Number(f.window), commissionHoldDays: Number(f.hold) },
    })
    setBusy(false)
    if (!r.ok) { setErr(r.error); return }
    onDone('Affiliate added. They are active; add a discount code in Discounts and a referral link if needed.')
  }
  return (
    <AdminCard>
      <AdminSectionHeader title="Add an affiliate manually" info="This is for people you already work with. It skips the application, so there are no recorded acceptances for them." />
      {err && <AdminNotice tone="danger" className="mb-3">{err}</AdminNotice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <AdminField label="Code" htmlFor="mc-code"><input id="mc-code" className={adminInputClass} value={f.code} onChange={e => set('code', e.target.value.toUpperCase())} /></AdminField>
        <AdminField label="Name" htmlFor="mc-name"><input id="mc-name" className={adminInputClass} value={f.name} onChange={e => set('name', e.target.value)} /></AdminField>
        <AdminField label="Email" htmlFor="mc-email"><input id="mc-email" type="email" className={adminInputClass} value={f.email} onChange={e => set('email', e.target.value)} /></AdminField>
        <AdminField label="Commission (%)" htmlFor="mc-rate"><input id="mc-rate" inputMode="decimal" className={adminInputClass} value={f.rate} onChange={e => set('rate', e.target.value)} /></AdminField>
        <AdminField label="Window (days)" htmlFor="mc-win"><input id="mc-win" inputMode="numeric" className={adminInputClass} value={f.window} onChange={e => set('window', e.target.value)} /></AdminField>
        <AdminField label="Hold (days)" htmlFor="mc-hold"><input id="mc-hold" inputMode="numeric" className={adminInputClass} value={f.hold} onChange={e => set('hold', e.target.value)} /></AdminField>
      </div>
      <div className="mt-4"><AdminButton variant="primary" loading={busy} onClick={() => void submit()}>Add affiliate</AdminButton></div>
    </AdminCard>
  )
}

function ProfileDetail({ p, onChanged, setFlash }: { p: any; onChanged: () => void; setFlash: (s: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const [notify, setNotify] = useState(true)
  const [revoke, setRevoke] = useState(false)
  const [code, setCode] = useState(p.code)
  const [email, setEmail] = useState(p.hasSignInEmail ? p.email : '')
  const [s, setS] = useState({
    displayName: p.displayName ?? '', threshold: centsToDollars(p.payoutThresholdCents), schedule: p.payoutSchedule ?? '', ads: p.paidAdsPolicy ?? 'not_permitted',
    start: p.programStartAt ? p.programStartAt.slice(0, 10) : '', end: p.programEndAt ? p.programEndAt.slice(0, 10) : '',
  })
  const [t, setT] = useState({ type: p.commissionType as string, rate: bpsToPercent(p.commissionRateBps), fixed: centsToDollars(p.commissionFixedCents), win: String(p.attributionWindowDays), hold: String(p.commissionHoldDays), effectiveAt: '', reason: '', policy: (p.fixedReversalPolicy ?? 'proportional') as string })
  const { confirm, node } = useConfirm()
  const actions = availableProfileActions(p.programStatus)
  const badge = programStatusBadge(p.programStatus)
  const orderLocked = p.orderCount > 0

  const post = async (url: string, body: unknown, ok: string) => {
    setBusy(true); setErr(null)
    const r = await adminApi(url, { body })
    setBusy(false)
    if (!r.ok) { setErr(r.error); return false }
    setFlash(ok); onChanged(); return true
  }
  const lifecycle = async (a: ProfileAction) => {
    const needsReason = a === 'terminate' || (a === 'reinstate' && p.programStatus === 'terminated')
    if (needsReason && !reason.trim()) { setErr('Give a reason first.'); return }
    if (!(await confirm(PROFILE_ACTION_WARNING[a] ?? 'Confirm this change.'))) return
    await post(`/api/admin/affiliates/profiles/${p.id}`, { action: a, reason, message, notify, revokePortal: revoke }, `${p.code}: ${ACTION_LABEL[a].toLowerCase()} done.`)
  }

  return (
    <AdminCard>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="text-[15px] font-medium">{p.displayName || p.name} <span className="font-mono text-[12px] text-[#6B6B66]">{p.code}</span></h3>
          <p className="text-[12px] text-[#6B6B66]">Since {formatDate(p.activatedAt)}{p.programEndAt ? ` · ends ${formatDate(p.programEndAt)}` : ''}</p></div>
        <StatusBadge status={badge.status} label={badge.label} />
      </div>
      {err && <AdminNotice tone="danger" className="mt-3">{err}</AdminNotice>}
      {p.programStatus === 'suspended' && <AdminNotice tone="warning" className="mt-3" title="Suspended">The discount code and referral link are off. History is unchanged.</AdminNotice>}
      {p.programStatus === 'terminated' && <AdminNotice tone="danger" className="mt-3" title="Terminated">The relationship has ended. History is kept.</AdminNotice>}
      {p.programStatus === 'onboarding' && <AdminNotice className="mt-3" title="Onboarding">The code is off until you activate. Activation needs the current terms accepted and the start date reached.</AdminNotice>}

      {actions.length > 0 && (
        <div className="mt-4 space-y-3 rounded-[12px] border border-black/[0.08] p-4">
          <h4 className="text-[12px] font-medium">Change status</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminField label="Reason" htmlFor="pf-reason" hint="Required to terminate or to reinstate a terminated affiliate. Stored in the audit log."><input id="pf-reason" className={adminInputClass} value={reason} onChange={e => setReason(e.target.value)} /></AdminField>
            <AdminField label="Message to the affiliate (optional)" htmlFor="pf-msg"><input id="pf-msg" className={adminInputClass} value={message} onChange={e => setMessage(e.target.value)} /></AdminField>
          </div>
          <div className="flex flex-wrap gap-4 text-[12px]">
            <label className="flex items-center gap-2"><input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />Email the affiliate</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={revoke} onChange={e => setRevoke(e.target.checked)} />Sign them out of the portal</label>
          </div>
          <div className="flex flex-wrap gap-2">
            {actions.map(a => <AdminButton key={a} variant={a === 'terminate' ? 'danger' : a === 'suspend' ? 'danger' : 'primary'} disabled={busy} onClick={() => void lifecycle(a)}>{ACTION_LABEL[a]}…</AdminButton>)}
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <h4 className="text-[12px] font-medium">Settings</h4>
          <AdminField label="Display name" htmlFor="ps-name"><input id="ps-name" className={adminInputClass} value={s.displayName} onChange={e => setS(x => ({ ...x, displayName: e.target.value }))} /></AdminField>
          <AdminField label="Payout threshold ($)" htmlFor="ps-thr"><input id="ps-thr" inputMode="decimal" className={adminInputClass} value={s.threshold} onChange={e => setS(x => ({ ...x, threshold: e.target.value }))} /></AdminField>
          <AdminField label="Payout schedule" htmlFor="ps-sched">
            <select id="ps-sched" className={adminInputClass} value={s.schedule} onChange={e => setS(x => ({ ...x, schedule: e.target.value }))}><option value="">Not set</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="manual">Manual</option></select>
          </AdminField>
          <AdminField label="Paid ads" htmlFor="ps-ads">
            <select id="ps-ads" className={adminInputClass} value={s.ads} onChange={e => setS(x => ({ ...x, ads: e.target.value }))}><option value="not_permitted">Not permitted</option><option value="written_approval">Written approval needed</option><option value="approved">Approved</option></select>
          </AdminField>
          <div className="grid grid-cols-2 gap-3">
            <AdminField label="Start date" htmlFor="ps-start"><input id="ps-start" type="date" className={adminInputClass} value={s.start} onChange={e => setS(x => ({ ...x, start: e.target.value }))} /></AdminField>
            <AdminField label="End date" htmlFor="ps-end"><input id="ps-end" type="date" className={adminInputClass} value={s.end} onChange={e => setS(x => ({ ...x, end: e.target.value }))} /></AdminField>
          </div>
          <AdminButton variant="primary" loading={busy} onClick={() => {
            const thr = dollarsToCents(s.threshold)
            if (Number.isNaN(thr)) { setErr('Payout threshold is not valid.'); return }
            void post(`/api/admin/affiliates/profiles/${p.id}`, { action: 'settings', settings: {
              displayName: s.displayName, payoutThresholdCents: thr, payoutSchedule: s.schedule || null, paidAdsPolicy: s.ads,
              programStartAt: s.start ? new Date(s.start).toISOString() : null, programEndAt: s.end ? new Date(s.end).toISOString() : null } }, 'Settings saved.')
          }}>Save settings</AdminButton>
        </div>

        <div className="space-y-5">
          <div className="space-y-3">
            <h4 className="flex items-center text-[12px] font-medium">Code<InfoTip label="About changing a code">A code can change only while it has never been used on an order, because orders are credited by the code text.</InfoTip></h4>
            <div className="flex gap-2">
              <input aria-label="Discount code" className={adminInputClass} value={code} onChange={e => setCode(e.target.value.toUpperCase())} disabled={orderLocked} />
              <AdminButton disabled={busy || orderLocked || code === p.code} onClick={() => void post(`/api/admin/affiliates/profiles/${p.id}`, { action: 'change_code', code }, 'Code changed.')}>Change</AdminButton>
            </div>
            {orderLocked && <p className="text-[11px] text-[#92400E]">This code has been used on {p.orderCount} order{p.orderCount === 1 ? '' : 's'} and is locked.</p>}
          </div>
          <div className="space-y-3">
            <h4 className="text-[12px] font-medium">Sign-in email</h4>
            <div className="flex gap-2">
              <input aria-label="Sign-in email" type="email" className={adminInputClass} value={email} onChange={e => setEmail(e.target.value)} />
              <AdminButton disabled={busy || !email.trim()} onClick={() => void post(`/api/admin/affiliates/profiles/${p.id}`, { action: 'set_email', email }, 'Email updated.')}>Save</AdminButton>
            </div>
          </div>
          <div className="space-y-2">
            <h4 className="text-[12px] font-medium">Terms</h4>
            <p className="text-[12px] text-[#4A4A46]">Accepted: program terms {p.acceptedProgramTermsVersion ?? 'none'}, disclosure policy {p.acceptedDisclosureVersion ?? 'none'}.</p>
            <AdminButton size="sm" disabled={busy} onClick={() => void post(`/api/admin/affiliates/profiles/${p.id}`, { action: 'request_reacceptance' }, 'Re-acceptance requested.')}>Ask to re-accept current terms</AdminButton>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-3 rounded-[12px] border border-black/[0.08] p-4">
        <h4 className="flex items-center text-[12px] font-medium">New commission terms<InfoTip label="About new terms">New terms apply to orders from the effective date forward. Earlier orders keep the terms that applied when they were placed. Nothing already earned changes.</InfoTip></h4>
        <div className="grid gap-3 sm:grid-cols-3">
          <AdminField label="Type" htmlFor="pt-type"><select id="pt-type" className={adminInputClass} value={t.type} onChange={e => setT(x => ({ ...x, type: e.target.value }))}><option value="percentage">Percentage</option><option value="fixed">Fixed per order</option></select></AdminField>
          {t.type === 'percentage'
            ? <AdminField label="Commission (%)" htmlFor="pt-rate"><input id="pt-rate" inputMode="decimal" className={adminInputClass} value={t.rate} onChange={e => setT(x => ({ ...x, rate: e.target.value }))} /></AdminField>
            : <AdminField label="Commission ($)" htmlFor="pt-fixed"><input id="pt-fixed" inputMode="decimal" className={adminInputClass} value={t.fixed} onChange={e => setT(x => ({ ...x, fixed: e.target.value }))} /></AdminField>}
          <AdminField label="Window (days)" htmlFor="pt-win"><input id="pt-win" inputMode="numeric" className={adminInputClass} value={t.win} onChange={e => setT(x => ({ ...x, win: e.target.value }))} /></AdminField>
          <AdminField label="Hold (days)" htmlFor="pt-hold"><input id="pt-hold" inputMode="numeric" className={adminInputClass} value={t.hold} onChange={e => setT(x => ({ ...x, hold: e.target.value }))} /></AdminField>
          <AdminField label="Effective from" htmlFor="pt-eff" hint="Blank = now. Cannot be in the future."><input id="pt-eff" type="date" className={adminInputClass} value={t.effectiveAt} onChange={e => setT(x => ({ ...x, effectiveAt: e.target.value }))} /></AdminField>
          <AdminField label="Reason" htmlFor="pt-reason"><input id="pt-reason" className={adminInputClass} value={t.reason} onChange={e => setT(x => ({ ...x, reason: e.target.value }))} /></AdminField>
        </div>
        <AdminButton loading={busy} onClick={async () => {
          const bps = percentToBps(t.rate), fixed = dollarsToCents(t.fixed)
          if (t.type === 'percentage' ? (bps === null || Number.isNaN(bps)) : (fixed === null || Number.isNaN(fixed))) { setErr('Enter a valid commission.'); return }
          if (!(await confirm('Save new commission terms? They apply to orders from the effective date forward.'))) return
          void post('/api/admin/affiliates', { kind: 'terms', affiliateId: p.id, commissionType: t.type, commissionRateBps: t.type === 'percentage' ? bps : null, commissionFixedCents: t.type === 'fixed' ? fixed : null,
            fixedReversalPolicy: t.policy, attributionWindowDays: Number(t.win), commissionHoldDays: Number(t.hold), effectiveAt: t.effectiveAt ? new Date(t.effectiveAt).toISOString() : null, reason: t.reason || null }, 'New terms saved.')
        }}>Save new terms</AdminButton>
      </div>
      {node}
    </AdminCard>
  )
}
