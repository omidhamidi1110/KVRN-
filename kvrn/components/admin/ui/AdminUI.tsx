'use client'
// components/admin/ui/AdminUI.tsx — shared Admin primitives for the refreshed Admin.
//
// Visual rules: warm off-white canvas (set by AdminShell), white cards, subtle borders,
// 14px radius, 11–13px body text, 9–10px ONLY for short uppercase eyebrows, flat fills only.
// Copy rules: short, decision-useful. Put background/method/units in <InfoTip>, but keep
// warnings and Exception/Incomplete/Failed/Unresolved states visible (see StatusBadge, Notice).

import { Children, type CSSProperties, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react'
import { InfoTip } from './InfoTip'
import './admin-stack.css'

export { InfoTip }

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(' ')

// ── Page frame ────────────────────────────────────────────────────────────────
// One max width and one padding scale for every Admin page.

const PAGE_WIDTH = { narrow: 'max-w-[980px]', default: 'max-w-[1240px]', wide: 'max-w-[1500px]' } as const
export function AdminPage({ children, width = 'default', className = '' }: {
  children: ReactNode; width?: keyof typeof PAGE_WIDTH; className?: string
}) {
  return (
    <div className={cx('mx-auto w-full min-w-0 max-w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8', PAGE_WIDTH[width], className)}>
      {children}
    </div>
  )
}

// ── Page + section headers ────────────────────────────────────────────────────

export function AdminPageHeader({
  title, description, eyebrow, info, actions, actionsFull,
}: {
  title: string
  /** Usually 3–8 words. */
  description?: string
  eyebrow?: string
  info?: ReactNode
  actions?: ReactNode
  /** Phones: let the actions use the full row (own toolbar layout) instead of sitting beside the title. */
  actionsFull?: boolean
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#8A8A85]">{eyebrow}</p>}
        <h1 className="flex items-center gap-1 text-[20px] font-medium leading-tight tracking-[-0.01em] text-[#171717]">
          {title}{info && <InfoTip label={`About ${title}`}>{info}</InfoTip>}
        </h1>
        {description && <p className="mt-1 text-[12px] text-[#6B6B66]">{description}</p>}
      </div>
      {actions && <div className={cx('flex flex-wrap items-center gap-2', actionsFull && 'w-full sm:w-auto')}>{actions}</div>}
    </header>
  )
}

export function AdminSectionHeader({
  title, description, info, actions,
}: { title: string; description?: string; info?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h2 className="flex items-center gap-1 text-[13px] font-medium text-[#171717]">
          {title}{info && <InfoTip label={`About ${title}`}>{info}</InfoTip>}
        </h2>
        {description && <p className="mt-0.5 text-[11px] text-[#6B6B66]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function AdminCard({
  children, className = '', padded = true,
}: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('min-w-0 max-w-full rounded-[14px] border border-black/[0.08] bg-white', padded && 'p-4 sm:p-5', className)}>
      {children}
    </section>
  )
}

// ── Buttons ───────────────────────────────────────────────────────────────────

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
type BtnSize = 'sm' | 'md'
const BTN_BASE = 'inline-flex items-center justify-center gap-1.5 rounded-[9px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 disabled:cursor-not-allowed disabled:opacity-50'
// 40px tall on touch screens, 32/36px from the sm breakpoint up.
const BTN_SIZES: Record<BtnSize, string> = { sm: 'h-10 px-3 text-[11px] sm:h-8', md: 'h-10 px-4 text-[12px] sm:h-9' }
const BTN_VARIANTS: Record<BtnVariant, string> = {
  primary:   'bg-[#171717] text-white hover:bg-black',
  secondary: 'border border-black/[0.12] bg-white text-[#171717] hover:bg-black/[0.03]',
  danger:    'border border-[#B91C1C]/30 bg-white text-[#B91C1C] hover:bg-[#FEF2F2]',
  ghost:     'text-[#4A4A46] hover:bg-black/[0.05]',
}
/** Class string for anchors/links that should look like an AdminButton. */
export const adminButtonClass = (variant: BtnVariant = 'secondary', size: BtnSize = 'md', extra = '') =>
  cx(BTN_BASE, BTN_SIZES[size], BTN_VARIANTS[variant], extra)

