'use client'
// app/admin/financials/FinancialsClient.tsx
// Period P&L. Every number here comes from lib/financial-calculator.ts via the
// summary API — no arithmetic is performed in this component.

import { useEffect, useState, useCallback } from 'react'
import {
  FONT, BORDER, money, moneyOrUnknown, pctOrDash,
  Metric, ReconciliationBadge, RangePicker, SectionTitle, buildQuery,
} from '@/components/admin/FinancialUI'
import { LineChart, type LineSeries } from '@/components/admin/charts/LineChart'
import { DonutChart, BarBreakdown } from '@/components/admin/charts/BreakdownChart'

// Series palette. Colour carries no meaning beyond distinguishing lines.
const SERIES_DEFS = [
  { key: 'netRevenueCents',         label: 'Net revenue',       color: '#047857' },
  { key: 'realizedProfitCents',     label: 'Profit',            color: '#1D4ED8' },
  { key: 'cogsCents',               label: 'COGS',              color: '#B45309' },
  { key: 'shippingCostCents',       label: 'Shipping cost',     color: '#7C3AED' },
  { key: 'stripeFeeCents',          label: 'Stripe fees',       color: '#BE185D' },
  { key: 'operatingExpenseCents',   label: 'Operating expense', color: '#0F766E' },
  { key: 'advertisingCents',        label: 'Advertising',       color: '#9A3412' },
] as const

type SeriesKey = typeof SERIES_DEFS[number]['key']

type TimeSeries = {
  granularity: string
  buckets: Array<Record<string, number | string>>
  composition: Array<{ label: string; valueCents: number }>
}

