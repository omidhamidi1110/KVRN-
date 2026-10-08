// lib/affiliate-auth.ts — affiliate-only passwordless authentication (magic link + server session).
// Server-only. SEPARATE from Admin auth (Cloudflare Access) and from the visitor attribution cookie
// (`kvrn_sid`, lib/affiliate-session.ts). Nothing here can produce, or be mistaken for, an Admin identity.
//
// ── MODEL ───────────────────────────────────────────────────────────────────
//   1. POST /api/affiliate/auth/request  { email }  → ALWAYS the same generic response. If (and only if) the
//      email belongs to an eligible affiliate a single-use token is stored (SHA-256 HASH ONLY) and mailed.
//   2. The email link opens /affiliate/login/verify#t=<token>. The token is in the URL FRAGMENT: it is never
//      sent to a server, never in access logs or Referer, and a mail scanner that merely GETs the link cannot
//      consume it. The page POSTs it to /api/affiliate/auth/verify, which consumes it atomically in SQL.
//   3. A session row (hash only) is created; the browser gets an HttpOnly cookie plus a CSRF cookie.
//
// ── COOKIE SameSite=Lax (not Strict) ────────────────────────────────────────
//   The verify step is a same-site fetch from our own page, but the user ARRIVES from an email client
//   (cross-site top-level navigation) and the portal then navigates internally. Strict would withhold the
//   cookie on the first navigation that follows a cross-site arrival in some browsers, which looks like a
//   random logout. Lax still blocks the cookie on every cross-site subrequest/POST; CSRF is additionally
//   enforced explicitly (Origin / Sec-Fetch-Site check + a session-bound double-submit token).
//
// ── NO ENUMERATION ──────────────────────────────────────────────────────────
//   Same status, body and (approximately) timing for matched / unmatched / malformed / revoked emails. Rate
//   limits are keyed on hashes of the INPUT, so they trigger identically whether or not an account exists.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'

// ── constants ────────────────────────────────────────────────────────────────
export const AFFILIATE_SESSION_COOKIE = 'kvrn_aff'
export const AFFILIATE_CSRF_COOKIE    = 'kvrn_aff_csrf'
export const AFFILIATE_CSRF_HEADER    = 'x-kvrn-csrf'
/** A cookie has ONE Path; the portal pages and the portal API live under two prefixes, so each cookie is set twice. */
export const AFFILIATE_COOKIE_PATHS = ['/affiliate', '/api/affiliate'] as const

export const LOGIN_TOKEN_TTL_SECONDS    = 15 * 60
export const SESSION_IDLE_SECONDS       = 8 * 60 * 60
export const SESSION_ABSOLUTE_SECONDS   = 30 * 24 * 60 * 60
/** Sliding expiry is refreshed at most this often (avoids a write on every request). */
export const SESSION_TOUCH_INTERVAL_SECONDS = 60

export const RATE_LIMITS = {
  loginIp:       { bucket: 'login_ip',        limit: 10, windowSeconds: 15 * 60 },
  loginEmail:    { bucket: 'login_email',     limit: 3,  windowSeconds: 15 * 60 },
  loginEmailDay: { bucket: 'login_email_day', limit: 8,  windowSeconds: 24 * 60 * 60 },
  verifyIp:      { bucket: 'verify_ip',       limit: 20, windowSeconds: 15 * 60 },
} as const

/** Identical for every outcome of a login request. */
export const GENERIC_LOGIN_MESSAGE =
  'If that email belongs to an approved affiliate, a sign-in link is on its way. It expires in 15 minutes.'

// ── hashing / tokens ─────────────────────────────────────────────────────────
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 32 random bytes, base64url → 43 characters. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function isWellFormedToken(t: unknown): t is string {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t)
}

const DEV_AUTH_PEPPER = 'kvrn-affiliate-auth-v1'

/** Production requires a real secret. Tests/local development may use the fixed fallback. */
export function affiliateAuthPepperConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.AFFILIATE_AUTH_PEPPER
  if (env.NODE_ENV !== 'production') return true
  return typeof value === 'string' && value.trim().length >= 32
}

