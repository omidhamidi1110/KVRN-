// lib/public-api-rate-limit.ts — cross-isolate abuse control for small public API surfaces.
// Server-only. Stores only a purpose-separated HMAC of the client address, never the raw address.
import { createHmac } from 'crypto'

type Sql = any

const DEV_PEPPER = 'kvrn-public-rate-dev-v1'

export class PublicRateLimitConfigError extends Error {
  constructor(message = 'Public API rate limiting is not configured securely') {
    super(message)
    this.name = 'PublicRateLimitConfigError'
  }
}

export function publicRateLimitConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NODE_ENV !== 'production') return true
  const p = env.PUBLIC_API_RATE_PEPPER
  return typeof p === 'string' && p.trim().length >= 32
}

function pepper(env: Record<string, string | undefined> = process.env): string {
  const p = env.PUBLIC_API_RATE_PEPPER
  if (typeof p === 'string' && p.trim().length >= 32) return p
  if (env.NODE_ENV === 'production') throw new PublicRateLimitConfigError()
  return DEV_PEPPER
}

/**
 * Cloudflare's CF-Connecting-IP is authoritative in production. Never trust X-Forwarded-For there:
 * a spoofed fallback would let a caller rotate the rate-limit key. XFF is only a local/test convenience.
 */
export function publicClientAddress(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string {
  const cf = headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf.slice(0, 64)
  if (env.NODE_ENV === 'production') throw new PublicRateLimitConfigError('Cloudflare client address is unavailable')
  const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return xff ? xff.slice(0, 64) : 'local-unknown'
}

function keyHash(bucket: string, address: string, env = process.env): string {
  return createHmac('sha256', pepper(env)).update(`${bucket}:${address}`, 'utf8').digest('hex')
}

export async function allowPublicApiRequest(
  sql: Sql,
  input: {
    bucket: string
    headers: Headers
    limit: number
    windowSeconds: number
  },
): Promise<boolean> {
  if (!/^[a-z0-9_.:-]{1,80}$/i.test(input.bucket)) throw new PublicRateLimitConfigError('Invalid rate-limit bucket')
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10000) throw new PublicRateLimitConfigError('Invalid rate limit')
  if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 1 || input.windowSeconds > 86400) {
    throw new PublicRateLimitConfigError('Invalid rate-limit window')
  }
  const address = publicClientAddress(input.headers)
  const hash = keyHash(input.bucket, address)
  const rows = await sql`
    SELECT public_api_rate_allow(${input.bucket}, ${hash}, ${input.limit}::integer, ${input.windowSeconds}::integer) AS ok
  ` as any[]
  return rows[0]?.ok === true
}
