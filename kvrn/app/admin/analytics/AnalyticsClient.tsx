'use client'
// app/admin/analytics/AnalyticsClient.tsx
//
// First-party funnel: visit -> product -> cart -> checkout -> purchase, plus a compact
// product table. Counts are SESSIONS that reached each stage OR LATER, so every step is <= the
// one before it. A rate with nothing to divide by is shown as "—", never as 0%.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Metric, pctOrDash, money } from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminNotice, AdminSegmented, AdminStatGrid,
  AdminTable, AdminTh, AdminTd, AdminLoading, AdminTag,
} from '@/components/admin/ui/AdminUI'
import type { GaAdminStatus } from '@/lib/ga-common'
import { LineChart } from '@/components/admin/charts/LineChart'
import { FunnelChart } from '@/components/admin/charts/FunnelChart'
import { ProductBarChart } from '@/components/admin/charts/ProductBarChart'
import { ChartBoundary, ChartError } from '@/components/admin/charts/ChartBoundary'
import {
  buildFunnelRows, funnelTrendSeries, funnelTrendHasData, funnelSummaryDataState, rankProducts,
  type FunnelTrendBucketView, type FunnelTrendMode, type ProductRankMetric,
} from '@/lib/chart-data'

type Range = '7d' | '30d' | '90d'
const RANGES: Range[] = ['7d', '30d', '90d']

interface Report {
  range: Range
  window: { start: string; end: string }
  stages: { visits: number; reachedProduct: number; reachedCart: number; reachedCheckout: number; purchased: number }
  rates: { visitToProduct: number | null; productToCart: number | null; cartToCheckout: number | null
           checkoutToPurchase: number | null; visitToPurchase: number | null }
  events: { productViews: number; addToCarts: number; checkoutStarts: number; purchases: number
            purchaseValueCents: number | null }
  coverage: { ordersPaid: number; trackedPurchases: number; trackedPurchaseSharePct: number | null }
  products: Array<{ productId: string; slug: string; name: string; views: number; adds: number
                    checkouts: number; purchases: number; addRatePct: number | null; purchaseRatePct: number | null }>
  /** Daily trend over the SAME window and cohort as `stages`. Absent only in an older cached response. */
  trend?: { granularity: 'day'; collectionStartedAt: string | null; buckets: FunnelTrendBucketView[] }
}

const STATE_LABEL = { unset: 'Not set', malformed: 'Set but malformed (ignored)', ok: 'Configured' } as const
const STATE_TONE = { unset: 'neutral', malformed: 'danger', ok: 'success' } as const

/** GA4 configuration status. States only: the secret is never shown, and GA numbers are NOT shown here. */
function GaStatusPanel({ ga }: { ga: GaAdminStatus }) {
  const row = (label: string, state: keyof typeof STATE_LABEL, extra?: string) => (
    <div className="flex items-center justify-between gap-3 py-1.5 text-[12px]">
      <span>{label}</span>
      <AdminTag tone={STATE_TONE[state]}>{STATE_LABEL[state]}{extra ? ` — ${extra}` : ''}</AdminTag>
    </div>
  )
  const serverReady = ga.clientState === 'ok' && ga.secretState === 'ok'
  return (
    <div className="mb-5 grid gap-3 md:grid-cols-2">
      <AdminCard>
        <AdminSectionHeader title="KVRN first-party funnel" />
        <p className="text-[12px] text-[#4A4A46]">
          KVRN&rsquo;s own data: consenting visitors, paid orders.
        </p>
      </AdminCard>
      <AdminCard>
        <AdminSectionHeader title="Google Analytics 4 (external system)"
          info={<>GA is a separate system: its numbers will differ from the first-party figures (sampling, ad blockers,
            processing delay, its own sessionisation). GA numbers are not shown here.</>} />
        {row('Measurement ID (browser)', ga.clientState, ga.measurementId ?? undefined)}
        {row('Server-side purchase secret', ga.secretState)}
        <p className="my-2 text-[11px] text-[#6B6B66]">
          {ga.clientState !== 'ok'
            ? 'GA is off: no Google script is ever loaded.'
            : serverReady
              ? 'GA loads only after a visitor accepts analytics. Purchases are sent from the order webhook (transaction id = order number).'
              : 'GA loads after consent, but no server-side purchase is sent until the secret is configured.'}
        </p>
        <a href="https://analytics.google.com/analytics/web/" target="_blank" rel="noopener noreferrer"
           className="text-[11px] font-medium text-[#171717] underline underline-offset-2">
          Open Google Analytics ↗
        </a>
      </AdminCard>
    </div>
  )
}

