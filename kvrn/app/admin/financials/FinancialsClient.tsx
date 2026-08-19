'use client'
// app/admin/financials/FinancialsClient.tsx
// Period P&L. Every number here comes from lib/financial-calculator.ts via the
// summary API — no arithmetic is performed in this component.

import { useEffect, useState, useCallback } from 'react'
import {
  FONT, BORDER, money, moneyOrUnknown, pctOrDash,
  Metric, ReconciliationBadge, RangePicker, SectionTitle, buildQuery,
} from '@/components/admin/FinancialUI'

type Period = {
  orderCount: number
  grossMerchandiseCents: number
  merchandiseDiscountCents: number
  merchandiseRevenueCents: number
  shippingRevenueCents: number
  grossCustomerRevenueCents: number
  refundCents: number
  netRevenueCents: number
  taxCollectedCents: number
  cogsCents: number
  shippingCostCents: number
  stripeFeeCents: number
  ordersMissingCogs: number
  ordersMissingShippingCost: number
  ordersMissingStripeFee: number
  shippingMarginCents: number
  shippingSubsidyCents: number
  freeShippingOrders: number
  freeShippingCostCents: number
  recognizedOperatingExpensesCents: number
  recognizedDevelopmentExpensesCents: number
  advertisingSpendCents: number
  estimatedAccruedOperatingExpensesCents: number
  projectedOperatingExpensesCents: number
  contributionProfitCents: number
  realizedOperatingProfitBeforeAdsCents: number
  realizedOperatingProfitAfterAdsCents: number
  realizedProfitAfterDevelopmentCents: number
  contributionMarginPct: number | null
  realizedOperatingMarginPct: number | null
  isPartial: boolean
}

type RecentOrder = {
  orderId: string
  orderNumber: string
  paidAt: string | null
  netRevenueCents: number
  contributionProfitCents: number | null
  contributionMarginPct: number | null
  reconciliation: { state: 'complete' | 'partial' | 'unknown'; missing: Array<{ field: string; label: string }> }
}

