'use client'
// app/admin/financials/affiliates/AffiliatesClient.tsx
//
// Tabbed Admin for the affiliate program. Four money concepts stay deliberately distinct:
//
//   CUSTOMER DISCOUNT     what the customer saved, from the existing discount engine
//   AFFILIATE COMMISSION  what KVRN owes the affiliate — a separate cost
//   ACCRUAL               period economics from the append-only ledger
//   CASH                  money actually paid out
//
// No amount on this page is calculated in the browser. Commission, reversal,
// payable and payout figures all come from SQL.

import { useEffect, useState, useCallback } from 'react'
import { money } from '@/components/admin/FinancialUI'
import {
  AdminButton, AdminCard, AdminField, AdminLoading, AdminNotice, AdminPageHeader,
  AdminSectionHeader, AdminTable, AdminTabs, AdminTd, AdminTh, StatusBadge, adminInputClass, useConfirm,
} from '@/components/admin/ui/AdminUI'
import { collectionAttemptFingerprint, readOrCreateAttemptKey, clearAttemptKey }
  from '@/lib/recovery-attempt-key'
import { affiliateTabs, isAffiliateTab, type AffiliateTabId } from '@/lib/affiliate-program-ui'
import { AffiliateApplicationsTab } from './AffiliateApplicationsTab'
import { AffiliateProfilesTab } from './AffiliateProfilesTab'
import { AffiliateTermsTab } from './AffiliateTermsTab'
import { AffiliateAuditTab } from './AffiliateAuditTab'
import { AffiliateComplianceTab } from './AffiliateComplianceTab'
import { AffiliatePayoutReadinessTab } from './AffiliatePayoutReadinessTab'

type Affiliate = {
  id: string; code: string; name: string; status: string
  commissionType: string; commissionRateBps: number | null
  commissionFixedCents: number | null
  attributionWindowDays: number; commissionHoldDays: number
  discountCode: string | null; orderCount: number
  netCommissionCents: number; paidCents: number; incompleteCount: number
}
type Commission = {
  id: string; orderNumber: string; affiliateCode: string
  baseCents: number; commissionCents: number; status: string
  payableCents: number; overpaidCents: number; netLedgerCents: number
  incomplete: boolean; incompleteReason: string | null
  attributionMethod: string; holdDaysSnapshot: number; eligibleAt: string
}
/**
 * ONE ROW PER UNRESOLVED SOURCE, not per commission.
 *
 * A commission can be blocked by two disputes, or by a refund and a dispute at
 * once. Keying on commission id would collapse them and let the operator resolve
 * the wrong one, or share draft component inputs across different sources.
 */
type Incomplete = {
  rowKey: string
  commissionId: string
  sourceKind: 'dispute' | 'refund'
  sourceId: string
  reason: string
  orderId: string; orderNumber: string
  affiliateId: string; affiliateCode: string
  commissionCents: number
  orderTotalCents: number; orderSubtotalCents: number; orderDiscountCents: number
  disputeId: string | null
  disputedAmountCents: number | null
  disputeStatus: string | null
  refundId: string | null
  refundAmountCents: number | null
  canResolveHere: boolean
}
type Period = {
  accruedCents: number; reversedCents: number; restoredCents: number
  netCommissionCents: number; incompleteCount: number
  cashPaidCents: number; payoutCount: number
}

const mono = 'font-mono'
const muted = 'text-[#6B6B66]'

function financialStatus(s: string) {
  return s === 'active' ? { status: 'Active' as const, label: 'Active' }
    : s === 'paused' ? { status: 'Held' as const, label: 'Paused' }
    : s === 'terminated' ? { status: 'Terminated' as const, label: 'Terminated' }
    : { status: 'Unknown' as const, label: s }
}

