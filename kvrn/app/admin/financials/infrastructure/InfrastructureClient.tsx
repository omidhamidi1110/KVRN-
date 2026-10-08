'use client'
// app/admin/financials/infrastructure/InfrastructureClient.tsx
//
// Provider-by-provider infrastructure cost view.
//
// THREE STATES, SHOWN SIDE BY SIDE, NEVER MERGED:
//
//   ACTUAL PAID         cash that actually left in this window (expense_transactions)
//   ESTIMATED ACCRUED   usage so far suggests this much        (usage snapshots)
//   PROJECTED MONTH-END forecast if usage continues            (usage snapshots)
//
// ACTUAL PAID vs RECOGNIZED OPERATING EXPENSE:
// This page reports CASH OUT. The Financial Overview reports RECOGNIZED expense,
// which apportions a transaction across its service period. A $40 annual renewal
// paid in August shows $40 here and recognises about $3.33 into the August P&L.
// Both are correct; they measure different things. The annual transaction is never
// split into fabricated monthly rows.
//
// A provider may have several obligations and several billable metrics. Every one is
// represented — the summary row aggregates, and the detail rows show each item.

import { Fragment, useEffect, useState, useCallback } from 'react'
import {
  money, moneyOrUnknown, RangePicker, buildQuery,
} from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminNotice, AdminButton, AdminField, AdminStat, AdminStatGrid,
  AdminSegmented, AdminTable, AdminTh, AdminTd, AdminLoading, AdminEmpty, AdminTag, adminInputClass, adminSelectClass,
} from '@/components/admin/ui/AdminUI'
import { PROVIDER_PORTALS } from '@/lib/provider-portals'
import { LineChart, type LineSeries } from '@/components/admin/charts/LineChart'

type UsageSeries = {
  granularity: string
  labels: string[]
  series: {
    usageValue: Array<number | null>
    estimatedAccruedCents: Array<number | null>
    spendCents: number[]
  }
  metricUnit: string | null
  includedAllowance: number | null
  availableMetrics: Array<{ provider: string; metricName: string; metricUnit: string }>
}

type Definition = {
  id: string; name: string; category: string; cadence: string
  expectedAmountCents: number | null
  monthlyEquivalentCents: number | null
  renewalDate: string | null
}
type UsageMetric = {
  metricName: string; metricUnit: string
  usageValue: number | null; includedAllowance: number | null
  estimatedAccruedCents: number | null; projectedMonthEndCents: number | null
  thresholdStatus: string | null; source: string | null
  billingPeriodStart: string | null; billingPeriodEnd: string | null
  capturedAt: string | null
}
type Provider = {
  provider: string
  category: string
  definitions: Definition[]
  expectedMonthlyEquivalentCents: number | null
  actualPaidCents: number | null
  transactionCount: number
  usageMetrics: UsageMetric[]
  estimatedAccruedCents: number | null
  projectedMonthEndCents: number | null
  thresholdStatus: string | null
}
type Totals = {
  actualPaidCents: number
  estimatedAccruedCents: number
  projectedMonthEndCents: number
  expectedMonthlyEquivalentCents: number
  providersWithoutActuals: number
  providerCount: number
  definitionCount: number
  usageMetricCount: number
}

const THRESHOLD_TONE = { ok: 'success', warning: 'warning', critical: 'danger' } as const
function ThresholdPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-[#8A8A85]">—</span>
  return <AdminTag tone={THRESHOLD_TONE[status as keyof typeof THRESHOLD_TONE] ?? 'success'}>{status}</AdminTag>
}