export function AdminButton({
  variant = 'secondary', size = 'md', loading, className = '', children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize; loading?: boolean }) {
  return (
    <button type="button" {...rest} disabled={disabled || loading} aria-busy={loading || undefined}
      className={adminButtonClass(variant, size, className)}>
      {loading ? 'Working…' : children}
    </button>
  )
}

// ── Notices (always visible; never inside a tooltip) ──────────────────────────

type Tone = 'info' | 'success' | 'warning' | 'danger'
const NOTICE: Record<Tone, string> = {
  info:    'border-black/[0.10] bg-[#FAFAF8] text-[#3A3A38]',
  success: 'border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]',
  warning: 'border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]',
  danger:  'border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]',
}
export function AdminNotice({ tone = 'info', title, children, className = '' }: {
  tone?: Tone; title?: string; children?: ReactNode; className?: string
}) {
  return (
    <div role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cx('rounded-[10px] border px-3.5 py-2.5 text-[12px] leading-[1.5]', NOTICE[tone], className)}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
    </div>
  )
}

// ── Fields ────────────────────────────────────────────────────────────────────

export function AdminField({ label, htmlFor, info, hint, error, children, className = '' }: {
  label: string; htmlFor?: string; info?: ReactNode; hint?: string; error?: string | null
  children: ReactNode; className?: string
}) {
  return (
    <div className={cx("w-full min-w-0 max-w-full", className)}>
      <label htmlFor={htmlFor} className="mb-1 flex min-h-[18px] items-center gap-0.5 text-[11px] font-medium leading-[1.3] text-[#4A4A46]">
        {label}{info && <span className="-my-1.5 inline-flex"><InfoTip label={`About ${label}`}>{info}</InfoTip></span>}
      </label>
      {children}
      {error ? <p role="alert" className="mt-1 text-[11px] text-[#B91C1C]">{error}</p>
             : hint ? <p className="mt-1 text-[11px] text-[#8A8A85]">{hint}</p> : null}
    </div>
  )
}

/** Shared form grid: equal tracks, 14/16px gutters, container-aware columns (1 → 2 → `cols`). Use `className="kv-span-all"` for full-width children. */
export function AdminFieldGrid({ cols = 3, children, className = '' }: { cols?: 2 | 3 | 4; children: ReactNode; className?: string }) {
  // An incomplete last row stretches its final field across the free tracks (no empty slot beside it). Skipped when a child
  // opts into kv-span-all, since the row arithmetic is then ambiguous.
  const kids = Children.toArray(children).filter(Boolean)
  const manual = kids.some(k => typeof k === 'object' && k !== null && 'props' in k && String((k as { props?: { className?: string } }).props?.className ?? '').includes('kv-span-all'))
  const span = (k: number) => (manual || kids.length % k === 0 ? 1 : k - (kids.length % k) + 1)
  const style = {
    ['--kv-cols' as string]: cols,
    ['--kv-span-2' as string]: span(2),
    ['--kv-span-mid' as string]: span(Math.min(cols, 3)),
    ['--kv-span-wide' as string]: span(cols),
  } as CSSProperties
  return (
    <div className={cx('kv-field-wrap', className)}>
      <div className="kv-field-grid" style={style}>{children}</div>
    </div>
  )
}

export const adminInputClass =
  'box-border h-10 w-full min-w-0 max-w-full rounded-[9px] border border-black/[0.14] bg-white px-3 text-[12px] text-[#171717] placeholder:text-[#A5A5A0] focus:border-[#171717] focus:outline-none focus:ring-1 focus:ring-[#171717] disabled:bg-black/[0.03] disabled:text-[#8A8A85] sm:h-9'
/** Native <select> — same height and border as inputs. */
export const adminSelectClass = adminInputClass + ' pr-8'
export const adminTextareaClass =
  'box-border w-full min-w-0 max-w-full rounded-[9px] border border-black/[0.14] bg-white px-3 py-2 text-[12px] leading-[1.5] text-[#171717] placeholder:text-[#A5A5A0] focus:border-[#171717] focus:outline-none focus:ring-1 focus:ring-[#171717] disabled:bg-black/[0.03] disabled:text-[#8A8A85]'
export const adminCheckboxClass = 'h-4 w-4 rounded border-black/[0.3] accent-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40'

// ── Status vocabulary ─────────────────────────────────────────────────────────
// ONE vocabulary across the Admin. Text is always rendered (no color-only meaning).

