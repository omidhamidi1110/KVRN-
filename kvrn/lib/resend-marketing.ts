// lib/resend-marketing.ts — Resend global Contact sync for KVRN marketing
// Server-only. Never import in client components.
//
// Resend current API model (audiences/legacy API is NOT used here):
//   Contacts    — global entities identified by email, managed via /contacts
//   Segments    — organizational groupings; contacts added via /contacts/{id}/segments/{segId}
//   Topics      — subscription preferences; updated via PATCH /contacts/{id}/topics
//   Broadcasts  — campaign emails sent to Segment/Topic combinations
//
// KVRN Resend resources (created once in Resend dashboard, IDs set as Cloudflare env vars):
//   RESEND_MARKETING_SEGMENT_ID  — "KVRN Marketing" segment ID
//   RESEND_MARKETING_TOPIC_ID    — "KVRN Updates" topic ID
//
// Sync semantics:
//   ALL THREE steps (Contact + Segment + Topic) must succeed to mark sync_status='synced'.
//   A partial success preserves the contactId in Neon but leaves sync_status='failed'
//   so the cron can retry the failed step.

const RESEND_API = 'https://api.resend.com'

export interface ResendSyncResult {
  ok:         boolean
  contactId?: string   // returned even on partial failure — stored for retry
  error?:     string   // safe, no PII
}

type ResendStep = 'contact' | 'segment' | 'topic'