function pepper(env: Record<string, string | undefined> = process.env): string {
  const value = env.AFFILIATE_AUTH_PEPPER
  if (typeof value === 'string' && value.trim().length >= 32) return value
  if (env.NODE_ENV === 'production') {
    // Fail closed. A public fallback in production would make email/IP/UA HMACs dictionary-attackable
    // and would let a configuration mistake silently weaken portal abuse controls.
    throw new Error('AFFILIATE_AUTH_PEPPER is not configured securely')
  }
  return DEV_AUTH_PEPPER
}
/** Keyed hash of an input used for rate limiting. Purpose-separated so an email hash never equals an IP hash. */
export function keyedHash(purpose: 'email' | 'ip' | 'ua', value: string): string {
  return createHmac('sha256', pepper()).update(`${purpose}:${value}`, 'utf8').digest('hex')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) { timingSafeEqual(ab, ab); return false }
  return timingSafeEqual(ab, bb)
}

// ── input normalisation ──────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/

/** Trim + lowercase + shape check. Returns null when it cannot be an email address. */
export function normalizeLoginEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  if (e.length < 5 || e.length > 254 || !EMAIL_RE.test(e)) return null
  return e
}

/** Best-effort client IP. Cloudflare sets CF-Connecting-IP; the first X-Forwarded-For hop is a fallback. */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  const cf = headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf.slice(0, 64)
  // On the Cloudflare Worker, CF-Connecting-IP is authoritative. Do not let a caller forge an XFF value
  // to rotate DB-backed rate-limit keys if that header is unexpectedly absent.
  if (env.NODE_ENV === 'production') return 'unknown'
  const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (xff) return xff.slice(0, 64)
  return 'unknown'
}

// ── cookies ──────────────────────────────────────────────────────────────────
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (!(k in out)) out[k] = v          // first wins; never let a later duplicate override
  }
  return out
}

interface CookieOpts { secure: boolean }
const base = (name: string, value: string, path: string, o: CookieOpts, extra: string[]) =>
  [`${name}=${value}`, `Path=${path}`, 'SameSite=Lax', ...(o.secure ? ['Secure'] : []), ...extra].join('; ')

/** Set-Cookie strings for a fresh session: the HttpOnly session cookie and the (script-readable) CSRF cookie. */
export function buildSessionCookies(
  p: { sessionToken: string; csrfToken: string; maxAgeSeconds: number }, o: CookieOpts,
): string[] {
  const age = `Max-Age=${Math.max(0, Math.floor(p.maxAgeSeconds))}`
  const out: string[] = []
  for (const path of AFFILIATE_COOKIE_PATHS) {
    out.push(base(AFFILIATE_SESSION_COOKIE, p.sessionToken, path, o, ['HttpOnly', age]))
    out.push(base(AFFILIATE_CSRF_COOKIE,    p.csrfToken,    path, o, [age]))
  }
  return out
}

export function buildClearCookies(o: CookieOpts): string[] {
  const out: string[] = []
  for (const path of AFFILIATE_COOKIE_PATHS) {
    out.push(base(AFFILIATE_SESSION_COOKIE, '', path, o, ['HttpOnly', 'Max-Age=0']))
    out.push(base(AFFILIATE_CSRF_COOKIE,    '', path, o, ['Max-Age=0']))
  }
  return out
}

export const isSecureEnv = (env: Record<string, string | undefined> = process.env) => env.NODE_ENV === 'production'

// ── CSRF ─────────────────────────────────────────────────────────────────────
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface CsrfInput {
  method: string
  origin: string | null
  secFetchSite: string | null
  expectedOrigins: string[]
  headerToken: string | null
  cookieToken: string | null
  /** SHA-256 hex of the CSRF token stored on the session. */
  csrfHash: string
}

/**
 * State-changing portal requests need ALL of:
 *   * not a cross-site request (Sec-Fetch-Site same-origin, when the browser sends it),
 *   * an Origin header that is one of our origins (absent Origin AND absent Sec-Fetch-Site ⇒ rejected),
 *   * the CSRF header equal to the CSRF cookie AND to the token bound to THIS session.
 */
export function evaluateCsrf(i: CsrfInput): { ok: true } | { ok: false; reason: 'origin' | 'token' } {
  if (SAFE_METHODS.has(i.method.toUpperCase())) return { ok: true }

  if (i.secFetchSite && i.secFetchSite !== 'same-origin') return { ok: false, reason: 'origin' }
  if (i.origin) {
    if (!i.expectedOrigins.includes(i.origin)) return { ok: false, reason: 'origin' }
  } else if (!i.secFetchSite) {
    return { ok: false, reason: 'origin' }
  }

  if (!i.headerToken || !i.cookieToken) return { ok: false, reason: 'token' }
  if (!constantTimeEqual(i.headerToken, i.cookieToken)) return { ok: false, reason: 'token' }
  if (!constantTimeEqual(sha256Hex(i.headerToken), i.csrfHash)) return { ok: false, reason: 'token' }
  return { ok: true }
}

