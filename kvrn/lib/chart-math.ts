// lib/chart-math.ts — pure charting mathematics
//
// No React, no DOM, no I/O. Every function here is deterministic and unit-tested,
// which is the main reason KVRN hand-rolls its charts instead of pulling in a
// charting library: the numbers that drive the pixels are verifiable.
//
// Money is handled in integer cents throughout. Values are only converted to
// floats for pixel positions, never for accounting.

// ─────────────────────────────────────────────────────────────────────────────
// SCALES
// ─────────────────────────────────────────────────────────────────────────────

/** Map a value from a data domain onto a pixel range. */
export function linearScale(
  value: number,
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): number {
  if (domainMax === domainMin) return rangeMin
  const t = (value - domainMin) / (domainMax - domainMin)
  return rangeMin + t * (rangeMax - rangeMin)
}

/**
 * Choose a human-friendly axis maximum and tick step.
 *
 * Raw maxima produce axes labelled $8,834.17. Rounding up to a 1/2/5 x 10^n step
 * gives $10,000 with even gridlines. Always includes zero so bar and area charts
 * are not visually misleading.
 */
export function niceTicks(
  min: number,
  max: number,
  targetCount = 5,
): { ticks: number[]; niceMin: number; niceMax: number } {
  // Always anchor at zero unless data genuinely goes negative (e.g. a loss).
  const lo = Math.min(0, min)
  const hi = Math.max(0, max)

  if (lo === hi) {
    return { ticks: [0, 1], niceMin: 0, niceMax: 1 }
  }

  const rawStep = (hi - lo) / Math.max(1, targetCount)
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawStep) || 1)))
  const normalized = rawStep / magnitude

  let stepMultiple: number
  if (normalized <= 1)      stepMultiple = 1
  else if (normalized <= 2) stepMultiple = 2
  else if (normalized <= 5) stepMultiple = 5
  else                      stepMultiple = 10
  const step = stepMultiple * magnitude

  const niceMin = Math.floor(lo / step) * step
  const niceMax = Math.ceil(hi / step) * step

  const ticks: number[] = []
  // Guard against runaway loops from pathological input.
  for (let v = niceMin, i = 0; v <= niceMax + step / 2 && i < 100; v += step, i++) {
    // Re-round to kill floating point drift like 0.30000000000000004
    ticks.push(Math.round(v * 1e6) / 1e6)
  }
  return { ticks, niceMax, niceMin }
}

// ─────────────────────────────────────────────────────────────────────────────
// LINE / AREA PATHS
// ─────────────────────────────────────────────────────────────────────────────

export interface PixelPoint { x: number; y: number }

/**
 * Convert a series of values into pixel points.
 * A null value means "no data" and is skipped, so a gap renders as a gap rather
 * than a line dropping to zero (which would read as a real zero).
 */
export function seriesToPoints(
  values: Array<number | null>,
  domainMin: number,
  domainMax: number,
  width: number,
  height: number,
  padLeft = 0,
  padTop = 0,
): Array<PixelPoint | null> {
  const n = values.length
  return values.map((v, i) => {
    if (v === null || v === undefined) return null
    const x = n === 1
      ? padLeft + width / 2
      : padLeft + (i / (n - 1)) * width
    // SVG y grows downward, so the range is inverted.
    const y = padTop + (height - (linearScale(v, domainMin, domainMax, 0, height)))
    return { x, y }
  })
}

/** Build an SVG polyline path, breaking at gaps rather than bridging them. */
export function buildLinePath(points: Array<PixelPoint | null>): string {
  let d = ''
  let penDown = false
  for (const p of points) {
    if (p === null) { penDown = false; continue }
    d += penDown ? ` L ${round(p.x)} ${round(p.y)}` : `${d ? ' ' : ''}M ${round(p.x)} ${round(p.y)}`
    penDown = true
  }
  return d
}

/**
 * Closed area path(s) under a line.
 *
 * Each contiguous run of non-null points becomes its OWN closed polygon. Filtering
 * nulls out and filling one shape would bridge the fill straight across a
 * missing-data gap, visually asserting data that does not exist — the same
 * mistake buildLinePath avoids by breaking the stroke.
 *
 * [10, null, 30] therefore yields two separate filled segments, not one.
 */
