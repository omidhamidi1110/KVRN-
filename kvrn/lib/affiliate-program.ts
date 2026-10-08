// lib/affiliate-program.ts — affiliate PROGRAM layer on top of the canonical financial model (020).
// Server-only. Contract exports for the affiliate-portal workstream:
//   recordAcceptance, getCurrentDocuments, getProfileByAffiliateId, getProfileByEmail.
//
// Money is never computed here. Commission, attribution and payouts stay in 020's SQL functions;
// this layer creates the identity (through create_affiliate()), manages program status, versioned
// documents and acceptances, and validates input. Every mutation is a single SQL function call that is
// atomic and audited in the database.

import { getSetting, putSetting } from './site-settings'
import { isFeatureEnabled } from './feature-flags'
import { cleanText, canonicalizeSocialUrl, normalizeEmail, isEmailShape, type SocialLink } from './affiliate-application-input'

type Sql = any

// ── Errors ──────────────────────────────────────────────────────────────────

export class ProgramError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message) }
}

const ERROR_MAP: Record<string, [number, string]> = {
  NOT_FOUND: [404, 'Not found.'],
  ACTOR_REQUIRED: [400, 'An admin identity is required.'],
  INVALID_INPUT: [400, 'Some input is not valid.'],
  INVALID_STATE: [409, 'That action is not available in the current state.'],
  CODE_TAKEN: [409, 'That code is already in use.'],
  CODE_LOCKED: [409, 'This code has been used on orders and can no longer change.'],
  LINK_SLUG_TAKEN: [409, 'That referral link name is already in use.'],
  EMAIL_ALREADY_AFFILIATE: [409, 'That email already belongs to an affiliate.'],
  INVITE_EXISTS: [409, 'An unused invite already exists for that email.'],
  INVITE_INVALID: [400, 'This invitation is not valid or has expired.'],
  COUNTRY_NOT_ALLOWED: [400, 'The program is not open in that country.'],
  AGE_ATTESTATION_REQUIRED: [400, 'You must confirm you are 18 or older.'],
  ACCURACY_CONFIRMATION_REQUIRED: [400, 'Confirm your information is accurate.'],
  ESIGN_CONSENT_REQUIRED: [400, 'Agree to use electronic signatures.'],
  DOCUMENT_VERSION_CHANGED: [409, 'The program documents changed. Reload and review them again.'],
  DOCUMENTS_UNAVAILABLE: [503, 'Applications are not available right now.'],
  ACCEPTANCES_MISSING: [409, 'The applicant’s acceptances are incomplete.'],
  ACTIVATION_NOT_ALLOWED: [409, 'This affiliate cannot be activated yet.'],
  REASON_REQUIRED: [400, 'A reason is required.'],
  MESSAGE_REQUIRED: [400, 'A message for the applicant is required.'],
  PLACEHOLDER_TEXT: [400, 'Remove the placeholder wording before publishing.'],
  ALREADY_PUBLISHED: [409, 'That version is already published.'],
  DOCUMENT_IMMUTABLE: [409, 'Published versions cannot be changed.'],
  DOCUMENT_NOT_FOUND: [404, 'That document version does not exist.'],
}

/** Convert a database exception into a safe ProgramError (null if it is not one of ours). */
export function toProgramError(err: unknown): ProgramError | null {
  const msg = String((err as any)?.message ?? '')
  const m = /KVRN_AFFPROG\|([A-Z_]+)(?:\|([^\n]*))?/.exec(msg)
  if (m) {
    const [status, text] = ERROR_MAP[m[1]] ?? [400, 'The request could not be completed.']
    const detail = m[1] === 'ACTIVATION_NOT_ALLOWED' || m[1] === 'INVALID_STATE' || m[1] === 'REASON_REQUIRED' ? (m[2] ?? '').trim() : ''
    return new ProgramError(m[1], detail ? `${text} ${capitalize(detail)}.` : text, status)
  }
  if (/affiliates_code_uq|discounts_code_uq/.test(msg)) return new ProgramError('CODE_TAKEN', ERROR_MAP.CODE_TAKEN[1], 409)
  if (/affiliate_links_slug_uq/.test(msg)) return new ProgramError('LINK_SLUG_TAKEN', ERROR_MAP.LINK_SLUG_TAKEN[1], 409)
  if (/KVRN_AFFILIATE\|/.test(msg)) return new ProgramError('AFFILIATE_RULE', 'The affiliate rules rejected that change.', 400)
  return null
}
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).replace(/\.$/, '') : s)

