// lib/affiliate-program-ui.ts — PURE helpers for the Admin affiliate screens (client-safe, unit-tested).
// Money entered in the UI is converted to integer cents / basis points here ONCE, then validated again
// on the server and in SQL. Nothing here calculates a commission.

import type { StatusLabel } from '@/components/admin/ui/AdminUI'

export const AFFILIATE_TAB_IDS = [
  'overview', 'applications', 'affiliates', 'commissions', 'payouts', 'unresolved', 'compliance', 'readiness', 'terms', 'audit',
] as const
export type AffiliateTabId = typeof AFFILIATE_TAB_IDS[number]

export function affiliateTabs(counts: { openApplications?: number; unresolved?: number; reacceptance?: number }): Array<{ id: AffiliateTabId; label: string; count?: number }> {
  const c = (n?: number) => (n && n > 0 ? n : undefined)
  return [
    { id: 'overview', label: 'Overview' },
    { id: 'applications', label: 'Applications', count: c(counts.openApplications) },
    { id: 'affiliates', label: 'Affiliates' },
    { id: 'commissions', label: 'Commissions' },
    { id: 'payouts', label: 'Payouts' },
    { id: 'unresolved', label: 'Unresolved', count: c(counts.unresolved) },
    { id: 'compliance', label: 'Compliance' },
    { id: 'readiness', label: 'Payout readiness' },
    { id: 'terms', label: 'Terms & settings', count: c(counts.reacceptance) },
    { id: 'audit', label: 'Audit' },
  ]
}

export function isAffiliateTab(v: unknown): v is AffiliateTabId {
  return typeof v === 'string' && (AFFILIATE_TAB_IDS as readonly string[]).includes(v)
}

// ── Status presentation (text is always shown; never colour-only) ────────────

export function programStatusBadge(s: string): { status: StatusLabel; label: string } {
  switch (s) {
    case 'active': return { status: 'Active', label: 'Active' }
    case 'onboarding': return { status: 'Pending', label: 'Onboarding' }
    case 'suspended': return { status: 'Suspended', label: 'Suspended' }
    case 'terminated': return { status: 'Terminated', label: 'Terminated' }
    default: return { status: 'Unknown', label: s }
  }
}

export function applicationStatusBadge(s: string): { status: StatusLabel; label: string } {
  switch (s) {
    case 'pending': return { status: 'Pending', label: 'New' }
    case 'under_review': return { status: 'Review', label: 'In review' }
    case 'needs_info': return { status: 'Held', label: 'Needs info' }
    case 'approved_onboarding': return { status: 'Approved', label: 'Approved' }
    case 'rejected': return { status: 'Rejected', label: 'Rejected' }
    case 'withdrawn': return { status: 'Inactive', label: 'Withdrawn' }
    default: return { status: 'Unknown', label: s }
  }
}

export function emailStatusBadge(s: string): { status: StatusLabel; label: string } {
  switch (s) {
    case 'sent': return { status: 'Sent', label: 'Sent' }
    case 'pending': return { status: 'Queued', label: 'Queued' }
    case 'sending': return { status: 'Processing', label: 'Sending' }
    case 'failed': return { status: 'Failed', label: 'Failed' }
    case 'held': return { status: 'Held', label: 'Held' }
    case 'skipped': return { status: 'Inactive', label: 'Skipped' }
    default: return { status: 'Unknown', label: s }
  }
}

export type ProfileAction = 'activate' | 'suspend' | 'terminate' | 'reinstate'
/** Which lifecycle actions make sense from a program status. The server enforces the rules again. */
export function availableProfileActions(programStatus: string): ProfileAction[] {
  switch (programStatus) {
    case 'onboarding': return ['activate', 'terminate']
    case 'active': return ['suspend', 'terminate']
    case 'suspended': return ['reinstate', 'terminate']
    case 'terminated': return ['reinstate']
    default: return []
  }
}

export type ApplicationAction = 'approve' | 'reject' | 'request_info' | 'under_review' | 'withdraw' | 'anonymize'
export function availableApplicationActions(status: string): ApplicationAction[] {
  switch (status) {
    case 'pending': return ['under_review', 'request_info', 'approve', 'reject', 'withdraw']
    case 'under_review': return ['request_info', 'approve', 'reject', 'withdraw']
    case 'needs_info': return ['under_review', 'approve', 'reject', 'withdraw']
    case 'rejected':
    case 'withdrawn': return ['anonymize']
    default: return []
  }
}

/** Actions that stop money-adjacent activity or remove access: always confirmed with the warning visible. */
export const PROFILE_ACTION_WARNING: Partial<Record<ProfileAction, string>> = {
  suspend: 'Suspending turns off this affiliate’s discount code and referral link right away. Orders already placed, commissions and anything owed are not changed.',
  terminate: 'Terminating turns off the code and link and ends the relationship. Commission and payout history is kept, and anything already earned or owed stays on the books.',
  reinstate: 'Reinstating turns the discount code and referral link back on.',
  activate: 'Activating turns on the discount code and referral link and makes the affiliate live.',
}

const DUP_LABELS: Record<string, string> = {
  prior_application: 'Earlier application with this email',
  similar_email_affiliate: 'Email matches an existing affiliate',
  duplicate_social: 'Social profile used in another application',
  duplicate_social_affiliate: 'Social profile belongs to an existing affiliate',
  shared_network: 'Same network as another application',
  same_name: 'Same name as another application',
  code_unavailable: 'Preferred code is not available',
}
export function duplicateFlagLabel(kind: string): string { return DUP_LABELS[kind] ?? kind.replace(/_/g, ' ') }
export function duplicateFlagTone(severity: string): 'danger' | 'warning' | 'info' {
  return severity === 'high' ? 'danger' : severity === 'medium' ? 'warning' : 'info'
}