export function FinancialsClient() {
  const [range, setRange]   = useState('30d')
  const [custom, setCustom] = useState({ start: '', end: '' })
  const [data, setData]     = useState<{ period: Period; recentOrders: RecentOrder[]; adSpendByPlatform: any[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await fetch(`/api/admin/financials/summary${buildQuery(range, custom)}`)
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load financials.'); return }
      setData(json)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [range, custom])

  useEffect(() => { void load() }, [load])

  const p = data?.period

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1180 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Financials
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Revenue is recognised on the date an order was paid. All periods are UTC.
      </p>

      <div style={{ marginBottom: 22 }}>
        <RangePicker range={range} onRange={setRange} custom={custom} onCustom={setCustom} />
      </div>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C',
                      background: '#FEF2F2', border: '1px solid #FECACA',
                      padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}

      {loading && !data && (
        <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B' }}>Loading…</p>
      )}

      {p && (
        <>
          {p.isPartial && (
            <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E',
                          background: '#FFFBEB', border: '1px solid #FDE68A',
                          padding: '10px 14px', marginBottom: 18 }}>
              Some costs in this period are not yet reconciled
              {p.ordersMissingCogs > 0        && ` · ${p.ordersMissingCogs} missing COGS`}
              {p.ordersMissingShippingCost > 0 && ` · ${p.ordersMissingShippingCost} missing shipping cost`}
              {p.ordersMissingStripeFee > 0    && ` · ${p.ordersMissingStripeFee} missing Stripe fee`}
              . Costs shown are a floor and profit is an upper bound.
            </div>
          )}

          {/* Revenue */}
          <SectionTitle note="What customers were charged, net of discounts and refunds.">
            Revenue
          </SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))',
                        gap: 10, marginBottom: 26 }}>
            <Metric label="Gross merchandise" value={money(p.grossMerchandiseCents)}
                    sub={`${p.orderCount} paid orders`} />
            <Metric label="Discounts" value={`-${money(p.merchandiseDiscountCents)}`} tone="muted" />
            <Metric label="Merchandise revenue" value={money(p.merchandiseRevenueCents)} />
            <Metric label="Shipping revenue" value={money(p.shippingRevenueCents)}
                    sub="Charged to customers" />
            <Metric label="Refunds" value={`-${money(p.refundCents)}`} tone="muted" />
            <Metric label="Net revenue" value={money(p.netRevenueCents)} tone="positive" />
          </div>

          {/* Costs */}
          <SectionTitle note="What the business actually paid. Unreconciled costs are excluded, not assumed to be zero.">
            Costs
          </SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))',
                        gap: 10, marginBottom: 26 }}>
            <Metric label="Product COGS" value={money(p.cogsCents)}
                    sub={p.ordersMissingCogs > 0 ? `${p.ordersMissingCogs} orders unknown` : 'All orders costed'}
                    pending={p.ordersMissingCogs > 0} />
            <Metric label="Shipping cost" value={money(p.shippingCostCents)}
                    sub={p.ordersMissingShippingCost > 0 ? `${p.ordersMissingShippingCost} orders unknown` : 'All labels recorded'}
                    pending={p.ordersMissingShippingCost > 0} />
            <Metric label="Stripe fees" value={money(p.stripeFeeCents)}
                    sub={p.ordersMissingStripeFee > 0 ? `${p.ordersMissingStripeFee} orders pending` : 'All reconciled'}
                    pending={p.ordersMissingStripeFee > 0} />
            <Metric label="Operating expenses"
                    value={money(p.recognizedOperatingExpensesCents)} tone="muted"
                    sub="Recognized to this period" />
            <Metric label="Development"
                    value={money(p.recognizedDevelopmentExpensesCents)} tone="muted"
                    sub="GitHub / Codespaces — reported apart" />
            <Metric label="Advertising" value={money(p.advertisingSpendCents)} tone="muted" />
            <Metric label="Tax collected" value={money(p.taxCollectedCents)} tone="muted"
                    sub="Pass-through — not revenue" />
          </div>

          {/* Profit */}
          <SectionTitle note="Contribution profit = net revenue − COGS − shipping cost − Stripe fees. Realised operating profit subtracts RECOGNIZED expense — real transactions apportioned to this period. Expected obligations and usage forecasts are never deducted. Cash actually paid is shown on the Infrastructure page and will differ when a charge spans several months.">
            Profit — realised
          </SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))',
                        gap: 10, marginBottom: 26 }}>
            <Metric label="Contribution profit" value={money(p.contributionProfitCents)}
                    tone={p.contributionProfitCents >= 0 ? 'positive' : 'negative'}
                    sub={`Margin ${pctOrDash(p.contributionMarginPct)}`}
                    pending={p.isPartial} />
            <Metric label="Operating profit before ads"
                    value={money(p.realizedOperatingProfitBeforeAdsCents)}
                    tone={p.realizedOperatingProfitBeforeAdsCents >= 0 ? 'positive' : 'negative'}
                    sub="− recognized operating expense"
                    pending={p.isPartial} />
            <Metric label="Operating profit after ads"
                    value={money(p.realizedOperatingProfitAfterAdsCents)}
                    tone={p.realizedOperatingProfitAfterAdsCents >= 0 ? 'positive' : 'negative'}
                    sub={`Margin ${pctOrDash(p.realizedOperatingMarginPct)}`}
                    pending={p.isPartial} />
            <Metric label="After development spend"
                    value={money(p.realizedProfitAfterDevelopmentCents)}
                    tone={p.realizedProfitAfterDevelopmentCents >= 0 ? 'positive' : 'negative'}
                    sub="− GitHub / Codespaces"
                    pending={p.isPartial} />
            <Metric label="Shipping margin" value={money(p.shippingMarginCents)}
                    tone={p.shippingMarginCents >= 0 ? 'positive' : 'negative'}
                    sub="Revenue − carrier cost" />
            <Metric label="Free shipping cost" value={money(p.freeShippingCostCents)} tone="muted"
                    sub={`${p.freeShippingOrders} orders`} />
          </div>

          {/* FORECASTS — explicitly labelled, never mixed into realised profit above */}
          <SectionTitle note="Forecasts from provider usage. These are NOT invoices and are excluded from every realised figure above.">
            Forecast — not billed
          </SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))',
                        gap: 10, marginBottom: 26 }}>
            <Metric label="Estimated accrued"
                    value={money(p.estimatedAccruedOperatingExpensesCents)} tone="muted"
                    sub="Usage so far — not billed" />
            <Metric label="Projected month-end"
                    value={money(p.projectedOperatingExpensesCents)} tone="muted"
                    sub="If usage continues" />
          </div>

          {/* Recent orders */}
          <SectionTitle>Recent orders</SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#FAF9F7' }}>
                  {['Order', 'Paid', 'Net revenue', 'Contribution', 'Margin', 'Status'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 9,
                                         letterSpacing: '0.1em', textTransform: 'uppercase',
                                         color: '#9B9B9B', borderBottom: BORDER }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data!.recentOrders.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No paid orders in this period.
                  </td></tr>
                )}
                {data!.recentOrders.map(o => (
                  <tr key={o.orderId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 12px' }}>{o.orderNumber}</td>
                    <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>
                      {o.paidAt ? new Date(o.paidAt).toISOString().slice(0, 10) : '—'}
                    </td>
                    <td style={{ padding: '9px 12px' }}>{money(o.netRevenueCents)}</td>
                    <td style={{ padding: '9px 12px',
                                 color: o.contributionProfitCents === null ? '#6B7280'
                                      : o.contributionProfitCents >= 0 ? '#047857' : '#B91C1C' }}>
                      {moneyOrUnknown(o.contributionProfitCents, 'Pending')}
                    </td>
                    <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>
                      {pctOrDash(o.contributionMarginPct)}
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <ReconciliationBadge state={o.reconciliation.state}
                                           missing={o.reconciliation.missing} />
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
