// lib/admin-auth.ts — Cloudflare Access JWT verification
// Server-only. Never import in client code.
import { type NextRequest } from 'next/server'
import { notifySecurityAlert } from './owner-notifications'

export type AdminIdentity = { email: string }

const TEAM_DOMAIN   = process.env.CF_ACCESS_TEAM_DOMAIN ?? ''   // e.g. kvrn.cloudflareaccess.com
const AUDIENCE      = process.env.CF_ACCESS_AUDIENCE    ?? ''   // AUD tag from Access app
const ALLOWLIST_RAW = process.env.ADMIN_EMAIL_ALLOWLIST  ?? ''
const ALLOWLIST     = new Set(ALLOWLIST_RAW.split(',').map(e => e.trim().toLowerCase()).filter(Boolean))

const IS_PROD = process.env.NODE_ENV === 'production'
const DEV_BYPASS_EMAIL = process.env.DEV_ADMIN_EMAIL ?? ''

/** Verify the Cloudflare Access JWT and return the admin identity or null. */
export async function verifyAdminRequest(
  req: NextRequest
): Promise<AdminIdentity | null> {

  // ── Local development bypass ────────────────────────────────────────────
  // DEV_ADMIN_EMAIL is ONLY checked when NODE_ENV !== production.
  // It is never honoured in production to prevent an accidental backdoor.
  if (!IS_PROD && DEV_BYPASS_EMAIL) {
    const devHeader = req.headers.get('x-dev-admin-email')
    if (devHeader === DEV_BYPASS_EMAIL && ALLOWLIST.has(devHeader.toLowerCase())) {
      return { email: devHeader }
    }
  }

  // ── Cloudflare Access JWT ───────────────────────────────────────────────
  const token = req.headers.get('cf-access-jwt-assertion')
  // Reject misconfiguration and oversized tokens before fetching verification keys.
  if (!token || token.length > 16_384 || !TEAM_DOMAIN || !AUDIENCE || !ALLOWLIST.size) return null
  if (!/^[a-z0-9.-]+\.cloudflareaccess\.com$/i.test(TEAM_DOMAIN) && IS_PROD) return null

  try {
    // Fetch the public JWKS from Cloudflare Access
    const certsUrl = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`
    const certsRes = await fetch(certsUrl, { next: { revalidate: 3600 } })
    if (!certsRes.ok) return null
    const certs: { keys: JsonWebKey[] } = await certsRes.json()

    // Decode header to get kid
    const segments = token.split('.')
    if (segments.length !== 3 || segments.some(part => !part)) return null
    const [rawHeader] = segments
    const header: { kid?: string; alg?: string } = JSON.parse(
      Buffer.from(rawHeader, 'base64url').toString('utf8')
    )
    if (header.alg !== 'RS256' || !header.kid || !Array.isArray(certs.keys)) return null
    const jwk = certs.keys.find((k: any) => k.kid === header.kid && k.kty === 'RSA')
    if (!jwk) return null

    // Import public key
    const publicKey = await crypto.subtle.importKey(
      'jwk', jwk as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    )

    // Verify signature
    const [headerB64, payloadB64, sigB64] = token.split('.')
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const sig  = Uint8Array.from(Buffer.from(sigB64, 'base64url'))
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, data)
    if (!valid) return null

    // Decode and validate claims
    const payload: { iss?: string; aud?: string | string[]; email?: string; exp?: number; nbf?: number; iat?: number } =
      JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))

    const nowSeconds = Math.floor(Date.now() / 1000)
    if (typeof payload.email !== 'string' || !payload.email.trim()) return null
    if (payload.iss !== `https://${TEAM_DOMAIN}`) return null
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || nowSeconds >= payload.exp) return null
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > nowSeconds + 60)) return null
    if (payload.iat !== undefined && (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > nowSeconds + 60)) return null

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!aud.includes(AUDIENCE)) return null

    return { email: payload.email }
  } catch {
    return null
  }
}

/** Check allowlist. Returns 401/403 response or null (allowed). */
export function checkAllowlist(identity: AdminIdentity | null): Response | null {
  if (!identity) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    })
  }
  if (!ALLOWLIST.has(identity.email.toLowerCase())) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    })
  }
  return null
}

/** Combined verify + allowlist check for API routes. */
export async function requireAdmin(req: NextRequest): Promise<
  { identity: AdminIdentity; error: null } | { identity: null; error: Response }
> {
  const identity = await verifyAdminRequest(req)
  const deny     = checkAllowlist(identity)
  if (deny) {
    // Missing/invalid JWTs are normally blocked by Cloudflare Access before they
    // reach the app and are too noisy to push. A VERIFIED Access identity that
    // reaches KVRN but is not on the owner allowlist is high-signal.
    if (identity && deny.status === 403) {
      // Fail-open belt and braces: nothing here may change the 403 the caller receives.
      await notifySecurityAlert('An authenticated Cloudflare Access identity was blocked by the KVRN admin allowlist.').catch(() => {})
    }
    return { identity: null, error: deny }
  }
  return { identity: identity!, error: null }
}