// ── Constants ───────────────────────────────────────────────────────────────

export const DOC_TYPES = ['program_terms', 'disclosure_policy', 'privacy_notice', 'brand_rules', 'ugc_license'] as const
export type DocType = typeof DOC_TYPES[number]
export const DOC_LABELS: Record<DocType, string> = {
  program_terms: 'Program Terms', disclosure_policy: 'Disclosure Policy', privacy_notice: 'Applicant Privacy Notice',
  brand_rules: 'Brand Rules', ugc_license: 'Content License',
}
export const PROGRAM_STATUSES = ['onboarding', 'active', 'suspended', 'terminated'] as const
export type ProgramStatus = typeof PROGRAM_STATUSES[number]
export const APPLICATION_STATUSES = ['pending', 'under_review', 'needs_info', 'approved_onboarding', 'rejected', 'withdrawn'] as const
export type ApplicationStatus = typeof APPLICATION_STATUSES[number]
export const PAYOUT_SCHEDULES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'manual'] as const
export const PAID_ADS_POLICIES = ['not_permitted', 'written_approval', 'approved'] as const

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

// ── Program settings (site_settings key `affiliate.program`) ────────────────

export const PROGRAM_SETTINGS_KEY = 'affiliate.program'

export interface ProgramSettings {
  /** ISO-3166 alpha-2 allowlist. Default U.S. only. */
  countries: string[]
  /** Staging only: lets the public form open while placeholder legal documents are current. */
  allowPlaceholderDocuments: boolean
  rateLimits: { perIpPerHour: number; perIpPerDay: number; perEmailPerDay: number; globalPerHour: number }
  inviteExpiryDays: number
  defaults: {
    commissionType: 'percentage' | 'fixed'
    commissionRateBps: number | null
    attributionWindowDays: number
    commissionHoldDays: number
    payoutThresholdCents: number | null
    payoutSchedule: string | null
    paidAdsPolicy: typeof PAID_ADS_POLICIES[number]
  }
}

export const DEFAULT_PROGRAM_SETTINGS: ProgramSettings = {
  countries: ['US'],
  allowPlaceholderDocuments: false,
  rateLimits: { perIpPerHour: 5, perIpPerDay: 15, perEmailPerDay: 3, globalPerHour: 200 },
  inviteExpiryDays: 14,
  defaults: {
    commissionType: 'percentage', commissionRateBps: null, attributionWindowDays: 30, commissionHoldDays: 30,
    payoutThresholdCents: null, payoutSchedule: null, paidAdsPolicy: 'not_permitted',
  },
}

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null

