// POST /api/affiliate/auth/verify — exchange a one-time sign-in token for a session.
// PUBLIC by design. The token arrives in a POST body (the link carries it in the URL FRAGMENT, which is never sent
// to a server, logged or put in a Referer). Origin-checked (login-CSRF), rate limited, single use, and every failure
// looks the same.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import {
  affiliateAuthPepperConfigured, buildSessionCookies, clientIp, createAffiliateAuthService, evaluateOriginOnly, isSecureEnv,
} from '@/lib/affiliate-auth'
import { expectedOrigins, jsonError, NO_STORE } from '@/lib/affiliate-auth-guard'
import { readSmallJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled('AFFILIATE_PORTAL')) return jsonError(404, 'Not found.')
  if (!affiliateAuthPepperConfigured()) return jsonError(503, 'Temporarily unavailable.')
  if (!evaluateOriginOnly({
    method: req.method, origin: req.headers.get('origin'), secFetchSite: req.headers.get('sec-fetch-site'),
    expectedOrigins: expectedOrigins(req),
  })) return jsonError(403, 'Request blocked.')

  const body = await readSmallJson(req, 1024)
  try {
    const r = await createAffiliateAuthService(sql).redeemLoginToken({
      token: body?.token, ip: clientIp(req.headers), userAgent: req.headers.get('user-agent'),
    })
    if (!r.ok) {
      if (r.reason === 'rate_limited') {
        return NextResponse.json({ ok: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
          { status: 429, headers: { ...NO_STORE, 'Retry-After': '900' } })
      }
      return NextResponse.json({ ok: false, message: 'This sign-in link is invalid or has expired. Request a new one.' },
        { status: 400, headers: NO_STORE })
    }
    const res = NextResponse.json({ ok: true }, { headers: NO_STORE })
    for (const c of buildSessionCookies(r, { secure: isSecureEnv() })) res.headers.append('Set-Cookie', c)
    return res
  } catch {
    console.error('[affiliate-auth] verify failed')
    return jsonError(503, 'Temporarily unavailable.')
  }
}