/** Origin-only variant for the unauthenticated verify POST (login-CSRF defence: no session exists yet). */
export function evaluateOriginOnly(
  i: { method: string; origin: string | null; secFetchSite: string | null; expectedOrigins: string[] },
): boolean {
  if (SAFE_METHODS.has(i.method.toUpperCase())) return true
  if (i.secFetchSite && i.secFetchSite !== 'same-origin') return false
  if (i.origin) return i.expectedOrigins.includes(i.origin)
  return Boolean(i.secFetchSite)
}

// ── access rules (pure) ──────────────────────────────────────────────────────
export type ProgramStatus = 'onboarding' | 'active' | 'suspended' | 'terminated'
export type PortalAccess = 'enabled' | 'read_only' | 'revoked'

export interface AccessDecision { allowed: boolean; readOnly: boolean; reason: string }

/**
 * Who may sign in and what they may do.
 *   onboarding / active  → full access (unless Admin set read_only)
 *   suspended / terminated → login allowed, READ-ONLY history and statements (no edits, no acceptance)
 *   portal_access = revoked → no login at all (fraud / security)
 * Unknown values and a missing profile fail CLOSED.
 */
export function decidePortalAccess(
  programStatus: string | null | undefined, portalAccess: string | null | undefined,
): AccessDecision {
  if (!programStatus || !portalAccess) return { allowed: false, readOnly: true, reason: 'no_profile' }
  if (portalAccess === 'revoked') return { allowed: false, readOnly: true, reason: 'access_revoked' }
  if (portalAccess !== 'enabled' && portalAccess !== 'read_only') return { allowed: false, readOnly: true, reason: 'unknown_access' }
  if (programStatus === 'onboarding' || programStatus === 'active') {
    return { allowed: true, readOnly: portalAccess === 'read_only', reason: portalAccess === 'read_only' ? 'read_only_access' : 'ok' }
  }
  if (programStatus === 'suspended') return { allowed: true, readOnly: true, reason: 'suspended' }
  if (programStatus === 'terminated') return { allowed: true, readOnly: true, reason: 'terminated' }
  return { allowed: false, readOnly: true, reason: 'unknown_status' }
}

/** A session issued BEFORE a suspension/termination is void even if nobody revoked it explicitly. */
export function sessionPredatesStatusChange(
  sessionCreatedAt: Date | string, suspendedAt: Date | string | null | undefined, terminatedAt: Date | string | null | undefined,
): boolean {
  const created = new Date(sessionCreatedAt).getTime()
  for (const t of [suspendedAt, terminatedAt]) {
    if (t && new Date(t).getTime() > created) return true
  }
  return false
}

// ── service ──────────────────────────────────────────────────────────────────
type Sql = any

export interface SessionContext {
  sessionId: string
  affiliateId: string
  csrfHash: string
  programStatus: ProgramStatus
  portalAccess: PortalAccess
  readOnly: boolean
  accessReason: string
  displayName: string | null
  name: string
  code: string
  requiresReacceptance: boolean
}

export interface LoginMessage { to: string; link: string }
export interface AuthDeps {
  now?: () => Date
  /** Sends the magic link. Must NEVER log the link. Returns false on any failure. */
  sendLoginEmail?: (m: LoginMessage) => Promise<boolean>
  siteOrigin?: () => string | null
}