/** Merge stored JSON over defaults. Unknown or invalid fields fall back to the safe default. */
export function mergeProgramSettings(stored: unknown): ProgramSettings {
  const d = DEFAULT_PROGRAM_SETTINGS
  const s = (stored && typeof stored === 'object' ? stored : {}) as any
  const countries = Array.isArray(s.countries)
    ? Array.from(new Set(s.countries.filter((c: unknown) => typeof c === 'string' && /^[A-Za-z]{2}$/.test(c)).map((c: string) => c.toUpperCase())))
    : d.countries
  const rl = s.rateLimits ?? {}
  const df = s.defaults ?? {}
  return {
    countries: countries as string[],
    allowPlaceholderDocuments: s.allowPlaceholderDocuments === true,
    rateLimits: {
      perIpPerHour: intIn(rl.perIpPerHour, 1, 1000) ?? d.rateLimits.perIpPerHour,
      perIpPerDay: intIn(rl.perIpPerDay, 1, 5000) ?? d.rateLimits.perIpPerDay,
      perEmailPerDay: intIn(rl.perEmailPerDay, 1, 100) ?? d.rateLimits.perEmailPerDay,
      globalPerHour: intIn(rl.globalPerHour, 1, 100000) ?? d.rateLimits.globalPerHour,
    },
    inviteExpiryDays: intIn(s.inviteExpiryDays, 1, 90) ?? d.inviteExpiryDays,
    defaults: {
      commissionType: df.commissionType === 'fixed' ? 'fixed' : 'percentage',
      commissionRateBps: intIn(df.commissionRateBps, 1, 10000),
      attributionWindowDays: intIn(df.attributionWindowDays, 1, 365) ?? d.defaults.attributionWindowDays,
      commissionHoldDays: intIn(df.commissionHoldDays, 0, 365) ?? d.defaults.commissionHoldDays,
      payoutThresholdCents: intIn(df.payoutThresholdCents, 0, 100_000_000),
      payoutSchedule: (PAYOUT_SCHEDULES as readonly string[]).includes(df.payoutSchedule) ? df.payoutSchedule : null,
      paidAdsPolicy: (PAID_ADS_POLICIES as readonly string[]).includes(df.paidAdsPolicy) ? df.paidAdsPolicy : 'not_permitted',
    },
  }
}

/** Strict validation for Admin edits (reject, don't silently coerce). */
export function validateProgramSettingsInput(v: any): { ok: true; value: ProgramSettings } | { ok: false; error: string } {
  if (!v || typeof v !== 'object') return { ok: false, error: 'Settings are required.' }
  if (!Array.isArray(v.countries) || v.countries.some((c: unknown) => typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c))) {
    return { ok: false, error: 'Countries must be two-letter codes.' }
  }
  const rl = v.rateLimits ?? {}
  for (const [k, max] of [['perIpPerHour', 1000], ['perIpPerDay', 5000], ['perEmailPerDay', 100], ['globalPerHour', 100000]] as const) {
    if (intIn(rl[k], 1, max) === null) return { ok: false, error: `Rate limit "${k}" must be a whole number from 1 to ${max}.` }
  }
  if (intIn(v.inviteExpiryDays, 1, 90) === null) return { ok: false, error: 'Invite expiry must be 1–90 days.' }
  const df = v.defaults ?? {}
  if (df.commissionRateBps != null && intIn(df.commissionRateBps, 1, 10000) === null) return { ok: false, error: 'Default rate must be 1–10000 basis points.' }
  if (intIn(df.attributionWindowDays, 1, 365) === null) return { ok: false, error: 'Attribution window must be 1–365 days.' }
  if (intIn(df.commissionHoldDays, 0, 365) === null) return { ok: false, error: 'Hold must be 0–365 days.' }
  if (df.payoutThresholdCents != null && intIn(df.payoutThresholdCents, 0, 100_000_000) === null) return { ok: false, error: 'Payout threshold is not valid.' }
  if (df.payoutSchedule != null && !(PAYOUT_SCHEDULES as readonly string[]).includes(df.payoutSchedule)) return { ok: false, error: 'Payout schedule is not valid.' }
  if (!(PAID_ADS_POLICIES as readonly string[]).includes(df.paidAdsPolicy)) return { ok: false, error: 'Paid-ads policy is not valid.' }
  return { ok: true, value: mergeProgramSettings(v) }
}

export async function getProgramSettings(sql: Sql): Promise<{ settings: ProgramSettings; revision: number }> {
  const { value, revision } = await getSetting<unknown>(sql, PROGRAM_SETTINGS_KEY, {})
  return { settings: mergeProgramSettings(value), revision }
}

/** Save settings (optimistic revision; audited by putSetting). */
export async function saveProgramSettings(sql: Sql, value: ProgramSettings, expectedRevision: number, actor: string) {
  return putSetting(sql, PROGRAM_SETTINGS_KEY, value, expectedRevision, actor)
}