// ── Number entry ─────────────────────────────────────────────────────────────

/** "12.5" percent -> 1250 bps. Returns null for blank, NaN for invalid. */
export function percentToBps(v: string): number | null {
  if (!v.trim()) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return NaN
  return Math.round(n * 100)
}
/** "10.00" dollars -> 1000 cents. Returns null for blank, NaN for invalid. */
export function dollarsToCents(v: string): number | null {
  if (!v.trim()) return null
  const n = Number(v.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return NaN
  return Math.round(n * 100)
}
export const bpsToPercent = (bps: number | null | undefined) => (bps == null ? '' : String(bps / 100))
export const centsToDollars = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2))

export function formatTerms(type: string, bps: number | null, fixedCents: number | null): string {
  if (type === 'percentage') return bps == null ? 'Not set' : `${(bps / 100).toFixed(2)}%`
  return fixedCents == null ? 'Not set' : `$${(fixedCents / 100).toFixed(2)} per order`
}

export interface ApprovalForm {
  code: string; commissionType: 'percentage' | 'fixed'; ratePercent: string; fixedDollars: string
  windowDays: string; holdDays: string; discountType: '' | 'percentage' | 'fixed_amount'; discountPercent: string; discountDollars: string
  payoutThresholdDollars: string; payoutSchedule: string; paidAdsPolicy: string; startAt: string; endAt: string; linkSlug: string
  activateNow: boolean; approvalMessage: string; internalNote: string
}

/** Convert the Admin form into the body the API validates. NaN is passed through so the server rejects it. */
export function approvalFormToConfig(f: ApprovalForm): Record<string, unknown> {
  const dt = (v: string) => (v ? new Date(v).toISOString() : null)
  return {
    code: f.code, commissionType: f.commissionType,
    commissionRateBps: f.commissionType === 'percentage' ? percentToBps(f.ratePercent) : null,
    commissionFixedCents: f.commissionType === 'fixed' ? dollarsToCents(f.fixedDollars) : null,
    attributionWindowDays: f.windowDays === '' ? undefined : Number(f.windowDays),
    commissionHoldDays: f.holdDays === '' ? undefined : Number(f.holdDays),
    discountType: f.discountType || null,
    discountBps: f.discountType === 'percentage' ? percentToBps(f.discountPercent) : null,
    discountCents: f.discountType === 'fixed_amount' ? dollarsToCents(f.discountDollars) : null,
    payoutThresholdCents: dollarsToCents(f.payoutThresholdDollars), payoutSchedule: f.payoutSchedule || null,
    paidAdsPolicy: f.paidAdsPolicy || 'not_permitted',
    programStartAt: dt(f.startAt), programEndAt: dt(f.endAt), linkSlug: f.linkSlug || null,
    activateNow: f.activateNow, approvalMessage: f.approvalMessage || null, internalNote: f.internalNote || null,
  }
}

/** Initial approval form: invitation proposal first, then program defaults. */
export function defaultApprovalForm(
  app: { preferredCode?: string | null; invite?: { proposedCode?: string | null; commissionType?: string | null; commissionRateBps?: number | null; commissionFixedCents?: number | null; discountType?: string | null; discountBps?: number | null; discountCents?: number | null; startAt?: string | null; endAt?: string | null } | null },
  defaults: { commissionType: 'percentage' | 'fixed'; commissionRateBps: number | null; attributionWindowDays: number; commissionHoldDays: number; payoutThresholdCents: number | null; payoutSchedule: string | null; paidAdsPolicy: string },
): ApprovalForm {
  const inv = app.invite ?? null
  const type = (inv?.commissionType === 'fixed' || inv?.commissionType === 'percentage' ? inv.commissionType : defaults.commissionType) as 'percentage' | 'fixed'
  const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '')
  return {
    code: (inv?.proposedCode || app.preferredCode || '').toUpperCase(), commissionType: type,
    ratePercent: bpsToPercent(inv?.commissionRateBps ?? defaults.commissionRateBps), fixedDollars: centsToDollars(inv?.commissionFixedCents),
    windowDays: String(defaults.attributionWindowDays), holdDays: String(defaults.commissionHoldDays),
    discountType: (inv?.discountType === 'percentage' || inv?.discountType === 'fixed_amount' ? inv.discountType : '') as ApprovalForm['discountType'],
    discountPercent: bpsToPercent(inv?.discountBps), discountDollars: centsToDollars(inv?.discountCents),
    payoutThresholdDollars: centsToDollars(defaults.payoutThresholdCents), payoutSchedule: defaults.payoutSchedule ?? '', paidAdsPolicy: defaults.paidAdsPolicy,
    startAt: day(inv?.startAt), endAt: day(inv?.endAt), linkSlug: '', activateNow: false, approvalMessage: '', internalNote: '',
  }
}

/** Plain-language list of what stops the public form from opening (shown verbatim in Admin). */
export function readinessMessage(r: { open: boolean; reasons: string[] } | null | undefined): { tone: 'success' | 'warning'; title: string; reasons: string[] } {
  if (!r) return { tone: 'warning', title: 'Status unknown', reasons: [] }
  return r.open
    ? { tone: 'success', title: 'The public application form is open.', reasons: [] }
    : { tone: 'warning', title: 'The public application form is closed.', reasons: r.reasons }
}

export const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—'
export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '—'
