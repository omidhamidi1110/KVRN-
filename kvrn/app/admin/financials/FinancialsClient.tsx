'use client'
// app/admin/financials/FinancialsClient.tsx
// Period P&L. Every number here comes from lib/financial-calculator.ts via the
// summary API — no arithmetic is performed in this component.

import { useEffect, useState, useCallback } from 'react'
import {
  money, pctOrDash,
  Metric, OrderIntegrityBadge, RangePicker, buildQuery,
} from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminNotice, AdminSegmented, AdminStatGrid,
  AdminTable, AdminTh, AdminTd, AdminLoading, AdminField, InfoTip, adminInputClass,
} from '@/components/admin/ui/AdminUI'
import { LineChart, type LineSeries } from '@/components/admin/charts/LineChart'
import { BarChart } from '@/components/admin/charts/BarChart'
import { ChartBoundary, ChartError, ChartLoading } from '@/components/admin/charts/ChartBoundary'
import { DonutChart, BarBreakdown } from '@/components/admin/charts/BreakdownChart'
import {
  plotFinancialSeries, summarizeCompleteness, salesTrend,
  type FinancialBucketView, type FinancialSeriesKey,
} from '@/lib/chart-data'
import { profitPresentation, knownSoFarLabel, orderRowPresentation, RECONCILIATION_HREF } from '@/lib/financial-presentation'

// Series palette. Colour carries no meaning beyond distinguishing lines.
const SERIES_DEFS = [
  { key: 'netRevenueCents',         label: 'Net revenue',       color: '#047857' },
  { key: 'refundCents',             label: 'Refunds',           color: '#6B7280' },
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
  /** Buckets carry the money fields plus the per-bucket unknown counters (see lib/chart-data.ts). */
  buckets: Array<FinancialBucketView & { start: string; end: string }>
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
  disputeLossCents: number
  returnCogsCreditCents: number
  cancellationCogsCreditCents: number
  exchangeCogsCents: number
  exchangeShippingCostCents: number
  returnLabelCostCents: number
  disputeFeeCents: number
  affiliateCommissionCents: number
  writeOffCostCents: number
  ordersWithUnknownCosts: number
  /** Exact, or null when ANY input is unknown. Null is shown as "Unknown", never $0. */
  canonicalOrderContributionCents: number | null
  canonicalOperatingProfitCents: number | null
  profitCompleteness: 'complete' | 'incomplete' | 'exception'
  /** Known-so-far diagnostic. Not exact; shown only with that label. */
  nonAuthoritativeOperatingProfitCents: number
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
  integrityState?: 'RECONCILED' | 'INCOMPLETE' | 'EXCEPTION'
}

type PeriodIntegrityView = {
  state: 'RECONCILED' | 'INCOMPLETE' | 'EXCEPTION'
  exceptionCount: number
  incompleteCount: number
  orderCohortCount: number
  byCode: Array<{ issueCode: string; state: string; domain: string; count: number }>
  scope: string
  checkedAt: string
}

