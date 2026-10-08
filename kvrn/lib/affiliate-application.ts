// lib/affiliate-application.ts — server-side public application handling.
// Anti-abuse: salted hashes (never raw IP/UA stored), DB-backed rate limits, honeypot, signed
// minimum-fill-time token, server validation, idempotent submit. NEVER approves anything.

import {
  validateApplicationInput, emailDedupeKey, type ApplicationInput,
} from './affiliate-application-input'
import {
  getApplicationReadiness, getCurrentDocuments, getProgramSettings, toProgramError, ProgramError,
} from './affiliate-program'

type Sql = any

const enc = new TextEncoder()
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')

export function affiliateHashPepperConfigured(
  env: Record<string, string | undefined> = process.env as any,
): boolean {
  if (env.NODE_ENV !== 'production') return true
  const value = env.AFFILIATE_HASH_PEPPER
  return typeof value === 'string' && value.trim().length >= 32
}

function pepper(env: Record<string, string | undefined> = process.env as any): string {
  const value = env.AFFILIATE_HASH_PEPPER ?? ''
  if (env.NODE_ENV === 'production' && value.trim().length < 32) {
    throw new Error('AFFILIATE_HASH_PEPPER is not configured securely')
  }
  return value
}

/** SHA-256 hex of `pepper|scope|value`. Used for IP / user-agent / email rate-limit keys and invite tokens. */
export async function hashValue(scope: string, value: string, env?: Record<string, string | undefined>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(`${pepper(env)}|${scope}|${value}`)))
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(value)))
}

/** Best-effort client IP (Cloudflare first). Only ever hashed. */
export function clientIpFrom(
  headers: { get(name: string): string | null },
  env: Record<string, string | undefined> = process.env as any,
): string {
  const cf = headers.get('cf-connecting-ip')
  if (cf) return cf.trim().slice(0, 64)
  // Production runs behind Cloudflare. Do not trust caller-controlled X-Forwarded-For as a fallback,
  // or a bot could rotate its DB-backed rate-limit key. Tests/local development may still use XFF.
  if (env.NODE_ENV === 'production') return 'unknown'
  const xff = headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim().slice(0, 64)
  return 'unknown'
}

// ── Signed minimum-fill-time token ──────────────────────────────────────────

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key || 'kvrn-affiliate-form'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
}

export async function issueFormToken(now = Date.now(), env?: Record<string, string | undefined>): Promise<string> {
  return `${now}.${await hmacHex(pepper(env), `form|${now}`)}`
}

export const MIN_FILL_MS = 4_000
export const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000

export type FormTokenCheck = 'ok' | 'too_fast' | 'expired' | 'invalid'
export async function checkFormToken(token: unknown, now = Date.now(), env?: Record<string, string | undefined>): Promise<FormTokenCheck> {
  if (typeof token !== 'string') return 'invalid'
  const m = /^([0-9]{10,15})\.([0-9a-f]{64})$/.exec(token)
  if (!m) return 'invalid'
  if ((await hmacHex(pepper(env), `form|${m[1]}`)) !== m[2]) return 'invalid'
  const age = now - Number(m[1])
  if (age < 0) return 'invalid'
  if (age < MIN_FILL_MS) return 'too_fast'
  if (age > MAX_FORM_AGE_MS) return 'expired'
  return 'ok'
}

// ── Rate limits (DB-backed) ─────────────────────────────────────────────────

export async function checkApplyRateLimits(
  sql: Sql, ipHash: string, emailHash: string, limits: { perIpPerHour: number; perIpPerDay: number; perEmailPerDay: number; globalPerHour: number },
): Promise<boolean> {
  const check = async (scope: string, key: string, max: number, secs: number) =>
    ((await sql`SELECT affiliate_rate_limit_check(${scope}, ${key}, ${max}::int, ${secs}::int) AS ok` as any[])[0]?.ok) === true
  // The GLOBAL flood cap is checked LAST: a single client that is already over its own limits must not be able
  // to spend the shared budget (every denied request would otherwise still consume a global slot).
  return (
    (await check('apply_ip_h', ipHash, limits.perIpPerHour, 3600)) &&
    (await check('apply_ip_d', ipHash, limits.perIpPerDay, 86400)) &&
    (await check('apply_email_d', emailHash, limits.perEmailPerDay, 86400)) &&
    (await check('apply_global_h', 'all', limits.globalPerHour, 3600))
  )
}

