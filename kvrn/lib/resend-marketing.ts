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
  providerTopicOptOut?: boolean // only after authenticated exact-contact/topic read
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
 *   POST /contacts { email, first_name, last_name } (never force provider unsubscribe=false)
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
  const apiKey    = process.env.RESEND_MARKETING_API_KEY    ?? ''
  const segmentId = process.env.RESEND_MARKETING_SEGMENT_ID ?? ''
  const topicId   = process.env.RESEND_MARKETING_TOPIC_ID   ?? ''

  if (!apiKey)    return { ok: false, error: 'RESEND_MARKETING_API_KEY not configured.' }
  if (!segmentId) return { ok: false, error: 'RESEND_MARKETING_SEGMENT_ID not configured.' }
  if (!topicId)   return { ok: false, error: 'RESEND_MARKETING_TOPIC_ID not configured.' }

  // ── Step 1: Create global Contact (idempotent by email) ───────────────────
  const contactBody: Record<string, unknown> = {
    email:        opts.email,
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

  // A Resend-level unsubscribe is authoritative even if KVRN has stale state.
  // Never re-enable a provider-suppressed contact via this sync path.
  if (contactRes.data?.unsubscribed === true || contactRes.data?.contact?.unsubscribed === true) {
    return { ok: false, contactId, error: 'Provider-suppressed contact requires reconciliation.' }
  }

  // A create/upsert response is not guaranteed to include provider opt-out
  // metadata. Retrieve the authoritative contact state before ANY operation
  // that could enroll the recipient into a marketing audience. If the provider
  // omits the flag or the request fails, fail closed and leave sync pending.
  // Official endpoint: GET /contacts/:contact_id (Resend Retrieve Contact).
  const contactState = await resendCall('GET', `/contacts/${encodeURIComponent(contactId)}`, apiKey)
  const providerRecord = contactState.data?.contact ?? contactState.data
  if (!contactState.ok || providerRecord?.unsubscribed !== false ||
      (typeof providerRecord?.email === 'string' &&
       providerRecord.email.trim().toLowerCase() !== opts.email.trim().toLowerCase())) {
    return { ok: false, contactId, error: 'Provider consent status unknown or suppressed; reconcile.' }
  }

  // A global contact can be subscribed while having independently opted OUT
  // of this specific topic in Resend. A KVRN web form assertion cannot
  // override that provider-side revocation. Fail closed on unknown, paginated
  // or malformed topic state. This also protects against topic-level opt-outs
  // received before the Resend webhook is configured.
  const existingTopics = await resendCall('GET', `/contacts/${encodeURIComponent(contactId)}/topics`, apiKey)
  const topicRows = existingTopics.data?.data
  if (existingTopics.ok && Array.isArray(topicRows) && existingTopics.data?.has_more !== true &&
      topicRows.some((topic: any) => topic?.id === topicId && topic.subscription === 'opt_out')) {
    return { ok: false, contactId, providerTopicOptOut: true,
      error: 'Provider topic opted out; local suppression must be recorded.' }
  }
  if (!existingTopics.ok || !Array.isArray(topicRows) || existingTopics.data?.has_more === true ||
      topicRows.some((topic: any) => topic?.id === topicId && topic.subscription !== 'opt_in')) {
    return { ok: false, contactId, error: 'Provider topic consent unknown or opted out; reconcile.' }
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
  const topicRes = await resendCall(
    'PATCH',
    `/contacts/${contactId}/topics`,
    apiKey,
    { topics: [{ id: topicId, subscription: 'opt_in' }] }
  )
  if (!topicRes.ok) {
    return {
      ok:        false,
      contactId,
      error: `Resend topic subscription returned HTTP ${topicRes.status}.`,
    }
  }

  // Do not report provider sync as reconciled unless the exact KVRN topic is
  // confirmed opted-in AND the global contact remains subscribed. These
  // reads are not permission to SEND; suppression must still be checked at
  // actual dispatch time (currently disabled).
  const verifiedTopics = await resendCall('GET', `/contacts/${encodeURIComponent(contactId)}/topics`, apiKey)
  const currentTopics = verifiedTopics.data?.data
  const verifiedContact = await resendCall('GET', `/contacts/${encodeURIComponent(contactId)}`, apiKey)
  const currentContact = verifiedContact.data?.contact ?? verifiedContact.data
  if (!verifiedTopics.ok || !Array.isArray(currentTopics) || verifiedTopics.data?.has_more === true ||
      !currentTopics.some((topic: any) => topic?.id === topicId && topic.subscription === 'opt_in') ||
      !verifiedContact.ok || currentContact?.unsubscribed !== false ||
      typeof currentContact?.email !== 'string' ||
      currentContact.email.trim().toLowerCase() !== opts.email.trim().toLowerCase()) {
    return { ok: false, contactId, error: 'Provider post-sync consent status cannot be verified.' }
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
  email?: string | null
}): Promise<ResendSyncResult> {
  const apiKey    = process.env.RESEND_MARKETING_API_KEY    ?? ''
  const segmentId = process.env.RESEND_MARKETING_SEGMENT_ID ?? ''
  const topicId   = process.env.RESEND_MARKETING_TOPIC_ID   ?? ''
  let contactId = opts.contactId

  if (!apiKey)    return { ok: false, error: 'RESEND_MARKETING_API_KEY not configured.' }
  if (!segmentId) return { ok: false, error: 'RESEND_MARKETING_SEGMENT_ID not configured.' }
  // Both provider exclusions are required before an opt-out can be reconciled.
  // Silently skipping the Topic opt-out and returning success risks future
  // topic-targeted sends even when Segment removal succeeded.
  if (!topicId)   return { ok: false, error: 'RESEND_MARKETING_TOPIC_ID not configured; opt-out pending.' }
  if (!contactId && opts.email) {
    // A webhook may have suppressed an address before KVRN persisted its
    // provider ID. Resend supports lookup by email. Never mark the local
    // suppression as reconciled unless the returned contact identity matches.
    const email = opts.email.trim().toLowerCase()
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'Provider contact lookup requires a valid address.' }
    }
    const lookup = await resendCall('GET', `/contacts/${encodeURIComponent(email)}`, apiKey)
    const record = lookup.data?.contact ?? lookup.data
    if (!lookup.ok || typeof record?.id !== 'string' ||
        typeof record?.email !== 'string' || record.email.trim().toLowerCase() !== email) {
      return { ok: false, error: 'Provider contact lookup could not be verified; reconcile unsubscribe.' }
    }
    contactId = record.id
  }
  if (!contactId) {
    // Absence of a recorded ID does NOT prove Resend has no contact.
    return { ok: false, error: 'Provider contact ID missing; reconcile unsubscribe.' }
  }
  if (opts.email) {
    // The saved provider ID could be stale, imported incorrectly or reassigned
    // in an external reconciliation. Never change another contact's preferences
    // without confirming it belongs to the locally suppressed address.
    const expectedEmail = opts.email.trim().toLowerCase()
    const identity = await resendCall('GET', `/contacts/${encodeURIComponent(contactId)}`, apiKey)
    const record = identity.data?.contact ?? identity.data
    if (!identity.ok || typeof record?.email !== 'string' ||
        record.email.trim().toLowerCase() !== expectedEmail) {
      return { ok: false, contactId, error: 'Provider identity mismatch; suppression requires reconciliation.' }
    }
  }

  // ── Step 1: Opt out of KVRN Updates Topic ────────────────────────────────
  const topicRes = await resendCall(
    'PATCH',
    `/contacts/${encodeURIComponent(contactId)}/topics`,
    apiKey,
    { topics: [{ id: topicId, subscription: 'opt_out' }] }
  )
  // ── Step 2: Remove from KVRN Marketing Segment ───────────────────────────
  // Attempt both independent exclusions even if one failed. Removing a
  // segment is still protective when topic opt-out returns a transient error.
  // Do not mark synced unless both have succeeded and topic state verifies.
  const segRes = await resendCall(
    'DELETE',
    `/contacts/${encodeURIComponent(contactId)}/segments/${encodeURIComponent(segmentId)}`,
    apiKey
  )
  if (!topicRes.ok) {
    return {
      ok: false,
      contactId,
      error: `Resend topic unsubscribe returned HTTP ${topicRes.status}; local suppression retained.`,
    }
  }
  if (!segRes.ok) {
    return {
      ok:    false,
      contactId,
      error: `Resend segment removal returned HTTP ${segRes.status}.`,
    }
  }

  const verify = await resendCall('GET', `/contacts/${encodeURIComponent(contactId)}/topics`, apiKey)
  if (!verify.ok || !Array.isArray(verify.data?.data) || verify.data?.has_more === true ||
      !verify.data.data.some((topic: any) => topic?.id === topicId && topic.subscription === 'opt_out')) {
    return { ok: false, contactId, error: 'Resend topic opt-out could not be verified; reconcile.' }
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
}): Promise<ResendSyncResult> {
  if (sub.status === 'subscribed') {
    return syncSubscribeToResend({
      email:     sub.email,
      firstName: sub.firstName,
      lastName:  sub.lastName,
    })
  } else {
    return syncUnsubscribeFromResend({ contactId: sub.resendContactId, email: sub.email })
  }
}