/** Internal helper — make one Resend API call and return { ok, data, status }. */
async function resendCall(
  method:  string,
  path:    string,
  apiKey:  string,
  body?:   unknown
): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`${RESEND_API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    return { ok: false, status: 0, data: null }
  }

  let data: any = null
  try { data = await res.json() } catch {}
  return { ok: res.ok, status: res.status, data }
}

// ── Subscribe ─────────────────────────────────────────────────────────────────

/**
 * Sync a marketing subscriber to Resend.
 * All three steps (Contact, Segment, Topic) must succeed for ok=true.
 *
 * Step 1 — Create/update global Contact:
 *   POST /contacts  { email, first_name, last_name, unsubscribed: false }
 *   (Resend deduplicates by email — idempotent)
 *
 * Step 2 — Add to KVRN Marketing Segment:
 *   POST /contacts/{contactId}/segments/{RESEND_MARKETING_SEGMENT_ID}
 *
 * Step 3 — Subscribe to KVRN Updates Topic:
 *   PATCH /contacts/{contactId}/topics  [{ id, subscription: 'opt_in' }]
 *
 * contactId is returned even on partial failure so Neon can store it for retry.
 */
export async function syncSubscribeToResend(opts: {
  email:      string
  firstName:  string | null
  lastName:   string | null
}): Promise<ResendSyncResult> {
  const apiKey    = process.env.RESEND_API_KEY              ?? ''
  const segmentId = process.env.RESEND_MARKETING_SEGMENT_ID ?? ''
  const topicId   = process.env.RESEND_MARKETING_TOPIC_ID   ?? ''

  if (!apiKey)    return { ok: false, error: 'RESEND_API_KEY not configured.' }
  if (!segmentId) return { ok: false, error: 'RESEND_MARKETING_SEGMENT_ID not configured.' }

  // ── Step 1: Create global Contact (idempotent by email) ───────────────────
  const contactBody: Record<string, unknown> = {
    email:        opts.email,
    unsubscribed: false,
  }
  if (opts.firstName) contactBody.first_name = opts.firstName
  if (opts.lastName)  contactBody.last_name  = opts.lastName

  const contactRes = await resendCall('POST', '/contacts', apiKey, contactBody)
  if (!contactRes.ok) {
    return {
      ok:    false,
      error: `Resend /contacts returned HTTP ${contactRes.status}.`,
    }
  }
  const contactId: string | undefined =
    contactRes.data?.id ?? contactRes.data?.contact?.id
  if (!contactId) {
    return { ok: false, error: 'Resend /contacts returned no contact ID.' }
  }

  // ── Step 2: Add to KVRN Marketing Segment ────────────────────────────────
  const segRes = await resendCall(
    'POST',
    `/contacts/${contactId}/segments/${segmentId}`,
    apiKey
  )
  if (!segRes.ok) {
    return {
      ok:        false,
      contactId,
      error: `Resend segment membership returned HTTP ${segRes.status}.`,
    }
  }

  // ── Step 3: Subscribe to KVRN Updates Topic ───────────────────────────────
  // Required for marketing consent — failure is NOT silently ignored.
  if (!topicId) {
    // Topic not configured — mark failed so cron can retry when configured
    return {
      ok:        false,
      contactId,
      error: 'RESEND_MARKETING_TOPIC_ID not configured.',
    }
  }

  const topicRes = await resendCall(
    'PATCH',
    `/contacts/${contactId}/topics`,
    apiKey,
    [{ id: topicId, subscription: 'opt_in' }]
  )
  if (!topicRes.ok) {
    return {
      ok:        false,
      contactId,
      error: `Resend topic subscription returned HTTP ${topicRes.status}.`,
    }
  }

  return { ok: true, contactId }
}

// ── Unsubscribe ───────────────────────────────────────────────────────────────

/**
 * Sync a marketing unsubscribe to Resend.
 * Both steps must succeed for ok=true.
 *
 * Step 1 — Unsubscribe from KVRN Updates Topic:
 *   PATCH /contacts/{contactId}/topics  [{ id, subscription: 'opt_out' }]
 *
 * Step 2 — Remove from KVRN Marketing Segment:
 *   DELETE /contacts/{contactId}/segments/{RESEND_MARKETING_SEGMENT_ID}
 *
 * Note: We do NOT set global Contact.unsubscribed=true — that would block
 * ALL Resend email including future transactional. Broadcast unsubscribes
 * (from {{{RESEND_UNSUBSCRIBE_URL}}} in campaign emails) are managed by
 * Resend's own mechanism and set the global flag automatically.
 * Our API-driven unsubscribe removes from Segment + sets Topic to opt_out.
 */
export async function syncUnsubscribeFromResend(opts: {
  contactId: string | null
}): Promise<ResendSyncResult> {
  const apiKey    = process.env.RESEND_API_KEY              ?? ''
  const segmentId = process.env.RESEND_MARKETING_SEGMENT_ID ?? ''
  const topicId   = process.env.RESEND_MARKETING_TOPIC_ID   ?? ''
  const contactId = opts.contactId

  if (!apiKey)    return { ok: false, error: 'RESEND_API_KEY not configured.' }
  if (!segmentId) return { ok: false, error: 'RESEND_MARKETING_SEGMENT_ID not configured.' }
  if (!contactId) {
    // No stored contact ID — nothing to sync (consent was never synced to Resend)
    return { ok: true }
  }

  // ── Step 1: Opt out of KVRN Updates Topic ────────────────────────────────
  if (topicId) {
    const topicRes = await resendCall(
      'PATCH',
      `/contacts/${contactId}/topics`,
      apiKey,
      [{ id: topicId, subscription: 'opt_out' }]
    )
    if (!topicRes.ok) {
      return {
        ok:    false,
        contactId,
        error: `Resend topic unsubscribe returned HTTP ${topicRes.status}.`,
      }
    }
  }

  // ── Step 2: Remove from KVRN Marketing Segment ───────────────────────────
  const segRes = await resendCall(
    'DELETE',
    `/contacts/${contactId}/segments/${segmentId}`,
    apiKey
  )
  if (!segRes.ok) {
    return {
      ok:    false,
      contactId,
      error: `Resend segment removal returned HTTP ${segRes.status}.`,
    }
  }

  return { ok: true, contactId }
}

// ── Cron batch ────────────────────────────────────────────────────────────────

export async function syncOnePendingSubscriber(sub: {
  id:              string
  email:           string
  firstName:       string | null
  lastName:        string | null
  status:          'subscribed' | 'unsubscribed'
  resendContactId: string | null
}): Promise<{ ok: boolean; contactId?: string; error?: string }> {
  if (sub.status === 'subscribed') {
    return syncSubscribeToResend({
      email:     sub.email,
      firstName: sub.firstName,
      lastName:  sub.lastName,
    })
  } else {
    return syncUnsubscribeFromResend({ contactId: sub.resendContactId })
  }
}