export function FinancialsClient() {
  const [range, setRange]   = useState('30d')
  const [custom, setCustom] = useState({ start: '', end: '' })
  const [data, setData]     = useState<{ period: Period; integrity?: PeriodIntegrityView; recentOrders: RecentOrder[]; adSpendByPlatform: any[]; cashMovement?: any } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)
  // Tax Scenario is a client-side planning tool only. It never posts anywhere.
  const [taxRate, setTaxRate] = useState('25')
  // Chart state. The chart consumes the time-series API; it never
  // recomputes any financial figure locally.
  const [ts, setTs] = useState<TimeSeries | null>(null)
  // A chart-data failure is shown as an error, never as an empty "no orders" chart.
  const [tsFailed, setTsFailed] = useState(false)
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
      if (tsRes.ok) { setTs(await tsRes.json()); setTsFailed(false) } else { setTs(null); setTsFailed(true) }
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [range, custom])

  useEffect(() => { void load() }, [load])

  const p = data?.period
  // Period-RELEVANT integrity state gates every "exact" claim. Missing integrity data
  // (older cached response) is treated as INCOMPLETE, never as reconciled.
  const intState = data?.integrity?.state ?? 'INCOMPLETE'
  const present = p ? profitPresentation({
    canonicalOperatingProfitCents: p.canonicalOperatingProfitCents,
    integrityState: intState,
    exceptionCount: data?.integrity?.exceptionCount,
    incompleteCount: data?.integrity?.incompleteCount,
  }) : null
  const notExact = intState !== 'RECONCILED'

  // Chart series: every point is classified as exact / incomplete / unknown by the pure
  // helper in lib/chart-data.ts. Nothing is recomputed and no unknown value becomes $0.
  const buckets = ts?.buckets ?? []
  const activeDefs = SERIES_DEFS.filter(d => enabled.has(d.key))
  const lineSeries: LineSeries[] = activeDefs.map(d => {
    const plotted = plotFinancialSeries(buckets, d.key as FinancialSeriesKey)
    return {
      key: d.key,
      // Profit is "known so far" whenever the period is not fully reconciled.
      label: d.key === 'realizedProfitCents' && notExact ? 'Profit (known so far)' : d.label,
      color: d.color, unit: 'cents',
      values: plotted.values, status: plotted.status, bounds: plotted.bounds, notes: plotted.notes,
    }
  })
  const completeness = summarizeCompleteness(buckets, activeDefs.map(d => d.key as FinancialSeriesKey))
  const sales = salesTrend(buckets)

  const sectionGap = 'mb-7'
  const rangeNote = (
    <>Revenue is recognised on the date an order was paid. All periods are UTC.</>
  )

  return (
    <AdminPage>
      <AdminPageHeader title="Financials" description="Revenue, costs, and profit." info={rangeNote} />

      <div className="mb-5">
        <RangePicker range={range} onRange={setRange} custom={custom} onCustom={setCustom} />
      </div>

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}

      {loading && !data && <AdminLoading />}

      {p && (
        <>
          {notExact && (
            <AdminNotice
              tone={intState === 'EXCEPTION' ? 'danger' : 'warning'}
              className="mb-4"
              title={intState === 'EXCEPTION' ? 'Invalid — reconciliation exception in this period.' : 'Not exact — reconciliation is incomplete for this period.'}
            >
              {data?.integrity?.exceptionCount ? `${data.integrity.exceptionCount} exception(s)` : ''}
              {data?.integrity?.exceptionCount && data?.integrity?.incompleteCount ? ' · ' : ''}
              {data?.integrity?.incompleteCount ? `${data.integrity.incompleteCount} incomplete` : ''}
              {data?.integrity?.byCode?.length ? ` (${data.integrity.byCode.slice(0, 4).map(c => c.issueCode).join(', ')})` : ''}
              {'. '}Exact operating profit is not shown; figures below are known so far.
              {' '}<a href={RECONCILIATION_HREF} className="font-medium underline underline-offset-2">Open Reconciliation</a>
            </AdminNotice>
          )}
          {p.isPartial && (
            <AdminNotice tone="warning" className="mb-4" title="Some costs are not yet reconciled.">
              {[
                p.ordersMissingCogs > 0 && `${p.ordersMissingCogs} missing COGS`,
                p.ordersMissingShippingCost > 0 && `${p.ordersMissingShippingCost} missing shipping cost`,
                p.ordersMissingStripeFee > 0 && `${p.ordersMissingStripeFee} missing Stripe fee`,
                p.ordersWithUnknownCosts > 0 && `${p.ordersWithUnknownCosts} orders with an unknown cost in total`,
              ].filter(Boolean).join(' · ')}
              {'. '}Costs shown are a floor and profit is an upper bound.
              {' '}<a href="/admin/financials/integrity" className="font-medium underline underline-offset-2">See reconciliation</a>
            </AdminNotice>
          )}

          {/* Revenue */}
          <AdminSectionHeader title="Revenue" info="What customers were charged, net of discounts and refunds." />
          <AdminStatGrid className={sectionGap}>
            <Metric label="Gross merchandise" value={money(p.grossMerchandiseCents)}
                    sub={`${p.orderCount} paid orders`} />
            <Metric label="Discounts" value={`-${money(p.merchandiseDiscountCents)}`} tone="muted" />
            <Metric label="Merchandise revenue" value={money(p.merchandiseRevenueCents)} />
            <Metric label="Shipping revenue" value={money(p.shippingRevenueCents)}
                    sub="Charged to customers" />
            <Metric label="Refunds" value={`-${money(p.refundCents)}`} tone="muted" />
            <Metric label="Net revenue" value={money(p.netRevenueCents)} tone="positive" />
          </AdminStatGrid>

          {/* Costs */}
          <AdminSectionHeader title="Costs"
            info="What the business actually paid. Unreconciled costs are excluded, not assumed to be zero." />
          <AdminStatGrid className={sectionGap}>
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
                    sub="Recognized to this period"
                    info="Real transactions apportioned to this period. Expected obligations and usage forecasts are not included." />
            <Metric label="Development"
                    value={money(p.recognizedDevelopmentExpensesCents)} tone="muted"
                    sub="GitHub / Codespaces — reported apart" />
            <Metric label="Advertising" value={money(p.advertisingSpendCents)} tone="muted" />
            <Metric label="Tax collected" value={money(p.taxCollectedCents)} tone="muted"
                    sub="Pass-through — not revenue" />
            <Metric label="Affiliate commission" value={money(p.affiliateCommissionCents)} tone="muted"
                    sub="Expense — payouts are cash"
                    info="Commission is recorded as an expense when it accrues. Payouts are cash movements and are shown on the Affiliates page." />
            <Metric label="Dispute loss / fees"
                    value={money(p.disputeLossCents + p.disputeFeeCents)} tone="muted"
                    sub="Loss is netted against refunds" />
            <Metric label="Returns & exchanges"
                    value={money(p.exchangeCogsCents + p.exchangeShippingCostCents + p.returnLabelCostCents - p.returnCogsCreditCents)}
                    tone="muted" sub="Replacement + labels − restocked cost" />
            <Metric label="Cancelled-order COGS credit"
                    value={money(p.cancellationCogsCreditCents)} tone="muted"
                    sub="Never-shipped, fully refunded"
                    info="Restocked cost of fully refunded orders that never shipped. It offsets the COGS recorded when the order was sold." />
            <Metric label="Inventory write-offs" value={money(p.writeOffCostCents)} tone="muted"
                    sub="Recognized when units leave stock" />

          </AdminStatGrid>

          {/* Profit */}
          <AdminSectionHeader title="Profit — realised"
            description="Cash movement is separate and is not profit."
            info={<>
              <p>Canonical order contribution = net revenue − COGS − shipping cost − Stripe fees (net of returned fees), plus the order&rsquo;s return, exchange, dispute and affiliate-commission effects; it is exact only when the order is reconciled.</p>
              <p className="mt-2">Realised operating profit subtracts recognised expense: real transactions apportioned to this period. Expected obligations and usage forecasts are never deducted. Cash actually paid is shown on the Infrastructure page and will differ when a charge spans several months.</p>
              <p className="mt-2">Cohort basis: orders paid in this period, with every refund, dispute, return, exchange and commission that later touched them. &ldquo;Exact&rdquo; is shown only when this period is reconciled (Unknown when something is missing, Invalid when the data contradicts itself); the other figures are known so far.</p>
            </>} />
          <AdminStatGrid className={sectionGap}>
            <Metric label={present!.label}
                    value={present!.word ?? money(present!.cents as number)}
                    tone={present!.kind === 'exact'
                      ? ((present!.cents as number) >= 0 ? 'positive' : 'negative') : 'muted'}
                    sub={present!.sub}
                    pending={present!.kind !== 'exact'} />
            {present!.href && (
              <a href={present!.href} className="self-center text-[12px] font-medium text-[#92400E] underline underline-offset-2">
                Open Reconciliation →
              </a>
            )}
            <Metric label={knownSoFarLabel("Contribution profit", intState)} value={money(p.contributionProfitCents)}
                    tone={p.contributionProfitCents >= 0 ? 'positive' : 'negative'}
                    sub={`Margin ${pctOrDash(p.contributionMarginPct)}`}
                    pending={p.isPartial || notExact} />
            <Metric label={knownSoFarLabel("Operating profit before ads", intState)}
                    value={money(p.realizedOperatingProfitBeforeAdsCents)}
                    tone={p.realizedOperatingProfitBeforeAdsCents >= 0 ? 'positive' : 'negative'}
                    sub="− recognized operating expense"
                    pending={p.isPartial || notExact} />
            <Metric label={knownSoFarLabel("Operating profit after ads", intState)}
                    value={money(p.realizedOperatingProfitAfterAdsCents)}
                    tone={p.realizedOperatingProfitAfterAdsCents >= 0 ? 'positive' : 'negative'}
                    sub={`Margin ${pctOrDash(p.realizedOperatingMarginPct)}`}
                    pending={p.isPartial || notExact} />
            <Metric label={knownSoFarLabel("After development spend", intState)}
                    value={money(p.realizedProfitAfterDevelopmentCents)}
                    tone={p.realizedProfitAfterDevelopmentCents >= 0 ? 'positive' : 'negative'}
                    sub="− GitHub / Codespaces"
                    pending={p.isPartial || notExact} />
            <Metric label="Shipping margin" value={money(p.shippingMarginCents)}
                    tone={p.shippingMarginCents >= 0 ? 'positive' : 'negative'}
                    sub="Revenue − carrier cost" />
            <Metric label="Free shipping cost" value={money(p.freeShippingCostCents)} tone="muted"
                    sub={`${p.freeShippingOrders} orders`} />
          </AdminStatGrid>

          {/* FORECASTS — explicitly labelled, never mixed into realised profit above */}
          <AdminSectionHeader title="Forecast — not billed"
            description="From provider usage. Not invoices; excluded from every figure above." />
          <AdminStatGrid className={sectionGap}>
            <Metric label="Estimated accrued"
                    value={money(p.estimatedAccruedOperatingExpensesCents)} tone="muted"
                    sub="Usage so far — not billed" />
            <Metric label="Projected month-end"
                    value={money(p.projectedOperatingExpensesCents)} tone="muted"
                    sub="If usage continues" />
          </AdminStatGrid>


          {/* ── Interactive chart ─────────────────────────────────────────── */}
          <AdminSectionHeader title="Trend"
            info={<>
              <p>Every value is supplied by the financial API and matches the cards above. Bucket totals reconcile exactly to the period totals.</p>
              <p className="mt-2">Orders, refunds and costs are placed in the bucket where the order was <em>paid</em> (the same cohort as the cards above; a refund appears against the order&rsquo;s payment date, not its refund date).</p>
            </>} />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <AdminSegmented ariaLabel="Chart view" value={chartView}
              options={[{ id: 'line' as const, label: 'Line' }, { id: 'breakdown' as const, label: 'Breakdown' }]}
              onChange={setChartView} />
            {chartView === 'breakdown' && (
              <AdminSegmented ariaLabel="Breakdown style" value={breakdownStyle}
                options={[{ id: 'donut' as const, label: 'Donut' }, { id: 'bars' as const, label: 'Bars' }]}
                onChange={setBreakdownStyle} />
            )}
            {ts && chartView === 'line' && (
              <span className="ml-1 text-[11px] text-[#8A8A85]">{ts.granularity} buckets</span>
            )}
          </div>

          {chartView === 'line' && (
            <>
              {/* Series toggles. All financial series are in cents, so they always
                  share one comparable axis. */}
              <div className="mb-3 flex flex-wrap gap-1.5">
                {SERIES_DEFS.map(d => {
                  const on = enabled.has(d.key)
                  return (
                    <button key={d.key} type="button"
                      onClick={() => setEnabled(prev => {
                        const next = new Set(prev)
                        if (next.has(d.key)) next.delete(d.key); else next.add(d.key)
                        return next
                      })}
                      aria-pressed={on}
                      className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 ${on ? 'bg-white text-[#171717]' : 'border-black/[0.10] bg-[#FAFAF8] text-[#8A8A85]'}`}
                      style={on ? { borderColor: d.color } : undefined}>
                      <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full"
                            style={{ background: on ? d.color : '#D6D2CB' }} />
                      {d.label}
                    </button>
                  )
                })}
              </div>

              <div className="mb-3">
                {tsFailed ? <ChartError /> : loading && !ts ? <ChartLoading height={240} /> : (
                  <ChartBoundary label="The trend chart">
                    <LineChart
                      labels={buckets.map(b => b.label)}
                      formatCents={money}
                      series={lineSeries}
                      emptyMessage={
                        enabled.size === 0
                          ? 'Select at least one series above.'
                          : 'No data for this period'
                      }
                    />
                  </ChartBoundary>
                )}
              </div>
              {(completeness.unknown > 0 || completeness.incomplete > 0) && (
                <p className="mb-7 text-[11px] font-medium text-[#92400E]">
                  {completeness.unknown > 0 && `${completeness.unknown} period${completeness.unknown === 1 ? '' : 's'} unknown (shaded). `}
                  {completeness.incomplete > 0 && `${completeness.incomplete} period${completeness.incomplete === 1 ? '' : 's'} incomplete (hollow markers): costs are floors and profit is an upper bound. `}
                  Unrecorded costs are never drawn as $0.
                </p>
              )}
              {notExact && !(completeness.unknown > 0 || completeness.incomplete > 0) && enabled.has('realizedProfitCents') && (
                <p className="mb-7 text-[11px] font-medium text-[#92400E]">The period is not fully reconciled, so the profit line is known-so-far, not exact.</p>
              )}
              {!(completeness.unknown > 0 || completeness.incomplete > 0) && !(notExact && enabled.has('realizedProfitCents')) && <div className="mb-7" />}
            </>
          )}

          {chartView === 'breakdown' && (
            <AdminCard className="mb-7">
              <p className="mb-3 flex items-center gap-0.5 text-[12px] text-[#4A4A46]">
                Cost composition for the selected period.
                <InfoTip label="About the breakdown">A breakdown shows parts of a whole, so it is applied to composition only and never to the trend above.</InfoTip>
              </p>
              {p?.isPartial && (
                <p className="mb-3 text-[11px] font-medium text-[#92400E]">Costs that are not yet recorded are not included in these parts, so they are lower bounds, not the full cost.</p>
              )}
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
            </AdminCard>
          )}

          {/* ── Sales & orders ─────────────────────────────────────────────── */}
          <AdminSectionHeader title="Sales & orders"
            info="Paid orders are counted on the date they were paid. Average order value is merchandise + shipping charged to customers, ex-tax and before refunds — the same definition as the Average order value card below. A period with no orders has no average (a gap), not $0." />
          {tsFailed ? <ChartError /> : loading && !ts ? <ChartLoading /> : (
            <div className="mb-7 grid gap-3 md:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">Paid orders per {ts?.granularity ?? 'period'}</p>
                <ChartBoundary label="The paid-orders chart">
                  <BarChart labels={buckets.map(b => b.label)} values={sales.orders} unitLabel="orders"
                            emptyMessage="No data for this period"
                            zeroMessage="0 paid orders in this period" />
                </ChartBoundary>
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">Average order value</p>
                <ChartBoundary label="The average-order-value chart">
                  <LineChart
                    labels={buckets.map(b => b.label)} formatCents={money} height={200}
                    series={[{ key: 'aov', label: 'Average order value', color: '#1D4ED8', unit: 'cents',
                               values: sales.averageOrderValueCents }]}
                    emptyMessage="No average order value — no paid orders in this period" />
                </ChartBoundary>
              </div>
            </div>
          )}

          {/* Operating metrics */}
          <AdminSectionHeader title="Operating metrics"
            info="Ratios share one denominator (net revenue) so they can be compared directly. A dash means the denominator was zero, not that the value is 0%." />
          <AdminStatGrid className={sectionGap}>
            <Metric label="Average order value"
                    value={p.averageOrderValueCents === null ? '—' : money(p.averageOrderValueCents)}
                    sub="Merchandise + shipping, ex-tax" />
            <Metric label="Profit per order"
                    value={p.profitPerOrderCents === null ? '—' : money(p.profitPerOrderCents)}
                    tone={(p.profitPerOrderCents ?? 0) >= 0 ? 'positive' : 'negative'}
                    sub="Contribution ÷ orders" pending={p.isPartial || notExact} />
            <Metric label="Total operating cost" value={money(p.totalOperatingCostCents)} tone="muted"
                    sub="All recognized costs" pending={p.isPartial || notExact} />
            <Metric label="COGS % of revenue" value={pctOrDash(p.cogsPctOfRevenue)} tone="muted" />
            <Metric label="Shipping % of revenue" value={pctOrDash(p.shippingCostPctOfRevenue)} tone="muted" />
            <Metric label="Stripe fees % of revenue" value={pctOrDash(p.stripeFeePctOfRevenue)} tone="muted" />
            <Metric label="Advertising % of revenue" value={pctOrDash(p.advertisingPctOfRevenue)} tone="muted" />
            <Metric label="Opex % of revenue" value={pctOrDash(p.operatingExpensePctOfRevenue)} tone="muted" />
            <Metric label="Refund rate" value={pctOrDash(p.refundRatePct)} tone="muted"
                    sub="Refunds ÷ gross customer revenue" />
          </AdminStatGrid>

          {/* Tax Scenario — planning only */}
          <AdminSectionHeader title="Tax scenario — hypothetical"
            description="Planning estimate only. Not saved; creates no expense or record."
            info="A planning estimate on the selected period's pre-income-tax profit. It changes no record and does not determine actual tax liability. Real liability depends on entity type, jurisdiction, deductions and credits that KVRN does not model — ask your accountant or tax preparer." />
          {(() => {
            // Pure client-side arithmetic. Mirrors computeTaxScenario in the
            // calculator; a loss produces zero estimated tax rather than a refund.
            const rate    = Math.min(100, Math.max(0, Number(taxRate) || 0))
            const preTax  = p.realizedOperatingProfitAfterAdsCents
            const isLoss  = preTax <= 0
            const estTax  = isLoss ? 0 : Math.round(preTax * (rate / 100))
            const afterTax = preTax - estTax
            return (
              <AdminCard className="mb-7">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">Pre-income-tax profit</p>
                    <p className="mt-1.5 text-[20px] font-medium">{money(preTax)}</p>
                    <p className="mt-1 text-[11px] text-[#6B6B66]">
                      {notExact ? 'Known so far, not exact' : 'Not changed by this tool'}
                    </p>
                  </div>
                  <div>
                    <AdminField label="Hypothetical rate %" htmlFor="tax-rate">
                      <input id="tax-rate" type="number" min="0" max="100" step="0.1" value={taxRate}
                        onChange={e => setTaxRate(e.target.value)}
                        aria-label="Hypothetical income tax rate percentage"
                        className={adminInputClass} />
                    </AdminField>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {['15', '20', '22', '25', '30', '37'].map(r => (
                        <button key={r} type="button" onClick={() => setTaxRate(r)} aria-pressed={taxRate === r}
                          className={`min-h-[32px] rounded-[8px] border px-2.5 text-[11px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 ${taxRate === r ? 'border-[#171717] bg-[#171717] text-white' : 'border-black/[0.12] bg-white text-[#171717]'}`}>
                          {r}%
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">Estimated tax</p>
                    <p className="mt-1.5 text-[20px] font-medium">{money(estTax)}</p>
                    {isLoss && <p className="mt-1 text-[11px] text-[#6B6B66]">No tax estimated on a loss</p>}
                  </div>
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">Estimated after-tax</p>
                    <p className="mt-1.5 text-[20px] font-medium">{money(afterTax)}</p>
                  </div>
                </div>
                <p className="mt-4 text-[11px] text-[#6B6B66]">
                  Hypothetical estimate only. It does not determine actual tax liability, is not saved, and creates no expense record.
                </p>
              </AdminCard>
            )
          })()}

          {/* Recent orders */}
          <AdminSectionHeader title="Recent orders" />
          <AdminTable caption="Recent orders" minWidth={640} stack>
            <thead>
              <tr>
                {['Order', 'Paid', 'Net revenue', 'Contribution', 'Margin', 'Status'].map(h => (
                  <AdminTh key={h}>{h}</AdminTh>
                ))}
              </tr>
            </thead>
            <tbody>
              {data!.recentOrders.length === 0 && (
                <tr><AdminTd colSpan={6} className="text-[#6B6B66]">No paid orders in this period.</AdminTd></tr>
              )}
              {data!.recentOrders.map(o => {
                // The scan's per-order integrityState WINS over the calculator's own input state.
                const row = orderRowPresentation({
                  integrityState: o.integrityState,
                  contributionProfitCents: o.contributionProfitCents,
                  contributionMarginPct: o.contributionMarginPct,
                  calculatorState: o.reconciliation.state,
                })
                const c = row.contribution
                return (
                <tr key={o.orderId}>
                  <AdminTd>{o.orderNumber}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">
                    {o.paidAt ? new Date(o.paidAt).toISOString().slice(0, 10) : '—'}
                  </AdminTd>
                  <AdminTd>{money(o.netRevenueCents)}</AdminTd>
                  <AdminTd className={c.kind === 'exact'
                      ? ((c.contributionProfitCents as number) >= 0 ? 'text-[#047857]' : 'text-[#B91C1C]')
                      : c.kind === 'invalid' ? 'font-medium text-[#991B1B]' : 'font-medium text-[#92400E]'}>
                    {c.kind === 'exact' ? money(c.contributionProfitCents as number) : c.word}
                  </AdminTd>
                  <AdminTd className="text-[#6B6B66]">
                    {c.kind === 'exact' ? pctOrDash(c.contributionMarginPct) : '—'}
                  </AdminTd>
                  <AdminTd>
                    <OrderIntegrityBadge text={row.badgeText} tone={row.badgeTone} href={row.href}
                                         missing={o.reconciliation.missing}
                                         reason={c.kind === 'exact' ? undefined : c.reason} />
                  </AdminTd>
                </tr>
                )
              })}
            </tbody>
          </AdminTable>
        </>
      )}
    </AdminPage>
  )
}
