'use client'
// app/admin/financials/disputes/DisputesClient.tsx
//
// Fees and cash movement come from Stripe balance transactions stored verbatim,
// never inferred from dispute status. Whether a fee is retained on a win varies
// by region and contract, so the UI reports what Stripe actually said.
//
// Only a LOST dispute reduces revenue, and only net of refunds already issued on
// the same order — so a refund and a dispute can never reduce revenue twice for
// the same money.

import { useEffect, useState, useCallback } from 'react'
import { FONT, BORDER, money, SectionTitle } from '@/components/admin/FinancialUI'

type Dispute = {
  id: string; stripeDisputeId: string; orderNumber: string
  amountCents: number; status: string; stripeStatus: string
  refundOffsetCents: number; netRevenueImpactCents: number
  disputeFeesCents: number; netCashCents: number; balanceTxnCount: number
  openedAt: string | null; resolvedAt: string | null
}

type Totals = {
  count: number; openCount: number; lostCount: number; wonCount: number
  preventedCount: number
  disputedCents: number; revenueImpactCents: number; feesCents: number
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; bd: string; fg: string }> = {
    open:         { bg: '#FFFBEB', bd: '#FDE68A', fg: '#92400E' },
    under_review: { bg: '#EEF2FF', bd: '#C7D2FE', fg: '#3730A3' },
    won:          { bg: '#F0FDF4', bd: '#BBF7D0', fg: '#166534' },
    lost:         { bg: '#FEF2F2', bd: '#FECACA', fg: '#B91C1C' },
    withdrawn:    { bg: '#F9FAFB', bd: '#E5E7EB', fg: '#6B7280' },
    // Terminal and favourable, but distinct from a contested win: the dispute
    // was blocked or auto-resolved before becoming a formal chargeback.
    prevented:    { bg: '#F0F9FF', bd: '#BAE6FD', fg: '#075985' },
  }
  const c = map[status] ?? map.withdrawn
  return (
    <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
                   padding: '3px 8px', background: c.bg,
                   border: `1px solid ${c.bd}`, color: c.fg }}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

export function DisputesClient() {
  const [disputes, setDisputes] = useState<Dispute[]>([])
  const [totals, setTotals]     = useState<Totals | null>(null)
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res  = await fetch('/api/admin/disputes')
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load disputes.'); return }
      setDisputes(json.disputes ?? [])
      setTotals(json.totals ?? null)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const card = (label: string, value: string, note: string, tone = '#1A1A1A') => (
    <div style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
      <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                  textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>{label}</p>
      <p style={{ fontFamily: FONT, fontSize: 22, fontWeight: 500, color: tone,
                  margin: '6px 0 0' }}>{value}</p>
      <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '4px 0 0' }}>{note}</p>
    </div>
  )

  const th = {
    textAlign: 'left' as const, padding: '9px 10px', fontSize: 9,
    letterSpacing: '0.1em', textTransform: 'uppercase' as const,
    color: '#9B9B9B', borderBottom: BORDER, whiteSpace: 'nowrap' as const,
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1240 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Disputes
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Chargebacks reported by Stripe. Only a lost dispute reduces revenue, and only for the
        portion not already refunded. A prevented dispute was blocked or auto-resolved before
        becoming a formal chargeback, so it never reduces revenue here.
      </p>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}
      {loading && !totals && (
        <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B' }}>Loading…</p>
      )}

      {totals && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
                        gap: 10, marginBottom: 20 }}>
            {card('Open', String(totals.openCount),
                  `${totals.count} total · ${totals.preventedCount} prevented`, '#92400E')}
            {card('Disputed amount', money(totals.disputedCents),
                  'Gross amount under dispute')}
            {card('Revenue impact', money(totals.revenueImpactCents),
                  `${totals.lostCount} lost, net of refunds`,
                  totals.revenueImpactCents > 0 ? '#B91C1C' : '#1A1A1A')}
            {card('Dispute fees', money(totals.feesCents),
                  'From Stripe balance transactions', '#B91C1C')}
          </div>

          <div style={{ fontFamily: FONT, fontSize: 12, color: '#3730A3', background: '#EEF2FF',
                        border: '1px solid #C7D2FE', padding: '10px 14px', marginBottom: 20 }}>
            Fees and cash movement are read from Stripe balance transactions, never inferred
            from status. A dispute already covered by a refund is offset so the same money is
            never counted against revenue twice.
          </div>

          <SectionTitle note="Revenue impact is frozen at the terminal outcome and excludes any amount already refunded.">
            All disputes
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#FAF9F7' }}>
                  {['Order', 'Amount', 'Status', 'Stripe status', 'Refund offset',
                    'Revenue impact', 'Fees', 'Opened'].map((h, i) => (
                    <th key={i} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {disputes.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No disputes. Stripe dispute webhooks will populate this automatically.
                  </td></tr>
                )}
                {disputes.map(d => (
                  <tr key={d.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{d.orderNumber}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 500 }}>{money(d.amountCents)}</td>
                    <td style={{ padding: '9px 10px' }}><StatusPill status={d.status} /></td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {d.stripeStatus.replace(/_/g, ' ')}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {d.refundOffsetCents > 0 ? money(d.refundOffsetCents) : '—'}
                    </td>
                    <td style={{ padding: '9px 10px',
                                 color: d.netRevenueImpactCents > 0 ? '#B91C1C' : '#6B6B6B' }}>
                      {d.netRevenueImpactCents > 0 ? money(d.netRevenueImpactCents) : '—'}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {d.balanceTxnCount === 0 ? 'Not reported' : money(d.disputeFeesCents)}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {d.openedAt ? new Date(d.openedAt).toISOString().slice(0, 10) : '—'}
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
