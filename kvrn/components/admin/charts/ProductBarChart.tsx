'use client'
// components/admin/charts/ProductBarChart.tsx
//
// DISPLAY ONLY. Ranked horizontal bars of product behaviour (distinct sessions per
// product at three stages). The detailed table stays alongside; this chart only makes the
// ranking easy to read.
//
// All bars share ONE scale (the largest value shown), so lengths are directly comparable
// across products and stages.

import type { ProductRow } from '@/lib/chart-data'

const FONT = '-apple-system, Helvetica Neue, Arial, sans-serif'

const STAGES = [
  { key: 'views',     label: 'Viewed',        color: '#1A1A1A' },
  { key: 'adds',      label: 'Added to cart', color: '#1D4ED8' },
  { key: 'purchases', label: 'Purchased',     color: '#047857' },
] as const

export function ProductBarChart({
  rows, emptyMessage = 'No data for this period',
}: {
  rows: ProductRow[]
  emptyMessage?: string
}) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: '28px 14px', textAlign: 'center', border: '1px solid #E8E5E0',
                    background: '#fff', fontFamily: FONT, fontSize: 12, color: '#9B9B9B' }}>
        {emptyMessage}
      </div>
    )
  }
  const max = Math.max(1, ...rows.flatMap(r => STAGES.map(s => r[s.key])))

  return (
    <div style={{ border: '1px solid #E8E5E0', background: '#fff', padding: '12px 16px' }}
         role="group" aria-label="Product performance, distinct sessions per product by stage">
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10,
                    fontFamily: FONT, fontSize: 11, color: '#6B6B6B' }}>
        {STAGES.map(s => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 8, background: s.color, display: 'inline-block' }} />{s.label}
          </span>
        ))}
      </div>
      {rows.map(r => (
        <div key={r.productId} style={{ marginBottom: 12 }}
             title={STAGES.map(s => `${s.label}: ${r[s.key]}`).join(' · ')}>
          <div style={{ fontFamily: FONT, fontSize: 12, marginBottom: 3, display: 'flex',
                        justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 500 }}>{r.name}</span>
            <span style={{ color: '#6B6B6B', fontSize: 11 }}>
              cart rate {r.addRatePct === null ? '—' : `${r.addRatePct.toFixed(1)}%`}
              {' · '}purchase rate {r.purchaseRatePct === null ? '—' : `${r.purchaseRatePct.toFixed(1)}%`}
            </span>
          </div>
          {STAGES.map(s => {
            const v = r[s.key]
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <div style={{ flex: 1, background: '#F1EEE8', height: 7 }}>
                  <div style={{ height: 7, width: `${(v / max) * 100}%`, background: s.color }} />
                </div>
                <span style={{ fontFamily: FONT, fontSize: 11, minWidth: 28, textAlign: 'right',
                               fontVariantNumeric: 'tabular-nums' }}>{v.toLocaleString()}</span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