const COMPOSITION_COLORS: Record<string, string> = {
  'Product COGS':       '#B45309',
  'Shipping cost':      '#7C3AED',
  'Stripe fees':        '#BE185D',
  'Operating expenses': '#0F766E',
  'Development':        '#475569',
  'Advertising':        '#9A3412',
}

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
  totalOperatingCostCents: number
  averageOrderValueCents: number | null
  profitPerOrderCents: number | null
  cogsPctOfRevenue: number | null
  shippingCostPctOfRevenue: number | null
  stripeFeePctOfRevenue: number | null
  advertisingPctOfRevenue: number | null
  operatingExpensePctOfRevenue: number | null
  refundRatePct: number | null
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
  // Tax Scenario is a client-side planning tool only. It never posts anywhere.
  const [taxRate, setTaxRate] = useState('25')
  // Chart state. The chart consumes the authoritative time-series API; it never
  // recomputes any financial figure locally.
  const [ts, setTs] = useState<TimeSeries | null>(null)
  const [chartView, setChartView] = useState<'line' | 'breakdown'>('line')
  const [breakdownStyle, setBreakdownStyle] = useState<'donut' | 'bars'>('donut')
  const [enabled, setEnabled] = useState<Set<SeriesKey>>(
    new Set<SeriesKey>(['netRevenueCents', 'realizedProfitCents']))

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const q = buildQuery(range, custom)
      const [res, tsRes] = await Promise.all([
        fetch(`/api/admin/financials/summary${q}`),
        fetch(`/api/admin/financials/timeseries${q}`),
      ])
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load financials.'); return }
      setData(json)
      // A chart failure must never blank the numbers above it.
      if (tsRes.ok) setTs(await tsRes.json()); else setTs(null)
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


          {/* ── Interactive chart ─────────────────────────────────────────── */}
          <SectionTitle note="Every value is supplied by the financial API and matches the cards above. Bucket totals reconcile exactly to the period totals.">
            Trend
          </SectionTitle>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                        flexWrap: 'wrap', marginBottom: 10 }}>
            {(['line', 'breakdown'] as const).map(v => (
              <button key={v} onClick={() => setChartView(v)}
                style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.04em',
                         padding: '6px 12px', cursor: 'pointer',
                         border: chartView === v ? '1px solid #1A1A1A' : BORDER,
                         background: chartView === v ? '#1A1A1A' : '#fff',
                         color: chartView === v ? '#fff' : '#1A1A1A' }}>
                {v === 'line' ? 'Line' : 'Breakdown'}
              </button>
            ))}
            {chartView === 'breakdown' && (
              <>
                <span style={{ width: 1, height: 20, background: '#E8E5E0' }} />
                {(['donut', 'bars'] as const).map(v => (
                  <button key={v} onClick={() => setBreakdownStyle(v)}
                    style={{ fontFamily: FONT, fontSize: 11, padding: '6px 12px',
                             cursor: 'pointer',
                             border: breakdownStyle === v ? '1px solid #1A1A1A' : BORDER,
                             background: breakdownStyle === v ? '#1A1A1A' : '#fff',
                             color: breakdownStyle === v ? '#fff' : '#1A1A1A' }}>
                    {v === 'donut' ? 'Donut' : 'Bars'}
                  </button>
                ))}
              </>
            )}
            {ts && chartView === 'line' && (
              <span style={{ fontFamily: FONT, fontSize: 11, color: '#9B9B9B', marginLeft: 4 }}>
                {ts.granularity} buckets
              </span>
            )}
          </div>

          {chartView === 'line' && (
            <>
              {/* Series toggles. All financial series are in cents, so they always
                  share one comparable axis. */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {SERIES_DEFS.map(d => {
                  const on = enabled.has(d.key)
                  return (
                    <button key={d.key}
                      onClick={() => setEnabled(prev => {
                        const next = new Set(prev)
                        if (next.has(d.key)) next.delete(d.key); else next.add(d.key)
                        return next
                      })}
                      aria-pressed={on}
                      style={{ fontFamily: FONT, fontSize: 11, padding: '5px 10px',
                               cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                               border: on ? `1px solid ${d.color}` : BORDER,
                               background: on ? '#fff' : '#FAF9F7',
                               color: on ? '#1A1A1A' : '#9B9B9B' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999,
                                     background: on ? d.color : '#D6D2CB',
                                     display: 'inline-block' }} />
                      {d.label}
                    </button>
                  )
                })}
              </div>

              <div style={{ marginBottom: 26 }}>
                <LineChart
                  labels={(ts?.buckets ?? []).map(b => String(b.label))}
                  formatCents={money}
                  series={SERIES_DEFS.filter(d => enabled.has(d.key)).map<LineSeries>(d => ({
                    key: d.key, label: d.label, color: d.color, unit: 'cents',
                    values: (ts?.buckets ?? []).map(b => Number(b[d.key] ?? 0)),
                  }))}
                  emptyMessage={
                    enabled.size === 0
                      ? 'Select at least one series above.'
                      : 'No paid orders in this period.'
                  }
                />
              </div>
            </>
          )}

          {chartView === 'breakdown' && (
            <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 26 }}>
              <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '0 0 14px' }}>
                Cost composition for the selected period. A breakdown shows parts of a
                whole, so it is applied to composition only and never to the trend above.
              </p>
              {breakdownStyle === 'donut' ? (
                <DonutChart formatCents={money}
                  items={(ts?.composition ?? []).map(c => ({
                    label: c.label, valueCents: c.valueCents,
                    color: COMPOSITION_COLORS[c.label] ?? '#9B9B9B',
                  }))} />
              ) : (
                <BarBreakdown formatCents={money}
                  items={(ts?.composition ?? []).map(c => ({
                    label: c.label, valueCents: c.valueCents,
                    color: COMPOSITION_COLORS[c.label] ?? '#9B9B9B',
                  }))} />
              )}
            </div>
          )}

          {/* Operating metrics */}
          <SectionTitle note="Ratios share one denominator (net revenue) so they can be compared directly. A dash means the denominator was zero, not that the value is 0%.">
            Operating metrics
          </SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))',
                        gap: 10, marginBottom: 26 }}>
            <Metric label="Average order value"
                    value={p.averageOrderValueCents === null ? '—' : money(p.averageOrderValueCents)}
                    sub="Merchandise + shipping, ex-tax" />
            <Metric label="Profit per order"
                    value={p.profitPerOrderCents === null ? '—' : money(p.profitPerOrderCents)}
                    tone={(p.profitPerOrderCents ?? 0) >= 0 ? 'positive' : 'negative'}
                    sub="Contribution ÷ orders" pending={p.isPartial} />
            <Metric label="Total operating cost" value={money(p.totalOperatingCostCents)} tone="muted"
                    sub="All recognized costs" pending={p.isPartial} />
            <Metric label="COGS % of revenue" value={pctOrDash(p.cogsPctOfRevenue)} tone="muted" />
            <Metric label="Shipping % of revenue" value={pctOrDash(p.shippingCostPctOfRevenue)} tone="muted" />
            <Metric label="Stripe fees % of revenue" value={pctOrDash(p.stripeFeePctOfRevenue)} tone="muted" />
            <Metric label="Advertising % of revenue" value={pctOrDash(p.advertisingPctOfRevenue)} tone="muted" />
            <Metric label="Opex % of revenue" value={pctOrDash(p.operatingExpensePctOfRevenue)} tone="muted" />
            <Metric label="Refund rate" value={pctOrDash(p.refundRatePct)} tone="muted"
                    sub="Refunds ÷ gross customer revenue" />
          </div>

          {/* Tax Scenario — planning only */}
          <SectionTitle note="A planning estimate on the selected period's pre-income-tax profit. It changes no record, creates no expense, and does not determine actual tax liability.">
            Tax scenario — hypothetical
          </SectionTitle>
          {(() => {
            // Pure client-side arithmetic. Mirrors computeTaxScenario in the
            // calculator; a loss produces zero estimated tax rather than a refund.
            const rate    = Math.min(100, Math.max(0, Number(taxRate) || 0))
            const preTax  = p.realizedOperatingProfitAfterAdsCents
            const isLoss  = preTax <= 0
            const estTax  = isLoss ? 0 : Math.round(preTax * (rate / 100))
            const afterTax = preTax - estTax
            return (
              <div style={{ border: '1px solid #C7D2FE', background: '#EEF2FF',
                            padding: '16px 18px', marginBottom: 26 }}>
                <div style={{ display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 14 }}>
                  <div>
                    <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                                textTransform: 'uppercase', color: '#4338CA', margin: 0 }}>
                      Pre-income-tax profit
                    </p>
                    <p style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500,
                                color: '#1E1B4B', margin: '6px 0 0' }}>{money(preTax)}</p>
                    <p style={{ fontFamily: FONT, fontSize: 10, color: '#4338CA', margin: '3px 0 0' }}>
                      Official figure — unchanged by this tool
                    </p>
                  </div>
                  <div>
                    <label style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                                    textTransform: 'uppercase', color: '#4338CA' }}>
                      Hypothetical rate %
                      <input type="number" min="0" max="100" step="0.1" value={taxRate}
                        onChange={e => setTaxRate(e.target.value)}
                        aria-label="Hypothetical income tax rate percentage"
                        style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px',
                                 fontSize: 16, fontFamily: FONT, border: '1px solid #C7D2FE',
                                 background: '#fff', boxSizing: 'border-box' }} />
                    </label>
                    <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                      {['15', '20', '22', '25', '30', '37'].map(r => (
                        <button key={r} onClick={() => setTaxRate(r)}
                          style={{ fontFamily: FONT, fontSize: 10, padding: '3px 7px',
                                   cursor: 'pointer', background: taxRate === r ? '#4338CA' : '#fff',
                                   color: taxRate === r ? '#fff' : '#4338CA',
                                   border: '1px solid #C7D2FE' }}>{r}%</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                                textTransform: 'uppercase', color: '#4338CA', margin: 0 }}>
                      Estimated tax
                    </p>
                    <p style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500,
                                color: '#1E1B4B', margin: '6px 0 0' }}>{money(estTax)}</p>
                    {isLoss && (
                      <p style={{ fontFamily: FONT, fontSize: 10, color: '#4338CA', margin: '3px 0 0' }}>
                        No tax estimated on a loss
                      </p>
                    )}
                  </div>
                  <div>
                    <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                                textTransform: 'uppercase', color: '#4338CA', margin: 0 }}>
                      Estimated after-tax
                    </p>
                    <p style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500,
                                color: '#1E1B4B', margin: '6px 0 0' }}>{money(afterTax)}</p>
                  </div>
                </div>
                <p style={{ fontFamily: FONT, fontSize: 11, color: '#4338CA', margin: '14px 0 0' }}>
                  Hypothetical planning estimate only. This does not determine actual tax liability,
                  is not saved, and creates no expense record. Real liability depends on entity type,
                  jurisdiction, deductions and credits that KVRN does not model — consult your
                  accountant or tax preparer.
                </p>
              </div>
            )
          })()}

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