export function AffiliatesClient() {
  const [tab, setTabState] = useState<AffiliateTabId>('overview')
  const [affiliates, setAffiliates] = useState<Affiliate[]>([])
  const [commissions, setCommissions] = useState<Commission[]>([])
  const [incomplete, setIncomplete] = useState<Incomplete[]>([])
  const [payouts, setPayouts] = useState<any[]>([])
  const [payoutReminder, setPayoutReminder] = useState<{
    draftPayouts: number; draftAmountCents: number | null;
    reviewCommissions: number; reviewAmountCents: number | null;
  } | null>(null)
  const [period, setPeriod] = useState<Period | null>(null)
  const [payable, setPayable] = useState<any[]>([])
  const [selectedAff, setSelectedAff] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [split, setSplit] = useState<Record<string, { m: string; s: string; t: string }>>({})
  const [recoveries, setRecoveries] = useState<any[]>([])
  const [collect, setCollect] = useState<Record<string,
    { amount: string; date: string; method: string; reference: string }>>({})
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null)
  const [recordingPaid, setRecordingPaid] = useState<{ id: string; paidAt: string; method: string; reference: string } | null>(null)
  const [counts, setCounts] = useState<{ openApplications: number; reacceptance: number }>({ openApplications: 0, reacceptance: 0 })
  const { confirm, node: confirmNode } = useConfirm()
  // Idempotency key for an in-flight recovery-collection attempt, per
  // commission. Backed by sessionStorage (readOrCreateAttemptKey above) so it
  // survives an ordinary page reload, not just component state.

  const setTab = (t: AffiliateTabId) => {
    setTabState(t)
    try { window.history.replaceState(null, '', `#${t}`) } catch { /* ignore */ }
  }
  useEffect(() => {
    const h = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
    if (isAffiliateTab(h)) setTabState(h)
  }, [])

  const loadCounts = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/affiliates/applications?countsOnly=1', { cache: 'no-store' })
      if (r.ok) setCounts((await r.json()).counts)
    } catch { /* counts are a convenience */ }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [j, rec] = await Promise.all([
        fetch('/api/admin/affiliates?range=30d').then(r => r.json()),
        fetch('/api/admin/affiliates/recoveries').then(r => r.json()).catch(() => ({})),
      ])
      if (rec?.recoveries) setRecoveries(rec.recoveries)
      if (j.affiliates) {
        setAffiliates(j.affiliates); setCommissions(j.commissions ?? [])
        setIncomplete(j.incomplete ?? []); setPayouts(j.payouts ?? []); setPeriod(j.period)
        setPayoutReminder(j.payoutReminder ?? null)
        setErr(null)
      } else setErr(j.error ?? 'Could not load affiliates.')
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(); void loadCounts() }, [load, loadCounts])

  useEffect(() => {
    if (!selectedAff) { setPayable([]); return }
    void fetch(`/api/admin/affiliates/payouts?affiliateId=${selectedAff}`)
      .then(r => r.json()).then(j => setPayable(j.payable ?? []))
  }, [selectedAff])

  const toCents = (v: string) => {
    if (!v.trim()) return null
    const n = Math.round(parseFloat(v) * 100)
    return Number.isFinite(n) ? n : null
  }

  /** Record that a draft payout's money actually moved. */
  async function markPaid(payoutId: string) {
    if (!recordingPaid || recordingPaid.id !== payoutId || !recordingPaid.method.trim() || !recordingPaid.reference.trim()) {
      setErr('Enter the external payment method and transaction reference before recording cash as paid.')
      return
    }
    const d = recordingPaid
    if (!(await confirm(`Confirm ${d.method} payment with reference ${d.reference} was actually completed outside KVRN? Marking paid records a permanent cash-flow event.`))) return
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/affiliates/payouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'mark_paid', payoutId,
                               paidAt: d.paidAt, method: d.method.trim(), reference: d.reference.trim() }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not mark paid.'); return }
      setRecordingPaid(null)
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  /** Cancel a draft, releasing the payable it was reserving. */
  async function voidPayout(payoutId: string, reason: string) {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/affiliates/payouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'void', payoutId, reason }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not void payout.'); return }
      setVoiding(null)
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  /** Record recovery CASH received back. Never more than outstanding. */
  async function collectRecovery(commissionId: string) {
    const d = collect[commissionId]
    if (!d) return
    const cents = toCents(d.amount)
    if (cents === null || cents <= 0) { setErr('Enter an amount to collect.'); return }
    setSaving(true); setErr(null)
    try {
      const fingerprint = collectionAttemptFingerprint(cents, d.date, d.method, d.reference)
      const res = await fetch('/api/admin/affiliates/recoveries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'collect', commissionId, amountCents: cents,
                               effectiveAt: d.date || null, method: d.method || null,
                               reference: d.reference || null,
                               idempotencyKey: readOrCreateAttemptKey(commissionId, fingerprint) }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not collect recovery.'); return }
      setCollect(x => ({ ...x, [commissionId]: { ...d, amount: '' } }))
      // Retire the key only on confirmed success, so the next collection is new.
      clearAttemptKey(commissionId)
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  /**
   * Supply the verified merchandise split for a partial dispute.
   *
   * Keyed by DISPUTE. A lost partial dispute can exist with no 018 financial
   * adjustment row at all, so requiring one made exactly those disputes
   * impossible to reconcile.
   */
  async function resolveSplit(row: Incomplete) {
    const d = split[row.rowKey]
    if (!d || row.sourceKind !== 'dispute' || !row.disputeId) return
    const m = toCents(d.m), s = toCents(d.s), t = toCents(d.t)
    if (m === null || s === null || t === null) {
      setErr('All three components are required — none may be left blank.'); return
    }
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/affiliates/reconciliation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disputeId: row.disputeId,
                               merchandiseCents: m, shippingCents: s, taxCents: t }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not resolve.'); return }
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  /** Create a draft payout. Amounts are computed server-side. */
  async function createPayout() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/affiliates/payouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          affiliateId: selectedAff,
          commissionIds: payable.map(p => p.commissionId),
        }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not create payout.'); return }
      await load()
      setPayable([])
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  const moneyInput = 'h-8 w-24 rounded-[8px] border border-black/[0.14] bg-white px-2 text-[12px]'
  const tabs = affiliateTabs({ openApplications: counts.openApplications, unresolved: incomplete.length, reacceptance: counts.reacceptance })
  const financial = tab === 'overview' || tab === 'commissions' || tab === 'payouts' || tab === 'unresolved'

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-8">
      <AdminPageHeader
        title="Affiliates"
        description="Applications, affiliates, commissions and payouts"
        info={<>Commission is calculated on net merchandise after customer discounts, excluding shipping and sales tax. A customer discount and an affiliate commission are separate costs and both may apply to one order.</>}
      />
      <AdminTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Affiliate sections" />

      {err && financial && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {loading && financial && <AdminLoading />}

      {tab === 'applications' && <AffiliateApplicationsTab onChanged={() => { void loadCounts(); void load() }} />}
      {tab === 'affiliates' && <AffiliateProfilesTab onChanged={() => { void load() }} />}
      {tab === 'compliance' && <AffiliateComplianceTab />}
      {tab === 'readiness' && <AffiliatePayoutReadinessTab />}
      {tab === 'terms' && <AffiliateTermsTab onChanged={() => { void loadCounts() }} />}
      {tab === 'audit' && <AffiliateAuditTab />}

      {tab === 'overview' && period && (
        <>
          <div className="mb-5 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {[['Net commission (30d)', money(period.netCommissionCents), 'Accrual, from the ledger'],
              ['Accrued', money(period.accruedCents), 'New commissions earned'],
              ['Reversed', money(period.reversedCents), 'Refunds and lost disputes'],
              ['Cash paid', money(period.cashPaidCents), `${period.payoutCount} payout(s), separate from accrual`]
            ].map(([label, value, note]) => (
              <AdminCard key={label}>
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#8A8A85]">{label}</p>
                <p className="mt-1.5 text-[22px] font-medium">{value}</p>
                <p className={`mt-1 text-[11px] ${muted}`}>{note}</p>
              </AdminCard>
            ))}
          </div>

          {period.incompleteCount > 0 && (
            <AdminNotice tone="warning" className="mb-4">
              <strong>{period.incompleteCount} commission(s) cannot be quantified yet.</strong> A
              refund breakdown or a partial dispute is unresolved. These are excluded from payout
              and are <strong>not</strong> treated as zero — resolve them under Unresolved.
            </AdminNotice>
          )}

          <AdminSectionHeader title="Affiliates" info="Accrual is period economics from the append-only ledger; cash is what has actually been paid. They are never mixed." />
          <AdminTable caption="Affiliates and their commission terms" stack>
            <thead><tr>
              {['Code', 'Name', 'Status', 'Terms', 'Window', 'Hold', 'Discount', 'Orders', 'Net commission', 'Paid'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
            </tr></thead>
            <tbody>
              {affiliates.length === 0 && !loading && (
                <tr><AdminTd className={muted}>No affiliates yet.</AdminTd>{Array.from({ length: 9 }).map((_, i) => <AdminTd key={i} />)}</tr>
              )}
              {affiliates.map(a => {
                const fs = financialStatus(a.status)
                return (
                  <tr key={a.id}>
                    <AdminTd className={mono}>{a.code}</AdminTd>
                    <AdminTd>{a.name}</AdminTd>
                    <AdminTd><StatusBadge status={fs.status} label={fs.label} /></AdminTd>
                    <AdminTd className={muted}>
                      {a.commissionType === 'percentage'
                        ? `${((a.commissionRateBps ?? 0) / 100).toFixed(2)}%`
                        : money(a.commissionFixedCents ?? 0)}
                    </AdminTd>
                    <AdminTd className={muted}>{a.attributionWindowDays}d</AdminTd>
                    <AdminTd className={muted}>{a.commissionHoldDays}d</AdminTd>
                    <AdminTd className={muted}>{a.discountCode ?? '—'}</AdminTd>
                    <AdminTd>{a.orderCount}</AdminTd>
                    <AdminTd className="font-medium">{money(a.netCommissionCents)}</AdminTd>
                    <AdminTd className={muted}>{money(a.paidCents)}</AdminTd>
                  </tr>
                )
              })}
            </tbody>
          </AdminTable>
        </>
      )}

      {tab === 'commissions' && (
        <>
          <AdminSectionHeader title="Commissions" info="Net ledger is the figure to rely on: accrual plus every reversal and restoration. The status column only summarises it." />
          <AdminTable caption="Commissions" stack>
            <thead><tr>
              {['Order', 'Affiliate', 'Via', 'Base', 'Commission', 'Net ledger', 'Payable', 'Overpaid', 'Status', 'Hold'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
            </tr></thead>
            <tbody>
              {commissions.length === 0 && !loading && (
                <tr><AdminTd className={muted}>No commissions recorded.</AdminTd>{Array.from({ length: 9 }).map((_, i) => <AdminTd key={i} />)}</tr>
              )}
              {commissions.map(c => (
                <tr key={c.id}>
                  <AdminTd>{c.orderNumber}</AdminTd>
                  <AdminTd className={mono}>{c.affiliateCode}</AdminTd>
                  <AdminTd className={muted}>{c.attributionMethod}</AdminTd>
                  <AdminTd className={muted}>{money(c.baseCents)}</AdminTd>
                  <AdminTd>{money(c.commissionCents)}</AdminTd>
                  <AdminTd className="font-medium">{money(c.netLedgerCents)}</AdminTd>
                  <AdminTd>{money(c.payableCents)}</AdminTd>
                  <AdminTd className={c.overpaidCents > 0 ? 'text-[#B91C1C]' : muted}>
                    {c.overpaidCents > 0 ? money(c.overpaidCents) : '—'}
                  </AdminTd>
                  <AdminTd className={muted}>
                    {c.status}
                    {c.incomplete && <span className="block"><StatusBadge status="Incomplete" /></span>}
                  </AdminTd>
                  <AdminTd className={muted}>{c.holdDaysSnapshot}d</AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        </>
      )}

      {tab === 'unresolved' && (
        <>
          <AdminNotice tone="warning" className="mb-4">
            Stripe reports a dispute as a single gross amount covering merchandise, shipping and
            tax. Affiliate commission is merchandise-only, so a <strong>partial</strong> dispute has
            no known merchandise share. Nothing is inferred — supply the verified split and
            the commission adjustment fires exactly once.
          </AdminNotice>

          <AdminTable caption="Unresolved commission sources" stack>
            <thead><tr>
              {['Order', 'Affiliate', 'Blocked by', 'Amount', 'Merchandise $', 'Shipping $', 'Tax $', 'Total', ''].map(h => <AdminTh key={h}>{h}</AdminTh>)}
            </tr></thead>
            <tbody>
              {incomplete.length === 0 && !loading && (
                <tr><AdminTd className={muted}>Nothing awaiting reconciliation.</AdminTd>{Array.from({ length: 8 }).map((_, i) => <AdminTd key={i} />)}</tr>
              )}
              {incomplete.map(r => {
                const d = split[r.rowKey] ?? { m: '', s: '', t: '' }
                const sum = (toCents(d.m) ?? 0) + (toCents(d.s) ?? 0) + (toCents(d.t) ?? 0)
                const complete = d.m.trim() && d.s.trim() && d.t.trim()
                const balanced = complete && sum === (r.disputedAmountCents ?? -1)
                const isDispute = r.sourceKind === 'dispute'
                return (
                  <tr key={r.rowKey}>
                    <AdminTd>{r.orderNumber}</AdminTd>
                    <AdminTd className={mono}>{r.affiliateCode}</AdminTd>
                    <AdminTd>
                      <StatusBadge status={isDispute ? 'Unresolved' : 'Incomplete'} label={r.sourceKind} />
                      <span className={`mt-1 block text-[11px] ${muted}`}>{r.reason?.replace(/_/g, ' ')}</span>
                    </AdminTd>
                    <AdminTd>
                      {isDispute
                        ? (r.disputedAmountCents === null ? '—' : money(r.disputedAmountCents))
                        : (r.refundAmountCents === null ? '—' : money(r.refundAmountCents))}
                    </AdminTd>
                    {isDispute ? (['m', 's', 't'] as const).map(k => (
                      <AdminTd key={k}>
                        <input type="number" step="0.01" min="0" value={d[k]}
                          aria-label={k === 'm' ? 'Merchandise amount' : k === 's' ? 'Shipping amount' : 'Tax amount'}
                          onChange={e => setSplit(x => ({ ...x, [r.rowKey]: { ...d, [k]: e.target.value } }))}
                          placeholder="0.00" className={moneyInput} />
                      </AdminTd>
                    )) : (
                      <AdminTd className={muted}>
                        <span className="block min-w-[240px]">This is a refund, not a dispute. Resolve its component breakdown under <strong>Returns</strong>; it is not decomposed here.</span>
                      </AdminTd>
                    )}
                    {!isDispute && <><AdminTd /><AdminTd /></>}
                    <AdminTd className={!isDispute || !complete ? muted : balanced ? 'text-[#047857]' : 'text-[#B91C1C]'}>
                      {isDispute && complete ? money(sum) : '—'}
                      {isDispute && complete && !balanced && <span className="block text-[11px]">must equal disputed</span>}
                    </AdminTd>
                    <AdminTd>
                      {isDispute && r.canResolveHere && (
                        <AdminButton size="sm" variant="primary" onClick={() => void resolveSplit(r)} disabled={saving || !balanced}>
                          Resolve
                        </AdminButton>
                      )}
                    </AdminTd>
                  </tr>
                )
              })}
            </tbody>
          </AdminTable>
        </>
      )}

      {tab === 'payouts' && (
        <>
          <AdminCard className="mb-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><p className="text-xs text-neutral-500">Draft payouts awaiting your manual payment</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{payoutReminder ? `${payoutReminder.draftPayouts} · ${payoutReminder.draftAmountCents === null ? 'Amount unavailable' : money(payoutReminder.draftAmountCents)}` : 'Unavailable'}</p></div>
              <div><p className="text-xs text-neutral-500">Unreserved commission balances for review</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{payoutReminder ? `${payoutReminder.reviewCommissions} · ${payoutReminder.reviewAmountCents === null ? 'Amount unavailable' : money(payoutReminder.reviewAmountCents)}` : 'Unavailable'}</p></div>
            </div>
            <p className="mt-3 text-xs text-neutral-500">Review payout readiness, refund/dispute holds, identity and tax requirements before paying. Draft balances are not automatically transferred. The Chief daily brief includes these totals; Pushover alerts require your existing notification gate and credentials.</p>
          </AdminCard>
          <AdminNotice className="mb-4">
            Commissions become <strong>eligible</strong> automatically after the hold window, which
            authorises nothing financial. Money moves only when you create a payout and record it
            as paid. Amounts are computed server-side under a lock, so two admins cannot pay the
            same commission twice.
          </AdminNotice>

          <AdminCard className="mb-6">
            <AdminField label="Affiliate" htmlFor="payout-aff">
              <select id="payout-aff" value={selectedAff} onChange={e => setSelectedAff(e.target.value)} className={`${adminInputClass} max-w-[320px]`}>
                <option value="">Select…</option>
                {affiliates.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
              </select>
            </AdminField>
            {selectedAff && (
              <p className={`my-3 text-[12px] ${muted}`}>
                {payable.length} commission(s) payable, totalling{' '}
                <strong>{money(payable.reduce((s, p) => s + p.payableCents, 0))}</strong>
              </p>
            )}
            <div className="mt-3">
              <AdminButton variant="primary" onClick={createPayout} disabled={saving || payable.length === 0} loading={saving}>
                Create draft payout
              </AdminButton>
            </div>
          </AdminCard>

          <AdminSectionHeader title="Recovery — overpaid commissions"
            info="Outstanding is DERIVED from cash paid minus what the ledger says was earned, so it cannot drift. 'Pursuit recorded' is an internal marker of a decision to chase the money — it is NOT cash and NOT an amount still owed. Collected is money actually received back." />
          <div className="mb-7">
            <AdminTable caption="Overpaid commissions" stack>
              <thead><tr>
                {['Order', 'Affiliate', 'Outstanding (derived)', 'Pursuit recorded', 'Collected (cash)', 'Collect $', 'Date', 'Method', 'Reference', ''].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {recoveries.length === 0 && !loading && (
                  <tr><AdminTd className={muted}>No overpaid commissions.</AdminTd>{Array.from({ length: 9 }).map((_, i) => <AdminTd key={i} />)}</tr>
                )}
                {recoveries.map(r => {
                  const d = collect[r.commissionId] ?? { amount: '', date: '', method: '', reference: '' }
                  const cents = toCents(d.amount) ?? 0
                  const over = cents > r.outstandingCents
                  return (
                    <tr key={r.commissionId}>
                      <AdminTd>{r.orderNumber}</AdminTd>
                      <AdminTd className={mono}>{r.affiliateCode}</AdminTd>
                      <AdminTd className={`font-medium ${r.outstandingCents > 0 ? 'text-[#B91C1C]' : 'text-[#047857]'}`}>
                        {money(r.outstandingCents)}
                      </AdminTd>
                      {/* A marker is NOT cash; the two are shown apart so a
                          pending decision can never read as money received. */}
                      <AdminTd className="text-[#92400E]">{money(r.recordedOwedCents)}</AdminTd>
                      <AdminTd className="text-[#047857]">{money(r.collectedCents)}</AdminTd>
                      <AdminTd>
                        <input type="number" step="0.01" min="0" value={d.amount} aria-label="Amount to collect"
                          onChange={e => setCollect(x => ({ ...x, [r.commissionId]: { ...d, amount: e.target.value } }))}
                          placeholder="0.00" className={moneyInput} />
                        {over && <span className="block text-[11px] text-[#B91C1C]">exceeds outstanding</span>}
                      </AdminTd>
                      <AdminTd>
                        <input type="date" value={d.date} aria-label="Date received"
                          onChange={e => setCollect(x => ({ ...x, [r.commissionId]: { ...d, date: e.target.value } }))}
                          className="h-8 w-36 rounded-[8px] border border-black/[0.14] bg-white px-2 text-[12px]" />
                      </AdminTd>
                      <AdminTd>
                        <input value={d.method} aria-label="Method" placeholder="ach"
                          onChange={e => setCollect(x => ({ ...x, [r.commissionId]: { ...d, method: e.target.value } }))}
                          className="h-8 w-20 rounded-[8px] border border-black/[0.14] bg-white px-2 text-[12px]" />
                      </AdminTd>
                      <AdminTd>
                        <input value={d.reference} aria-label="Reference"
                          onChange={e => setCollect(x => ({ ...x, [r.commissionId]: { ...d, reference: e.target.value } }))}
                          className="h-8 w-28 rounded-[8px] border border-black/[0.14] bg-white px-2 text-[12px]" />
                      </AdminTd>
                      <AdminTd>
                        <AdminButton size="sm" variant="primary" onClick={() => void collectRecovery(r.commissionId)}
                          disabled={saving || cents <= 0 || over || r.outstandingCents === 0}>
                          Collect
                        </AdminButton>
                      </AdminTd>
                    </tr>
                  )
                })}
              </tbody>
            </AdminTable>
          </div>

          <AdminSectionHeader title="Payout history" info="Cash flow reads the paid date only. Accrual lives in the commission ledger and is never mixed in." />
          <AdminTable caption="Payouts" stack>
            <thead><tr>
              {['Payout', 'Affiliate', 'Amount', 'Lines', 'Status', 'Paid on', 'Reference', 'Actions'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
            </tr></thead>
            <tbody>
              {payouts.length === 0 && !loading && (
                <tr><AdminTd className={muted}>No payouts yet.</AdminTd>{Array.from({ length: 7 }).map((_, i) => <AdminTd key={i} />)}</tr>
              )}
              {payouts.map(p => (
                <tr key={p.id}>
                  <AdminTd className={mono}>{p.payoutNumber}</AdminTd>
                  <AdminTd>{p.affiliateCode}</AdminTd>
                  <AdminTd className="font-medium">{money(p.amountCents)}</AdminTd>
                  <AdminTd className={muted}>{p.lineCount}</AdminTd>
                  <AdminTd>
                    <StatusBadge status={p.status === 'paid' ? 'Paid' : p.status === 'draft' ? 'Draft' : p.status === 'void' ? 'Archived' : 'Unknown'} label={p.status} />
                  </AdminTd>
                  <AdminTd className={muted}>{p.paidAt ? p.paidAt.slice(0, 10) : '—'}</AdminTd>
                  <AdminTd className={muted}>{p.reference ?? '—'}</AdminTd>
                  <AdminTd>
                    {/* DRAFT is the only actionable state. A paid payout has
                        moved real cash, so voiding it would misstate the cash
                        record; a void payout has nothing left to do. */}
                    {p.status === 'draft' && (voiding && voiding.id === p.id ? (
                      <div className="flex min-w-[220px] flex-col gap-2">
                        <input aria-label="Reason for voiding" placeholder="Reason for voiding" value={voiding.reason}
                          onChange={e => setVoiding({ id: p.id, reason: e.target.value })} className={adminInputClass} />
                        <div className="flex gap-2">
                          <AdminButton size="sm" variant="danger" disabled={saving || !voiding.reason.trim()} onClick={() => void voidPayout(p.id, voiding.reason)}>Void payout</AdminButton>
                          <AdminButton size="sm" variant="ghost" onClick={() => setVoiding(null)}>Cancel</AdminButton>
                        </div>
                      </div>
                    ) : recordingPaid !== null && recordingPaid.id === p.id ? (
                      <div className="flex min-w-[220px] flex-col gap-2">
                        <label className="text-xs">Paid date
                          <input type="date" className={adminInputClass} value={recordingPaid.paidAt}
                            onChange={e=>setRecordingPaid({ ...recordingPaid, paidAt:e.target.value })} /></label>
                        <label className="text-xs">External payment method
                          <input className={adminInputClass} placeholder="Bank transfer, PayPal, etc."
                            value={recordingPaid.method} maxLength={120}
                            onChange={e=>setRecordingPaid({ ...recordingPaid, method:e.target.value })} /></label>
                        <label className="text-xs">Provider transaction reference
                          <input className={adminInputClass} placeholder="Actual payment confirmation/reference"
                            value={recordingPaid.reference} maxLength={200}
                            onChange={e=>setRecordingPaid({ ...recordingPaid, reference:e.target.value })} /></label>
                        <div className="flex flex-wrap gap-2">
                          <AdminButton size="sm" variant="primary" disabled={saving||!recordingPaid.method.trim()||!recordingPaid.reference.trim()||!recordingPaid.paidAt} onClick={()=>void markPaid(p.id)}>Confirm paid</AdminButton>
                          <AdminButton size="sm" variant="ghost" onClick={()=>setRecordingPaid(null)}>Cancel</AdminButton>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <AdminButton size="sm" variant="primary" onClick={() => setRecordingPaid({ id: p.id, paidAt: new Date().toISOString().slice(0, 10), method:'', reference:'' })} disabled={saving}>Record external payment</AdminButton>
                        <AdminButton size="sm" variant="danger" onClick={() => setVoiding({ id: p.id, reason: '' })} disabled={saving}>Void</AdminButton>
                      </div>
                    ))}
                    {p.status !== 'draft' && <span className="text-[11px] text-[#8A8A85]">—</span>}
                  </AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        </>
      )}
      {confirmNode}
    </div>
  )
}
