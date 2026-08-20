'use client'
// components/admin/charts/LineChart.tsx
//
// DISPLAY ONLY. This component receives values that were already computed by the
// authoritative financial layer and turns them into pixels. It performs no
// accounting: no revenue, COGS, profit, margin, fee, shipping or refund formula
// exists here. If a number is wrong, it is wrong upstream in
// lib/financial-calculator.ts, not in this file.
//
// Interaction works with mouse, pen and touch via pointer events. touch-action is
// pan-y so vertical page scrolling still works on mobile while a horizontal drag
// scrubs values.

import { useState, useRef, useCallback } from 'react'
import {
  niceTicks, seriesToPoints, buildLinePath, buildAreaPath, nearestIndex,
} from '@/lib/chart-math'

/** Unit tag. Series of different units must never share one axis unlabelled. */
export type SeriesUnit = 'cents' | 'count'

export interface LineSeries {
  key:    string
  label:  string
  color:  string
  values: Array<number | null>
  unit:   SeriesUnit
  /** Shown in the tooltip for count series, e.g. "CU-hours". */
  unitLabel?: string
}

const PAD = { top: 14, right: 16, bottom: 26, left: 62 }

export function LineChart({
  labels, series, height = 240, formatCents, emptyMessage = 'No data in this period.',
}: {
  labels:   string[]
  series:   LineSeries[]
  height?:  number
  formatCents: (cents: number) => string
  emptyMessage?: string
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [width, setWidth]       = useState(760)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const measure = useCallback((node: SVGSVGElement | null) => {
    svgRef.current = node
    if (node) {
      const w = node.getBoundingClientRect().width
      if (w > 0) setWidth(w)
    }
  }, [])

  const plotW = Math.max(40, width - PAD.left - PAD.right)
  const plotH = Math.max(40, height - PAD.top - PAD.bottom)

  const hasPoints = labels.length > 0 && series.length > 0
  const hasAnyValue = series.some(s => s.values.some(v => v !== null && v !== 0))

  // UNIT GUARD: overlaying cents on counts would draw a meaningless comparison.
  const units = [...new Set(series.map(s => s.unit))]
  const mixedUnits = units.length > 1

  // Domain spans every enabled series so they share one comparable axis.
  // Negative values (a loss) are preserved, not clipped to zero.
  const allValues = series.flatMap(s => s.values.filter((v): v is number => v !== null))
  const dataMin = allValues.length ? Math.min(...allValues) : 0
  const dataMax = allValues.length ? Math.max(...allValues) : 0
  const { ticks, niceMin, niceMax } = niceTicks(dataMin, dataMax, 4)

  const fmt = (v: number, s?: LineSeries) =>
    !s || s.unit === 'cents'
      ? formatCents(v)
      : `${v.toLocaleString()}${s.unitLabel ? ` ${s.unitLabel}` : ''}`

  const yFor = (v: number) =>
    PAD.top + plotH - ((v - niceMin) / ((niceMax - niceMin) || 1)) * plotH

  const zeroY = yFor(0)

  function onPointer(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const idx = nearestIndex(e.clientX - rect.left, labels.length, plotW, PAD.left)
    setHoverIdx(idx >= 0 ? idx : null)
  }

  if (!hasPoints || !hasAnyValue) {
    return (
      <div style={{
        height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid #E8E5E0', background: '#fff',
        fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif',
        fontSize: 12, color: '#9B9B9B',
      }}>
        {emptyMessage}
      </div>
    )
  }

  const hoverX = hoverIdx === null
    ? null
    : PAD.left + (labels.length === 1 ? plotW / 2 : (hoverIdx / (labels.length - 1)) * plotW)

  // Thin out x labels so they never overlap on dense ranges.
  const labelStep = Math.max(1, Math.ceil(labels.length / 8))

  return (
    <div style={{ position: 'relative', border: '1px solid #E8E5E0', background: '#fff' }}>
      {mixedUnits && (
        <p style={{
          margin: 0, padding: '8px 12px', background: '#FFFBEB',
          borderBottom: '1px solid #FDE68A', color: '#92400E',
          fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif', fontSize: 11,
        }}>
          Mixed units selected ({units.join(' and ')}). These are not directly comparable —
          each series is scaled to the same axis for shape only, not magnitude.
        </p>
      )}

      <svg
        ref={measure}
        viewBox={`0 0 ${width} ${height}`}
        width="100%" height={height}
        role="img"
        aria-label={`Chart of ${series.map(s => s.label).join(', ')} over ${labels.length} periods`}
        style={{ display: 'block', touchAction: 'pan-y' }}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {/* Gridlines + y axis */}
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={yFor(t)} y2={yFor(t)}
                  stroke="#F1EEE8" strokeWidth={1} />
            <text x={PAD.left - 8} y={yFor(t) + 3} textAnchor="end"
                  fontSize={9} fill="#9B9B9B"
                  fontFamily="-apple-system, Helvetica Neue, Arial, sans-serif">
              {units[0] === 'cents' ? formatCents(t) : t.toLocaleString()}
            </text>
          </g>
        ))}

        {/* Zero baseline emphasised when the data crosses it (a loss) */}
        {niceMin < 0 && (
          <line x1={PAD.left} x2={PAD.left + plotW} y1={zeroY} y2={zeroY}
                stroke="#C9C4BB" strokeWidth={1} strokeDasharray="3 3" />
        )}

        {/* x labels */}
        {labels.map((l, i) => (
          i % labelStep === 0 ? (
            <text key={i}
              x={PAD.left + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW)}
              y={height - 8} textAnchor="middle" fontSize={9} fill="#9B9B9B"
              fontFamily="-apple-system, Helvetica Neue, Arial, sans-serif">
              {l}
            </text>
          ) : null
        ))}

        {/* Series */}
        {series.map(s => {
          const pts = seriesToPoints(s.values, niceMin, niceMax, plotW, plotH, PAD.left, PAD.top)
          return (
            <g key={s.key}>
              {series.length === 1 && (
                <path d={buildAreaPath(pts, PAD.top + plotH)} fill={s.color} opacity={0.08} />
              )}
              <path d={buildLinePath(pts)} fill="none" stroke={s.color}
                    strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
              {/* Lone points would otherwise be invisible with no segment to draw */}
              {pts.map((p, i) =>
                p && !pts[i - 1] && !pts[i + 1]
                  ? <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={s.color} />
                  : null
              )}
            </g>
          )
        })}

        {/* Hover marker */}
        {hoverX !== null && (
          <>
            <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={PAD.top + plotH}
                  stroke="#1A1A1A" strokeWidth={1} opacity={0.25} />
            {series.map(s => {
              const v = s.values[hoverIdx!]
              if (v === null || v === undefined) return null
              return <circle key={s.key} cx={hoverX} cy={yFor(v)} r={3.5}
                             fill="#fff" stroke={s.color} strokeWidth={2} />
            })}
          </>
        )}
      </svg>

      {/* Tooltip — plain DOM so text stays selectable and readable on mobile */}
      {hoverIdx !== null && (
        <div style={{
          position: 'absolute', top: 8,
          left: Math.min(Math.max(8, (hoverX ?? 0) + 12), Math.max(8, width - 190)),
          background: '#0F0F0F', color: '#F2EFE9', padding: '8px 10px',
          border: '1px solid #2A2A2A', pointerEvents: 'none', minWidth: 150,
          fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif', fontSize: 11,
        }}>
          <div style={{ color: '#9B9B9B', fontSize: 9, letterSpacing: '0.1em',
                        textTransform: 'uppercase', marginBottom: 5 }}>
            {labels[hoverIdx]}
          </div>
          {series.map(s => (
            <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 2, background: s.color, display: 'inline-block' }} />
                {s.label}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {s.values[hoverIdx] === null ? '—' : fmt(s.values[hoverIdx] as number, s)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
