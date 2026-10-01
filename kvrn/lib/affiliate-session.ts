// lib/affiliate-session.ts — first-party session identity for attribution
// Server-only.
//
// ── WHAT THIS IS FOR, AND WHAT IT IS NOT ────────────────────────────────────
//
// The minimum chain needed for correct affiliate attribution:
//
//   /r/[slug] -> first-party cookie -> affiliate_clicks -> Stripe
//   client_reference_id -> paid-order attribution
//
// It is NOT a general analytics ingestion system and NOT a public affiliate
// portal. It creates only the analytics_sessions row needed to keep session
// identity referentially coherent.
//
// ── THE IDENTIFIER ──────────────────────────────────────────────────────────
//
// Cryptographically random and opaque. It deliberately encodes NOTHING: no
// email, no customer id, no affiliate id, no IP hash, no business data. It is a
// lookup key and nothing else, so possessing the cookie reveals no information
// and forging one grants no privilege — a fabricated id simply matches no click.

import { randomBytes } from 'crypto'
import type { NeonQueryFunction } from '@neondatabase/serverless'

export const AFFILIATE_SESSION_COOKIE = 'kvrn_sid'

/**
 * Cookie lifetime, in seconds.
 *
 * MUST outlive the longest supported attribution window, or a 30-day window
 * would silently fail whenever the cookie expired first. affiliates
 * .attribution_window_days is capped at 365 by CHECK constraint, so the cookie
 * is set to 400 days — comfortably longer, and at the ceiling most browsers
 * enforce for cookie lifetimes anyway.
 *
 * A window longer than this cannot be honoured by a cookie alone; the CHECK
 * constraint is what keeps that from arising.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60
export const MAX_ATTRIBUTION_WINDOW_DAYS = 365

/** Opaque, 256 bits of entropy, URL-safe. */
export function generateSessionId(): string {
  return randomBytes(32).toString('base64url')
}

/** Shape check only — never trust a client-supplied value beyond this. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 32 && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value)
}

export const sessionCookieOptions = {
  httpOnly: true,        // no client-side script needs to read it
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,  // survives the top-level navigation from /r/[slug]
  path:     '/',
  maxAge:   SESSION_COOKIE_MAX_AGE_SECONDS,
}

/**
 * Normalise an affiliate link destination to a safe internal path.
 *
 * OPEN-REDIRECT DEFENCE. Only stored internal paths are ever used, and even
 * those are normalised, because a stored value could still be mistyped or
 * tampered with in the database. Anything that could leave KVRN's origin
 * degrades to '/' rather than being followed:
 *
 *   absolute URLs            https://evil.test/...
 *   protocol-relative        //evil.test
 *   backslash variants       /\evil.test  (some parsers treat \ as /)
 *   scheme-like strings      javascript:, data:, mailto:
 *   encoded scheme separators
 */
export function safeDestinationPath(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  let p = raw.trim()
  if (p === '') return '/'

  // Backslashes are treated as separators by some clients; normalise first so
  // "/\evil.test" cannot slip past the protocol-relative check below.
  p = p.replace(/\\/g, '/')

  // Any scheme at all, including encoded colons.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return '/'
  if (/^%[0-9a-fA-F]{2}/.test(p)) return '/'
  if (p.includes('://')) return '/'

  // Protocol-relative.
  if (p.startsWith('//')) return '/'

  // Must be rooted; a bare "evil.test" would otherwise resolve relatively.
  if (!p.startsWith('/')) return '/'

  // Collapse duplicate leading slashes introduced by normalisation.
  p = '/' + p.replace(/^\/+/, '')

  // Control characters and whitespace can be used to smuggle past filters.
  if (/[\u0000-\u001F\u007F\s]/.test(p)) return '/'

  // Final check against a real parser: it must stay on the placeholder origin.
  try {
    const u = new URL(p, 'https://kvrn.invalid')
    if (u.origin !== 'https://kvrn.invalid') return '/'
    return u.pathname + u.search + u.hash
  } catch {
    return '/'
  }
}

