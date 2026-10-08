// POST /api/affiliate/auth/request — ask for a sign-in link.
// PUBLIC by design (there is no session yet), so it is the one place the protections are explicit:
//   flag OFF → 404; cross-site origin → rejected; DB-backed rate limits keyed on IP + email hashes;
//   the response is IDENTICAL whether or not the address belongs to an affiliate, and padded to a minimum duration.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { getSiteOrigin } from '@/lib/site-origin'
import { affiliateAuthPepperConfigured, clientIp, createAffiliateAuthService, evaluateOriginOnly, GENERIC_LOGIN_MESSAGE } from '@/lib/affiliate-auth'
import { createMagicLinkSender } from '@/lib/affiliate-portal-notifications'
import { expectedOrigins, jsonError, NO_STORE } from '@/lib/affiliate-auth-guard'
import { readSmallJson, sleep } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'
const MIN_DURATION_MS = 650

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled('AFFILIATE_PORTAL')) return jsonError(404, 'Not found.')
  if (!affiliateAuthPepperConfigured()) return jsonError(503, 'Temporarily unavailable.')
  if (!evaluateOriginOnly({
    method: req.method, origin: req.headers.get('origin'), secFetchSite: req.headers.get('sec-fetch-site'),
    expectedOrigins: expectedOrigins(req),
  })) return jsonError(403, 'Request blocked.')

  const started = Date.now()
  const body = await readSmallJson(req, 2048)
  let limited = false
  try {
    const svc = createAffiliateAuthService(sql, { siteOrigin: getSiteOrigin, sendLoginEmail: createMagicLinkSender() })
    const r = await svc.requestLogin({ email: body?.email, ip: clientIp(req.headers), userAgent: req.headers.get('user-agent') })
    limited = r.status === 'rate_limited'
  } catch {
    // Same public answer as success: a failure must not reveal that an account was (or was not) found.
    console.error('[affiliate-auth] request failed')
  }
  const wait = MIN_DURATION_MS - (Date.now() - started)
  if (wait > 0) await sleep(wait + Math.floor(Math.random() * 120))

  if (limited) {
    return NextResponse.json({ ok: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': '900' } })
  }
  return NextResponse.json({ ok: true, message: GENERIC_LOGIN_MESSAGE }, { headers: NO_STORE })
}