// ── Contract exports for affiliate-portal ───────────────────────────────────

export interface AffiliateDocument {
  id: string; docType: DocType; version: string; versionNo: number; title: string; body: string
  effectiveAt: string | null; publishedAt: string | null; isPlaceholder: boolean; materialChange: boolean; changeSummary: string | null
}
const iso = (v: any) => (v ? new Date(v).toISOString() : null)
function toDoc(r: any): AffiliateDocument {
  return {
    id: r.id, docType: r.doc_type, version: r.version, versionNo: Number(r.version_no), title: r.title, body: r.body,
    effectiveAt: iso(r.effective_at), publishedAt: iso(r.published_at), isPlaceholder: !!r.is_placeholder,
    materialChange: !!r.material_change, changeSummary: r.change_summary ?? null,
  }
}

/** The CURRENT published version of every document type. */
export async function getCurrentDocuments(sql: Sql): Promise<Partial<Record<DocType, AffiliateDocument>>> {
  const rows = await sql`
    SELECT DISTINCT ON (doc_type) * FROM affiliate_documents
     WHERE published_at IS NOT NULL AND effective_at <= now()
     ORDER BY doc_type, version_no DESC` as any[]
  const out: Partial<Record<DocType, AffiliateDocument>> = {}
  for (const r of rows) out[r.doc_type as DocType] = toDoc(r)
  return out
}

export interface AffiliateProfile {
  affiliateId: string; emailNormalized: string; displayName: string | null; applicationId: string | null
  programStatus: ProgramStatus; kycStatus: string; taxStatus: string; payoutMethodStatus: string
  payoutProvider: string | null; payoutProviderRef: string | null
  portalAccess: 'enabled' | 'read_only' | 'revoked'; paidAdsPolicy: string
  payoutThresholdCents: number | null; payoutSchedule: string | null
  country: string | null; stateRegion: string | null; socialLinks: SocialLink[]; website: string | null
  acceptedProgramTermsVersion: string | null; acceptedDisclosureVersion: string | null; requiresReacceptance: boolean
  activatedAt: string | null; suspendedAt: string | null; terminatedAt: string | null
  programStartAt: string | null; programEndAt: string | null; createdAt: string
}
function toProfile(r: any): AffiliateProfile {
  return {
    affiliateId: r.affiliate_id, emailNormalized: r.email_normalized, displayName: r.display_name ?? null,
    applicationId: r.application_id ?? null, programStatus: r.program_status, kycStatus: r.kyc_status, taxStatus: r.tax_status,
    payoutMethodStatus: r.payout_method_status, payoutProvider: r.payout_provider ?? null, payoutProviderRef: r.payout_provider_ref ?? null,
    portalAccess: r.portal_access, paidAdsPolicy: r.paid_ads_policy,
    payoutThresholdCents: r.payout_threshold_cents == null ? null : Number(r.payout_threshold_cents), payoutSchedule: r.payout_schedule ?? null,
    country: r.country ?? null, stateRegion: r.state_region ?? null, socialLinks: Array.isArray(r.social_links) ? r.social_links : [],
    website: r.website ?? null, acceptedProgramTermsVersion: r.accepted_program_terms_version ?? null,
    acceptedDisclosureVersion: r.accepted_disclosure_version ?? null, requiresReacceptance: !!r.requires_reacceptance,
    activatedAt: iso(r.activated_at), suspendedAt: iso(r.suspended_at), terminatedAt: iso(r.terminated_at),
    programStartAt: iso(r.program_start_at), programEndAt: iso(r.program_end_at), createdAt: iso(r.created_at)!,
  }
}

export async function getProfileByAffiliateId(sql: Sql, affiliateId: string): Promise<AffiliateProfile | null> {
  if (!isUuid(affiliateId)) return null
  const rows = await sql`SELECT * FROM affiliate_profiles WHERE affiliate_id = ${affiliateId}::uuid` as any[]
  return rows[0] ? toProfile(rows[0]) : null
}