/**
 * Privacy-minimised referrer.
 *
 * A raw Referer header routinely carries query strings, fragments and path
 * segments containing emails, tokens, order ids or session identifiers. Storing
 * it verbatim would have put third-party customer data into affiliate tables
 * that are explicitly meant to hold none.
 *
 * Only the ORIGIN is retained — enough to tell an Instagram referral from a
 * newsletter — with userinfo, query, fragment and path all discarded. Anything
 * unparseable, non-http or oversized becomes NULL, because a missing referrer is
 * strictly better than a leaked one.
 */
export function normalizeReferrer(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (v === '' || v.length > 2048) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // u.origin drops username, password, path, query and fragment entirely.
    return u.origin === 'null' ? null : u.origin
  } catch {
    return null
  }
}

export function createAffiliateSessionService(sql: NeonQueryFunction<false, false>) {
  return {
    /**
     * Ensure an analytics_sessions row exists for this identifier.
     *
     * Minimum lifecycle only: enough to keep session identity coherent for
     * attribution. Deliberately not a general analytics pipeline.
     */
    async ensureAnalyticsSession(sessionId: string, landingPage: string | null,
                                 referrer: string | null) {
      await sql`
        INSERT INTO analytics_sessions (session_id, landing_page, referrer, last_seen_at)
        VALUES (${sessionId}, ${landingPage}, ${referrer}, NOW())
        ON CONFLICT (session_id) DO UPDATE SET last_seen_at = NOW()
      `
    },

    /**
     * Capture a referral DURABLY: session row and affiliate click, together.
     *
     * The click is the ONLY record of which affiliate a visitor came through.
     * The opaque cookie deliberately encodes nothing, so if the click is lost the
     * identity is unrecoverable — checkout later sees a cookie with no evidence,
     * treats it as stale, and the commission obligation disappears silently.
     *
     * Both writes therefore happen in ONE statement. Either the referral is
     * captured and the caller may confirm it, or nothing is written and the
     * caller must report a retryable failure rather than a false success.
     *
     * Returns null when the slug does not resolve to an active, eligible link —
     * an ordinary miss, not an error, and indistinguishable to the visitor.
     * Throws only when a genuine referral could not be persisted.
     */
    async captureReferral(slug: string, sessionId: string, referrer: string | null) {
      const rows = await sql`
        WITH resolved AS (
          SELECT l.id AS link_id, l.affiliate_id, l.destination_path
          FROM affiliate_links l
          WHERE l.slug = ${slug}
            AND l.active
            AND affiliate_active_at(l.affiliate_id, NOW())
          LIMIT 1
        ),
        session_upsert AS (
          INSERT INTO analytics_sessions (session_id, landing_page, referrer, last_seen_at)
          SELECT ${sessionId}, ${'/r/' + slug}, ${referrer}, NOW()
          FROM resolved
          ON CONFLICT (session_id) DO UPDATE SET last_seen_at = NOW()
          RETURNING session_id
        ),
        click AS (
          INSERT INTO affiliate_clicks (link_id, affiliate_id, session_id, referrer)
          SELECT r.link_id, r.affiliate_id, ${sessionId}, ${referrer}
          FROM resolved r
          WHERE EXISTS (SELECT 1 FROM session_upsert)
          RETURNING id, link_id
        )
        SELECT c.id AS click_id, r.destination_path, r.affiliate_id
        FROM click c JOIN resolved r ON r.link_id = c.link_id
      `
      const row = (rows as any[])[0]
      if (!row) return null
      return {
        clickId: row.click_id as string,
        affiliateId: row.affiliate_id as string,
        destination: (row.destination_path ?? '/') as string,
      }
    },

    /** Does this slug resolve to a live, eligible referral link? */
    async slugIsLiveReferral(slug: string) {
      const rows = await sql`
        SELECT 1 FROM affiliate_links l
        WHERE l.slug = ${slug} AND l.active AND affiliate_active_at(l.affiliate_id, NOW())
        LIMIT 1
      `
      return (rows as any[]).length > 0
    },
  }
}
