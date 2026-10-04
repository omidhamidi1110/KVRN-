'use client'
// components/admin/charts/FunnelChart.tsx
//
// DISPLAY ONLY. Horizontal funnel built from the first-party funnel report: counts, the
// share of all visits, and the step-to-step conversion the server already computed.
//
// WORDING MATTERS. A session with no event at a later stage is not proof that the visitor
// "skipped" or "abandoned" anything: events come only from consenting visitors, and stages
// are cumulative (a session counts at a stage or any later one). So the gap between two
// stages is described as "no later event recorded", never as lost/abandoned/skipped.

import type { FunnelRow } from '@/lib/chart-data'

const FONT = '-apple-system, Helvetica Neue, Arial, sans-serif'
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`)

export function FunnelChart({
  rows, overallPct, emptyMessage = 'No data for this period',
}: {
  rows: FunnelRow[]
  /** Visit → purchase, from the server rates (null when there are no visits). */
  overallPct: number | null
  emptyMessage?: string
}) {
  const visits = rows[0]?.count ?? 0
  if (rows.length === 0 || visits === 0) {
    return (
      <div style={{ padding: '28px 14px', textAlign: 'center', border: '1px solid #E8E5E0',
                    background: '#fff', fontFamily: FONT, fontSize: 12, color: '#9B9B9B' }}>
        {emptyMessage}
      </div>
    )
  }

  return (
    <div style={{ border: '1px solid #E8E5E0', background: '#fff', padding: '12px 16px 14px' }}
         role="group" aria-label="Ecommerce funnel from session start to purchase">
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r, i) => {
          const width = Math.max(r.count > 0 ? 0.8 : 0, Math.min(100, (r.count / visits) * 100))
          const last = i === rows.length - 1
          return (
            <li key={r.key} style={{ margin: 0 }}>
              {i > 0 && (
                <div style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', padding: '5px 0 5px 10px',
                              borderLeft: '2px solid #E8E5E0', marginLeft: 4 }}>
                  ↓ {r.stepRatePct === null ? 'no rate (nothing at the previous step)' : `${pct(r.stepRatePct)} continued`}
                  {r.notRecordedAtStep !== null && r.notRecordedAtStep > 0 && (
                    <span style={{ color: '#9B9B9B' }}>
                      {' '}· {r.notRecordedAtStep.toLocaleString()} with no later event recorded
                    </span>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 12px',
                            fontFamily: FONT, fontSize: 12 }}>
                <span style={{ fontWeight: 500, minWidth: 120 }}>{r.label}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {r.count.toLocaleString()}
                </span>
                <span style={{ color: '#6B6B6B', fontVariantNumeric: 'tabular-nums' }}>
                  {pct(r.pctOfVisits)} of visits
                </span>
              </div>
              <div style={{ background: '#F1EEE8', height: 12, marginTop: 4 }}
                   title={`${r.label}: ${r.count.toLocaleString()} sessions (${pct(r.pctOfVisits)} of visits)`}>
                <div style={{ height: 12, width: `${width}%`, background: last ? '#047857' : '#1A1A1A' }} />
              </div>
            </li>
          )
        })}
      </ol>
      <p style={{ fontFamily: FONT, fontSize: 12, margin: '12px 0 0', paddingTop: 10, borderTop: '1px solid #F1EEE8' }}>
        <strong>Overall visit → purchase:</strong> {pct(overallPct)}
      </p>
    </div>
  )
}
