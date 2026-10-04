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
import { formatPointValue, incompleteLegend, seriesDataState, type PointStatus, type PointBound } from '@/lib/chart-data'

/** Unit tag. Series of different units must never share one axis unlabelled. */
export type SeriesUnit = 'cents' | 'count' | 'pct'

export interface LineSeries {
  key:    string
  label:  string
  color:  string
  values: Array<number | null>
  unit:   SeriesUnit
  /** Shown in the tooltip for count series, e.g. "CU-hours". */
  unitLabel?: string
  /**
   * Optional per-point honesty flags (same length as values).
   *   'incomplete'  a known-so-far value: drawn with a hollow marker. How it is worded
   *                 comes from `bounds` (never guessed here): floor "≥", ceiling "≤",
   *                 neither "known so far".
   *   'unknown'     no authoritative value: the value is null (a gap) and the column is
   *                 shaded. Never drawn as zero.
   * Omitted = every point is exact (the behaviour every pre-existing caller gets).
   */
  status?: Array<PointStatus | undefined>
  /** Optional per-point bound direction for 'incomplete' points: 'floor' (a cost, ≥) or 'ceiling' (a profit, ≤). */
  bounds?: Array<PointBound | undefined>
  /** Optional per-point tooltip explanation. */
  notes?: Array<string | undefined>
}

const PAD = { top: 14, right: 16, bottom: 26, left: 62 }

