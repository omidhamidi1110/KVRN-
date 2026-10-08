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
import { money, moneyOrUnknown } from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminNotice, AdminButton, AdminTable, AdminTh, AdminTd,
  AdminLoading, AdminEmpty, adminInputClass,
} from '@/components/admin/ui/AdminUI'

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

  /** Derive the split from the order. Offered only for a genuine full refund. */
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

  const moneyInput = `${adminInputClass} !w-[104px]`

  return (
    <AdminPage>
      <AdminPageHeader
        title="Returns"
        description="Returns affect stock and COGS, not revenue."
        info="A return records what physically came back and what it means for inventory and COGS. It does not reduce revenue on its own — that is handled by the refund it is allocated to."
      />

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {note && <AdminNotice tone="success" className="mb-4">{note}</AdminNotice>}

      {/* ── Refunds whose processing-fee return is not recorded ──────────── */}
      {awaitingFee.length > 0 && (
        <div className="mb-7">
          <AdminNotice tone="warning" className="mb-3" title="Fee returned is unknown, not $0.">
            Until Stripe&apos;s returned processing fee is recorded, the order&apos;s Stripe fee and profit
            cannot be stated. If Stripe returned nothing, record <strong>$0.00</strong> explicitly.
            A recorded value is permanent.
          </AdminNotice>
          <AdminSectionHeader title={`Refunds awaiting processing-fee return (${awaitingFee.length})`}
            info="Independent of the merchandise / shipping / tax split and of any return." />
          <AdminTable minWidth={720} caption="Refunds awaiting processing-fee return">
            <thead>
              <tr>
                {['Order', 'Refund', 'Original Stripe fee', 'Fee returned', 'Fee returned $'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
                <AdminTh><span className="sr-only">Actions</span></AdminTh>
              </tr>
            </thead>
            <tbody>
              {awaitingFee.map(r => (
                <tr key={r.id}>
                  <AdminTd>{r.orderNumber}</AdminTd>
                  <AdminTd className="font-medium">{money(r.amountCents)}</AdminTd>
                  <AdminTd>{moneyOrUnknown(r.orderStripeFeeCents, 'Unknown')}</AdminTd>
                  <AdminTd className="font-medium text-[#92400E]">Unknown</AdminTd>
                  <AdminTd>
                    <input type="number" step="0.01" min="0" value={feeDraft[r.id] ?? ''}
                      onChange={e => setFeeDraft(x => ({ ...x, [r.id]: e.target.value }))}
                      placeholder="0.00" className={moneyInput}
                      aria-label={`Processing fee returned for ${r.orderNumber}`} />
                  </AdminTd>
                  <AdminTd className="whitespace-nowrap">
                    <span className="flex gap-1.5">
                      <AdminButton size="sm" onClick={() => setFeeDraft(x => ({ ...x, [r.id]: '0.00' }))}
                        disabled={busyId === r.id}>
                        Stripe returned $0
                      </AdminButton>
                      <AdminButton size="sm" variant="primary" onClick={() => void submitFee(r)}
                        loading={busyId === r.id} disabled={(feeDraft[r.id] ?? '').trim() === ''}>
                        Record
                      </AdminButton>
                    </span>
                  </AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        </div>
      )}

      {/* ── Refunds awaiting component breakdown ─────────────────────────── */}
      {awaiting.length > 0 && (
        <div className="mb-7">
          <AdminNotice tone="warning" className="mb-3" title="Refund split is unknown.">
            Stripe reports a refund total but not the merchandise, shipping and tax split. Until it
            is recorded these refunds count as unknown — not zero, not the full amount — and cannot
            be allocated to a return.
          </AdminNotice>

          <AdminSectionHeader title={`Refunds awaiting breakdown (${awaiting.length})`}
            description="Derive when the refund equals the order total; otherwise enter a split that totals the refund." />

          <AdminTable minWidth={760} caption="Refunds awaiting breakdown">
            <thead>
              <tr>
                {['Order', 'Refund', 'Merchandise $', 'Shipping $', 'Tax $', 'Total'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
                <AdminTh><span className="sr-only">Actions</span></AdminTh>
              </tr>
            </thead>
            <tbody>
              {awaiting.map(r => {
                const d = draft[r.id] ?? { m: '', s: '', t: '' }
                const sum = (toCents(d.m) ?? 0) + (toCents(d.s) ?? 0) + (toCents(d.t) ?? 0)
                const complete = d.m.trim() && d.s.trim() && d.t.trim()
                const balanced = complete && sum === r.amountCents
                return (
                  <tr key={r.id}>
                    <AdminTd>{r.orderNumber}</AdminTd>
                    <AdminTd className="font-medium">{money(r.amountCents)}</AdminTd>
                    {(['m', 's', 't'] as const).map(k => (
                      <AdminTd key={k}>
                        <input type="number" step="0.01" min="0" value={d[k]}
                          onChange={e => setDraft(x => ({ ...x, [r.id]: { ...d, [k]: e.target.value } }))}
                          placeholder="0.00" className={moneyInput}
                          aria-label={`${k === 'm' ? 'Merchandise' : k === 's' ? 'Shipping' : 'Tax'} for ${r.orderNumber}`} />
                      </AdminTd>
                    ))}
                    <AdminTd className={!complete ? 'text-[#8A8A85]' : balanced ? 'text-[#047857]' : 'font-medium text-[#B91C1C]'}>
                      {complete ? money(sum) : '—'}
                      {complete && !balanced && (
                        <span className="block text-[11px]">must equal refund</span>
                      )}
                    </AdminTd>
                    <AdminTd className="whitespace-nowrap">
                      <span className="flex gap-1.5">
                        {r.canDeriveFullRefund && (
                          <AdminButton size="sm" onClick={() => void derive(r.id)} disabled={busyId === r.id}>
                            Derive
                          </AdminButton>
                        )}
                        <AdminButton size="sm" variant="primary" onClick={() => void submitSplit(r)}
                          loading={busyId === r.id} disabled={!balanced}>
                          Save
                        </AdminButton>
                      </span>
                    </AdminTd>
                  </tr>
                )
              })}
            </tbody>
          </AdminTable>
        </div>
      )}

      {/* ── Returns ───────────────────────────────────────────────────────── */}
      <AdminSectionHeader title="Returns"
        info="COGS is credited back only when a unit is sellable AND restocked. Damaged or lost units keep their original cost." />
      {loading ? <AdminLoading /> : returns.length === 0 ? <AdminEmpty title="No returns recorded." /> : (
        <AdminTable minWidth={720} caption="Returns">
          <thead>
            <tr>
              {['Return', 'Order', 'Status', 'Units', 'Return shipping', 'KVRN label cost', 'Requested'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
            </tr>
          </thead>
          <tbody>
            {returns.map(r => (
              <tr key={r.id}>
                <AdminTd className="font-medium">{r.returnNumber}</AdminTd>
                <AdminTd className="text-[#6B6B66]">{r.orderNumber}</AdminTd>
                <AdminTd className="text-[#6B6B66]">{r.status}</AdminTd>
                <AdminTd>{r.totalQuantity}</AdminTd>
                <AdminTd className="text-[#6B6B66]">{r.returnShippingPaidBy.replace(/_/g, ' ')}</AdminTd>
                <AdminTd className={r.returnLabelCostCents === null && r.returnShippingPaidBy === 'kvrn' ? 'font-medium text-[#92400E]' : ''}>
                  {r.returnShippingPaidBy === 'kvrn'
                    ? moneyOrUnknown(r.returnLabelCostCents, 'Not recorded')
                    : '—'}
                </AdminTd>
                <AdminTd className="text-[#6B6B66]">
                  {r.requestedAt ? new Date(r.requestedAt).toISOString().slice(0, 10) : '—'}
                </AdminTd>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  )
}
