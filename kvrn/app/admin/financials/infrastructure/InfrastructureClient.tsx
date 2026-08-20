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

import { useEffect, useState, useCallback } from 'react'
import {
  FONT, BORDER, money, moneyOrUnknown, RangePicker, SectionTitle, buildQuery,
} from '@/components/admin/FinancialUI'
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

const INPUT_STYLE = { fontFamily: FONT, fontSize: 12, padding: '8px 10px', border: BORDER, background: '#fff', width: '100%', boxSizing: 'border-box' as const }

function ThresholdPill({ status }: { status: string | null }) {
  if (!status) return <span style={{ color: '#9B9B9B' }}>—</span>
  const map: Record<string, { bg: string; bd: string; fg: string }> = {
    ok:       { bg: '#F0FDF4', bd: '#BBF7D0', fg: '#166534' },
    warning:  { bg: '#FFFBEB', bd: '#FDE68A', fg: '#92400E' },
    critical: { bg: '#FEF2F2', bd: '#FECACA', fg: '#B91C1C' },
  }
  const c = map[status] ?? map.ok
  return (
    <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
                   padding: '3px 8px', background: c.bg,
                   border: `1px solid ${c.bd}`, color: c.fg }}>
      {status}
    </span>
  )
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

  const card = (label: string, value: string, note: string, tone: string) => (
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
        Infrastructure costs
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Actual paid, estimated accrued and projected month-end are tracked separately.
        Only real transactions affect profit, and they are recognised over their service
        period in the P&amp;L — so cash paid here can differ from expense recognised there.
      </p>

      <div style={{ marginBottom: 22 }}>
        <RangePicker range={range} onRange={setRange} custom={custom} onCustom={setCustom} />
      </div>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}
      {loading && !data && (
        <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B' }}>Loading…</p>
      )}

      {t && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))',
                        gap: 10, marginBottom: 20 }}>
            {card('Actual paid', money(t.actualPaidCents),
                  `Cash out · ${t.providerCount - t.providersWithoutActuals} of ${t.providerCount} providers invoiced`,
                  '#1A1A1A')}
            {card('Expected monthly', money(t.expectedMonthlyEquivalentCents),
                  `${t.definitionCount} obligations · planning only`, '#6B6B6B')}
            {card('Estimated accrued', money(t.estimatedAccruedCents),
                  `${t.usageMetricCount} metrics · not billed`, '#92400E')}
            {card('Projected month-end', money(t.projectedMonthEndCents),
                  'Forecast if usage continues', '#92400E')}
          </div>

          <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                        border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 12 }}>
            Estimated and projected figures are forecasts, not invoices. They are excluded
            from every profit figure — only real transactions count.
          </div>

          <div style={{ fontFamily: FONT, fontSize: 12, color: '#3730A3', background: '#EEF2FF',
                        border: '1px solid #C7D2FE', padding: '10px 14px', marginBottom: 20 }}>
            <strong>Actual paid</strong> is cash that left in this window.
            The Financial Overview shows <strong>recognized operating expense</strong>, which
            spreads a charge across the period it covers. A $40 annual renewal paid this month
            appears as $40 here and about $3.33 in a one-month P&amp;L. Both are correct.
          </div>


          {/* ── Usage / spend over time ───────────────────────────────────── */}
          <SectionTitle note="Separate from the Financial Overview chart: this answers how much has been used and how close a plan limit is, not what it did to profit.">
            Usage and spend over time
          </SectionTitle>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                        flexWrap: 'wrap', marginBottom: 10 }}>
            {(['spend', 'usage'] as const).map(m => (
              <button key={m} onClick={() => setChartMode(m)}
                style={{ fontFamily: FONT, fontSize: 11, padding: '6px 12px', cursor: 'pointer',
                         border: chartMode === m ? '1px solid #1A1A1A' : BORDER,
                         background: chartMode === m ? '#1A1A1A' : '#fff',
                         color: chartMode === m ? '#fff' : '#1A1A1A' }}>
                {m === 'spend' ? 'Spend (billed)' : 'Usage'}
              </button>
            ))}
            <span style={{ width: 1, height: 20, background: '#E8E5E0' }} />
            <select value={chartProvider} onChange={e => { setChartProvider(e.target.value); setChartMetric('') }}
              style={{ fontFamily: FONT, fontSize: 11, padding: '6px 10px', border: BORDER, background: '#fff' }}>
              <option value="">All providers</option>
              {[...new Set((usageTs?.availableMetrics ?? []).map(m => m.provider))]
                .map(pv => <option key={pv} value={pv}>{pv}</option>)}
            </select>
            {chartMode === 'usage' && chartProvider && (
              <select value={chartMetric} onChange={e => setChartMetric(e.target.value)}
                style={{ fontFamily: FONT, fontSize: 11, padding: '6px 10px', border: BORDER, background: '#fff' }}>
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
            <p style={{ fontFamily: FONT, fontSize: 11, color: '#92400E', background: '#FFFBEB',
                        border: '1px solid #FDE68A', padding: '8px 12px', marginBottom: 10 }}>
              Usage units differ between providers (CU-hours, GB, messages, emails).
              Select a provider and metric to view a single comparable unit.
            </p>
          )}

          <div style={{ marginBottom: 26 }}>
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
              <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', marginTop: 6 }}>
                Included allowance for the latest reading:{' '}
                <strong>{usageTs.includedAllowance.toLocaleString()}
                {usageTs.metricUnit ? ` ${usageTs.metricUnit}` : ''}</strong>
              </p>
            )}
            {chartMode === 'spend' && (
              <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', marginTop: 6 }}>
                Billed spend only — real invoices from expense transactions.
                Estimated and projected figures are forecasts and are excluded here.
              </p>
            )}
          </div>

          {/* Manual usage entry — the only ingestion path until Batch 4 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <button onClick={() => setShowUsageForm(v => !v)}
              style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em',
                       textTransform: 'uppercase', padding: '9px 16px',
                       background: '#1A1A1A', color: '#fff', border: 'none', cursor: 'pointer' }}>
              {showUsageForm ? 'Cancel' : 'Record usage reading'}
            </button>
            <span style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B' }}>
              Manual readings are stored as forecasts and never count as billed cost.
            </span>
          </div>

          {showUsageForm && (
            <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 24 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 12 }}>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Provider *
                  <input list="kvrn-providers" value={usageForm.provider}
                    onChange={e => setUsageForm({ ...usageForm, provider: e.target.value })}
                    placeholder="Neon" style={INPUT_STYLE} />
                  <datalist id="kvrn-providers">
                    {PROVIDER_PORTALS.map(p2 => <option key={p2.provider} value={p2.provider} />)}
                  </datalist>
                </label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Metric name *
                  <input value={usageForm.metricName}
                    onChange={e => setUsageForm({ ...usageForm, metricName: e.target.value })}
                    placeholder="compute" style={INPUT_STYLE} /></label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Unit *
                  <input value={usageForm.metricUnit}
                    onChange={e => setUsageForm({ ...usageForm, metricUnit: e.target.value })}
                    placeholder="CU-hours" style={INPUT_STYLE} /></label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Used
                  <input type="number" step="any" value={usageForm.usageValue}
                    onChange={e => setUsageForm({ ...usageForm, usageValue: e.target.value })}
                    style={INPUT_STYLE} /></label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Included allowance
                  <input type="number" step="any" value={usageForm.includedAllowance}
                    onChange={e => setUsageForm({ ...usageForm, includedAllowance: e.target.value })}
                    style={INPUT_STYLE} /></label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Estimated accrued $
                  <input type="number" step="0.01" min="0" value={usageForm.estimatedAccruedCents}
                    onChange={e => setUsageForm({ ...usageForm, estimatedAccruedCents: e.target.value })}
                    style={INPUT_STYLE} /></label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Projected month-end $
                  <input type="number" step="0.01" min="0" value={usageForm.projectedMonthEndCents}
                    onChange={e => setUsageForm({ ...usageForm, projectedMonthEndCents: e.target.value })}
                    style={INPUT_STYLE} /></label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Status
                  <select value={usageForm.thresholdStatus}
                    onChange={e => setUsageForm({ ...usageForm, thresholdStatus: e.target.value })}
                    style={INPUT_STYLE}>
                    <option value="">—</option>
                    <option value="ok">ok</option>
                    <option value="warning">warning</option>
                    <option value="critical">critical</option>
                  </select></label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Billing period start
                  <input type="date" value={usageForm.billingPeriodStart}
                    onChange={e => setUsageForm({ ...usageForm, billingPeriodStart: e.target.value })}
                    style={INPUT_STYLE} /></label>
                <label style={{ fontFamily: FONT, fontSize: 11 }}>Billing period end
                  <input type="date" value={usageForm.billingPeriodEnd}
                    onChange={e => setUsageForm({ ...usageForm, billingPeriodEnd: e.target.value })}
                    style={INPUT_STYLE} /></label>
              </div>
              <button onClick={() => void saveUsage()} disabled={savingUsage}
                style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em',
                         textTransform: 'uppercase', padding: '9px 16px', marginTop: 14,
                         background: '#1A1A1A', color: '#fff', border: 'none',
                         cursor: 'pointer', opacity: savingUsage ? 0.45 : 1 }}>
                {savingUsage ? 'Saving…' : 'Save reading'}
              </button>
            </div>
          )}

          <SectionTitle note="Every obligation and every billable metric is represented. Select a provider to expand its detail.">
            By provider
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#FAF9F7' }}>
                  {['', 'Provider', 'Category', 'Obligations', 'Expected /mo',
                    'Actual paid', 'Est. accrued', 'Projected', 'Metrics', 'Status'].map((h, i) => (
                    <th key={i} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data!.providers.length === 0 && (
                  <tr><td colSpan={10} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No providers configured. Add expense definitions or transactions to populate this view.
                  </td></tr>
                )}
                {data!.providers.map(p => {
                  const isOpen = expanded.has(p.provider)
                  const hasDetail = p.definitions.length > 0 || p.usageMetrics.length > 0
                  return (
                    <>
                      <tr key={p.provider} style={{ borderBottom: '1px solid #F1EEE8' }}>
                        <td style={{ padding: '9px 10px', width: 28 }}>
                          {hasDetail && (
                            <button onClick={() => toggle(p.provider)}
                              aria-label={isOpen ? 'Collapse' : 'Expand'}
                              style={{ background: 'none', border: 'none', cursor: 'pointer',
                                       color: '#6B6B6B', fontSize: 11, padding: 0 }}>
                              {isOpen ? '▾' : '▸'}
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '9px 10px', fontWeight: 500 }}>{p.provider}</td>
                        <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                          {p.category.replace(/_/g, ' ')}
                        </td>
                        <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                          {p.definitions.length}
                        </td>
                        <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                          {p.expectedMonthlyEquivalentCents === null
                            ? '—' : `${money(p.expectedMonthlyEquivalentCents)}/mo`}
                        </td>
                        {/* CASH OUT */}
                        <td style={{ padding: '9px 10px', fontWeight: 500,
                                     color: p.actualPaidCents === null ? '#92400E' : '#1A1A1A' }}>
                          {moneyOrUnknown(p.actualPaidCents, 'Not paid')}
                        </td>
                        {/* FORECASTS */}
                        <td style={{ padding: '9px 10px', color: '#92400E' }}>
                          {moneyOrUnknown(p.estimatedAccruedCents, '—')}
                        </td>
                        <td style={{ padding: '9px 10px', color: '#92400E' }}>
                          {moneyOrUnknown(p.projectedMonthEndCents, '—')}
                        </td>
                        <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                          {p.usageMetrics.length}
                        </td>
                        <td style={{ padding: '9px 10px' }}>
                          <ThresholdPill status={p.thresholdStatus} />
                        </td>
                      </tr>

                      {isOpen && p.definitions.map(d => (
                        <tr key={`${p.provider}-def-${d.id}`}
                            style={{ borderBottom: '1px solid #F7F5F1', background: '#FCFBF9' }}>
                          <td />
                          <td style={{ padding: '7px 10px 7px 24px', color: '#6B6B6B' }}>
                            obligation · {d.name}
                          </td>
                          <td style={{ padding: '7px 10px', color: '#9B9B9B' }}>
                            {d.category.replace(/_/g, ' ')}
                          </td>
                          <td style={{ padding: '7px 10px', color: '#9B9B9B' }}>
                            {d.cadence.replace(/_/g, ' ')}
                          </td>
                          <td style={{ padding: '7px 10px', color: '#6B6B6B' }}>
                            {d.monthlyEquivalentCents === null
                              ? (d.expectedAmountCents === null ? 'usage-based' : '—')
                              : `${money(d.monthlyEquivalentCents)}/mo`}
                          </td>
                          <td style={{ padding: '7px 10px', color: '#9B9B9B' }}>
                            {d.expectedAmountCents === null
                              ? '—' : `${money(d.expectedAmountCents)} expected`}
                          </td>
                          <td colSpan={3} style={{ padding: '7px 10px', color: '#9B9B9B' }}>
                            {d.renewalDate ? `renews ${d.renewalDate}` : ''}
                          </td>
                          <td />
                        </tr>
                      ))}

                      {isOpen && p.usageMetrics.map(m => (
                        <tr key={`${p.provider}-metric-${m.metricName}`}
                            style={{ borderBottom: '1px solid #F7F5F1', background: '#FCFBF9' }}>
                          <td />
                          <td style={{ padding: '7px 10px 7px 24px', color: '#6B6B6B' }}>
                            metric · {m.metricName}
                          </td>
                          <td colSpan={3} style={{ padding: '7px 10px', color: '#9B9B9B' }}>
                            {m.usageValue === null ? '—' : (
                              <>
                                {m.usageValue}
                                {m.includedAllowance !== null && ` / ${m.includedAllowance}`}
                                {` ${m.metricUnit}`}
                              </>
                            )}
                          </td>
                          <td style={{ padding: '7px 10px', color: '#9B9B9B' }}>—</td>
                          <td style={{ padding: '7px 10px', color: '#92400E' }}>
                            {moneyOrUnknown(m.estimatedAccruedCents, '—')}
                          </td>
                          <td style={{ padding: '7px 10px', color: '#92400E' }}>
                            {moneyOrUnknown(m.projectedMonthEndCents, '—')}
                          </td>
                          <td style={{ padding: '7px 10px', color: '#9B9B9B' }}>
                            {m.source ?? '—'}
                          </td>
                          <td style={{ padding: '7px 10px' }}>
                            <ThresholdPill status={m.thresholdStatus} />
                          </td>
                        </tr>
                      ))}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '12px 0 0' }}>
            Monthly equivalents are planning arithmetic for comparing obligations. The actual
            charge stays a single transaction on its real cadence — no monthly rows are fabricated.
          </p>

          {/* Provider portals — navigation shortcuts, no credentials involved */}
          <div style={{ marginTop: 30 }}>
            <SectionTitle note="Open the provider's own dashboard to verify a figure or retrieve an invoice. These are links only — no credentials are stored or transmitted by KVRN.">
              Provider portals
            </SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 10 }}>
              {PROVIDER_PORTALS.map(p2 => (
                <a key={p2.provider} href={p2.url}
                   target="_blank" rel="noopener noreferrer"
                   style={{ border: BORDER, background: '#fff', padding: '12px 14px',
                            textDecoration: 'none', display: 'block' }}>
                  <span style={{ fontFamily: FONT, fontSize: 12, fontWeight: 500,
                                 color: '#1A1A1A', display: 'block' }}>
                    {p2.label} ↗
                  </span>
                  <span style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B',
                                 display: 'block', marginTop: 3 }}>
                    {p2.purpose}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