export async function getProfileByEmail(sql: Sql, email: string): Promise<AffiliateProfile | null> {
  const e = normalizeEmail(email)
  if (!isEmailShape(e)) return null
  const rows = await sql`SELECT * FROM affiliate_profiles WHERE email_normalized = ${e}` as any[]
  return rows[0] ? toProfile(rows[0]) : null
}

export interface RecordAcceptanceInput {
  affiliateId?: string | null
  applicationId?: string | null
  docType: DocType
  version: string
  ipHash?: string | null
  userAgentHash?: string | null
  method: 'application' | 'portal' | 'admin_recorded'
  /** Admin back-fill only. Default: only the CURRENT version can be accepted. */
  allowNonCurrent?: boolean
}

/** Record exact-version acceptance (idempotent). Updates the profile's accepted versions and clears reacceptance when satisfied. */
export async function recordAcceptance(sql: Sql, input: RecordAcceptanceInput): Promise<{ outcome: 'recorded' | 'already_recorded'; acceptanceId: string }> {
  if (!(DOC_TYPES as readonly string[]).includes(input.docType)) throw new ProgramError('INVALID_INPUT', 'Unknown document type.', 400)
  if (!/^v[0-9]{1,6}$/.test(input.version)) throw new ProgramError('INVALID_INPUT', 'Invalid version.', 400)
  if (!isUuid(input.affiliateId ?? '') && !isUuid(input.applicationId ?? '')) throw new ProgramError('INVALID_INPUT', 'An affiliate or application is required.', 400)
  try {
    const rows = await sql`SELECT record_affiliate_acceptance(
      ${input.affiliateId ?? null}::uuid, ${input.applicationId ?? null}::uuid, ${input.docType}, ${input.version},
      ${input.ipHash ?? null}, ${input.userAgentHash ?? null}, ${input.method}, ${input.allowNonCurrent === true}
    ) AS r` as any[]
    return { outcome: rows[0].r.outcome, acceptanceId: rows[0].r.acceptance_id }
  } catch (err) {
    throw toProgramError(err) ?? err
  }
}

// ── Readiness ───────────────────────────────────────────────────────────────

export interface ApplicationReadiness { open: boolean; reasons: string[] }

/**
 * Applications can accept submissions only when the flag is ON and the three applicant documents are
 * REAL (not placeholders) — unless staging explicitly allows placeholders. Fails closed.
 */
export async function getApplicationReadiness(sql: Sql, env?: Record<string, string | undefined>): Promise<ApplicationReadiness> {
  const reasons: string[] = []
  if (!isFeatureEnabled('AFFILIATE_APPLICATIONS', env as any)) reasons.push('The AFFILIATE_APPLICATIONS flag is off.')
  // Production fails closed without the hash secret: without it the anti-bot form token is forgeable and
  // stored IP / user-agent hashes are unsalted. (Dev and test environments are not required to set it.)
  const e = env ?? (process.env as Record<string, string | undefined>)
  if (e.NODE_ENV === 'production' && (e.AFFILIATE_HASH_PEPPER ?? '').trim().length < 32) reasons.push('The application hash secret (AFFILIATE_HASH_PEPPER) is not configured securely.')
  try {
    const docs = await getCurrentDocuments(sql)
    const { settings } = await getProgramSettings(sql)
    for (const t of ['program_terms', 'disclosure_policy', 'privacy_notice'] as const) {
      const d = docs[t]
      if (!d) reasons.push(`No published ${DOC_LABELS[t]}.`)
      else if (d.isPlaceholder && !settings.allowPlaceholderDocuments) reasons.push(`${DOC_LABELS[t]} is still a placeholder awaiting legal review.`)
    }
    if (settings.countries.length === 0) reasons.push('No eligible countries are configured.')
  } catch {
    reasons.push('Program settings could not be read.')
  }
  return { open: reasons.length === 0, reasons }
}

// ── Approval configuration ──────────────────────────────────────────────────

