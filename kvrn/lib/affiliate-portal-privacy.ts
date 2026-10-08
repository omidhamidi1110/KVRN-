// lib/affiliate-portal-privacy.ts — runtime defence-in-depth for "own data only, no customer PII".
//
// Every /api/affiliate/* JSON payload passes through assertPortalPayloadSafe() before it leaves the server.
// The queries are written to select only permitted columns; this is the second wall: if a future change adds a
// forbidden key to a portal payload, the response fails closed (500) instead of leaking.

/** Key-name fragments that must never appear in an affiliate-facing payload. */
export const FORBIDDEN_PORTAL_KEY_PATTERNS: RegExp[] = [
  /customer/i, /e-?mail/i, /phone/i, /address/i, /shipping/i, /billing/i, /payment/i, /stripe/i,
  /fraud/i, /risk/i, /radar/i, /support/i, /internal/i, /\bnotes?\b/i, /note$/i, /cogs/i, /profit/i, /margin/i,
  /order_?id/i, /order_?number/i, /orderref/i, /ip_?hash/i, /token/i, /secret/i, /password/i,
  /other_?affiliate/i, /affiliate_?id/i, /company/i,
]

export class PortalPrivacyError extends Error {
  constructor(public readonly path: string) { super(`Portal payload contains a forbidden key at ${path}.`) }
}

function walk(v: unknown, path: string): void {
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_PORTAL_KEY_PATTERNS.some(re => re.test(k))) throw new PortalPrivacyError(`${path}.${k}`)
      walk(x, `${path}.${k}`)
    }
  }
}

/** Throws PortalPrivacyError when any key (at any depth) matches a forbidden pattern. Returns the payload. */
export function assertPortalPayloadSafe<T>(payload: T): T {
  walk(payload, '$')
  return payload
}

/** Every key at every depth, for tests. */
export function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach(x => collectKeys(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.push(k); collectKeys(x, out) }
  return out
}
