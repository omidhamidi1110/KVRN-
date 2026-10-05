'use client'
// app/admin/financials/returns/ReturnsClient.tsx
//
// A RETURN NEVER REDUCES REVENUE. It records what physically came back and what
// that means for inventory and COGS. Money is handled by the refund it is
// allocated to. The UI says so explicitly so the distinction is not lost.
//
// Refund component breakdown: Stripe reports only a total. Until the split is
// resolved it is shown as UNKNOWN — never zero, never the full amount — and
// allocation is blocked.

import { useEffect, useState, useCallback } from 'react'
import { FONT, BORDER, money, moneyOrUnknown, SectionTitle } from '@/components/admin/FinancialUI'

type ReturnRow = {
  id: string; returnNumber: string; orderNumber: string; status: string
  returnShippingPaidBy: string
  returnLabelCostCents: number | null
  reason: string | null; requestedAt: string | null
  itemCount: number; totalQuantity: number
}

type AwaitingRow = {
  id: string; stripeRefundId: string; amountCents: number
  orderNumber: string; refundedAt: string | null
  orderSubtotalCents: number; orderDiscountCents: number
  orderShippingCents: number; orderTaxCents: number; orderTotalCents: number
  canDeriveFullRefund: boolean
}

type AwaitingFeeRow = {
  id: string; stripeRefundId: string | null; orderId: string; orderNumber: string
  amountCents: number; orderStripeFeeCents: number | null
  otherFeeReturnedCents: number; refundedAt: string | null
}

const inputStyle = {
  fontFamily: FONT, fontSize: 12, padding: '7px 9px',
  border: BORDER, background: '#fff', width: 100, boxSizing: 'border-box' as const,
}