export const STATUS_TONES = {
  Live: 'success', Active: 'success', Paid: 'success', Fulfilled: 'success', Reconciled: 'success',
  Approved: 'success', Verified: 'success', Ready: 'success', Recovered: 'success', Released: 'success', Sent: 'success',
  Draft: 'neutral', Inactive: 'neutral', Archived: 'neutral', Unfulfilled: 'neutral', Open: 'neutral', Cancelled: 'neutral',
  Scheduled: 'info', Processing: 'info', Queued: 'info', Refunded: 'info', Resolved: 'info',
  Pending: 'warning', Incomplete: 'warning', Unknown: 'warning', Held: 'warning', Review: 'warning', Partial: 'warning',
  Exception: 'danger', Failed: 'danger', Unresolved: 'danger', Rejected: 'danger', Suspended: 'danger', Terminated: 'danger',
} as const
export type StatusLabel = keyof typeof STATUS_TONES

const BADGE: Record<'success' | 'neutral' | 'info' | 'warning' | 'danger', string> = {
  success: 'border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]',
  neutral: 'border-black/[0.10] bg-[#F5F5F3] text-[#4A4A46]',
  info:    'border-[#BFDBFE] bg-[#EFF6FF] text-[#1E40AF]',
  warning: 'border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]',
  danger:  'border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]',
}
export function StatusBadge({ status, label }: { status: StatusLabel; label?: string }) {
  return (
    <span className={cx('inline-flex items-center rounded-full border px-2 py-[2px] text-[10px] font-medium uppercase tracking-[0.06em]', BADGE[STATUS_TONES[status]])}>
      {label ?? status}
    </span>
  )
}

