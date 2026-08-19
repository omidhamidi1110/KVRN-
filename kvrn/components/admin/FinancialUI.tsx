'use client'
// components/admin/FinancialUI.tsx
// Shared presentation primitives for the Phase B financial admin.
//
// THE MOST IMPORTANT RULE HERE: a null cost is rendered as "Pending" or
// "Not recorded", NEVER as "$0.00". Displaying an unreconciled cost as zero would
// show a confident, wrong profit number. Every formatter below enforces that.

import React from 'react'

export const FONT   = '-apple-system, Helvetica Neue, Arial, sans-serif'
export const BORDER = '1px solid #E8E5E0'

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
  label, value, sub, tone = 'default', pending,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'positive' | 'negative' | 'muted'
  pending?: boolean
}) {
  const color =
    tone === 'positive' ? '#047857' :
    tone === 'negative' ? '#B91C1C' :
    tone === 'muted'    ? '#6B6B6B' : '#1A1A1A'

  return (
    <div style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
      <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                  textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>
        {label}
      </p>
      <p style={{ fontFamily: FONT, fontSize: 22, fontWeight: 500, color,
                  margin: '6px 0 0', letterSpacing: '-0.01em' }}>
        {value}
      </p>
      {sub && (
        <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '4px 0 0' }}>
          {sub}
        </p>
      )}
      {pending && (
        <p style={{ fontFamily: FONT, fontSize: 10, color: '#92400E', margin: '4px 0 0' }}>
          Partial — some costs not yet reconciled
        </p>
      )}
    </div>
  )
}

// ── Reconciliation badge ─────────────────────────────────────────────────────

export function ReconciliationBadge({
  state, missing,
}: {
  state: 'complete' | 'partial' | 'unknown'
  missing?: Array<{ field: string; label: string }>
}) {
  const map = {
    complete: { bg: '#F0FDF4', border: '#BBF7D0', color: '#166534', text: 'Reconciled' },
    partial:  { bg: '#FFFBEB', border: '#FDE68A', color: '#92400E', text: 'Partial' },
    unknown:  { bg: '#F9FAFB', border: '#E5E7EB', color: '#6B7280', text: 'Unreconciled' },
  }[state]

  const title = missing && missing.length > 0
    ? `Missing: ${missing.map(m => m.label).join(', ')}`
    : undefined

  return (
    <span title={title}
      style={{ display: 'inline-block', fontFamily: FONT, fontSize: 9,
               letterSpacing: '0.08em', textTransform: 'uppercase',
               padding: '3px 8px', background: map.bg,
               border: `1px solid ${map.border}`, color: map.color }}>
      {map.text}
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
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {RANGE_OPTIONS.map(o => (
        <button key={o.value} onClick={() => onRange(o.value)}
          style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.04em',
                   padding: '7px 12px', cursor: 'pointer',
                   border: range === o.value ? '1px solid #1A1A1A' : BORDER,
                   background: range === o.value ? '#1A1A1A' : '#fff',
                   color: range === o.value ? '#fff' : '#1A1A1A' }}>
          {o.label}
        </button>
      ))}
      <span style={{ width: 1, height: 22, background: '#E8E5E0', margin: '0 4px' }} />
      <input type="date" value={custom.start}
        onChange={e => onCustom({ ...custom, start: e.target.value })}
        style={{ fontFamily: FONT, fontSize: 11, padding: '6px 8px', border: BORDER }} />
      <span style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B' }}>to</span>
      <input type="date" value={custom.end}
        onChange={e => onCustom({ ...custom, end: e.target.value })}
        style={{ fontFamily: FONT, fontSize: 11, padding: '6px 8px', border: BORDER }} />
      <button onClick={() => onRange('custom')}
        disabled={!custom.start || !custom.end}
        style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.04em',
                 padding: '7px 12px',
                 cursor: custom.start && custom.end ? 'pointer' : 'default',
                 border: range === 'custom' ? '1px solid #1A1A1A' : BORDER,
                 background: range === 'custom' ? '#1A1A1A' : '#fff',
                 color: range === 'custom' ? '#fff' : '#1A1A1A',
                 opacity: custom.start && custom.end ? 1 : 0.45 }}>
        Apply
      </button>
    </div>
  )
}

export function SectionTitle({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h2 style={{ fontFamily: FONT, fontSize: 11, fontWeight: 600,
                   letterSpacing: '0.12em', textTransform: 'uppercase',
                   color: '#1A1A1A', margin: 0 }}>
        {children}
      </h2>
      {note && (
        <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '4px 0 0' }}>
          {note}
        </p>
      )}
    </div>
  )
}

export function buildQuery(range: string, custom: { start: string; end: string }): string {
  if (range === 'custom' && custom.start && custom.end) {
    return `?start=${custom.start}&end=${custom.end}`
  }
  return `?range=${range}`
}
