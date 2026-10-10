'use client'
// components/admin/FinancialUI.tsx
// Shared presentation primitives for the Phase B financial admin.
//
// THE MOST IMPORTANT RULE HERE: a null cost is rendered as "Pending" or
// "Not recorded", NEVER as "$0.00". Displaying an unreconciled cost as zero would
// show a confident, wrong profit number. Every formatter below enforces that.

import React from 'react'
import { AdminStat, AdminSegmented, InfoTip, StatusBadge, adminInputClass, adminButtonClass } from '@/components/admin/ui/AdminUI'

export const FONT   = '-apple-system, Helvetica Neue, Arial, sans-serif'
// Hairline used by the inline-styled tables that remain; matches AdminCard's border.
export const BORDER = '1px solid rgba(0,0,0,0.08)'

/** Format integer cents as USD. */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

/**
 * Format a possibly-unknown money value.
 * null renders as the supplied placeholder — never as $0.00.
 */
export function moneyOrUnknown(cents: number | null, placeholder = 'Pending'): string {
  return cents === null || cents === undefined ? placeholder : money(cents)
}

export function pctOrDash(v: number | null): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(1)}%`
}

// ── Metric card ──────────────────────────────────────────────────────────────

export function Metric({
  label, value, sub, tone = 'default', pending, info,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'positive' | 'negative' | 'muted'
  pending?: boolean
  /** Definition / method for this figure. Warnings never go here. */
  info?: React.ReactNode
}) {
  return (
    <AdminStat label={label} value={value} sub={sub} tone={tone} info={info}
      flag={pending ? 'Partial — some costs not yet reconciled' : undefined} />
  )
}

// ── Reconciliation badge ─────────────────────────────────────────────────────
// What is missing is printed under the badge (visible), never only in a title attribute.

export function ReconciliationBadge({
  state, missing,
}: {
  state: 'complete' | 'partial' | 'unknown'
  missing?: Array<{ field: string; label: string }>
}) {
  const badge = state === 'complete'
    ? <StatusBadge status="Reconciled" />
    : state === 'partial'
      ? <StatusBadge status="Partial" />
      : <StatusBadge status="Unknown" label="Unreconciled" />
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      {badge}
      {missing && missing.length > 0 && (
        <span className="text-[11px] text-[#92400E]">Missing: {missing.map(m => m.label).join(', ')}</span>
      )}
    </span>
  )
}

// ── Range selector ───────────────────────────────────────────────────────────

export const RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '7d',    label: '7 days' },
  { value: '30d',   label: '30 days' },
  { value: 'mtd',   label: 'Month to date' },
  { value: 'ytd',   label: 'Year to date' },
] as const

export function RangePicker({
  range, onRange, custom, onCustom,
}: {
  range: string
  onRange: (r: string) => void
  custom: { start: string; end: string }
  onCustom: (c: { start: string; end: string }) => void
}) {
  const canApply = Boolean(custom.start && custom.end)
  // One aligned toolbar: [presets][start] to [end][Apply]. Every control is the same height (40px touch / 36px desktop).
  // Phones: the presets get their own compact 5-up row, then the date pair, then Apply.
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
      <div role="group" aria-label="Date range" className="grid w-full min-w-0 grid-cols-5 gap-1 sm:hidden">
        {RANGE_OPTIONS.map(o => (
          <button key={o.value} type="button" aria-label={o.label} aria-pressed={range === o.value}
            onClick={() => onRange(o.value)}
            className={`h-10 min-w-0 rounded-[9px] border px-1 text-[11px] font-medium tabular-nums ${range === o.value ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-black/[0.14] bg-white text-neutral-700'}`}>
            {({ today: 'Today', '7d': '7D', '30d': '30D', mtd: 'MTD', ytd: 'YTD' } as Record<string, string>)[o.value]}
          </button>
        ))}
      </div>
      <div className="hidden min-w-0 shrink-0 sm:block">
        <AdminSegmented ariaLabel="Date range" value={range}
          options={RANGE_OPTIONS.map(o => ({ id: o.value as string, label: o.label }))}
          onChange={onRange} />
      </div>
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:flex sm:w-auto sm:min-w-0 sm:flex-1 sm:flex-nowrap sm:justify-start">
        <input type="date" value={custom.start} aria-label="Start date"
          onChange={e => onCustom({ ...custom, start: e.target.value })}
          className={`${adminInputClass} sm:min-w-[132px] sm:max-w-[160px] sm:flex-1`} />
        <span aria-hidden="true" className="text-[11px] text-[#6B6B66]">to</span>
        <input type="date" value={custom.end} aria-label="End date"
          onChange={e => onCustom({ ...custom, end: e.target.value })}
          className={`${adminInputClass} sm:min-w-[132px] sm:max-w-[160px] sm:flex-1`} />
        <button type="button" onClick={() => onRange('custom')} disabled={!canApply}
          aria-pressed={range === 'custom'}
          className={adminButtonClass(range === 'custom' ? 'primary' : 'secondary', 'md', 'col-span-3 w-full sm:col-span-1 sm:w-auto sm:shrink-0')}>
          Apply
        </button>
      </div>
    </div>
  )
}

export function SectionTitle({ children, note, info }: {
  children: React.ReactNode
  /** Short visible line — only when it changes what the reader should do. */
  note?: string
  /** Definition / method / accounting rule, shown on demand. */
  info?: React.ReactNode
}) {
  return (
    <div className="mb-3">
      <h2 className="flex items-center gap-0.5 text-[13px] font-medium text-[#171717]">
        {children}
        {info && <InfoTip label={`About ${typeof children === 'string' ? children : 'this section'}`}>{info}</InfoTip>}
      </h2>
      {note && <p className="mt-0.5 text-[11px] text-[#6B6B66]">{note}</p>}
    </div>
  )
}

export function buildQuery(range: string, custom: { start: string; end: string }): string {
  if (range === 'custom' && custom.start && custom.end) {
    return `?start=${custom.start}&end=${custom.end}`
  }
  return `?range=${range}`
}

// ── Order integrity badge (REV2) ─────────────────────────────────────────────
// Reflects the scan's per-order integrity state, which wins over the calculator's input
// state. Green is reserved for a genuinely RECONCILED order; INCOMPLETE and EXCEPTION are
// visibly different and (when not exact) link to the Reconciliation page. The state word and
// what is missing are always visible; the longer reason sits behind an InfoTip.

export function OrderIntegrityBadge({
  text, tone, href, missing, reason,
}: {
  text: string
  tone: 'ok' | 'warn' | 'bad' | 'neutral'
  href?: string | null
  missing?: Array<{ field: string; label: string }>
  reason?: string
}) {
  const cls = {
    ok:      'border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]',
    warn:    'border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]',
    bad:     'border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]',
    neutral: 'border-black/[0.10] bg-[#F5F5F3] text-[#4A4A46]',
  }[tone]
  const badgeCls = `inline-flex items-center rounded-full border px-2 py-[2px] text-[10px] font-medium uppercase tracking-[0.06em] ${cls}`
  const hasMissing = Boolean(missing && missing.length > 0)
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="inline-flex items-center">
        {href ? <a href={href} className={`${badgeCls} underline-offset-2 hover:underline`}>{text}</a> : <span className={badgeCls}>{text}</span>}
        {reason && <InfoTip label={`About ${text}`}>{reason}</InfoTip>}
      </span>
      {hasMissing && <span className="text-[11px] text-[#92400E]">Missing: {missing!.map(m => m.label).join(', ')}</span>}
    </span>
  )
}
