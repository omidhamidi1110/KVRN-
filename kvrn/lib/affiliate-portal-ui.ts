// lib/affiliate-portal-ui.ts — pure UI helpers for the affiliate portal (no React, no DOM at import time),
// so the logic is unit-testable without a browser.

// ── money ────────────────────────────────────────────────────────────────────
/** Unknown money is shown as an em dash — NEVER as $0.00. */
export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—'
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const sym = currency === 'USD' ? '$' : `${currency} `
  return `${sign}${sym}${dollars}.${String(abs % 100).padStart(2, '0')}`
}

// ── labels ───────────────────────────────────────────────────────────────────
export const SALE_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending', available: 'Available', in_payout: 'In payout', paid: 'Paid', reversed: 'Reversed', under_review: 'Under review',
}
export const REVERSAL_LABEL: Record<string, string> = { none: '', partial: 'Partly reversed', full: 'Reversed', under_review: 'Under review' }
export const PAYOUT_STATUS_LABEL: Record<string, string> = { processing: 'Processing', paid: 'Paid', failed: 'Failed', cancelled: 'Cancelled' }
export const READINESS_LABEL: Record<string, string> = {
  not_started: 'Not started', pending: 'In review', verified: 'Verified', complete: 'Complete', ready: 'Ready', problem: 'Needs attention', failed: 'Needs attention',
}
export type Tone = 'good' | 'warn' | 'bad' | 'muted'
export function toneForStatus(s: string | null | undefined): Tone {
  switch (s) {
    case 'paid': case 'verified': case 'complete': case 'ready': case 'available': return 'good'
    case 'pending': case 'processing': case 'in_payout': case 'under_review': return 'warn'
    case 'failed': case 'problem': case 'reversed': return 'bad'
    default: return 'muted'
  }
}
export const labelFor = (map: Record<string, string>, v: string | null | undefined) => (v && map[v]) || (v ? v.replace(/_/g, ' ') : '—')

// ── sign-in link ─────────────────────────────────────────────────────────────
/** Reads `#t=<token>` from location.hash. Returns null for anything that is not a plausible token. */
export function extractFragmentToken(hash: string | null | undefined): string | null {
  if (!hash) return null
  const m = /^#?(?:.*&)?t=([A-Za-z0-9_-]{43})(?:&.*)?$/.exec(hash)
  return m ? m[1] : null
}

// ── CSRF ─────────────────────────────────────────────────────────────────────
export function readCookie(cookieString: string, name: string): string | null {
  for (const part of cookieString.split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null
  }
  return null
}

// ── access banner ────────────────────────────────────────────────────────────
export function accessBanner(me: { readOnly: boolean; accessReason: string; requiresReacceptance: boolean } | null):
  { tone: Tone; text: string } | null {
  if (!me) return null
  if (me.accessReason === 'suspended') return { tone: 'bad', text: 'Your affiliate account is suspended. You can view your history and statements, but cannot make changes.' }
  if (me.accessReason === 'terminated') return { tone: 'bad', text: 'Your affiliate account has ended. You can view your history and statements.' }
  if (me.readOnly) return { tone: 'warn', text: 'Your portal is in view-only mode. Contact support if you need changes.' }
  if (me.requiresReacceptance) return { tone: 'warn', text: 'Updated program terms need your acceptance to keep receiving payouts. Your sales are still tracked.' }
  return null
}

// ── onboarding checklist ─────────────────────────────────────────────────────
export interface OnboardingLike {
  readiness: { identity: string; tax: string; payoutMethod: string }
  terms: { requiresReacceptance: boolean; documents: Array<{ needsAcceptance: boolean }> }
}
export function setupSteps(o: OnboardingLike | null): Array<{ id: string; label: string; done: boolean; status: string }> {
  if (!o) return []
  const pendingDocs = o.terms.requiresReacceptance || o.terms.documents.some(d => d.needsAcceptance)
  return [
    { id: 'terms', label: 'Accept program terms', done: !pendingDocs, status: pendingDocs ? 'pending' : 'complete' },
    { id: 'identity', label: 'Identity verification', done: o.readiness.identity === 'verified', status: o.readiness.identity },
    { id: 'tax', label: 'Tax information', done: o.readiness.tax === 'complete', status: o.readiness.tax },
    { id: 'payout', label: 'Payout method', done: o.readiness.payoutMethod === 'ready', status: o.readiness.payoutMethod },
  ]
}

// ── safe markdown-lite (documents) ───────────────────────────────────────────
// Produces DATA, never HTML. React renders text nodes, so nothing in a document can inject markup or script.
export type Inline = { t: 'text'; v: string } | { t: 'bold'; v: string } | { t: 'link'; v: string; href: string }
export type Block =
  | { t: 'h'; level: 1 | 2 | 3; inline: Inline[] }
  | { t: 'p'; inline: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }

const SAFE_LINK = /^https:\/\/[^\s<>"']+$/i

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  const re = /\*\*([^*]{1,500})\*\*|\[([^\]]{1,200})\]\((https:\/\/[^)\s]{1,500})\)/g   // bounded: linear-time on hostile input
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: 'bold', v: m[1] })
    else if (SAFE_LINK.test(m[3])) out.push({ t: 'link', v: m[2], href: m[3] })
    else out.push({ t: 'text', v: m[0] })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) })
  return out
}

export function parseMarkdownLite(src: string): Block[] {
  const blocks: Block[] = []
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null
  const flushPara = () => { if (para.length) { blocks.push({ t: 'p', inline: parseInline(para.join(' ')) }); para = [] } }
  const flushList = () => { if (list) { blocks.push({ t: list.kind, items: list.items.map(parseInline) }); list = null } }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') { flushPara(); flushList(); continue }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) { flushPara(); flushList(); blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3, inline: parseInline(h[2]) }); continue }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushPara()
      const kind = ul ? 'ul' : 'ol'
      if (list && list.kind !== kind) flushList()
      if (!list) list = { kind, items: [] }
      list.items.push((ul ?? ol)![1])
      continue
    }
    flushList(); para.push(line.trim())
  }
  flushPara(); flushList()
  return blocks
}

// ── client fetch ─────────────────────────────────────────────────────────────
export interface ApiResult<T = any> { ok: boolean; status: number; data: T | null; error: string | null }

/** Same-origin JSON call. Adds the CSRF header from the script-readable cookie for state-changing requests. */
export async function portalFetch<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json'
    const csrf = typeof document !== 'undefined' ? readCookie(document.cookie, 'kvrn_aff_csrf') : null
    if (csrf) headers['x-kvrn-csrf'] = csrf
  }
  try {
    const res = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    let data: any = null
    try { data = await res.json() } catch { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data?.error ?? data?.message ?? 'Something went wrong.') }
  } catch {
    return { ok: false, status: 0, data: null, error: 'Network problem. Check your connection and try again.' }
  }
}