export function LineChart({
  labels, series, height = 240, formatCents, emptyMessage = 'No data in this period.',
  ariaLabel,
}: {
  labels:   string[]
  series:   LineSeries[]
  height?:  number
  formatCents: (cents: number) => string
  emptyMessage?: string
  /** Overrides the generated accessible description. */
  ariaLabel?: string
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
  // A chart whose only content is "unknown" or "incomplete" points is NOT empty: hiding it
  // behind a "no data" message would hide the very fact the operator needs to see.
  const hasFlagged = series.some(s => (s.status ?? []).some(x => x === 'incomplete' || x === 'unknown'))
  // Exact zero is DATA ("all $0"), not absence: only a chart with no buckets, or with nothing but
  // nulls, is empty. See seriesDataState in lib/chart-data.ts (unit-tested).
  const dataState = seriesDataState(labels.length, series)
  const hasAnyValue = hasFlagged || dataState !== 'empty'
  const flaggedKinds = {
    incomplete: series.some(s => (s.status ?? []).includes('incomplete')),
    unknown:    series.some(s => (s.status ?? []).includes('unknown')),
  }
  // Columns where ANY plotted series is unknown get a shaded band.
  const unknownCols = labels.map((_, i) => series.some(s => s.status?.[i] === 'unknown'))

  // UNIT GUARD: overlaying cents on counts would draw a meaningless comparison.
  const units = [...new Set(series.map(s => s.unit))]
  const mixedUnits = units.length > 1

  // Domain spans every enabled series so they share one comparable axis.
  // Negative values (a loss) are preserved, not clipped to zero.
  const allValues = series.flatMap(s => s.values.filter((v): v is number => v !== null))
  const dataMin = allValues.length ? Math.min(...allValues) : 0
  const dataMax = allValues.length ? Math.max(...allValues) : 0
  const nice = niceTicks(dataMin, dataMax, 4)
  const { niceMin, niceMax } = nice
  // An all-zero series gets only its real baseline tick: niceTicks' placeholder top tick (1) would
  // read as "$0.01" on a money axis.
  const ticks = dataState === 'zero' ? [0] : nice.ticks

  const fmt = (v: number, s?: LineSeries) =>
    !s || s.unit === 'cents'
      ? formatCents(v)
      : s.unit === 'pct'
        ? `${v.toFixed(1)}%`
        : `${v.toLocaleString()}${s.unitLabel ? ` ${s.unitLabel}` : ''}`

  const yFor = (v: number) =>
    PAD.top + plotH - ((v - niceMin) / ((niceMax - niceMin) || 1)) * plotH

  const zeroY = yFor(0)

  function onPointer(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    // The SVG scales with its container (viewBox), so convert the pointer from screen
    // pixels into the chart's own coordinate space before mapping it to a point.
    const scale = rect.width > 0 ? width / rect.width : 1
    const idx = nearestIndex((e.clientX - rect.left) * scale, labels.length, plotW, PAD.left)
    setHoverIdx(idx >= 0 ? idx : null)
  }

  // Keyboard: arrow keys move the readout; Escape clears it.
  function onKey(e: React.KeyboardEvent<SVGSVGElement>) {
    if (labels.length === 0) return
    if (e.key === 'ArrowRight') { e.preventDefault(); setHoverIdx(i => Math.min(labels.length - 1, (i ?? -1) + 1)) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setHoverIdx(i => Math.max(0, (i ?? labels.length) - 1)) }
    else if (e.key === 'Escape') setHoverIdx(null)
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
        aria-label={ariaLabel ?? `Chart of ${series.map(s => s.label).join(', ')} over ${labels.length} periods` +
          (flaggedKinds.unknown || flaggedKinds.incomplete
            ? `. Some points are ${[flaggedKinds.unknown && 'unknown', flaggedKinds.incomplete && 'incomplete'].filter(Boolean).join(' or ')}; hover or use the arrow keys for details.`
            : dataState === 'zero'
              ? '. Every recorded value is zero. Hover or use the arrow keys for values.'
              : '. Hover or use the arrow keys for values.')}
        tabIndex={0}
        style={{ display: 'block', touchAction: 'pan-y' }}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setHoverIdx(null)}
        onKeyDown={onKey}
        onBlur={() => setHoverIdx(null)}
      >
        {/* Gridlines + y axis */}
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={yFor(t)} y2={yFor(t)}
                  stroke="#F1EEE8" strokeWidth={1} />
            <text x={PAD.left - 8} y={yFor(t) + 3} textAnchor="end"
                  fontSize={9} fill="#9B9B9B"
                  fontFamily="-apple-system, Helvetica Neue, Arial, sans-serif">
              {units[0] === 'cents' ? formatCents(t) : units[0] === 'pct' ? `${t}%` : t.toLocaleString()}
            </text>
          </g>
        ))}

        {/* Zero baseline emphasised when the data crosses it (a loss) */}
        {niceMin < 0 && (
          <line x1={PAD.left} x2={PAD.left + plotW} y1={zeroY} y2={zeroY}
                stroke="#C9C4BB" strokeWidth={1} strokeDasharray="3 3" />
        )}

        {/* Unknown columns: shaded, so a missing value reads as "unknown", not as a low value */}
        {unknownCols.map((on, i) => {
          if (!on) return null
          const cx = PAD.left + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW)
          const bandW = labels.length === 1 ? plotW : plotW / (labels.length - 1)
          return (
            <rect key={`unk-${i}`} x={Math.max(PAD.left, cx - bandW / 2)} y={PAD.top}
                  width={Math.min(bandW, PAD.left + plotW - Math.max(PAD.left, cx - bandW / 2))}
                  height={plotH} fill="#F59E0B" opacity={0.12}>
              <title>{`${labels[i]}: unknown`}</title>
            </rect>
          )
        })}

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
                p && !pts[i - 1] && !pts[i + 1] && s.status?.[i] !== 'incomplete'
                  ? <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={s.color} />
                  : null
              )}
              {/* Incomplete (known-so-far) points: hollow, so they never look like exact readings */}
              {pts.map((p, i) =>
                p && s.status?.[i] === 'incomplete'
                  ? <circle key={`inc-${i}`} cx={p.x} cy={p.y} r={3.5} fill="#fff"
                            stroke={s.color} strokeWidth={1.5} strokeDasharray="2 1.5" />
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

      {dataState === 'zero' && (
        <p role="status" style={{
          margin: 0, padding: '6px 12px 8px', borderTop: '1px solid #F1EEE8',
          fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif', fontSize: 11, color: '#6B6B6B',
        }}>
          Every recorded value in this period is exactly {mixedUnits ? 'zero' : fmt(0, series[0])} — this is real data, not a missing period.
        </p>
      )}

      {(flaggedKinds.incomplete || flaggedKinds.unknown) && (
        <p style={{
          margin: 0, padding: '6px 12px 8px', borderTop: '1px solid #F1EEE8',
          fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif', fontSize: 10.5, color: '#6B6B6B',
        }}>
          {flaggedKinds.incomplete && <>◌ Dashed hollow marker = incomplete: {incompleteLegend(series)}. </>}
          {flaggedKinds.unknown && <>▒ Shaded column = unknown: no authoritative value yet (not zero). </>}
        </p>
      )}

      {/* Tooltip — plain DOM so text stays selectable and readable on mobile */}
      {hoverIdx !== null && (
        <div style={{
          position: 'absolute', top: 8,
          left: Math.min(Math.max(8, (hoverX ?? 0) + 12), Math.max(8, width - 190)),
          background: '#0F0F0F', color: '#F2EFE9', padding: '8px 10px',
          border: '1px solid #2A2A2A', pointerEvents: 'none', minWidth: 150, maxWidth: 'calc(100% - 16px)',
          fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif', fontSize: 11,
        }}>
          <div style={{ color: '#9B9B9B', fontSize: 9, letterSpacing: '0.1em',
                        textTransform: 'uppercase', marginBottom: 5 }}>
            {labels[hoverIdx]}
          </div>
          {series.map(s => {
            const v = s.values[hoverIdx]
            const st = s.status?.[hoverIdx]
            const note = s.notes?.[hoverIdx]
            return (
              <div key={s.key} style={{ marginBottom: note ? 3 : 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 8, height: 2, background: s.color, display: 'inline-block' }} />
                    {s.label}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatPointValue(v === null || v === undefined ? null : fmt(v, s), st, s.bounds?.[hoverIdx])}
                  </span>
                </div>
                {note && (
                  <div style={{ color: st === 'unknown' || st === 'incomplete' ? '#FCD34D' : '#9B9B9B',
                                fontSize: 10, lineHeight: 1.35, marginTop: 1, maxWidth: 220 }}>
                    {note}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