export interface ApprovalConfigInput {
  code?: unknown; commissionType?: unknown; commissionRateBps?: unknown; commissionFixedCents?: unknown
  fixedReversalPolicy?: unknown; attributionWindowDays?: unknown; commissionHoldDays?: unknown
  discountType?: unknown; discountBps?: unknown; discountCents?: unknown
  payoutThresholdCents?: unknown; payoutSchedule?: unknown; paidAdsPolicy?: unknown
  programStartAt?: unknown; programEndAt?: unknown; linkSlug?: unknown
  activateNow?: unknown; approvalMessage?: unknown; internalNote?: unknown
}

const optInt = (v: unknown): number | null | undefined => {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isInteger(n) ? n : undefined
}
const optDate = (v: unknown): string | null | undefined => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

export function validateApprovalConfig(i: ApprovalConfigInput): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const code = cleanText(i.code, 40).toUpperCase()
  if (!CODE_RE.test(code)) return { ok: false, error: 'Code must be 2–32 characters: A–Z, 0–9, hyphen or underscore.' }
  const type = i.commissionType === 'fixed' ? 'fixed' : i.commissionType === 'percentage' || i.commissionType == null ? 'percentage' : null
  if (!type) return { ok: false, error: 'Commission type must be percentage or fixed.' }
  const bps = optInt(i.commissionRateBps), fixed = optInt(i.commissionFixedCents)
  if (bps === undefined || fixed === undefined) return { ok: false, error: 'Commission amounts must be whole numbers.' }
  if (type === 'percentage' && (bps === null || bps <= 0 || bps > 10000)) return { ok: false, error: 'Rate must be 0.01%–100% (1–10000 basis points).' }
  if (type === 'fixed' && (fixed === null || fixed < 0 || fixed > 100_000_000)) return { ok: false, error: 'Fixed commission must be a non-negative number of cents.' }
  const policy = i.fixedReversalPolicy == null || i.fixedReversalPolicy === '' ? 'proportional' : i.fixedReversalPolicy
  if (policy !== 'proportional' && policy !== 'all_or_nothing') return { ok: false, error: 'Reversal policy is not valid.' }
  const win = optInt(i.attributionWindowDays) ?? 30, hold = optInt(i.commissionHoldDays) ?? 30
  if (win < 1 || win > 365) return { ok: false, error: 'Attribution window must be 1–365 days.' }
  if (hold < 0 || hold > 365) return { ok: false, error: 'Hold must be 0–365 days.' }
  const dType = i.discountType == null || i.discountType === '' ? null : i.discountType
  if (dType !== null && dType !== 'percentage' && dType !== 'fixed_amount') return { ok: false, error: 'Discount type is not valid.' }
  const dBps = optInt(i.discountBps), dCents = optInt(i.discountCents)
  if (dBps === undefined || dCents === undefined) return { ok: false, error: 'Discount amounts must be whole numbers.' }
  if (dType === 'percentage' && (dBps === null || dBps <= 0 || dBps > 10000)) return { ok: false, error: 'Discount must be 0.01%–100%.' }
  if (dType === 'fixed_amount' && (dCents === null || dCents <= 0 || dCents > 100_000)) return { ok: false, error: 'Discount amount must be between 1 cent and $1,000.' }
  const thr = optInt(i.payoutThresholdCents)
  if (thr === undefined || (thr !== null && (thr < 0 || thr > 100_000_000))) return { ok: false, error: 'Payout threshold is not valid.' }
  const sched = i.payoutSchedule == null || i.payoutSchedule === '' ? null : String(i.payoutSchedule)
  if (sched !== null && !(PAYOUT_SCHEDULES as readonly string[]).includes(sched)) return { ok: false, error: 'Payout schedule is not valid.' }
  const ads = i.paidAdsPolicy == null || i.paidAdsPolicy === '' ? 'not_permitted' : String(i.paidAdsPolicy)
  if (!(PAID_ADS_POLICIES as readonly string[]).includes(ads)) return { ok: false, error: 'Paid-ads policy is not valid.' }
  const start = optDate(i.programStartAt), end = optDate(i.programEndAt)
  if (start === undefined || end === undefined) return { ok: false, error: 'Dates are not valid.' }
  if (start && end && Date.parse(end) <= Date.parse(start)) return { ok: false, error: 'The end date must be after the start date.' }
  const slug = cleanText(i.linkSlug, 41).toLowerCase()
  if (slug && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return { ok: false, error: 'Link name must be 2–41 lowercase letters, numbers or hyphens.' }
  return {
    ok: true,
    value: {
      code, commissionType: type, commissionRateBps: type === 'percentage' ? bps : null, commissionFixedCents: type === 'fixed' ? fixed : null,
      fixedReversalPolicy: policy, attributionWindowDays: win, commissionHoldDays: hold,
      discountType: dType, discountBps: dType === 'percentage' ? dBps : null, discountCents: dType === 'fixed_amount' ? dCents : null,
      payoutThresholdCents: thr, payoutSchedule: sched, paidAdsPolicy: ads, programStartAt: start, programEndAt: end,
      linkSlug: slug || null, activateNow: i.activateNow === true,
      approvalMessage: cleanText(i.approvalMessage, 1000) || null, internalNote: cleanText(i.internalNote, 2000) || null,
    },
  }
}

