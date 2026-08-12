// lib/twilio.ts — Twilio REST adapter for KVRN
// Server-only. Never import in client components.
//
// Authentication: API Key SID + API Key Secret (HTTP Basic Auth)
//   Username = TWILIO_API_KEY_SID
//   Password = TWILIO_API_KEY_SECRET
// This pair is used for all REST API calls (send SMS, etc.)
//
// Webhook signature validation: requires TWILIO_AUTH_TOKEN (separate from API Key)
//   The Auth Token signs webhook payloads. The API Key Secret is NOT a substitute.
//   See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//   TWILIO_AUTH_TOKEN must be added as an additional Cloudflare Worker secret.
//
// A2P 10DLC NOTE:
//   US application-to-person messaging at scale requires an approved A2P 10DLC
//   Campaign. Set TWILIO_A2P_APPROVED=true in Cloudflare env only after Campaign
//   approval to enable promotional sends. Subscriber consent storage is not gated.

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01'

export interface TwilioSendResult {
  ok:         boolean
  messageSid?: string
  status?:    string
  error?:     string   // safe, no PII
}

// ── A2P readiness ─────────────────────────────────────────────────────────────

export function isA2PApproved(): boolean {
  return process.env.TWILIO_A2P_APPROVED === 'true'
}

export function isMarketingSendEnabled(): boolean {
  return process.env.TWILIO_MARKETING_SEND_ENABLED === 'true'
}

/**
 * Returns true only when ALL three conditions are met:
 * 1. Local subscriber is marked subscribed (must be checked by caller)
 * 2. A2P Campaign is approved (TWILIO_A2P_APPROVED=true)
 * 3. Marketing sends are explicitly enabled (TWILIO_MARKETING_SEND_ENABLED=true)
 */
export function canSendMarketingSms(): boolean {
  return isA2PApproved() && isMarketingSendEnabled()
}

// ── REST API: send one SMS ─────────────────────────────────────────────────────

/**
 * Send a single SMS to a normalized E.164 recipient via Twilio Messaging Service.
 * Requires: TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_MESSAGING_SERVICE_SID.
 * Uses MessagingServiceSid (not a hardcoded From number) for A2P compliance.
 *
 * IMPORTANT: For promotional messages, call isA2PApproved() and check local subscriber
 * status before calling this function.
 */
export async function sendSms(opts: {
  to:             string   // E.164
  body:           string
  statusCallback?: string  // optional: URL to receive delivery status callbacks
}): Promise<TwilioSendResult> {
  const accountSid       = process.env.TWILIO_ACCOUNT_SID          ?? ''
  const apiKeySid        = process.env.TWILIO_API_KEY_SID          ?? ''
  const apiKeySecret     = process.env.TWILIO_API_KEY_SECRET       ?? ''
  const messagingService = process.env.TWILIO_MESSAGING_SERVICE_SID ?? ''

  if (!accountSid || !apiKeySid || !apiKeySecret) {
    return { ok: false, error: 'Twilio credentials not configured.' }
  }
  if (!messagingService) {
    return { ok: false, error: 'TWILIO_MESSAGING_SERVICE_SID not configured.' }
  }

  // HTTP Basic Auth: API Key SID (username) + API Key Secret (password)
  const auth    = btoa(`${apiKeySid}:${apiKeySecret}`)
  const url     = `${TWILIO_BASE}/Accounts/${accountSid}/Messages.json`
  const params  = new URLSearchParams({
    MessagingServiceSid: messagingService,
    To:                  opts.to,
    Body:                opts.body,
  })
  if (opts.statusCallback) params.set('StatusCallback', opts.statusCallback)

  let res: Response
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch {
    return { ok: false, error: 'Network error contacting Twilio.' }
  }

  let data: any
  try { data = await res.json() } catch {}

  if (!res.ok) {
    const code = data?.code ?? res.status
    return { ok: false, error: `Twilio API returned ${code}.` }
  }

  return {
    ok:         true,
    messageSid: data?.sid,
    status:     data?.status,
  }
}

// ── Webhook signature validation ──────────────────────────────────────────────
// Requires TWILIO_AUTH_TOKEN (different from the API Key pair).
// The Auth Token is specifically used for webhook HMAC-SHA1 signing.
// Without it, we CANNOT securely validate Twilio webhooks.

/**
 * Validate the X-Twilio-Signature header on an inbound Twilio webhook.
 *
 * Algorithm (official Twilio): HMAC-SHA1 of (URL + sorted param key+values)
 * signed with the Auth Token.
 *
 * Returns 'valid', 'invalid', or 'unconfigured' (when TWILIO_AUTH_TOKEN is absent).
 * Callers MUST reject the request on 'invalid' or 'unconfigured'.
 */

/**
 * Reconstruct the externally-visible webhook URL for Twilio signature validation.
 *
 * Problem: In Cloudflare Workers + OpenNext, req.url may be the internal URL
 * (e.g. https://cron-internal/...) rather than the external public URL that
 * Twilio signed when sending the webhook. Twilio signs the public URL.
 *
 * Solution: Reconstruct from NEXT_PUBLIC_SITE_URL (the configured public origin)
 * and the request pathname + query string. This guarantees we validate against
 * exactly the URL Twilio used:  https://kvrn.shop/api/twilio/incoming
 *
 * If NEXT_PUBLIC_SITE_URL is not set, fall back to req.url (will fail validation
 * if the URL was rewritten internally, but fails closed rather than accepting all).
 */
export function getWebhookUrl(req: Request): string {
  const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ?? ''
  if (!siteOrigin) return (req as any).url ?? ''
  const url = new URL((req as any).url)
  return `${siteOrigin}${url.pathname}${url.search}`
}

export async function validateTwilioSignature(
  url:       string,
  params:    Record<string, string>,
  signature: string
): Promise<'valid' | 'invalid' | 'unconfigured'> {
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? ''
  if (!authToken) return 'unconfigured'

  // Build the string Twilio signs: URL + alphabetically sorted key+value pairs
  const sortedKeys = Object.keys(params).sort()
  const toSign     = url + sortedKeys.map(k => k + params[k]).join('')

  const encoder = new TextEncoder()
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(authToken),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    )
  } catch {
    return 'invalid'
  }

  const sigBytes  = await crypto.subtle.sign('HMAC', key, encoder.encode(toSign))
  const computed  = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))

  // Timing-safe comparison
  if (computed.length !== signature.length) return 'invalid'
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0 ? 'valid' : 'invalid'
}

/** Parse an application/x-www-form-urlencoded body into a plain object. */
export function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {}
  new URLSearchParams(body).forEach((v, k) => { params[k] = v })
  return params
}