/** Small neutral/toned label for things that are NOT workflow states (e.g. "Contact form", "3 new"). */
export function AdminTag({ tone = 'neutral', children, label }: {
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'dark'; children: ReactNode; label?: string
}) {
  const cls = tone === 'dark' ? 'border-[#171717] bg-[#171717] text-white' : BADGE[tone]
  return (
    <span aria-label={label} className={cx('inline-flex items-center rounded-full border px-2 py-[1px] text-[10px] font-medium', cls)}>
      {children}
    </span>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
// Label + value + optional sub-line. `flag` is a VISIBLE warning line (Partial / Unknown /
// Incomplete); it is never tucked into the tooltip. `info` carries the definition.

const STAT_TONE = { default: 'text-[#171717]', positive: 'text-[#047857]', negative: 'text-[#B91C1C]', muted: 'text-[#6B6B66]', warning: 'text-[#92400E]' } as const
export function AdminStat({ label, value, sub, tone = 'default', info, flag, className = '' }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: keyof typeof STAT_TONE
  info?: ReactNode; flag?: ReactNode; className?: string
}) {
  return (
    <div className={cx('min-w-0 rounded-[14px] border border-black/[0.08] bg-white px-3.5 py-3 sm:px-4 sm:py-3.5', className)}>
      <p className="flex min-h-[16px] items-center gap-0.5 text-[10px] font-medium uppercase leading-4 tracking-[0.1em] text-[#8A8A85]">
        <span className="min-w-0">{label}</span>{info && <span className="-my-2 flex shrink-0"><InfoTip label={`About ${label}`}>{info}</InfoTip></span>}
      </p>
      <p className={cx('mt-1 break-words text-[18px] sm:mt-1.5 sm:text-[20px] font-medium leading-tight tracking-[-0.01em]', STAT_TONE[tone])}>{value}</p>
      {sub && <p className="mt-1 text-[11px] text-[#6B6B66]">{sub}</p>}
      {flag && <p className="mt-1 text-[11px] font-medium text-[#92400E]">{flag}</p>}
    </div>
  )
}
/** Largest divisor of n that is <= max (and >= 2); falls back to an even split so no card is left alone. */
function balancedCols(n: number, max: number): number {
  if (n <= 1) return 1
  if (n <= max) return n
  for (let d = max; d >= 2; d--) if (n % d === 0) return d
  return Math.ceil(n / Math.ceil(n / max))
}
/**
 * Responsive, balanced grid for stat cards. Columns are derived from the number of cards so there is never an
 * orphan row: 6 cards → 6 across on wide containers, 3+3 mid, 2+2+2 narrow; 12 → 6+6 / 4+4+4 / 2×6.
 * `maxCols` caps the widest layout, `midCols` caps the mid layout. `min` is kept for call-site compatibility only.
 */
export function AdminStatGrid({ children, maxCols = 6, midCols = 4, className = '' }: {
  children: ReactNode; min?: number; maxCols?: number; midCols?: number; className?: string
}) {
  const n = Children.toArray(children).filter(Boolean).length
  const lg = balancedCols(n, maxCols)
  const md = balancedCols(n, Math.min(midCols, lg))
  return (
    <div className={cx('kv-stat-wrap', className)}>
      <div className="kv-stat-grid" style={{ ['--kv-lg' as string]: lg, ['--kv-md' as string]: md, ['--kv-span-lg' as string]: n % lg ? lg - (n % lg) + 1 : 1, ['--kv-span-md' as string]: n % md ? md - (n % md) + 1 : 1 } as CSSProperties}>
        {children}
      </div>
    </div>
  )
}

// ── Segmented control (range pickers, view switches) ──────────────────────────

export function AdminSegmented<T extends string>({ options, value, onChange, ariaLabel }: {
  options: ReadonlyArray<{ id: T; label: string }>; value: T; onChange: (id: T) => void; ariaLabel: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex w-full min-w-0 flex-nowrap items-center justify-between gap-0.5 rounded-[10px] border border-black/[0.10] bg-white p-0.5 sm:inline-flex sm:min-h-9 sm:w-auto sm:flex-wrap sm:justify-start sm:gap-1">
      {options.map(o => {
        const active = o.id === value
        return (
          <button key={o.id} type="button" aria-pressed={active} onClick={() => onChange(o.id)} aria-label={o.label}
            className={cx('h-9 min-w-0 flex-1 whitespace-nowrap rounded-[8px] px-1.5 text-[10px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 sm:h-[30px] sm:flex-none sm:px-3 sm:text-[12px]',
              active ? 'bg-[#171717] text-white' : 'text-[#4A4A46] hover:bg-black/[0.05]')}>
            <span className="sm:hidden">{ariaLabel === 'Date range' ? ({ Today: 'Today', '7 days': '7d', '30 days': '30d', 'Month to date': 'MTD', 'Year to date': 'YTD' } as Record<string,string>)[o.label] ?? o.label : o.label}</span>
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Compact expandable help (for several related notes; warnings do NOT belong here) ──

export function AdminDisclosure({ summary, children, className = '' }: { summary: string; children: ReactNode; className?: string }) {
  return (
    <details className={cx('group rounded-[10px] border border-black/[0.08] bg-white', className)}>
      <summary className="flex min-h-[40px] cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2 text-[12px] font-medium text-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 [&::-webkit-details-marker]:hidden">
        {summary}
        <span aria-hidden="true" className="text-[#8A8A85] transition-transform group-open:rotate-180">⌄</span>
      </summary>
      <div className="border-t border-black/[0.06] px-3.5 py-3 text-[12px] leading-[1.55] text-[#3A3A38]">{children}</div>
    </details>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

/**
 * ONE tab control for the whole Admin: a rounded pill strip. Labels never shrink or overlap (every pill is `shrink-0`
 * with an explicit min-width:auto); when they do not fit the strip scrolls horizontally with edge fades as the
 * affordance, the active tab is kept in view, and arrow/Home/End keyboard navigation + focus rings are kept.
 */
export function AdminTabs<T extends string>({ tabs, value, onChange, ariaLabel }: {
  tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void; ariaLabel: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const scroller = useRef<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const measure = () => {
    const el = scroller.current
    if (!el) return
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 })
  }
  useEffect(() => {
    measure()
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs.length])
  useEffect(() => {
    const i = tabs.findIndex(t => t.id === value)
    const el = refs.current[i]
    const box = scroller.current
    if (!el || !box) return
    const l = el.offsetLeft, r = l + el.offsetWidth
    if (l < box.scrollLeft + 8) box.scrollTo({ left: Math.max(0, l - 12), behavior: 'smooth' })
    else if (r > box.scrollLeft + box.clientWidth - 8) box.scrollTo({ left: r - box.clientWidth + 12, behavior: 'smooth' })
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const onKeyDown = (e: ReactKeyboardEvent, i: number) => {
    const last = tabs.length - 1
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
      : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1
    if (next < 0) return
    e.preventDefault()
    refs.current[next]?.focus()
    onChange(tabs[next].id)
  }
  return (
    <div className="kv-tabs relative mb-4 min-w-0 max-w-full" data-left={edges.left || undefined} data-right={edges.right || undefined}>
      <div ref={scroller} onScroll={measure} role="tablist" aria-label={ariaLabel}
        className="kv-tabs-strip flex gap-1.5 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t, i) => {
          const active = t.id === value
          return (
            <button key={t.id} type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
              ref={el => { refs.current[i] = el }} onKeyDown={e => onKeyDown(e, i)} onClick={() => onChange(t.id)}
              className={cx('inline-flex h-10 min-w-max shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-4 text-[12px] font-medium leading-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 focus-visible:ring-offset-1 sm:h-9',
                active ? 'border-[#171717] bg-[#171717] text-white' : 'border-black/[0.10] bg-white text-[#4A4A46] hover:border-black/25 hover:text-[#171717]')}>
              {t.label}{typeof t.count === 'number' && <span className={cx('ml-1.5 text-[10px]', active ? 'text-white/70' : 'text-[#8A8A85]')}>{t.count}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

/**
 * Contained horizontal scroll for wide tables.
 *
 * `relative` is load-bearing (root cause of the Admin Shipping "black right strip", measured in
 * qa/admin-responsive): `.sr-only` is position:absolute, and an overflow:auto box is NOT the
 * containing block for absolutely-positioned descendants unless it is itself positioned. Without
 * it, the sr-only caption / "Notes" / "Save" header text sat at its static position at the table's
 * far-right edge (~x=637) OUTSIDE this scroller's clip, so it widened the DOCUMENT's scrollable
 * overflow. Mobile browsers then shrink the layout viewport to fit (iOS zooms out); the admin shell
 * stays one phone-width wide and the dark html/body background shows to its right. `relative` makes
 * this scroller the containing block, so those boxes are clipped and scroll with the table.
 */
const StackCtx = createContext(false)

/**
 * `stack` (opt-in): below 640px every row becomes a labelled card (label on the left, value on
 * the right) so the operator reads the data without swiping. NOTHING is hidden: every cell
 * stays, header labels move onto the cells (`label`), and the wide-table scroller remains as a
 * safety net. From 640px up it is the normal table. Use AdminTr/AdminTd/AdminTh inside.
 * Explicit ARIA roles keep table semantics when CSS changes the display type.
 */
/**
 * Copy each column header's text onto the cells of that column (`data-label`) so the stacked cards can show it.
 * Cells that already carry a label (an explicit `label` prop) and full-width cells (colSpan > 1: empty/detail rows) are left alone.
 * Idempotent; safe to run after every DOM change.
 */
export function labelStackCells(table: HTMLTableElement): void {
  const headRow = table.tHead?.rows[table.tHead.rows.length - 1]
  if (!headRow) return
  const labels: string[] = []
  for (const th of Array.from(headRow.cells)) {
    const text = (th.textContent ?? '').replace(/\s+/g, ' ').trim()
    for (let i = 0; i < Math.max(1, th.colSpan); i++) labels.push(text)
  }
  for (const body of Array.from(table.tBodies)) {
    for (const tr of Array.from(body.rows)) {
      let col = 0
      for (const td of Array.from(tr.cells)) {
        const auto = td.getAttribute('data-auto-label') === '1'
        if (td.colSpan <= 1 && (auto || !td.hasAttribute('data-label'))) {
          const l = labels[col]
          if (l) { if (td.getAttribute('data-label') !== l) td.setAttribute('data-label', l); td.setAttribute('data-auto-label', '1') }
          else if (auto) { td.removeAttribute('data-label'); td.removeAttribute('data-auto-label') }
        }
        // Long values (product names, emails, provider refs) and anything interactive take the full card width; short values pair up two per row.
        const wide = col === 0 || (td.textContent ?? '').trim().length > 18 || td.querySelector('button, a, input, select, textarea, form') !== null
        if (wide !== td.hasAttribute('data-wide')) { if (wide) td.setAttribute('data-wide', '1'); else td.removeAttribute('data-wide') }
        col += Math.max(1, td.colSpan)
      }
    }
  }
}

export function AdminTable({ children, caption, minWidth = 560, stack = false }: { children: ReactNode; caption?: string; minWidth?: number; stack?: boolean }) {
  const tableRef = useRef<HTMLTableElement>(null)
  useEffect(() => {
    const t = tableRef.current
    if (!stack || !t) return
    labelStackCells(t)
    if (typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => labelStackCells(t))   // rows arrive after the data loads; attribute writes do not re-trigger it
    mo.observe(t, { childList: true, subtree: true, characterData: true })
    return () => mo.disconnect()
  }, [stack])
  return (
    <div className="relative w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-[12px] border border-black/[0.08] bg-white" tabIndex={0} role="region" aria-label={caption ? `${caption} (scrollable)` : 'Scrollable table'}>
      <StackCtx.Provider value={stack}>
        <table
          ref={tableRef}
          role={stack ? 'table' : undefined}
          className={cx('w-full border-collapse text-left text-[12px]', stack && 'kv-stack')}
          style={{ minWidth }}>
          {caption && <caption className="sr-only">{caption}</caption>}
          {children}
        </table>
      </StackCtx.Provider>
    </div>
  )
}
export function AdminTr({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const stack = useContext(StackCtx)
  return <tr role={stack ? 'row' : undefined} onClick={onClick} className={className}>{children}</tr>
}
export const AdminTh = ({ children, className = '', info }: { children?: ReactNode; className?: string; info?: ReactNode }) => {
  const stack = useContext(StackCtx)
  return (
    <th scope="col" role={stack ? 'columnheader' : undefined} className={cx('whitespace-nowrap border-b border-black/[0.08] bg-[#FAFAF8] px-3 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#8A8A85]', className)}>
      {children}{info && <InfoTip label={`About ${typeof children === 'string' ? children : 'this column'}`}>{info}</InfoTip>}
    </th>
  )
}
export const AdminTd = ({ children, className = '', colSpan, label }: { children?: ReactNode; className?: string; colSpan?: number; label?: string }) => {
  const stack = useContext(StackCtx)
  return (
    <td colSpan={colSpan} role={stack ? 'cell' : undefined} data-label={stack ? label : undefined}
      className={cx('border-b border-black/[0.05] px-3 py-2.5 align-top text-[#171717]', className)}>{children}</td>
  )
}

// ── Empty / loading / error ───────────────────────────────────────────────────

export function AdminEmpty({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="rounded-[12px] border border-dashed border-black/[0.14] bg-white px-4 py-8 text-center">
      <p className="text-[13px] font-medium text-[#171717]">{title}</p>
      {description && <p className="mt-1 text-[12px] text-[#6B6B66]">{description}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}
export function AdminLoading({ label = 'Loading…' }: { label?: string }) {
  return <div role="status" aria-live="polite" className="px-1 py-6 text-[12px] text-[#8A8A85]">{label}</div>
}
export function AdminError({ message = 'Try again in a moment.', onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <AdminNotice tone="danger" title="Couldn’t load this data.">
      <span>{message}</span>
      {onRetry && <> <button type="button" onClick={onRetry} className="min-h-[24px] font-medium underline underline-offset-2">Retry</button></>}
    </AdminNotice>
  )
}

// ── Confirm (destructive actions: warning text stays VISIBLE in the dialog body) ──

export interface ConfirmOptions { confirmLabel?: string; cancelLabel?: string; title?: string; tone?: 'danger' | 'primary' }

export function useConfirm() {
  const [state, setState] = useState<null | { message: string; opts: ConfirmOptions; resolve: (v: boolean) => void }>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirm = (message: string, opts: ConfirmOptions = {}) =>
    new Promise<boolean>(resolve => setState({ message, opts, resolve }))
  const close = (v: boolean) => { state?.resolve(v); setState(null) }

  useEffect(() => {
    if (!state) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { state.resolve(false); setState(null) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state])

  const node = state ? (
    <div role="alertdialog" aria-modal="true" aria-label={state.opts.title ?? 'Confirm action'}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[380px] rounded-[14px] bg-white p-5 shadow-xl">
        {state.opts.title && <p className="mb-1 text-[13px] font-medium text-[#171717]">{state.opts.title}</p>}
        <p className="text-[13px] leading-[1.5] text-[#171717]">{state.message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={() => close(false)} className={adminButtonClass('secondary', 'md')}>
            {state.opts.cancelLabel ?? 'Cancel'}
          </button>
          <AdminButton variant={state.opts.tone === 'primary' ? 'primary' : 'danger'} onClick={() => close(true)}>
            {state.opts.confirmLabel ?? 'Confirm'}
          </AdminButton>
        </div>
      </div>
    </div>
  ) : null
  return { confirm, node }
}