export interface InviteInput {
  email?: unknown; displayName?: unknown; socialUrls?: unknown; internalNote?: unknown
  proposedCode?: unknown; commissionType?: unknown; commissionRateBps?: unknown; commissionFixedCents?: unknown
  discountType?: unknown; discountBps?: unknown; discountCents?: unknown; startAt?: unknown; endAt?: unknown
}

export function validateInviteInput(i: InviteInput): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const email = normalizeEmail(i.email)
  if (!isEmailShape(email)) return { ok: false, error: 'Enter a valid email address.' }
  const name = cleanText(i.displayName, 100)
  if (name.length < 2) return { ok: false, error: 'Enter the creator’s name.' }
  const socials: SocialLink[] = []
  for (const u of Array.isArray(i.socialUrls) ? i.socialUrls.filter((x: unknown) => typeof x === 'string' && (x as string).trim()) : []) {
    const c = canonicalizeSocialUrl(u)
    if (!c) return { ok: false, error: 'One of the social links is not a valid profile link.' }
    if (!socials.some(s => s.key === c.key)) socials.push(c)
  }
  if (socials.length > 5) return { ok: false, error: 'Add at most 5 social links.' }
  const code = cleanText(i.proposedCode, 40).toUpperCase()
  if (code && !CODE_RE.test(code)) return { ok: false, error: 'Proposed code must be 2–32 characters: A–Z, 0–9, hyphen or underscore.' }
  const type = i.commissionType == null || i.commissionType === '' ? null : i.commissionType
  if (type !== null && type !== 'percentage' && type !== 'fixed') return { ok: false, error: 'Commission type is not valid.' }
  const bps = optInt(i.commissionRateBps), fixed = optInt(i.commissionFixedCents)
  const dBps = optInt(i.discountBps), dCents = optInt(i.discountCents)
  if ([bps, fixed, dBps, dCents].some(x => x === undefined)) return { ok: false, error: 'Amounts must be whole numbers.' }
  if (bps != null && (bps <= 0 || bps > 10000)) return { ok: false, error: 'Rate must be 1–10000 basis points.' }
  if (fixed != null && (fixed < 0 || fixed > 100_000_000)) return { ok: false, error: 'Fixed commission is not valid.' }
  const dType = i.discountType == null || i.discountType === '' ? null : i.discountType
  if (dType !== null && dType !== 'percentage' && dType !== 'fixed_amount') return { ok: false, error: 'Discount type is not valid.' }
  if (dBps != null && (dBps <= 0 || dBps > 10000)) return { ok: false, error: 'Discount percentage is not valid.' }
  if (dCents != null && (dCents <= 0 || dCents > 100_000)) return { ok: false, error: 'Discount amount is not valid.' }
  const start = optDate(i.startAt), end = optDate(i.endAt)
  if (start === undefined || end === undefined) return { ok: false, error: 'Dates are not valid.' }
  if (start && end && Date.parse(end) <= Date.parse(start)) return { ok: false, error: 'The end date must be after the start date.' }
  return {
    ok: true,
    value: {
      email: i.email && String(i.email).trim(), displayName: name, socialLinks: socials, proposedCode: code || null,
      commissionType: type, commissionRateBps: bps, commissionFixedCents: fixed,
      discountType: dType, discountBps: dBps, discountCents: dCents, startAt: start, endAt: end,
      internalNote: cleanText(i.internalNote, 2000) || null,
    },
  }
}

