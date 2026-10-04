'use client'
// components/admin/charts/BarChart.tsx
//
// DISPLAY ONLY. Vertical columns for a COUNT per time bucket (for example paid orders
// per day). It performs no accounting: the numbers arrive already computed.
//
// A null value is "no data" and draws no bar and a "—" tooltip; a real 0 draws no bar
// but reads "0". The two are never conflated.

import { useState, useRef, useCallback } from 'react'
import { niceTicks } from '@/lib/chart-math'
import { seriesDataState } from '@/lib/chart-data'

const FONT = '-apple-system, Helvetica Neue, Arial, sans-serif'
const PAD = { top: 12, right: 12, bottom: 26, left: 40 }

export function BarChart({
  labels, values, color = '#1A1A1A', height = 200, unitLabel = 'orders',
  ariaLabel, emptyMessage = 'No data for this period', zeroMessage,
}: {
  labels: string[]
  values: Array<number | null>
  color?: string
  height?: number
  /** Noun used in the tooltip and the accessible label, e.g. "orders". */
  unitLabel?: string
  ariaLabel?: string
  /** Shown when there are no periods, or every value is null (unknown). */
  emptyMessage?: string
  /** Shown under the baseline when every value is exactly 0 - a known zero, NOT missing data. */
  zeroMessage?: string
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [width, setWidth] = useState(520)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const measure = useCallback((node: SVGSVGElement | null) => {
    svgRef.current = node
    if (node) { const w = node.getBoundingClientRect().width; if (w > 0) setWidth(w) }
  }, [])

  const plotW = Math.max(40, width - PAD.left - PAD.right)
  const plotH = Math.max(40, height - PAD.top - PAD.bottom)
  const known = values.filter((v): v is number => v !== null)
  // Exact zero is data ("0 orders"), not absence: only no periods / all-null is empty.
  const dataState = seriesDataState(labels.length, [{ values }])
  const isZero = dataState === 'zero'

  if (dataState === 'empty') {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: '1px solid #E8E5E0', background: '#fff',
                    fontFamily: FONT, fontSize: 12, color: '#9B9B9B' }}>
        {emptyMessage}
      </div>
    )
  }

  const max = Math.max(...known)
  // Counts: whole-number ticks only. An all-zero series keeps a 0..1 scale but labels only 0.
  let { ticks, niceMax } = niceTicks(0, max, 4)
  ticks = ticks.filter(t => Number.isInteger(t))
  if (ticks.length < 2) { ticks = [0, Math.max(1, Math.ceil(max))]; niceMax = ticks[1] }
  if (isZero) ticks = [0]
  const yFor = (v: number) => PAD.top + plotH - (v / (niceMax || 1)) * plotH

  const slot = plotW / labels.length
  const barW = Math.max(1, Math.min(28, slot * 0.7))
  const labelStep = Math.max(1, Math.ceil(labels.length / 8))

  function onPointer(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const scale = rect.width > 0 ? width / rect.width : 1
    // Bars are centred in equal slots, so map the pointer to a slot rather than to line-chart spacing.
    const x = (e.clientX - rect.left) * scale - PAD.left
    const idx = Math.floor(x / slot)
    setHoverIdx(idx >= 0 && idx < labels.length ? idx : null)
  }
  function onKey(e: React.KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') { e.preventDefault(); setHoverIdx(i => Math.min(labels.length - 1, (i ?? -1) + 1)) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setHoverIdx(i => Math.max(0, (i ?? labels.length) - 1)) }
    else if (e.key === 'Escape') setHoverIdx(null)
  }
  const total = known.reduce((s, v) => s + v, 0)
  const hv = hoverIdx === null ? undefined : values[hoverIdx]

  return (
    <div style={{ position: 'relative', border: '1px solid #E8E5E0', background: '#fff' }}>
      <svg ref={measure} viewBox={`0 0 ${width} ${height}`} width="100%" height={height}
           role="img" tabIndex={0}
           aria-label={ariaLabel ?? (isZero
             ? `Bar chart of ${unitLabel} over ${labels.length} periods: 0 in every period. ${zeroMessage ?? `0 ${unitLabel} in this period`}.`
             : `Bar chart of ${unitLabel} over ${labels.length} periods, ${total} in total. Hover or use the arrow keys for values.`)}
           style={{ display: 'block', touchAction: 'pan-y' }}
           onPointerMove={onPointer} onPointerDown={onPointer}
           onPointerLeave={() => setHoverIdx(null)}
           onKeyDown={onKey} onBlur={() => setHoverIdx(null)}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={yFor(t)} y2={yFor(t)} stroke="#F1EEE8" strokeWidth={1} />
            <text x={PAD.left - 8} y={yFor(t) + 3} textAnchor="end" fontSize={9} fill="#9B9B9B" fontFamily={FONT}>
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        {labels.map((l, i) => i % labelStep === 0 ? (
          <text key={i} x={PAD.left + slot * i + slot / 2} y={height - 8} textAnchor="middle"
                fontSize={9} fill="#9B9B9B" fontFamily={FONT}>{l}</text>
        ) : null)}
        {values.map((v, i) => {
          if (v === null || v <= 0) return null
          const x = PAD.left + slot * i + (slot - barW) / 2
          return (
            <rect key={i} x={x} y={yFor(v)} width={barW} height={Math.max(1, PAD.top + plotH - yFor(v))}
                  fill={color} opacity={hoverIdx === null || hoverIdx === i ? 0.9 : 0.4}>
              <title>{`${labels[i]}: ${v.toLocaleString()} ${unitLabel}`}</title>
            </rect>
          )
        })}
      </svg>
      {isZero && (
        <p role="status" style={{ margin: 0, padding: '6px 12px 8px', borderTop: '1px solid #F1EEE8',
                                  fontFamily: FONT, fontSize: 11, color: '#6B6B6B' }}>
          {zeroMessage ?? `0 ${unitLabel} in this period`} — a real count of zero, not missing data.
        </p>
      )}
      {hoverIdx !== null && (
        <div style={{ position: 'absolute', top: 8,
                      left: Math.min(Math.max(8, PAD.left + slot * hoverIdx + slot / 2 + 12), Math.max(8, width - 150)),
                      background: '#0F0F0F', color: '#F2EFE9', padding: '6px 10px',
                      border: '1px solid #2A2A2A', pointerEvents: 'none', fontFamily: FONT, fontSize: 11 }}>
          <div style={{ color: '#9B9B9B', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>
            {labels[hoverIdx]}
          </div>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {hv === null || hv === undefined ? '—' : `${hv.toLocaleString()} ${unitLabel}`}
          </span>
        </div>
      )}
    </div>
  )
}
