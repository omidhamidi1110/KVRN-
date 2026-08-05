// lib/site-origin.ts — server-safe SITE_URL origin helper

/**
 * Returns the URL.origin of SITE_URL (falls back to NEXT_PUBLIC_SITE_URL).
 * Requires https: in production. Only allows http://localhost in development.
 * Rejects credentials, query strings, hashes, and trailing-path ambiguity.
 * Returns null when the URL is absent or invalid.
 */
export function getSiteOrigin(): string | null {
  const raw = (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? '').trim()
  if (!raw) return null

  let parsed: URL
  try { parsed = new URL(raw) } catch { return null }

  // Reject credentials, query, hash
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null

  const isProd = process.env.NODE_ENV === 'production'

  if (isProd && parsed.protocol !== 'https:') return null
  if (!isProd && parsed.protocol === 'http:' && parsed.hostname !== 'localhost') return null

  // Return origin only (strips path/trailing slash)
  return parsed.origin
}
