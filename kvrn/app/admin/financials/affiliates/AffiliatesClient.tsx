'use client'
// app/admin/financials/affiliates/AffiliatesClient.tsx
//
// Four things kept deliberately distinct:
//
//   CUSTOMER DISCOUNT     what the customer saved, from the existing discount engine
//   AFFILIATE COMMISSION  what KVRN owes the affiliate — a separate cost
//   ACCRUAL               period economics from the append-only ledger
//   CASH                  money actually paid out
//
// No amount on this page is calculated in the browser. Commission, reversal,
// payable and payout figures all come from SQL.

import { useEffect, useState, useCallback } from 'react'
import { FONT, BORDER, money, SectionTitle } from '@/components/admin/FinancialUI'
import { collectionAttemptFingerprint, readOrCreateAttemptKey, clearAttemptKey }
  from '@/lib/recovery-attempt-key'

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

const inputStyle = { fontFamily: FONT, fontSize: 12, padding: '7px 9px',
                     border: BORDER, background: '#fff', boxSizing: 'border-box' as const }

export function AffiliatesClient() {
  const [tab, setTab] = useState<'overview' | 'commissions' | 'reconcile' | 'payouts'>('overview')
  const [affiliates, setAffiliates] = useState<Affiliate[]>([])
  const [commissions, setCommissions] = useState<Commission[]>([])
  const [incomplete, setIncomplete] = useState<Incomplete[]>([])
  const [payouts, setPayouts] = useState<any[]>([])
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
  // Idempotency key for an in-flight recovery-collection attempt, per
  // commission. Backed by sessionStorage (readOrCreateAttemptKey above) so it
  // survives an ordinary page reload, not just component state.

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
      } else setErr(j.error ?? 'Could not load affiliates.')
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

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
    if (!confirm('Mark this payout as PAID? This records that money actually moved.')) return
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/affiliates/payouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'mark_paid', payoutId,
                               paidAt: new Date().toISOString().slice(0, 10) }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not mark paid.'); return }
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  /** Cancel a draft, releasing the payable it was reserving. */
  async function voidPayout(payoutId: string) {
    const reason = prompt('Reason for voiding this draft payout?')
    if (reason === null) return
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/affiliates/payouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'void', payoutId, reason }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not void payout.'); return }
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

  const th = { textAlign: 'left' as const, padding: '9px 10px', fontSize: 9,
               letterSpacing: '0.1em', textTransform: 'uppercase' as const,
               color: '#9B9B9B', borderBottom: BORDER, whiteSpace: 'nowrap' as const }
  const btn = { fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em',
                textTransform: 'uppercase' as const, padding: '9px 16px',
                background: '#1A1A1A', color: '#fff', border: 'none', cursor: 'pointer' as const }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1240 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Affiliates
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Commission is calculated on net merchandise after customer discounts, excluding
        shipping and sales tax. A customer discount and an affiliate commission are separate
        costs and both may apply to one order.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {([['overview','Overview'],['commissions','Commissions'],
           ['reconcile',`Unresolved${incomplete.length ? ` (${incomplete.length})` : ''}`],
           ['payouts','Payouts']] as const).map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ fontFamily: FONT, fontSize: 11, padding: '7px 14px', cursor: 'pointer',
                     border: tab === k ? '1px solid #1A1A1A' : BORDER,
                     background: tab === k ? '#1A1A1A' : '#fff',
                     color: tab === k ? '#fff' : '#1A1A1A' }}>{l}</button>
        ))}
      </div>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}
      {loading && <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B' }}>Loading…</p>}

      {tab === 'overview' && period && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
                        gap: 10, marginBottom: 22 }}>
            {[['Net commission (30d)', money(period.netCommissionCents), 'Accrual, from the ledger'],
              ['Accrued', money(period.accruedCents), 'New commissions earned'],
              ['Reversed', money(period.reversedCents), 'Refunds and lost disputes'],
              ['Cash paid', money(period.cashPaidCents), `${period.payoutCount} payout(s) — separate from accrual`]
            ].map(([label, value, note]) => (
              <div key={label} style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
                <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                            textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>{label}</p>
                <p style={{ fontFamily: FONT, fontSize: 22, fontWeight: 500, margin: '6px 0 0' }}>{value}</p>
                <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '4px 0 0' }}>{note}</p>
              </div>
            ))}
          </div>

          {period.incompleteCount > 0 && (
            <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                          border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 18 }}>
              <strong>{period.incompleteCount} commission(s) cannot be quantified yet.</strong> A
              refund breakdown or a partial dispute is unresolved. These are excluded from payout
              and are <strong>not</strong> treated as zero — resolve them under Unresolved.
            </div>
          )}

          <SectionTitle note="Accrual is period economics from the append-only ledger; cash is what has actually been paid. They are never mixed.">
            Affiliates
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Code','Name','Status','Terms','Window','Hold','Discount','Orders','Net commission','Paid'].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {affiliates.length === 0 && !loading && (
                  <tr><td colSpan={10} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No affiliates yet.
                  </td></tr>
                )}
                {affiliates.map(a => (
                  <tr key={a.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{a.code}</td>
                    <td style={{ padding: '9px 10px' }}>{a.name}</td>
                    <td style={{ padding: '9px 10px', color: a.status === 'active' ? '#047857' : '#92400E' }}>
                      {a.status}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {a.commissionType === 'percentage'
                        ? `${((a.commissionRateBps ?? 0) / 100).toFixed(2)}%`
                        : money(a.commissionFixedCents ?? 0)}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{a.attributionWindowDays}d</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{a.commissionHoldDays}d</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{a.discountCode ?? '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{a.orderCount}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 500 }}>{money(a.netCommissionCents)}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{money(a.paidCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'commissions' && (
        <>
          <SectionTitle note="Net ledger is the authoritative figure: accrual plus every reversal and restoration. The status column only summarises it.">
            Commissions
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Order','Affiliate','Via','Base','Commission','Net ledger','Payable','Overpaid','Status','Hold'].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {commissions.length === 0 && !loading && (
                  <tr><td colSpan={10} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No commissions recorded.
                  </td></tr>
                )}
                {commissions.map(c => (
                  <tr key={c.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{c.orderNumber}</td>
                    <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{c.affiliateCode}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{c.attributionMethod}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{money(c.baseCents)}</td>
                    <td style={{ padding: '9px 10px' }}>{money(c.commissionCents)}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 500 }}>{money(c.netLedgerCents)}</td>
                    <td style={{ padding: '9px 10px' }}>{money(c.payableCents)}</td>
                    <td style={{ padding: '9px 10px', color: c.overpaidCents > 0 ? '#B91C1C' : '#6B6B6B' }}>
                      {c.overpaidCents > 0 ? money(c.overpaidCents) : '—'}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {c.status}
                      {c.incomplete && (
                        <span style={{ display: 'block', fontSize: 10, color: '#92400E' }}>
                          incomplete
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{c.holdDaysSnapshot}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'reconcile' && (
        <>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                        border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 18 }}>
            Stripe reports a dispute as a single gross amount covering merchandise, shipping and
            tax. Affiliate commission is merchandise-only, so a <strong>partial</strong> dispute has
            no deterministic merchandise share. Nothing is inferred — supply the verified split and
            the commission adjustment fires exactly once.
          </div>

          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Order','Affiliate','Blocked by','Amount','Merchandise $','Shipping $','Tax $','Total',''].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {incomplete.length === 0 && !loading && (
                  <tr><td colSpan={9} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    Nothing awaiting reconciliation.
                  </td></tr>
                )}
                {incomplete.map(r => {
                  const d = split[r.rowKey] ?? { m: '', s: '', t: '' }
                  const sum = (toCents(d.m) ?? 0) + (toCents(d.s) ?? 0) + (toCents(d.t) ?? 0)
                  const complete = d.m.trim() && d.s.trim() && d.t.trim()
                  const balanced = complete && sum === (r.disputedAmountCents ?? -1)
                  const isDispute = r.sourceKind === 'dispute'
                  return (
                    <tr key={r.rowKey} style={{ borderBottom: '1px solid #F1EEE8' }}>
                      <td style={{ padding: '9px 10px' }}>{r.orderNumber}</td>
                      <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{r.affiliateCode}</td>
                      <td style={{ padding: '9px 10px' }}>
                        <span style={{ fontSize: 9, letterSpacing: '0.08em',
                                       textTransform: 'uppercase', padding: '3px 8px',
                                       border: BORDER,
                                       background: isDispute ? '#FEF2F2' : '#FFFBEB',
                                       color: isDispute ? '#B91C1C' : '#92400E' }}>
                          {r.sourceKind}
                        </span>
                        <span style={{ display: 'block', fontSize: 10, color: '#6B6B6B',
                                       marginTop: 3 }}>
                          {r.reason?.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        {isDispute
                          ? (r.disputedAmountCents === null ? '—' : money(r.disputedAmountCents))
                          : (r.refundAmountCents === null ? '—' : money(r.refundAmountCents))}
                      </td>
                      {isDispute ? (['m','s','t'] as const).map(k => (
                        <td key={k} style={{ padding: '9px 10px' }}>
                          <input type="number" step="0.01" min="0" value={d[k]}
                            onChange={e => setSplit(x => ({ ...x, [r.rowKey]: { ...d, [k]: e.target.value } }))}
                            placeholder="0.00" style={{ ...inputStyle, width: 90 }} />
                        </td>
                      )) : (
                        <td colSpan={3} style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                          This is a refund, not a dispute. Resolve its component breakdown
                          under <strong>Returns</strong>; it is not decomposed here.
                        </td>
                      )}
                      <td style={{ padding: '9px 10px',
                                   color: !isDispute ? '#9B9B9B'
                                        : !complete ? '#9B9B9B'
                                        : balanced ? '#047857' : '#B91C1C' }}>
                        {isDispute && complete ? money(sum) : '—'}
                        {isDispute && complete && !balanced && (
                          <span style={{ display: 'block', fontSize: 10 }}>must equal disputed</span>
                        )}
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        {isDispute && r.canResolveHere && (
                          <button onClick={() => void resolveSplit(r)}
                            disabled={saving || !balanced}
                            style={{ ...btn, padding: '6px 10px', fontSize: 10,
                                     opacity: balanced ? 1 : 0.4 }}>
                            Resolve
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'payouts' && (
        <>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#3730A3', background: '#EEF2FF',
                        border: '1px solid #C7D2FE', padding: '10px 14px', marginBottom: 18 }}>
            Commissions become <strong>eligible</strong> automatically after the hold window, which
            authorises nothing financial. Money moves only when you create a payout and record it
            as paid. Amounts are computed server-side under a lock, so two admins cannot pay the
            same commission twice.
          </div>

          <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 22 }}>
            <label style={{ fontFamily: FONT, fontSize: 11, display: 'block', marginBottom: 8 }}>
              Affiliate
              <select value={selectedAff} onChange={e => setSelectedAff(e.target.value)}
                style={{ ...inputStyle, width: 280, marginTop: 4, display: 'block' }}>
                <option value="">Select…</option>
                {affiliates.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
              </select>
            </label>
            {selectedAff && (
              <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '10px 0' }}>
                {payable.length} commission(s) payable, totalling{' '}
                <strong>{money(payable.reduce((s, p) => s + p.payableCents, 0))}</strong>
              </p>
            )}
            <button onClick={createPayout} disabled={saving || payable.length === 0}
              style={{ ...btn, opacity: saving || payable.length === 0 ? 0.45 : 1 }}>
              {saving ? 'Creating…' : 'Create draft payout'}
            </button>
          </div>

          <SectionTitle note="Outstanding is DERIVED from cash paid minus what the ledger says was earned, so it cannot drift. 'Pursuit recorded' is an internal marker of a decision to chase the money — it is NOT cash and NOT an amount still owed. Collected is money actually received back.">
            Recovery — overpaid commissions
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 26 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Order','Affiliate','Outstanding (derived)','Pursuit recorded','Collected (cash)',
                  'Collect $','Date','Method','Reference',''].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {recoveries.length === 0 && !loading && (
                  <tr><td colSpan={10} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No overpaid commissions.
                  </td></tr>
                )}
                {recoveries.map(r => {
                  const d = collect[r.commissionId] ?? { amount: '', date: '', method: '', reference: '' }
                  const cents = toCents(d.amount) ?? 0
                  const over = cents > r.outstandingCents
                  return (
                    <tr key={r.commissionId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                      <td style={{ padding: '9px 10px' }}>{r.orderNumber}</td>
                      <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{r.affiliateCode}</td>
                      <td style={{ padding: '9px 10px', fontWeight: 500,
                                   color: r.outstandingCents > 0 ? '#B91C1C' : '#047857' }}>
                        {money(r.outstandingCents)}
                      </td>
                      {/* A marker is NOT cash; the two are shown apart so a
                          pending decision can never read as money received. */}
                      <td style={{ padding: '9px 10px', color: '#92400E' }}>
                        {money(r.recordedOwedCents)}
                      </td>
                      <td style={{ padding: '9px 10px', color: '#047857' }}>
                        {money(r.collectedCents)}
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        <input type="number" step="0.01" min="0" value={d.amount}
                          onChange={e => setCollect(x => ({ ...x, [r.commissionId]: { ...d, amount: e.target.value } }))}
                          placeholder="0.00" style={{ ...inputStyle, width: 90 }} />
                        {over && (
                          <span style={{ display: 'block', fontSize: 10, color: '#B91C1C' }}>
                            exceeds outstanding
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        <input type="date" value={d.date}
                          onChange={e => setCollect(x => ({ ...x, [r.commissionId]: { ...d, date: e.target.value } }))}
                          style={{ ...inputStyle, width: 130 }} />
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        <input value={d.method}
                          onChange={e => setCollect(x => ({ ...x, [r.commissionId]: { ...d, method: e.target.value } }))}
                          placeholder="ach" style={{ ...inputStyle, width: 80 }} />
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        <input value={d.reference}
                          onChange={e => setCollect(x => ({ ...x, [r.commissionId]: { ...d, reference: e.target.value } }))}
                          style={{ ...inputStyle, width: 100 }} />
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        <button onClick={() => void collectRecovery(r.commissionId)}
                          disabled={saving || cents <= 0 || over || r.outstandingCents === 0}
                          style={{ ...btn, padding: '6px 10px', fontSize: 10,
                                   opacity: (cents > 0 && !over && r.outstandingCents > 0) ? 1 : 0.4 }}>
                          Collect
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <SectionTitle note="Cash flow reads the paid date only. Accrual lives in the commission ledger and is never mixed in.">
            Payout history
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Payout','Affiliate','Amount','Lines','Status','Paid on','Reference','Actions'].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {payouts.length === 0 && !loading && (
                  <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No payouts yet.
                  </td></tr>
                )}
                {payouts.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{p.payoutNumber}</td>
                    <td style={{ padding: '9px 10px' }}>{p.affiliateCode}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 500 }}>{money(p.amountCents)}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{p.lineCount}</td>
                    <td style={{ padding: '9px 10px', color: p.status === 'paid' ? '#047857' : '#6B6B6B' }}>
                      {p.status}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {p.paidAt ? p.paidAt.slice(0, 10) : '—'}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{p.reference ?? '—'}</td>
                    <td style={{ padding: '9px 10px' }}>
                      {/* DRAFT is the only actionable state. A paid payout has
                          moved real cash, so voiding it would misstate the cash
                          record; a void payout has nothing left to do. */}
                      {p.status === 'draft' && (
                        <>
                          <button onClick={() => void markPaid(p.id)} disabled={saving}
                            style={{ ...btn, padding: '5px 9px', fontSize: 10, marginRight: 6 }}>
                            Mark paid
                          </button>
                          <button onClick={() => void voidPayout(p.id)} disabled={saving}
                            style={{ ...btn, padding: '5px 9px', fontSize: 10,
                                     background: '#fff', color: '#B91C1C',
                                     border: '1px solid #FECACA' }}>
                            Void
                          </button>
                        </>
                      )}
                      {p.status !== 'draft' && (
                        <span style={{ fontSize: 10, color: '#9B9B9B' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