// ── Submission ──────────────────────────────────────────────────────────────

export interface SubmitContext {
  ip: string
  userAgent: string
  formToken?: unknown
  honeypot?: unknown
  inviteToken?: string | null
  env?: Record<string, string | undefined>
  now?: number
}

export type SubmitOutcome =
  | { kind: 'received' }                       // created, existing, already-affiliate or silently dropped: identical to the applicant
  | { kind: 'invalid'; errors: Record<string, string> }
  | { kind: 'closed'; reasons: string[] }
  | { kind: 'rate_limited' }
  | { kind: 'retry'; message: string }          // too fast / stale form
  | { kind: 'error'; status: number; message: string }

/**
 * Process one public application. The response is deliberately the same for a new application, a
 * repeat of one that is already open, and an existing affiliate, so the endpoint cannot be used to
 * learn who has applied. The confirmation email is queued only when a NEW application is stored.
 */
export async function submitPublicApplication(sql: Sql, body: any, ctx: SubmitContext): Promise<SubmitOutcome> {
  const readiness = await getApplicationReadiness(sql, ctx.env)
  if (!readiness.open) return { kind: 'closed', reasons: readiness.reasons }

  // Honeypot: bots fill hidden fields. Pretend success; store nothing.
  if (typeof ctx.honeypot === 'string' && ctx.honeypot.trim() !== '') return { kind: 'received' }

  const tok = await checkFormToken(ctx.formToken, ctx.now, ctx.env)
  if (tok === 'too_fast') return { kind: 'retry', message: 'Please review your answers and submit again.' }
  if (tok !== 'ok') return { kind: 'retry', message: 'This form expired. Reload the page and try again.' }

  const { settings } = await getProgramSettings(sql)
  const v = validateApplicationInput(body as Partial<ApplicationInput>, settings.countries)
  if (!v.ok) return { kind: 'invalid', errors: v.errors }
  const a = v.value

  const ipHash = await hashValue('ip', ctx.ip, ctx.env)
  const uaHash = ctx.userAgent ? await hashValue('ua', ctx.userAgent.slice(0, 300), ctx.env) : null
  const emailHash = await hashValue('email', emailDedupeKey(a.email), ctx.env)
  if (!(await checkApplyRateLimits(sql, ipHash, emailHash, settings.rateLimits))) return { kind: 'rate_limited' }

  const inviteTokenHash = ctx.inviteToken ? await sha256Hex(ctx.inviteToken) : null
  const payload = {
    idempotencyKey: a.idempotencyKey, applicantName: a.applicantName, displayName: a.displayName, email: a.email,
    country: a.country, stateRegion: a.stateRegion, socialLinks: a.socialLinks, website: a.website,
    audienceSize: a.audienceSize, contentCategory: a.contentCategory, motivation: a.motivation,
    promotionPlan: a.promotionPlan, preferredCode: a.preferredCode, heardAbout: a.heardAbout, applicantNotes: a.applicantNotes,
    ageAttested: true, accuracyConfirmed: true, esignConsent: true,
    termsVersion: a.termsVersion, disclosureVersion: a.disclosureVersion, privacyVersion: a.privacyVersion,
    ipHash, userAgentHash: uaHash, inviteTokenHash,
  }
  try {
    await sql`SELECT submit_affiliate_application(${JSON.stringify(payload)}::jsonb) AS r`
    return { kind: 'received' }
  } catch (err) {
    const pe = toProgramError(err)
    if (pe) {
      if (pe.code === 'DOCUMENT_VERSION_CHANGED') return { kind: 'retry', message: pe.message }
      return { kind: 'error', status: pe.status, message: pe.message }
    }
    console.error('[affiliate-apply] submit failed')
    return { kind: 'error', status: 500, message: 'We could not save your application. Please try again.' }
  }
}

/** Data the public page needs: current applicant documents. */
export async function loadApplyPageData(sql: Sql) {
  const docs = await getCurrentDocuments(sql)
  const { settings } = await getProgramSettings(sql)
  return { docs, countries: settings.countries }
}

export { ProgramError }
