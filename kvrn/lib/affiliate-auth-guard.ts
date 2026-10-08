// lib/affiliate-auth-guard.ts — requireAffiliate(): the ONE gate for every /api/affiliate/* handler.
// Server-only.
//
// AUTHORIZATION RULE (non-negotiable): the affiliate id used by a portal handler comes ONLY from the value
// returned here (derived from the validated server session). It is never read from the URL, query, body or any
// header. A source-guard test enforces that every route under app/api/affiliate/** calls this function.
//
// This module never reads Admin credentials and Admin auth never reads the affiliate cookie, so an affiliate
// session can never satisfy requireAdmin() and an Admin identity can never satisfy this guard.
import { type NextRequest, NextResponse } from 'next/server'
import { sql as appSql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { getSiteOrigin } from '@/lib/site-origin'
import {
  AFFILIATE_CSRF_COOKIE, AFFILIATE_CSRF_HEADER, AFFILIATE_SESSION_COOKIE,
  affiliateAuthPepperConfigured, buildClearCookies, createAffiliateAuthService, evaluateCsrf, isSecureEnv, parseCookies, SAFE_METHODS,
  type SessionContext,
} from '@/lib/affiliate-auth'

export const NO_STORE = { 'Cache-Control': 'no-store' } as const

export interface RequireAffiliateOptions {
  /** Test seam: defaults to the app database. */
  sql?: any
  /** Allow a state-changing request from a read-only (suspended / terminated / read_only) affiliate. Default false. */
  allowReadOnly?: boolean
}

type Ok  = { ctx: SessionContext; error: null }
type Bad = { ctx: null; error: Response }

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: { ...NO_STORE, ...headers } })
}

export function expectedOrigins(req: NextRequest): string[] {
  const out = new Set<string>()
  try { out.add(new URL(req.url).origin) } catch { /* ignore */ }
  const site = getSiteOrigin()
  if (site) out.add(site)
  return [...out]
}

export async function requireAffiliate(req: NextRequest, opts: RequireAffiliateOptions = {}): Promise<Ok | Bad> {
  // Flag OFF: the whole surface does not exist. No cookie is inspected and no database is touched.
  if (!isFeatureEnabled('AFFILIATE_PORTAL')) return { ctx: null, error: jsonError(404, 'Not found.') }
  if (!affiliateAuthPepperConfigured()) {
    console.error('[affiliate-auth] portal disabled: AFFILIATE_AUTH_PEPPER is not configured securely')
    return { ctx: null, error: jsonError(503, 'Temporarily unavailable.') }
  }

  const cookies = parseCookies(req.headers.get('cookie'))
  const token = cookies[AFFILIATE_SESSION_COOKIE]
  if (!token) return { ctx: null, error: jsonError(401, 'Not signed in.') }

  const sql = opts.sql ?? appSql
  let ctx: SessionContext | null = null
  try {
    ctx = await createAffiliateAuthService(sql).validateSession(token)
  } catch {
    // Fail closed. No detail: the cause could be anything from a deploy gap to an outage.
    return { ctx: null, error: jsonError(503, 'Temporarily unavailable.') }
  }
  if (!ctx) {
    const res = jsonError(401, 'Not signed in.')
    for (const c of buildClearCookies({ secure: isSecureEnv() })) res.headers.append('Set-Cookie', c)
    return { ctx: null, error: res }
  }

  if (!SAFE_METHODS.has(req.method.toUpperCase())) {
    const csrf = evaluateCsrf({
      method: req.method,
      origin: req.headers.get('origin'),
      secFetchSite: req.headers.get('sec-fetch-site'),
      expectedOrigins: expectedOrigins(req),
      headerToken: req.headers.get(AFFILIATE_CSRF_HEADER),
      cookieToken: cookies[AFFILIATE_CSRF_COOKIE] ?? null,
      csrfHash: ctx.csrfHash,
    })
    if (!csrf.ok) return { ctx: null, error: jsonError(403, 'Request blocked.') }
    if (ctx.readOnly && !opts.allowReadOnly) {
      return { ctx: null, error: jsonError(403, 'Your account is read-only.', { code: 'read_only' }) }
    }
  }
  return { ctx, error: null }
}
