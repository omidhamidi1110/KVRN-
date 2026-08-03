// lib/admin-auth.ts — Cloudflare Access JWT verification
// Server-only. Never import in client code.
import { type NextRequest } from 'next/server'

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
  if (!token) return null

  try {
    // Fetch the public JWKS from Cloudflare Access
    const certsUrl = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`
    const certsRes = await fetch(certsUrl, { next: { revalidate: 3600 } })
    if (!certsRes.ok) return null
    const certs: { keys: JsonWebKey[] } = await certsRes.json()

    // Decode header to get kid
    const [rawHeader] = token.split('.')
    const header: { kid?: string; alg?: string } = JSON.parse(
      Buffer.from(rawHeader, 'base64url').toString('utf8')
    )
    const jwk = certs.keys.find((k: any) => k.kid === header.kid)
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
    const payload: { iss?: string; aud?: string | string[]; email?: string; exp?: number } =
      JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))

    if (!payload.email) return null
    if (Date.now() / 1000 > (payload.exp ?? 0)) return null

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
  if (deny) return { identity: null, error: deny }
  return { identity: identity!, error: null }
}