export function ReturnsClient() {
  const [returns, setReturns]   = useState<ReturnRow[]>([])
  const [awaiting, setAwaiting] = useState<AwaitingRow[]>([])
  const [awaitingFee, setAwaitingFee] = useState<AwaitingFeeRow[]>([])
  const [feeDraft, setFeeDraft] = useState<Record<string, string>>({})
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)
  const [busyId, setBusyId]     = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, { m: string; s: string; t: string }>>({})

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res  = await fetch('/api/admin/returns')
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load returns.'); return }
      setReturns(json.returns ?? [])
      setAwaiting(json.awaitingBreakdown ?? [])
      setAwaitingFee(json.awaitingFee ?? [])
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const toCents = (v: string) => {
    if (!v.trim()) return null
    const n = Math.round(parseFloat(v) * 100)
    return Number.isFinite(n) ? n : null
  }

  /** Derive deterministically. Offered only for a genuine full refund. */
  async function derive(refundId: string) {
    setBusyId(refundId); setErr(null)
    try {
      const res = await fetch(`/api/admin/refunds/${refundId}/resolve-components`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not derive components.'); return }
      await load()
    } catch { setErr('Network error.') }
    finally { setBusyId(null) }
  }

  /** Explicit admin decomposition. Rejected unless it totals the refund exactly. */
  async function submitSplit(row: AwaitingRow) {
    const d = draft[row.id]
    if (!d) return
    const m = toCents(d.m), s = toCents(d.s), t = toCents(d.t)
    if (m === null || s === null || t === null) {
      setErr('All three components are required — none may be left blank.')
      return
    }
    if (m + s + t !== row.amountCents) {
      setErr(`Components total ${money(m + s + t)} but the refund is ${money(row.amountCents)}.`)
      return
    }
    setBusyId(row.id); setErr(null)
    try {
      const res = await fetch(`/api/admin/refunds/${row.id}/resolve-components`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchandiseCents: m, shippingCents: s, taxCents: t }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not save components.'); return }
      setDraft(x => { const n = { ...x }; delete n[row.id]; return n })
      await load()
    } catch { setErr('Network error.') }
    finally { setBusyId(null) }
  }

  /**
   * Record the processing fee Stripe actually returned for a refund. WRITE-ONCE: the same amount
   * again is a harmless no-op, a different amount is refused by the server (409, shown verbatim).
   * Blank is NOT zero: the admin must type 0 (or press "Stripe returned $0") explicitly.
   */
  async function submitFee(row: AwaitingFeeRow) {
    const raw = (feeDraft[row.id] ?? '').trim()
    if (raw === '') { setErr('Enter the fee Stripe returned. Leave nothing blank: type 0.00 if Stripe returned none.'); return }
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) { setErr('Enter a dollar amount of zero or more, with at most two decimals.'); return }
    const cents = Math.round(parseFloat(raw) * 100)
    if (!Number.isInteger(cents) || cents < 0) { setErr('Enter a dollar amount of zero or more.'); return }
    if (!window.confirm(
      `Record ${money(cents)} as the processing fee Stripe returned for ${row.orderNumber}?\n\n` +
      'This is permanent: once recorded it cannot be changed.')) return
    setBusyId(row.id); setErr(null); setNote(null)
    try {
      const res = await fetch(`/api/admin/refunds/${row.id}/fee-returned`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feeRefundedCents: cents }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not record the refund fee.'); return }
      setFeeDraft(x => { const n = { ...x }; delete n[row.id]; return n })
      setNote(json?.result?.outcome === 'already_recorded'
        ? `${row.orderNumber}: that exact amount was already recorded; nothing changed.`
        : `${row.orderNumber}: processing fee returned recorded as ${money(cents)}.`)
      await load()
    } catch { setErr('Network error.') }
    finally { setBusyId(null) }
  }

  const th = {
    textAlign: 'left' as const, padding: '9px 10px', fontSize: 9,
    letterSpacing: '0.1em', textTransform: 'uppercase' as const,
    color: '#9B9B9B', borderBottom: BORDER, whiteSpace: 'nowrap' as const,
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1240 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Returns
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        A return records what physically came back and what it means for inventory and COGS.
        It does not reduce revenue on its own — that is handled by the refund it is allocated to.
      </p>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}

      {note && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#047857', background: '#ECFDF5',
                      border: '1px solid #A7F3D0', padding: '10px 14px', marginBottom: 16 }}>
          {note}
        </div>
      )}

      {/* ── Refunds whose processing-fee return is not recorded ──────────── */}
      {awaitingFee.length > 0 && (
        <>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                        border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 12 }}>
            Whether Stripe returned any of the original processing fee on these refunds is
            <strong> unknown</strong> — not $0. Until it is recorded, the order&apos;s Stripe fee and
            profit cannot be stated. If Stripe returned nothing, record <strong>$0.00</strong>
            explicitly. A recorded value is permanent.
          </div>
          <SectionTitle note="Independent of the merchandise / shipping / tax split and of any return.">
            Refunds awaiting processing-fee return ({awaitingFee.length})
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 26 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#FAF9F7' }}>
                  {['Order', 'Refund', 'Original Stripe fee', 'Fee returned', 'Fee returned $', ''].map((h, i) => (
                    <th key={i} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {awaitingFee.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{r.orderNumber}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 500 }}>{money(r.amountCents)}</td>
                    <td style={{ padding: '9px 10px' }}>
                      {moneyOrUnknown(r.orderStripeFeeCents, 'Unknown')}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#92400E' }}>Unknown</td>
                    <td style={{ padding: '9px 10px' }}>
                      <input type="number" step="0.01" min="0" value={feeDraft[r.id] ?? ''}
                        onChange={e => setFeeDraft(x => ({ ...x, [r.id]: e.target.value }))}
                        placeholder="0.00" style={inputStyle}
                        aria-label={`Processing fee returned for ${r.orderNumber}`} />
                    </td>
                    <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => setFeeDraft(x => ({ ...x, [r.id]: '0.00' }))}
                        disabled={busyId === r.id}
                        style={{ fontFamily: FONT, fontSize: 10, letterSpacing: '0.06em',
                                 textTransform: 'uppercase', padding: '6px 10px', marginRight: 6,
                                 background: '#fff', color: '#1A1A1A', border: BORDER, cursor: 'pointer' }}>
                        Stripe returned $0
                      </button>
                      <button onClick={() => void submitFee(r)}
                        disabled={busyId === r.id || (feeDraft[r.id] ?? '').trim() === ''}
                        style={{ fontFamily: FONT, fontSize: 10, letterSpacing: '0.06em',
                                 textTransform: 'uppercase', padding: '6px 10px',
                                 background: '#1A1A1A', color: '#fff', border: 'none', cursor: 'pointer',
                                 opacity: (feeDraft[r.id] ?? '').trim() === '' ? 0.4 : 1 }}>
                        {busyId === r.id ? '…' : 'Record'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Refunds awaiting component breakdown ─────────────────────────── */}
      {awaiting.length > 0 && (
        <>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                        border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 12 }}>
            Stripe reports a refund total but does not split it into merchandise, shipping
            and tax. Until the split is recorded it is <strong>unknown</strong> — not zero,
            and not the full amount — and these refunds cannot be allocated to a return.
          </div>

          <SectionTitle note="Derive automatically when the refund equals the order total. Otherwise enter a split that totals the refund exactly.">
            Refunds awaiting breakdown ({awaiting.length})
          </SectionTitle>

          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 26 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#FAF9F7' }}>
                  {['Order', 'Refund', 'Merchandise $', 'Shipping $', 'Tax $', 'Total', ''].map((h, i) => (
                    <th key={i} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {awaiting.map(r => {
                  const d = draft[r.id] ?? { m: '', s: '', t: '' }
                  const sum = (toCents(d.m) ?? 0) + (toCents(d.s) ?? 0) + (toCents(d.t) ?? 0)
                  const complete = d.m.trim() && d.s.trim() && d.t.trim()
                  const balanced = complete && sum === r.amountCents
                  return (
                    <tr key={r.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                      <td style={{ padding: '9px 10px' }}>{r.orderNumber}</td>
                      <td style={{ padding: '9px 10px', fontWeight: 500 }}>
                        {money(r.amountCents)}
                      </td>
                      {(['m', 's', 't'] as const).map(k => (
                        <td key={k} style={{ padding: '9px 10px' }}>
                          <input type="number" step="0.01" min="0" value={d[k]}
                            onChange={e => setDraft(x => ({ ...x, [r.id]: { ...d, [k]: e.target.value } }))}
                            placeholder="0.00" style={inputStyle}
                            aria-label={`${k === 'm' ? 'Merchandise' : k === 's' ? 'Shipping' : 'Tax'} for ${r.orderNumber}`} />
                        </td>
                      ))}
                      <td style={{ padding: '9px 10px',
                                   color: !complete ? '#9B9B9B' : balanced ? '#047857' : '#B91C1C' }}>
                        {complete ? money(sum) : '—'}
                        {complete && !balanced && (
                          <span style={{ display: 'block', fontSize: 10 }}>must equal refund</span>
                        )}
                      </td>
                      <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                        {r.canDeriveFullRefund && (
                          <button onClick={() => void derive(r.id)} disabled={busyId === r.id}
                            style={{ fontFamily: FONT, fontSize: 10, letterSpacing: '0.06em',
                                     textTransform: 'uppercase', padding: '6px 10px',
                                     marginRight: 6, background: '#fff', color: '#1A1A1A',
                                     border: BORDER, cursor: 'pointer' }}>
                            Derive
                          </button>
                        )}
                        <button onClick={() => void submitSplit(r)}
                          disabled={busyId === r.id || !balanced}
                          style={{ fontFamily: FONT, fontSize: 10, letterSpacing: '0.06em',
                                   textTransform: 'uppercase', padding: '6px 10px',
                                   background: '#1A1A1A', color: '#fff', border: 'none',
                                   cursor: 'pointer', opacity: balanced ? 1 : 0.4 }}>
                          {busyId === r.id ? '…' : 'Save'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Returns ───────────────────────────────────────────────────────── */}
      <SectionTitle note="COGS is credited back only when a unit is sellable AND restocked. Damaged or lost units keep their original cost.">
        Returns
      </SectionTitle>
      <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#FAF9F7' }}>
              {['Return', 'Order', 'Status', 'Units', 'Return shipping', 'KVRN label cost', 'Requested'].map((h, i) => (
                <th key={i} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} style={{ padding: '18px 12px', color: '#6B6B6B' }}>Loading…</td></tr>
            )}
            {!loading && returns.length === 0 && (
              <tr><td colSpan={7} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                No returns recorded.
              </td></tr>
            )}
            {returns.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                <td style={{ padding: '9px 10px', fontWeight: 500 }}>{r.returnNumber}</td>
                <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.orderNumber}</td>
                <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.status}</td>
                <td style={{ padding: '9px 10px' }}>{r.totalQuantity}</td>
                <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                  {r.returnShippingPaidBy.replace(/_/g, ' ')}
                </td>
                <td style={{ padding: '9px 10px',
                             color: r.returnLabelCostCents === null ? '#92400E' : '#1A1A1A' }}>
                  {r.returnShippingPaidBy === 'kvrn'
                    ? moneyOrUnknown(r.returnLabelCostCents, 'Not recorded')
                    : '—'}
                </td>
                <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                  {r.requestedAt ? new Date(r.requestedAt).toISOString().slice(0, 10) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
