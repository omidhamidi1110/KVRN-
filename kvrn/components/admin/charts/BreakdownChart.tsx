'use client'
// components/admin/charts/BreakdownChart.tsx
//
// DISPLAY ONLY — no accounting logic. Values arrive pre-computed from the
// authoritative financial layer.
//
// COMPOSITION ONLY. A donut expresses parts of a whole, so it is offered for cost
// or revenue composition and is never applied to a time series, where it would
// destroy the time axis and imply that periods sum to a meaningful whole.
//
// Negative components are excluded from the donut (a negative slice has no
// coherent area) and are surfaced explicitly instead, so they cannot silently
// vanish from the picture.

import { useState } from 'react'
import { buildDonut } from '@/lib/chart-math'

export interface BreakdownItem {
  label:      string
  valueCents: number
  color:      string
}

const FONT = '-apple-system, Helvetica Neue, Arial, sans-serif'

export function DonutChart({
  items, formatCents, size = 200, emptyMessage = 'No costs recorded in this period.',
}: {
  items: BreakdownItem[]
  formatCents: (c: number) => string
  size?: number
  emptyMessage?: string
}) {
  const [active, setActive] = useState<string | null>(null)

  const positive = items.filter(i => i.valueCents > 0)
  const negative = items.filter(i => i.valueCents < 0)
  const total = positive.reduce((s, i) => s + i.valueCents, 0)

  if (positive.length === 0) {
    return (
      <div style={{ padding: '28px 12px', textAlign: 'center',
                    fontFamily: FONT, fontSize: 12, color: '#9B9B9B' }}>
        {emptyMessage}
      </div>
    )
  }

  const cx = size / 2, cy = size / 2
  const slices = buildDonut(
    positive.map(i => ({ label: i.label, valueCents: i.valueCents })),
    cx, cy, size / 2 - 4, size / 2 - 34,
  )
  const colorFor = (label: string) =>
    items.find(i => i.label === label)?.color ?? '#9B9B9B'

  const shown = active
    ? positive.find(i => i.label === active) ?? null
    : null

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
           role="img" aria-label="Cost composition breakdown"
           style={{ flexShrink: 0, touchAction: 'pan-y' }}>
        {slices.map(s => (
          <path
            key={s.label}
            d={s.path}
            fill={colorFor(s.label)}
            opacity={active === null || active === s.label ? 1 : 0.32}
            stroke="#fff" strokeWidth={1}
            onPointerEnter={() => setActive(s.label)}
            onPointerDown={() => setActive(a => a === s.label ? null : s.label)}
            onPointerLeave={() => setActive(null)}
            style={{ cursor: 'pointer' }}
          >
            <title>{`${s.label}: ${formatCents(s.valueCents)} (${s.pct.toFixed(1)}%)`}</title>
          </path>
        ))}
        {/* Centre readout: the hovered slice, otherwise the total */}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={9} fill="#9B9B9B"
              fontFamily={FONT} letterSpacing="0.1em">
          {shown ? shown.label.toUpperCase().slice(0, 14) : 'TOTAL'}
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize={14} fontWeight={500}
              fill="#1A1A1A" fontFamily={FONT}>
          {formatCents(shown ? shown.valueCents : total)}
        </text>
      </svg>

      <div style={{ flex: 1, minWidth: 200 }}>
        {slices.map(s => (
          <div key={s.label}
               onPointerEnter={() => setActive(s.label)}
               onPointerLeave={() => setActive(null)}
               style={{ display: 'flex', alignItems: 'center', gap: 8,
                        padding: '4px 0', fontFamily: FONT, fontSize: 12,
                        opacity: active === null || active === s.label ? 1 : 0.45 }}>
            <span style={{ width: 10, height: 10, background: colorFor(s.label),
                           flexShrink: 0, display: 'inline-block' }} />
            <span style={{ flex: 1 }}>{s.label}</span>
            <span style={{ color: '#6B6B6B', fontVariantNumeric: 'tabular-nums' }}>
              {s.pct.toFixed(1)}%
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 74, textAlign: 'right' }}>
              {formatCents(s.valueCents)}
            </span>
          </div>
        ))}

        {/* Negative components cannot be drawn as slices, so state them plainly */}
        {negative.length > 0 && (
          <p style={{ fontFamily: FONT, fontSize: 11, color: '#92400E', marginTop: 8 }}>
            Excluded from the chart (negative):{' '}
            {negative.map(n => `${n.label} ${formatCents(n.valueCents)}`).join(', ')}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Horizontal bars for the same composition data.
 * Preferred over the donut when there are many components, where thin slices
 * become unreadable.
 */
export function BarBreakdown({
  items, formatCents,
}: {
  items: BreakdownItem[]
  formatCents: (c: number) => string
}) {
  const positive = items.filter(i => i.valueCents > 0)
  if (positive.length === 0) {
    return (
      <div style={{ padding: '28px 12px', textAlign: 'center',
                    fontFamily: FONT, fontSize: 12, color: '#9B9B9B' }}>
        No costs recorded in this period.
      </div>
    )
  }
  const total = positive.reduce((s, i) => s + i.valueCents, 0)
  const max   = Math.max(...positive.map(i => i.valueCents))

  return (
    <div>
      {positive.map(i => {
        const pct = (i.valueCents / total) * 100
        return (
          <div key={i.label} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
                          fontFamily: FONT, fontSize: 12, marginBottom: 3 }}>
              <span>{i.label}</span>
              <span style={{ color: '#6B6B6B', fontVariantNumeric: 'tabular-nums' }}>
                {formatCents(i.valueCents)} · {pct.toFixed(1)}%
              </span>
            </div>
            <div style={{ height: 8, background: '#F1EEE8' }}>
              {/* Width is share of the LARGEST component so differences stay legible */}
              <div style={{ height: '100%', width: `${(i.valueCents / max) * 100}%`,
                            background: i.color }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