export function InfrastructureClient() {
  const [range, setRange]   = useState('mtd')
  const [custom, setCustom] = useState({ start: '', end: '' })
  const [data, setData]     = useState<{ providers: Provider[]; totals: Totals } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)
  const [usageTs, setUsageTs] = useState<UsageSeries | null>(null)
  // Usage (a meter reading in provider units) and spend (money) are never drawn
  // on one axis. The operator picks which to view.
  const [chartMode, setChartMode] = useState<'usage' | 'spend'>('spend')
  const [chartProvider, setChartProvider] = useState('')
  const [chartMetric, setChartMetric] = useState('')
  const [showUsageForm, setShowUsageForm] = useState(false)
  const [savingUsage, setSavingUsage]     = useState(false)
  const [usageForm, setUsageForm] = useState({
    provider: '', metricName: '', metricUnit: '',
    usageValue: '', includedAllowance: '',
    estimatedAccruedCents: '', projectedMonthEndCents: '',
    thresholdStatus: '', billingPeriodStart: '', billingPeriodEnd: '',
  })

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const q = buildQuery(range, custom)
      const params = new URLSearchParams()
      if (chartProvider) params.set('provider', chartProvider)
      if (chartMetric)   params.set('metric', chartMetric)
      const extra = params.toString() ? `&${params}` : ''

      const [res, tsRes] = await Promise.all([
        fetch(`/api/admin/financials/infrastructure${q}`),
        fetch(`/api/admin/financials/infrastructure/timeseries${q}${extra}`),
      ])
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load infrastructure costs.'); return }
      setData(json)
      // A chart failure must not blank the cost tables below it.
      if (tsRes.ok) setUsageTs(await tsRes.json()); else setUsageTs(null)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [range, custom, chartProvider, chartMetric])

  useEffect(() => { void load() }, [load])

  /**
   * Record a manual usage reading.
   *
   * Until Batch 4 wires provider APIs, this is how usage and forecast figures
   * enter the system. Everything saved here is stored as source='manual' and
   * remains a FORECAST — estimated/projected amounts are never treated as a bill
   * and never reduce realised profit.
   */
  async function saveUsage() {
    if (!usageForm.provider.trim() || !usageForm.metricName.trim() || !usageForm.metricUnit.trim()) {
      setErr('Provider, metric name and unit are required.'); return
    }
    const toCents = (v: string) => {
      if (!v.trim()) return null
      const n = Math.round(parseFloat(v) * 100)
      return Number.isFinite(n) ? n : null
    }
    const toNum = (v: string) => (v.trim() === '' ? null : Number(v))

    setSavingUsage(true); setErr(null)
    try {
      const res = await fetch('/api/admin/provider-usage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider:   usageForm.provider.trim(),
          metricName: usageForm.metricName.trim(),
          metricUnit: usageForm.metricUnit.trim(),
          usageValue:             toNum(usageForm.usageValue),
          includedAllowance:      toNum(usageForm.includedAllowance),
          estimatedAccruedCents:  toCents(usageForm.estimatedAccruedCents),
          projectedMonthEndCents: toCents(usageForm.projectedMonthEndCents),
          thresholdStatus:    usageForm.thresholdStatus || null,
          billingPeriodStart: usageForm.billingPeriodStart || null,
          billingPeriodEnd:   usageForm.billingPeriodEnd || null,
          source: 'manual',
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not save usage reading.'); return }
      setUsageForm({ ...usageForm, usageValue: '', estimatedAccruedCents: '', projectedMonthEndCents: '' })
      setShowUsageForm(false)
      await load()
    } catch { setErr('Network error.') }
    finally { setSavingUsage(false) }
  }

  const toggle = (p: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(p)) next.delete(p); else next.add(p)
    return next
  })

  const t = data?.totals

  const recognitionInfo = (
    <>
      <p><strong className="font-medium">Actual paid</strong> is cash that left in this window. The Financial Overview shows <strong className="font-medium">recognized operating expense</strong>, which spreads a charge across the period it covers.</p>
      <p className="mt-2">A $40 annual renewal paid this month appears as $40 here and about $3.33 in a one-month P&amp;L. Both are correct. Only real transactions affect profit.</p>
    </>
  )
  const providerOptions = [...new Set((usageTs?.availableMetrics ?? []).map(m => m.provider))]

  return (
    <AdminPage>
      <AdminPageHeader
        title="Infrastructure"
        description="Provider costs, usage, and forecasts."
        info={recognitionInfo}
      />

      <div className="mb-5">
        <RangePicker range={range} onRange={setRange} custom={custom} onCustom={setCustom} />
      </div>

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {loading && !data && <AdminLoading />}

      {t && (
        <>
          <AdminStatGrid min={210} className="mb-4">
            <AdminStat label="Actual paid" value={money(t.actualPaidCents)}
              sub={`Cash out · ${t.providerCount - t.providersWithoutActuals} of ${t.providerCount} providers invoiced`}
              info={recognitionInfo} />
            <AdminStat label="Expected monthly" value={money(t.expectedMonthlyEquivalentCents)} tone="muted"
              sub={`${t.definitionCount} obligations · planning only`} />
            <AdminStat label="Estimated accrued" value={money(t.estimatedAccruedCents)} tone="warning"
              sub={`${t.usageMetricCount} metrics · not billed`} />
            <AdminStat label="Projected month-end" value={money(t.projectedMonthEndCents)} tone="warning"
              sub="Forecast if usage continues" />
          </AdminStatGrid>

          <AdminNotice tone="warning" className="mb-6">
            Estimated and projected figures are forecasts, not invoices. They are excluded from every profit figure.
          </AdminNotice>

          {/* ── Usage / spend over time ───────────────────────────────────── */}
          <AdminSectionHeader title="Usage and spend over time"
            description="How much is used and how close a plan limit is."
            info="Separate from the Financial Overview chart: this answers how much has been used and how close a plan limit is, not what it did to profit." />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <AdminSegmented ariaLabel="Chart mode" value={chartMode}
              options={[{ id: 'spend' as const, label: 'Spend (billed)' }, { id: 'usage' as const, label: 'Usage' }]}
              onChange={setChartMode} />
            <select aria-label="Provider" value={chartProvider} onChange={e => { setChartProvider(e.target.value); setChartMetric('') }}
              className={`${adminSelectClass} !w-auto`}>
              <option value="">All providers</option>
              {providerOptions.map(pv => <option key={pv} value={pv}>{pv}</option>)}
            </select>
            {chartMode === 'usage' && chartProvider && (
              <select aria-label="Metric" value={chartMetric} onChange={e => setChartMetric(e.target.value)}
                className={`${adminSelectClass} !w-auto`}>
                <option value="">All metrics</option>
                {(usageTs?.availableMetrics ?? [])
                  .filter(m => m.provider === chartProvider)
                  .map(m => <option key={m.metricName} value={m.metricName}>
                    {m.metricName} ({m.metricUnit})
                  </option>)}
              </select>
            )}
          </div>

          {chartMode === 'usage' && !chartMetric && chartProvider === '' && (
            <AdminNotice tone="warning" className="mb-3">
              Usage units differ between providers (CU-hours, GB, messages, emails).
              Select a provider and metric to view a single comparable unit.
            </AdminNotice>
          )}

          <div className="mb-7">
            <LineChart
              labels={usageTs?.labels ?? []}
              formatCents={money}
              series={
                chartMode === 'spend'
                  ? [{
                      key: 'spend', label: 'Billed spend', color: '#1A1A1A', unit: 'cents',
                      values: usageTs?.series.spendCents ?? [],
                    } as LineSeries]
                  : [{
                      key: 'usage',
                      label: chartMetric || 'Usage',
                      color: '#0F766E',
                      unit: 'count',
                      unitLabel: usageTs?.metricUnit ?? undefined,
                      values: usageTs?.series.usageValue ?? [],
                    } as LineSeries]
              }
              emptyMessage={
                chartMode === 'spend'
                  ? 'No billed provider transactions in this period.'
                  : 'No usage readings recorded. Use "Record usage reading" below.'
              }
            />
            {chartMode === 'usage' && usageTs?.includedAllowance != null && (
              <p className="mt-1.5 text-[11px] text-[#6B6B66]">
                Included allowance for the latest reading:{' '}
                <strong className="font-medium">{usageTs.includedAllowance.toLocaleString()}
                {usageTs.metricUnit ? ` ${usageTs.metricUnit}` : ''}</strong>
              </p>
            )}
            {chartMode === 'spend' && (
              <p className="mt-1.5 text-[11px] text-[#6B6B66]">
                Billed spend only — real invoices from expense transactions. Forecasts are excluded.
              </p>
            )}
          </div>

          {/* Manual usage entry — the only ingestion path until Batch 4 */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <AdminButton variant={showUsageForm ? 'secondary' : 'primary'} onClick={() => setShowUsageForm(v => !v)}>
              {showUsageForm ? 'Cancel' : 'Record usage reading'}
            </AdminButton>
            <span className="text-[11px] text-[#6B6B66]">
              Manual readings are stored as forecasts and never count as billed cost.
            </span>
          </div>

          {showUsageForm && (
            <AdminCard className="mb-6">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <AdminField label="Provider *" htmlFor="iu-provider">
                  <input id="iu-provider" list="kvrn-providers" value={usageForm.provider}
                    onChange={e => setUsageForm({ ...usageForm, provider: e.target.value })}
                    placeholder="Neon" className={adminInputClass} />
                  <datalist id="kvrn-providers">
                    {PROVIDER_PORTALS.map(p2 => <option key={p2.provider} value={p2.provider} />)}
                  </datalist>
                </AdminField>
                <AdminField label="Metric name *" htmlFor="iu-metric">
                  <input id="iu-metric" value={usageForm.metricName}
                    onChange={e => setUsageForm({ ...usageForm, metricName: e.target.value })}
                    placeholder="compute" className={adminInputClass} />
                </AdminField>
                <AdminField label="Unit *" htmlFor="iu-unit">
                  <input id="iu-unit" value={usageForm.metricUnit}
                    onChange={e => setUsageForm({ ...usageForm, metricUnit: e.target.value })}
                    placeholder="CU-hours" className={adminInputClass} />
                </AdminField>
                <AdminField label="Used" htmlFor="iu-used">
                  <input id="iu-used" type="number" step="any" value={usageForm.usageValue}
                    onChange={e => setUsageForm({ ...usageForm, usageValue: e.target.value })}
                    className={adminInputClass} />
                </AdminField>
                <AdminField label="Included allowance" htmlFor="iu-allow">
                  <input id="iu-allow" type="number" step="any" value={usageForm.includedAllowance}
                    onChange={e => setUsageForm({ ...usageForm, includedAllowance: e.target.value })}
                    className={adminInputClass} />
                </AdminField>
                <AdminField label="Estimated accrued $" htmlFor="iu-acc">
                  <input id="iu-acc" type="number" step="0.01" min="0" value={usageForm.estimatedAccruedCents}
                    onChange={e => setUsageForm({ ...usageForm, estimatedAccruedCents: e.target.value })}
                    className={adminInputClass} />
                </AdminField>
                <AdminField label="Projected month-end $" htmlFor="iu-proj">
                  <input id="iu-proj" type="number" step="0.01" min="0" value={usageForm.projectedMonthEndCents}
                    onChange={e => setUsageForm({ ...usageForm, projectedMonthEndCents: e.target.value })}
                    className={adminInputClass} />
                </AdminField>
                <AdminField label="Status" htmlFor="iu-status">
                  <select id="iu-status" value={usageForm.thresholdStatus}
                    onChange={e => setUsageForm({ ...usageForm, thresholdStatus: e.target.value })}
                    className={adminSelectClass}>
                    <option value="">—</option>
                    <option value="ok">ok</option>
                    <option value="warning">warning</option>
                    <option value="critical">critical</option>
                  </select>
                </AdminField>
                <AdminField label="Billing period start" htmlFor="iu-ps">
                  <input id="iu-ps" type="date" value={usageForm.billingPeriodStart}
                    onChange={e => setUsageForm({ ...usageForm, billingPeriodStart: e.target.value })}
                    className={adminInputClass} />
                </AdminField>
                <AdminField label="Billing period end" htmlFor="iu-pe">
                  <input id="iu-pe" type="date" value={usageForm.billingPeriodEnd}
                    onChange={e => setUsageForm({ ...usageForm, billingPeriodEnd: e.target.value })}
                    className={adminInputClass} />
                </AdminField>
              </div>
              <AdminButton variant="primary" className="mt-4" onClick={() => void saveUsage()} loading={savingUsage}>
                Save reading
              </AdminButton>
            </AdminCard>
          )}

          <AdminSectionHeader title="By provider"
            description="Select a provider to expand its detail."
            info="Every obligation and every billable metric is represented. Monthly equivalents are planning arithmetic for comparing obligations. The actual charge stays a single transaction on its real cadence — no monthly rows are fabricated." />
          {data!.providers.length === 0 ? (
            <AdminEmpty title="No providers configured." description="Add expense definitions or transactions to populate this view." />
          ) : (
            <AdminTable minWidth={900} caption="Infrastructure cost by provider">
              <thead>
                <tr>
                  <AdminTh><span className="sr-only">Expand</span></AdminTh>
                  {['Provider', 'Category', 'Obligations', 'Expected /mo',
                    'Actual paid', 'Est. accrued', 'Projected', 'Metrics', 'Status'].map(h => (
                    <AdminTh key={h}>{h}</AdminTh>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data!.providers.map(p => {
                  const isOpen = expanded.has(p.provider)
                  const hasDetail = p.definitions.length > 0 || p.usageMetrics.length > 0
                  return (
                    <Fragment key={p.provider}>
                      <tr>
                        <AdminTd className="w-8 !px-1.5">
                          {hasDetail && (
                            <button onClick={() => toggle(p.provider)}
                              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${p.provider}`}
                              aria-expanded={isOpen}
                              className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[#6B6B66] hover:bg-black/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40">
                              {isOpen ? '▾' : '▸'}
                            </button>
                          )}
                        </AdminTd>
                        <AdminTd className="font-medium">{p.provider}</AdminTd>
                        <AdminTd className="text-[#6B6B66]">{p.category.replace(/_/g, ' ')}</AdminTd>
                        <AdminTd className="text-[#6B6B66]">{p.definitions.length}</AdminTd>
                        <AdminTd className="text-[#6B6B66]">
                          {p.expectedMonthlyEquivalentCents === null
                            ? '—' : `${money(p.expectedMonthlyEquivalentCents)}/mo`}
                        </AdminTd>
                        {/* CASH OUT */}
                        <AdminTd className={p.actualPaidCents === null ? 'font-medium text-[#92400E]' : 'font-medium'}>
                          {moneyOrUnknown(p.actualPaidCents, 'Not paid')}
                        </AdminTd>
                        {/* FORECASTS */}
                        <AdminTd className="text-[#92400E]">{moneyOrUnknown(p.estimatedAccruedCents, '—')}</AdminTd>
                        <AdminTd className="text-[#92400E]">{moneyOrUnknown(p.projectedMonthEndCents, '—')}</AdminTd>
                        <AdminTd className="text-[#6B6B66]">{p.usageMetrics.length}</AdminTd>
                        <AdminTd><ThresholdPill status={p.thresholdStatus} /></AdminTd>
                      </tr>

                      {isOpen && p.definitions.map(d => (
                        <tr key={`${p.provider}-def-${d.id}`} className="bg-[#FCFBF9]">
                          <AdminTd />
                          <AdminTd className="pl-6 text-[#6B6B66]">obligation · {d.name}</AdminTd>
                          <AdminTd className="text-[#8A8A85]">{d.category.replace(/_/g, ' ')}</AdminTd>
                          <AdminTd className="text-[#8A8A85]">{d.cadence.replace(/_/g, ' ')}</AdminTd>
                          <AdminTd className="text-[#6B6B66]">
                            {d.monthlyEquivalentCents === null
                              ? (d.expectedAmountCents === null ? 'usage-based' : '—')
                              : `${money(d.monthlyEquivalentCents)}/mo`}
                          </AdminTd>
                          <AdminTd className="text-[#8A8A85]">
                            {d.expectedAmountCents === null
                              ? '—' : `${money(d.expectedAmountCents)} expected`}
                          </AdminTd>
                          <AdminTd colSpan={3} className="text-[#8A8A85]">
                            {d.renewalDate ? `renews ${d.renewalDate}` : ''}
                          </AdminTd>
                          <AdminTd />
                        </tr>
                      ))}

                      {isOpen && p.usageMetrics.map(m => (
                        <tr key={`${p.provider}-metric-${m.metricName}`} className="bg-[#FCFBF9]">
                          <AdminTd />
                          <AdminTd className="pl-6 text-[#6B6B66]">metric · {m.metricName}</AdminTd>
                          <AdminTd colSpan={3} className="text-[#8A8A85]">
                            {m.usageValue === null ? '—' : (
                              <>
                                {m.usageValue}
                                {m.includedAllowance !== null && ` / ${m.includedAllowance}`}
                                {` ${m.metricUnit}`}
                              </>
                            )}
                          </AdminTd>
                          <AdminTd className="text-[#8A8A85]">—</AdminTd>
                          <AdminTd className="text-[#92400E]">{moneyOrUnknown(m.estimatedAccruedCents, '—')}</AdminTd>
                          <AdminTd className="text-[#92400E]">{moneyOrUnknown(m.projectedMonthEndCents, '—')}</AdminTd>
                          <AdminTd className="text-[#8A8A85]">{m.source ?? '—'}</AdminTd>
                          <AdminTd><ThresholdPill status={m.thresholdStatus} /></AdminTd>
                        </tr>
                      ))}
                    </Fragment>
                  )
                })}
              </tbody>
            </AdminTable>
          )}

          {/* Provider portals — navigation shortcuts, no credentials involved */}
          <div className="mt-8">
            <AdminSectionHeader title="Provider portals"
              description="Open a provider's dashboard to verify a figure or get an invoice."
              info="These are links only. KVRN does not store or send credentials." />
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(min(210px,100%),1fr))' }}>
              {PROVIDER_PORTALS.map(p2 => (
                <a key={p2.provider} href={p2.url}
                   target="_blank" rel="noopener noreferrer"
                   className="block rounded-[12px] border border-black/[0.08] bg-white px-3.5 py-3 transition-colors hover:border-black/[0.18] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40">
                  <span className="block text-[12px] font-medium text-[#171717]">{p2.label} ↗</span>
                  <span className="mt-0.5 block text-[11px] text-[#6B6B66]">{p2.purpose}</span>
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </AdminPage>
  )
}