export function buildAreaPath(
  points: Array<PixelPoint | null>,
  baselineY: number,
): string {
  const parts: string[] = []
  let segment: PixelPoint[] = []

  const flush = () => {
    if (segment.length === 0) return
    let d = `M ${round(segment[0].x)} ${round(baselineY)}`
    for (const p of segment) d += ` L ${round(p.x)} ${round(p.y)}`
    d += ` L ${round(segment[segment.length - 1].x)} ${round(baselineY)} Z`
    parts.push(d)
    segment = []
  }

  for (const p of points) {
    if (p === null) { flush(); continue }
    segment.push(p)
  }
  flush()

  return parts.join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

// ─────────────────────────────────────────────────────────────────────────────
// HOVER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index of the data point nearest a pointer x position.
 * Returns -1 for an empty series so callers can skip rendering a tooltip.
 */
export function nearestIndex(
  pointerX: number,
  count: number,
  width: number,
  padLeft = 0,
): number {
  if (count <= 0) return -1
  if (count === 1) return 0
  const t = (pointerX - padLeft) / width
  const idx = Math.round(t * (count - 1))
  return Math.min(count - 1, Math.max(0, idx))
}

// ─────────────────────────────────────────────────────────────────────────────
// DONUT / PIE — composition only
// ─────────────────────────────────────────────────────────────────────────────

export interface DonutSlice {
  label:      string
  valueCents: number
  pct:        number
  path:       string
  /** Mid-angle in radians, useful for label placement. */
  midAngle:   number
}

/**
 * Build donut arc paths for a composition breakdown.
 *
 * Negative values are dropped rather than rendered: a pie implies parts of a
 * whole, and a negative slice has no coherent area. Callers should surface
 * negative components (e.g. a loss) in a different visual.
 */
export function buildDonut(
  items: Array<{ label: string; valueCents: number }>,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
): DonutSlice[] {
  const positive = items.filter(i => i.valueCents > 0)
  const total = positive.reduce((s, i) => s + i.valueCents, 0)
  if (total <= 0) return []

  let angle = -Math.PI / 2   // start at 12 o'clock
  return positive.map(item => {
    const sweep = (item.valueCents / total) * Math.PI * 2
    const start = angle
    const end   = angle + sweep
    angle = end

    const path = arcPath(cx, cy, outerR, innerR, start, end)
    return {
      label:      item.label,
      valueCents: item.valueCents,
      pct:        Math.round((item.valueCents / total) * 10000) / 100,
      path,
      midAngle:   start + sweep / 2,
    }
  })
}

function arcPath(
  cx: number, cy: number, outerR: number, innerR: number,
  start: number, end: number,
): string {
  // A full circle cannot be drawn with a single arc; nudge it closed.
  const sweep = end - start
  const e = sweep >= Math.PI * 2 ? start + Math.PI * 2 - 0.0001 : end
  const largeArc = (e - start) > Math.PI ? 1 : 0

  const x1 = cx + outerR * Math.cos(start), y1 = cy + outerR * Math.sin(start)
  const x2 = cx + outerR * Math.cos(e),     y2 = cy + outerR * Math.sin(e)
  const x3 = cx + innerR * Math.cos(e),     y3 = cy + innerR * Math.sin(e)
  const x4 = cx + innerR * Math.cos(start), y4 = cy + innerR * Math.sin(start)

  return [
    `M ${round(x1)} ${round(y1)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${round(x2)} ${round(y2)}`,
    `L ${round(x3)} ${round(y3)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${round(x4)} ${round(y4)}`,
    'Z',
  ].join(' ')
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME BUCKETING
// ─────────────────────────────────────────────────────────────────────────────

export type Granularity = 'day' | 'week' | 'month'

export interface TimeBucket {
  /** Inclusive ISO start of the bucket. */
  start: string
  /** Exclusive ISO end of the bucket. */
  end:   string
  /** Short axis label, e.g. "14 Jun". */
  label: string
}

/**
 * Pick a granularity that keeps the x-axis readable.
 * A one-year range at daily granularity is 365 unlabelled points; monthly is 12.
 */
export function autoGranularity(startISO: string, endISO: string): Granularity {
  const days = (Date.parse(endISO) - Date.parse(startISO)) / 86400000
  if (days <= 31)  return 'day'
  if (days <= 182) return 'week'
  return 'month'
}

/**
 * Split a half-open [start, end) range into buckets.
 *
 * Buckets are contiguous and non-overlapping, so summing a metric across every
 * bucket reproduces the whole-period total exactly. That invariant is tested —
 * it is what guarantees the chart agrees with the summary cards above it.
 */
export function buildBuckets(
  startISO: string,
  endISO: string,
  granularity: Granularity,
): TimeBucket[] {
  const start = new Date(startISO)
  const end   = new Date(endISO)
  if (!(start < end)) return []

  const buckets: TimeBucket[] = []
  let cursor = truncate(start, granularity)
  // Never emit a bucket that begins before the requested range.
  if (cursor < start) cursor = new Date(start)

  let guard = 0
  while (cursor < end && guard++ < 2000) {
    const next = advance(truncate(cursor, granularity), granularity)
    const bucketEnd = next > end ? end : next
    buckets.push({
      start: cursor.toISOString(),
      end:   bucketEnd.toISOString(),
      label: formatLabel(cursor, granularity),
    })
    cursor = bucketEnd
  }
  return buckets
}

function truncate(d: Date, g: Granularity): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate()
  if (g === 'month') return new Date(Date.UTC(y, m, 1))
  if (g === 'week') {
    // Week starts Monday. getUTCDay(): 0=Sun..6=Sat
    const dow = (d.getUTCDay() + 6) % 7
    return new Date(Date.UTC(y, m, day - dow))
  }
  return new Date(Date.UTC(y, m, day))
}

function advance(d: Date, g: Granularity): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate()
  if (g === 'month') return new Date(Date.UTC(y, m + 1, 1))
  if (g === 'week')  return new Date(Date.UTC(y, m, day + 7))
  return new Date(Date.UTC(y, m, day + 1))
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function formatLabel(d: Date, g: Granularity): string {
  if (g === 'month') return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** Index of the bucket containing an instant, or -1 when outside every bucket. */
export function bucketIndexFor(buckets: TimeBucket[], iso: string): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return -1
  for (let i = 0; i < buckets.length; i++) {
    if (t >= Date.parse(buckets[i].start) && t < Date.parse(buckets[i].end)) return i
  }
  return -1
}

// ─────────────────────────────────────────────────────────────────────────────
// EXACT ALLOCATION ACROSS BUCKETS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spread an integer-cent amount across buckets by weight, losing no cents.
 *
 * Largest-remainder apportionment, same technique as the order-level discount
 * allocator. Naive per-bucket rounding would make the chart's column totals
 * disagree with the summary cards; this guarantees the parts sum to the whole.
 * Ties break by descending weight then ascending index, so it is deterministic.
 */
export function allocateAcrossBuckets(
  totalCents: number,
  weights: number[],
): number[] {
  const n = weights.length
  if (n === 0) return []
  if (totalCents === 0) return new Array(n).fill(0)

  const weightSum = weights.reduce((s, w) => s + w, 0)
  // No weighting signal: spread as evenly as cents allow.
  if (weightSum <= 0) {
    const base = Math.floor(totalCents / n)
    const out = new Array(n).fill(base)
    let leftover = totalCents - base * n
    for (let i = 0; i < n && leftover > 0; i++, leftover--) out[i] += 1
    return out
  }

  const exact = weights.map(w => (totalCents * w) / weightSum)
  const floors = exact.map(Math.floor)
  let leftover = totalCents - floors.reduce((s, v) => s + v, 0)

  const order = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e), w: weights[i] }))
    .sort((a, b) => (b.rem - a.rem) || (b.w - a.w) || (a.i - b.i))

  const out = [...floors]
  for (let k = 0; k < leftover; k++) out[order[k % n].i] += 1
  return out
}