export function AnalyticsClient({ ga }: { ga: GaAdminStatus }) {
  const [range, setRange] = useState<Range>('30d')
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [trendMode, setTrendMode] = useState<FunnelTrendMode>('counts')
  const [rankMetric, setRankMetric] = useState<ProductRankMetric>('views')

  const load = useCallback(async (r: Range) => {
    setLoading(true); setErr(null)
    try {
      const res = await fetch(`/api/admin/analytics/funnel?range=${r}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load analytics.'); setData(null); return }
      setData(json)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(range) }, [range, load])

  const s = data?.stages
  const r = data?.rates
  // Every chart below is derived from ONE response, so the 7/30/90-day control drives the
  // summary, the funnel, the trend and the product ranking identically.
  const funnelRows = useMemo(() => (data ? buildFunnelRows(data.stages, data.rates) : []), [data])
  const trendBuckets = useMemo(() => data?.trend?.buckets ?? [], [data])
  const trendHasData = funnelTrendHasData(trendBuckets)
  // Days with collection but no sessions are a real zero (drawn as such); only a window with no
  // collection at all - every day unknown - falls back to the plain empty state.
  const trendHasCollection = trendBuckets.some(b => b.stages !== null)
  const trendSeries = useMemo(() => funnelTrendSeries(trendBuckets, trendMode), [trendBuckets, trendMode])
  const funnelState = funnelSummaryDataState(s?.visits ?? 0, Boolean(data?.trend) && trendHasCollection)
  const rankedProducts = useMemo(() => rankProducts(data?.products ?? [], rankMetric, 8), [data, rankMetric])

  const rangeOptions = RANGES.map(o => ({ id: o, label: o.replace('d', ' days') }))
  const trendOptions = [{ id: 'counts' as const, label: 'Sessions by stage' }, { id: 'conversion' as const, label: 'Step conversion' }]
  const rankOptions = [{ id: 'views' as const, label: 'Views' }, { id: 'adds' as const, label: 'Added to cart' }, { id: 'purchases' as const, label: 'Purchases' }]

  return (
    <AdminPage>
      <AdminPageHeader
        title="Analytics"
        description="Funnel for consenting visitors."
        info={<>Only visitors who accepted analytics cookies are counted (no choice, decline, Do Not Track and Global
          Privacy Control are never tracked), so these are the behaviour of consenting visitors, not total traffic.</>}
      />

      <GaStatusPanel ga={ga} />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <AdminSegmented ariaLabel="Date range" options={rangeOptions} value={range} onChange={setRange} />
        {loading && data && <span role="status" className="text-[11px] text-[#6B6B66]">Updating…</span>}
      </div>

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {loading && !data && <AdminLoading />}

      {data && s && r && (
        <>
          <AdminStatGrid className="mb-2">
            <Metric label="Visits / sessions" value={String(s.visits)} sub="sessions that started" />
            <Metric label="Product views" value={String(data.events.productViews)} sub="unique per session and product" />
            <Metric label="Add-to-cart events" value={String(data.events.addToCarts)} sub="recorded events" />
            <Metric label="Checkout starts" value={String(data.events.checkoutStarts)} sub="recorded events" />
            <Metric label="Purchases" value={String(data.events.purchases)}
                    sub={data.events.purchaseValueCents === null ? 'order value unknown'
                         : `${money(data.events.purchaseValueCents)} charged (incl. shipping and tax; not revenue)`} />
            <Metric label="Visit → purchase" value={pctOrDash(r.visitToPurchase)} />
          </AdminStatGrid>
          <p className="mb-6 text-[11px] text-[#6B6B66]">
            The cards above count <strong className="font-medium">recorded events</strong>. The funnel below counts <strong className="font-medium">sessions that reached each stage or any later one</strong>,
            so the two can differ — for example when a session has a later event but its earlier event was not recorded.
          </p>

          <AdminSectionHeader title="Funnel"
            info="Sessions that reached each stage or any later one, so each step is never larger than the one before. The gap between two steps means no later event was recorded for those sessions — not proof they skipped or abandoned that step." />
          <div className="mb-6">
            <ChartBoundary label="The funnel chart">
              <FunnelChart
                rows={funnelRows}
                overallPct={r.visitToPurchase}
                emptyMessage={funnelState === 'zero'
                  ? '0 sessions recorded in this period — a real count of zero, not missing data.'
                  : 'No analytics data for this period'}
              />
            </ChartBoundary>
          </div>

          <AdminSectionHeader title="Funnel trend"
            info={`Daily, UTC, for the selected ${range.replace('d', '-day')} window. Each day groups sessions by the day they started and follows them to their furthest stage, so the days add up to the funnel above. Days before analytics collection began are shown as unknown, not zero; the first and last day of a rolling window can be partial.`} />
          <div className="mb-3">
            <AdminSegmented ariaLabel="Trend view" options={trendOptions} value={trendMode} onChange={setTrendMode} />
          </div>
          <div className="mb-6">
            {!data.trend ? (
              <ChartError message="Trend data was not returned." />
            ) : (
              <ChartBoundary label="The funnel trend chart">
                <LineChart
                  // With no collection at all the chart shows its plain empty state instead of an all-shaded plot.
                  labels={trendHasCollection ? trendBuckets.map(b => b.label) : []}
                  formatCents={money}
                  series={trendSeries.map(t => ({
                    key: t.key, label: t.label, color: t.color, unit: t.unit,
                    unitLabel: 'unitLabel' in t ? (t as any).unitLabel : undefined,
                    values: t.values, notes: t.notes,
                    // A day with no collection is UNKNOWN (shaded), never a low reading.
                    status: trendBuckets.map(b => (b.coverage === 'none' ? 'unknown' as const : undefined)),
                  }))}
                  emptyMessage="No data for this period"
                  ariaLabel={`Daily funnel trend, ${trendMode === 'counts' ? 'sessions at each stage' : 'step-to-step conversion'}, ${trendBuckets.length} days. Hover or use the arrow keys for values.`}
                />
              </ChartBoundary>
            )}
            {data.trend && !trendHasData && (
              <p className="mt-1.5 text-[11px] text-[#6B6B66]">
                {data.trend.collectionStartedAt === null
                  ? 'No analytics sessions have been recorded yet.'
                  : 'No sessions were recorded in this window.'}
              </p>
            )}
          </div>

          <p className="mb-6 text-[11px] text-[#6B6B66]">
            {data.coverage.ordersPaid === 0
              ? 'No paid orders in this window, so tracked-purchase coverage is not available.'
              : `${data.coverage.trackedPurchases} of ${data.coverage.ordersPaid} paid orders in this window ` +
                `(${pctOrDash(data.coverage.trackedPurchaseSharePct)}) are linked to a tracked analytics session. ` +
                'Untracked orders may reflect declined/no analytics consent or unavailable analytics data.'}
          </p>

          <AdminSectionHeader title="Products"
            info="Distinct sessions per stage within the window. Rates use sessions that reached the product at any stage as the base." />
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-[#6B6B66]">Rank by</span>
            <AdminSegmented ariaLabel="Rank products by" options={rankOptions} value={rankMetric} onChange={setRankMetric} />
            <span className="text-[11px] text-[#8A8A85]">top 8 · distinct sessions</span>
          </div>
          <div className="mb-4">
            <ChartBoundary label="The product chart">
              <ProductBarChart rows={rankedProducts}
                emptyMessage={data.products.length === 0 ? 'No data for this period'
                  : `No ${rankMetric === 'adds' ? 'add-to-cart' : rankMetric === 'purchases' ? 'purchase' : 'view'} activity recorded for any product in this window`} />
            </ChartBoundary>
          </div>
          <AdminTable caption="Product funnel" stack>
            <thead><tr>
              {['Product', 'Views', 'Add to cart', 'Checkout starts', 'Purchases', 'Cart rate', 'Purchase rate'].map(h =>
                <AdminTh key={h}>{h}</AdminTh>)}
            </tr></thead>
            <tbody>
              {data.products.length === 0 && (
                <tr><AdminTd colSpan={7} className="text-[#6B6B66]">No product activity recorded in this window yet.</AdminTd></tr>
              )}
              {data.products.map(p => (
                <tr key={p.productId}>
                  <AdminTd>{p.name}</AdminTd>
                  <AdminTd>{p.views}</AdminTd>
                  <AdminTd>{p.adds}</AdminTd>
                  <AdminTd>{p.checkouts}</AdminTd>
                  <AdminTd>{p.purchases}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">{pctOrDash(p.addRatePct)}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">{pctOrDash(p.purchaseRatePct)}</AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        </>
      )}
    </AdminPage>
  )
}