export function validateProfileSettingsInput(i: any): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!i || typeof i !== 'object') return { ok: false, error: 'Settings are required.' }
  const out: Record<string, unknown> = {}
  if ('displayName' in i) { const v = cleanText(i.displayName, 100); if (v.length < 2) return { ok: false, error: 'Enter a display name.' }; out.displayName = v }
  if ('stateRegion' in i) out.stateRegion = cleanText(i.stateRegion, 80) || null
  if ('country' in i) { const c = cleanText(i.country, 2).toUpperCase(); if (!/^[A-Z]{2}$/.test(c)) return { ok: false, error: 'Country is not valid.' }; out.country = c }
  if ('website' in i) { const w = cleanText(i.website, 300); if (w && !/^https:\/\/[^\s]+$/i.test(w)) return { ok: false, error: 'Website must start with https://.' }; out.website = w || null }
  if ('socialLinks' in i) {
    const links: SocialLink[] = []
    for (const u of Array.isArray(i.socialLinks) ? i.socialLinks : []) {
      const c = canonicalizeSocialUrl(typeof u === 'string' ? u : u?.url)
      if (!c) return { ok: false, error: 'One of the social links is not valid.' }
      if (!links.some(s => s.key === c.key)) links.push(c)
    }
    if (links.length > 5) return { ok: false, error: 'At most 5 social links.' }
    out.socialLinks = links
  }
  if ('payoutThresholdCents' in i) {
    const n = optInt(i.payoutThresholdCents)
    if (n === undefined || (n !== null && (n < 0 || n > 100_000_000))) return { ok: false, error: 'Payout threshold is not valid.' }
    out.payoutThresholdCents = n
  }
  if ('payoutSchedule' in i) {
    const s = i.payoutSchedule == null || i.payoutSchedule === '' ? null : String(i.payoutSchedule)
    if (s !== null && !(PAYOUT_SCHEDULES as readonly string[]).includes(s)) return { ok: false, error: 'Payout schedule is not valid.' }
    out.payoutSchedule = s
  }
  if ('paidAdsPolicy' in i) {
    if (!(PAID_ADS_POLICIES as readonly string[]).includes(i.paidAdsPolicy)) return { ok: false, error: 'Paid-ads policy is not valid.' }
    out.paidAdsPolicy = i.paidAdsPolicy
  }
  for (const k of ['programStartAt', 'programEndAt'] as const) {
    if (k in i) { const d = optDate(i[k]); if (d === undefined) return { ok: false, error: 'Dates are not valid.' }; out[k] = d }
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'Nothing to update.' }
  return { ok: true, value: out }
}

export function validateDocumentInput(i: any): { ok: true; value: { docType: DocType; title: string; body: string; changeSummary: string | null } } | { ok: false; error: string } {
  if (!i || !(DOC_TYPES as readonly string[]).includes(i.docType)) return { ok: false, error: 'Choose a document type.' }
  const title = cleanText(i.title, 200)
  if (title.length < 3) return { ok: false, error: 'A title is required.' }
  const body = typeof i.body === 'string' ? i.body.replace(/\r\n?/g, '\n').slice(0, 200_000) : ''
  if (body.trim().length < 20) return { ok: false, error: 'The document text is too short.' }
  return { ok: true, value: { docType: i.docType, title, body, changeSummary: cleanText(i.changeSummary, 500) || null } }
}

export { toProfile as _toProfile, toDoc as _toDoc }