export function createAffiliateAuthService(sql: Sql, deps: AuthDeps = {}) {
  const now = deps.now ?? (() => new Date())

  return {
    /**
     * Start a login. The caller must return GENERIC_LOGIN_MESSAGE for every result except 'rate_limited'.
     * Exactly one of: 'sent' (token stored + mail attempted), 'ignored' (no eligible account / bad input).
     */
    async requestLogin(input: { email: unknown; ip: string; userAgent?: string | null }):
      Promise<{ status: 'sent' | 'ignored' | 'rate_limited' }> {
      const ipHash = keyedHash('ip', input.ip)
      const email = normalizeLoginEmail(input.email)
      // Hash whatever was typed (even malformed) so malformed input is limited like any other.
      const emailHash = keyedHash('email', email ?? String(typeof input.email === 'string' ? input.email.trim().toLowerCase().slice(0, 254) : ''))

      for (const r of [RATE_LIMITS.loginIp, RATE_LIMITS.loginEmail, RATE_LIMITS.loginEmailDay]) {
        const key = r.bucket === 'login_ip' ? ipHash : emailHash
        const rows = await sql`SELECT affiliate_auth_rate_allow(${r.bucket}, ${key}, ${r.limit}::integer, ${r.windowSeconds}::integer) AS ok` as any[]
        if (rows[0]?.ok !== true) return { status: 'rate_limited' }
      }
      if (!email) return { status: 'ignored' }

      const found = await sql`
        SELECT affiliate_id FROM affiliate_profiles
         WHERE email_normalized = ${email} AND portal_access <> 'revoked'
         LIMIT 1` as any[]
      const affiliateId: string | undefined = found[0]?.affiliate_id
      if (!affiliateId) return { status: 'ignored' }

      const token = newToken()
      const tokenHash = sha256Hex(token)
      const expires = new Date(now().getTime() + LOGIN_TOKEN_TTL_SECONDS * 1000)
      await sql`
        INSERT INTO affiliate_login_tokens (token_hash, affiliate_id, email_hash, ip_hash, expires_at)
        VALUES (${tokenHash}, ${affiliateId}::uuid, ${emailHash}, ${ipHash}, ${expires.toISOString()}::timestamptz)`
      await sql`
        INSERT INTO affiliate_security_events (affiliate_id, event_type, ip_hash)
        VALUES (${affiliateId}::uuid, 'login_link_requested', ${ipHash})`

      const origin = (deps.siteOrigin ?? (() => null))()
      if (origin && deps.sendLoginEmail) {
        const ok = await deps.sendLoginEmail({ to: email, link: `${origin}/affiliate/login/verify#t=${token}` }).catch(() => false)
        if (!ok) console.error('[affiliate-auth] login email could not be sent')
      } else {
        console.error('[affiliate-auth] login email not sent: site origin or mailer is not configured')
      }
      return { status: 'sent' }
    },

    /** Consume a token and open a session. Every failure looks identical to the caller. */
    async redeemLoginToken(input: { token: unknown; ip: string; userAgent?: string | null }):
      Promise<
        | { ok: true; affiliateId: string; sessionToken: string; csrfToken: string; maxAgeSeconds: number }
        | { ok: false; reason: 'rate_limited' | 'invalid' }> {
      const ipHash = keyedHash('ip', input.ip)
      const lim = await sql`SELECT affiliate_auth_rate_allow(${RATE_LIMITS.verifyIp.bucket}, ${ipHash}, ${RATE_LIMITS.verifyIp.limit}::integer, ${RATE_LIMITS.verifyIp.windowSeconds}::integer) AS ok` as any[]
      if (lim[0]?.ok !== true) return { ok: false, reason: 'rate_limited' }
      if (!isWellFormedToken(input.token)) return { ok: false, reason: 'invalid' }

      const rows = await sql`SELECT affiliate_consume_login_token(${sha256Hex(input.token)}) AS affiliate_id` as any[]
      const affiliateId: string | null = rows[0]?.affiliate_id ?? null
      if (!affiliateId) {
        return { ok: false, reason: 'invalid' }
      }

      const sessionToken = newToken()
      const csrfToken = newToken(24)
      const t = now()
      const idle = new Date(t.getTime() + SESSION_IDLE_SECONDS * 1000)
      const abs  = new Date(t.getTime() + SESSION_ABSOLUTE_SECONDS * 1000)
      const uaHash = input.userAgent ? keyedHash('ua', input.userAgent.slice(0, 300)) : null
      await sql`
        INSERT INTO affiliate_sessions (session_hash, csrf_hash, affiliate_id, created_at, last_seen_at, expires_at, absolute_expires_at, user_agent_hash)
        VALUES (${sha256Hex(sessionToken)}, ${sha256Hex(csrfToken)}, ${affiliateId}::uuid, ${t.toISOString()}::timestamptz,
                ${t.toISOString()}::timestamptz, ${idle.toISOString()}::timestamptz, ${abs.toISOString()}::timestamptz, ${uaHash})`
      await sql`
        INSERT INTO affiliate_security_events (affiliate_id, event_type, ip_hash)
        VALUES (${affiliateId}::uuid, 'login_succeeded', ${ipHash})`
      return { ok: true, affiliateId, sessionToken, csrfToken, maxAgeSeconds: SESSION_IDLE_SECONDS }
    },

    /**
     * Resolve a session cookie value to a live, still-eligible affiliate context. Null for anything else
     * (unknown, expired, revoked, access revoked, no profile, issued before a suspension/termination).
     */
    async validateSession(sessionToken: string | undefined | null): Promise<SessionContext | null> {
      if (!isWellFormedToken(sessionToken)) return null
      const t = now()
      const rows = await sql`
        SELECT s.id AS session_id, s.affiliate_id, s.csrf_hash, s.created_at, s.last_seen_at,
               a.name, a.code,
               p.program_status, p.portal_access, p.display_name, p.requires_reacceptance,
               p.suspended_at, p.terminated_at
          FROM affiliate_sessions s
          JOIN affiliates a ON a.id = s.affiliate_id
          LEFT JOIN affiliate_profiles p ON p.affiliate_id = s.affiliate_id
         WHERE s.session_hash = ${sha256Hex(sessionToken)}
           AND s.revoked_at IS NULL
           AND s.expires_at > ${t.toISOString()}::timestamptz
           AND s.absolute_expires_at > ${t.toISOString()}::timestamptz
         LIMIT 1` as any[]
      const r = rows[0]
      if (!r) return null

      const decision = decidePortalAccess(r.program_status, r.portal_access)
      if (!decision.allowed || sessionPredatesStatusChange(r.created_at, r.suspended_at, r.terminated_at)) {
        // Close it for good so the state is visible in Admin and cannot flap.
        await sql`UPDATE affiliate_sessions SET revoked_at = NOW(),
                     revoked_reason = ${decision.allowed ? 'status_change' : decision.reason}
                   WHERE id = ${r.session_id}::uuid AND revoked_at IS NULL`
        return null
      }

      // Sliding expiry, written at most once per interval.
      const idleMs = SESSION_IDLE_SECONDS * 1000
      if (t.getTime() - new Date(r.last_seen_at).getTime() > SESSION_TOUCH_INTERVAL_SECONDS * 1000) {
        await sql`UPDATE affiliate_sessions
                     SET last_seen_at = ${t.toISOString()}::timestamptz,
                         expires_at = LEAST(${new Date(t.getTime() + idleMs).toISOString()}::timestamptz, absolute_expires_at)
                   WHERE id = ${r.session_id}::uuid`
      }
      return {
        sessionId: r.session_id, affiliateId: r.affiliate_id, csrfHash: r.csrf_hash,
        programStatus: r.program_status, portalAccess: r.portal_access,
        readOnly: decision.readOnly, accessReason: decision.reason,
        displayName: r.display_name ?? null, name: r.name, code: r.code,
        requiresReacceptance: r.requires_reacceptance === true,
      }
    },

    async logout(sessionId: string, affiliateId: string): Promise<void> {
      await sql`UPDATE affiliate_sessions SET revoked_at = NOW(), revoked_reason = 'logout'
                 WHERE id = ${sessionId}::uuid AND affiliate_id = ${affiliateId}::uuid AND revoked_at IS NULL`
      await sql`INSERT INTO affiliate_security_events (affiliate_id, event_type) VALUES (${affiliateId}::uuid, 'logout')`
    },

    /** Admin / system revocation of every live session (SQL function writes the audit rows). */
    async revokeAllSessions(affiliateId: string, reason: string, actor: string): Promise<number> {
      const rows = await sql`SELECT revoke_affiliate_sessions(${affiliateId}::uuid, ${reason}, ${actor}) AS n` as any[]
      return Number(rows[0]?.n ?? 0)
    },

    /** Maintenance: drop dead tokens/sessions/rate events. Idempotent. */
    async cleanup(): Promise<{ tokens: number; sessions: number; rateEvents: number }> {
      const t = await sql`WITH d AS (DELETE FROM affiliate_login_tokens WHERE expires_at < NOW() - INTERVAL '1 day' RETURNING 1) SELECT COUNT(*)::int AS n FROM d` as any[]
      const s = await sql`WITH d AS (DELETE FROM affiliate_sessions
                            WHERE absolute_expires_at < NOW() - INTERVAL '7 days' OR expires_at < NOW() - INTERVAL '7 days'
                               OR revoked_at < NOW() - INTERVAL '7 days' RETURNING 1) SELECT COUNT(*)::int AS n FROM d` as any[]
      const r = await sql`WITH d AS (DELETE FROM affiliate_auth_rate_events WHERE created_at < NOW() - INTERVAL '2 days' RETURNING 1) SELECT COUNT(*)::int AS n FROM d` as any[]
      return { tokens: Number(t[0]?.n ?? 0), sessions: Number(s[0]?.n ?? 0), rateEvents: Number(r[0]?.n ?? 0) }
    },
  }
}

export type AffiliateAuthService = ReturnType<typeof createAffiliateAuthService>
