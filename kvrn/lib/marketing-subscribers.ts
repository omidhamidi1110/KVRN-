// lib/marketing-subscribers.ts — Marketing subscriber service
// Neon is the source of truth for marketing consent.
// Server-only. Never import in client components.

import { sql } from './db'

// ── Constants ─────────────────────────────────────────────────────────────────

export const ALLOWED_CONSENT_SOURCES = new Set([
  'homepage', 'waitlist', 'checkout', 'footer', 'giveaway', 'manual_admin',
])

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MarketingSubscriber {
  id:              string
  email:           string
  firstName:       string | null
  lastName:        string | null
  status:          'subscribed' | 'unsubscribed'
  consentSource:   string
  consentedAt:     string
  unsubscribedAt:  string | null
  resendContactId: string | null
  syncStatus:      'synced' | 'pending' | 'failed' | null
  syncError:       string | null
  createdAt:       string
}

export interface UpsertResult {
  id:    string
  isNew: boolean
}

// ── Normalisation ─────────────────────────────────────────────────────────────

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

// ── DB operations ─────────────────────────────────────────────────────────────

/** Enroll or refresh a public email-list assertion with append-only evidence.
 * IMPORTANT: the public form does not verify mailbox control. An address that has
 * unsubscribed stays suppressed; it cannot be reactivated by a stranger typing it.
 * Future verified re-opt-in is a separate workflow and requires owner approval.
 * Migration 044 must exist before any new public marketing enrollment can succeed.
 */
export async function upsertSubscriber(opts: {
  email: string
  firstName?: string | null
  lastName?: string | null
  consentSource: string
}): Promise<UpsertResult> {
  const { email, firstName = null, lastName = null, consentSource } = opts
  if (!ALLOWED_CONSENT_SOURCES.has(consentSource)) throw Error('INVALID_EMAIL_CONSENT_SOURCE')
  const rows = await sql`
    WITH enrolled AS (
      INSERT INTO marketing_subscribers
        (email, first_name, last_name, status, consent_source, consented_at, sync_status)
      VALUES
        (${email}, ${firstName}, ${lastName}, 'subscribed', ${consentSource}, NOW(), 'pending')
      ON CONFLICT (email) DO UPDATE
      SET
        -- Never undo a prior unsubscribe based only on an unverified web form.
        status = marketing_subscribers.status,
        consent_source = marketing_subscribers.consent_source,
        consented_at = marketing_subscribers.consented_at,
        unsubscribed_at = marketing_subscribers.unsubscribed_at,
        sync_status = marketing_subscribers.sync_status,
        first_name = COALESCE(marketing_subscribers.first_name, EXCLUDED.first_name),
        last_name = COALESCE(marketing_subscribers.last_name, EXCLUDED.last_name),
        updated_at = NOW()
      RETURNING id, status, (xmax = 0) AS is_new
    ), evidence AS (
      INSERT INTO marketing_email_consent_events (subscriber_id,event_type,source,statement_version)
      SELECT id,CASE WHEN status='subscribed' THEN 'affirmative_checkbox' ELSE 'resubscribe_requested' END,
             ${consentSource},'KVRN-email-2026-10-08-checkbox-v1'
      FROM enrolled RETURNING subscriber_id
    )
    SELECT enrolled.id,enrolled.is_new FROM enrolled INNER JOIN evidence ON evidence.subscriber_id=enrolled.id
  `
  const row = (rows as any[])[0]
  if (!row) throw Error('EMAIL_CONSENT_NOT_RECORDED')
  return { id: String(row.id), isNew: Boolean(row.is_new) }
}

/** Opt-outs must never fail because an optional marketing history migration is absent.
 * First perform the canonical suppression update. The append-only event is best-effort;
 * missing migration 044 must not turn consent back on or block a STOP request.
 */
async function recordUnsubscribeEvidence(id: string, source: 'support_staff' | 'signed_self_service'): Promise<void> {
  try {
    await sql`
      INSERT INTO marketing_email_consent_events(subscriber_id,event_type,source,statement_version)
      VALUES(${id}::uuid,'unsubscribed',${source},'KVRN-email-2026-10-08-checkbox-v1')
    `
  } catch {
    // Migration 044 may not exist yet. The local unsubscribe remains durable.
    console.error('[marketing-consent] Audit event unavailable; suppression saved.')
  }
}

/** Idempotent marketing suppression by contact ID. Never alters transactional mail. */
export async function revokeMarketingSubscriberById(id: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw Error('INVALID_MARKETING_CONTACT')
  }
  const rows = await sql`
    UPDATE marketing_subscribers
      SET status='unsubscribed', unsubscribed_at=NOW(), sync_status='pending', updated_at=NOW()
      WHERE id=${id}::uuid AND status='subscribed' RETURNING id
  `
  if (rows.length) await recordUnsubscribeEvidence(String(rows[0].id), 'signed_self_service')
}

/** Admin-authorized support opt-out. Preserve suppression even when this email
 * was NOT previously in the list. Never creates a subscribed contact.
 * Artificial consented_at on a suppression-only row is just legacy schema's
 * NOT NULL requirement; it is not evidence of opt-in.
 */
export async function suppressMarketingEmailFromSupport(emailInput: string): Promise<void> {
  const email = normaliseEmail(emailInput)
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('INVALID_EMAIL')
  const rows = await sql`
    INSERT INTO marketing_subscribers
      (email, status, consent_source, consented_at, unsubscribed_at, sync_status)
    VALUES(${email},'unsubscribed','manual_admin',NOW(),NOW(),'pending')
    ON CONFLICT(email) DO UPDATE
    SET status='unsubscribed', unsubscribed_at=COALESCE(marketing_subscribers.unsubscribed_at,NOW()),
        sync_status='pending', updated_at=NOW()
    RETURNING id
  `
  if (!rows[0]?.id) throw Error('SUPPRESSION_NOT_SAVED')
  await recordUnsubscribeEvidence(String(rows[0].id), 'support_staff')
}

/** Returns false when the email wasn't currently subscribed; no PII in logs. */
export async function unsubscribeByEmail(email: string): Promise<boolean> {
  const rows = await sql`
    UPDATE marketing_subscribers
      SET status='unsubscribed', unsubscribed_at=NOW(), sync_status='pending', updated_at=NOW()
      WHERE email=${normaliseEmail(email)} AND status='subscribed' RETURNING id
  `
  if (!rows.length) return false
  await recordUnsubscribeEvidence(String(rows[0].id), 'support_staff')
  return true
}

/**
 * Update sync state after a Resend API call.
 */
/** Current local state is authoritative after a network round-trip.
 * Use this to detect revocation that happened while Resend was responding.
 */
export async function getMarketingSyncState(id: string): Promise<'subscribed' | 'unsubscribed' | null> {
  const rows = await sql`SELECT status FROM marketing_subscribers WHERE id = ${id}::uuid LIMIT 1`
  const state = rows[0]?.status
  return state === 'subscribed' || state === 'unsubscribed' ? state : null
}

/** Provider-side topic opt-out is NOT a new marketing enrollment.
 * This is called only after the adapter checked the exact provider contact's
 * email and found an explicit opt_out for KVRN's configured marketing topic.
 * One database function applies the STOP and appends the evidence atomically.
 * Requires proposed migration 047; failure leaves provider sync incomplete.
 */
export async function suppressMarketingEmailFromResendTopic(
  id: string, email: string, providerContactId: string
): Promise<boolean> {
  const rows = await sql`
    SELECT kvrn_resend_topic_suppress_marketing(
      ${id}::uuid, ${normaliseEmail(email)}, ${providerContactId}
    ) AS recorded
  `
  return rows[0]?.recorded === true
}

export async function updateSyncStatus(
  id:               string,
  status:           'synced' | 'failed',
  resendContactId?: string | null,
  error?:           string | null,
  expectedStatus:   'subscribed' | 'unsubscribed' = 'subscribed'
): Promise<void> {
  await sql`
    UPDATE marketing_subscribers
    SET
      sync_status       = ${status},
      sync_error        = ${error ?? null},
      resend_contact_id = COALESCE(${resendContactId ?? null}, resend_contact_id),
      last_synced_at    = NOW(),
      updated_at        = NOW()
    WHERE id = ${id}
      AND status = ${expectedStatus}
  `
  if (expectedStatus === 'subscribed' && resendContactId) {
    // If a STOP raced with provider contact creation, retain the contact ID so
    // the suppression worker can reach the external record on its next pass.
    await sql`
      UPDATE marketing_subscribers
      SET resend_contact_id = ${resendContactId}, sync_status = 'pending', updated_at = NOW()
      WHERE id = ${id}::uuid AND status = 'unsubscribed' AND resend_contact_id IS NULL
    `
  }
}

/** Enforce a fresh, local affirmative email-consent event before opting in
 * to any external marketing provider. Legacy/imported rows are NOT proof.
 * This check is a defense, not a guarantee against a later concurrent STOP;
 * provider send safety must independently recheck suppression before dispatch.
 */
export async function getVerifiedResendOptIn(id: string): Promise<MarketingSubscriber | null> {
  const rows = await sql`
    SELECT ms.id, ms.email, ms.first_name AS "firstName", ms.last_name AS "lastName",
      ms.status, ms.consent_source AS "consentSource", ms.consented_at AS "consentedAt",
      ms.unsubscribed_at AS "unsubscribedAt", ms.resend_contact_id AS "resendContactId",
      ms.sync_status AS "syncStatus", ms.sync_error AS "syncError", ms.created_at AS "createdAt"
    FROM marketing_subscribers ms
    WHERE ms.id = ${id}::uuid
      AND ms.status = 'subscribed'
      AND ms.unsubscribed_at IS NULL
      AND ms.sync_status IN ('pending', 'failed')
      AND EXISTS (
        SELECT 1 FROM marketing_email_consent_events e
        WHERE e.subscriber_id = ms.id
          AND e.event_type = 'affirmative_checkbox'
          AND e.source IN ('homepage', 'footer', 'waitlist')
      )
      AND NOT EXISTS (
        SELECT 1 FROM marketing_email_consent_events e
        WHERE e.subscriber_id = ms.id AND e.event_type = 'unsubscribed'
      )
    LIMIT 1
  `
  return (rows[0] as MarketingSubscriber | undefined) ?? null
}

/**
 * Fetch subscribers that need Resend sync.
 * Includes: status=subscribed|unsubscribed AND sync_status=pending|failed.
 */
export async function getPendingSyncs(limit = 50, includeSubscribed = true): Promise<MarketingSubscriber[]> {
  const rows = await sql`
    SELECT
      id, email, first_name AS "firstName", last_name AS "lastName",
      status, consent_source AS "consentSource",
      consented_at AS "consentedAt", unsubscribed_at AS "unsubscribedAt",
      resend_contact_id AS "resendContactId",
      sync_status AS "syncStatus", sync_error AS "syncError",
      created_at AS "createdAt"
    FROM marketing_subscribers
    WHERE sync_status IN ('pending', 'failed')
      AND (status = 'unsubscribed' OR ${includeSubscribed})
    -- Opt-in records are ignored entirely when opt-in sync is disabled, so
    -- STOP reconciliation cannot be starved by a backlog of new signups.
    -- Suppression events cannot be starved by a backlog of opt-in records.
    ORDER BY CASE WHEN status = 'unsubscribed' THEN 0 ELSE 1 END, updated_at
    LIMIT ${limit}
  `
  return rows as MarketingSubscriber[]
}

/**
 * Admin list with counts and recent subscribers.
 */
export async function getSubscriberStats(): Promise<{
  total: number
  subscribed: number
  unsubscribed: number
  recent: MarketingSubscriber[]
}> {
  const [stats] = await sql`
    SELECT
      COUNT(*)                                     AS total,
      COUNT(*) FILTER (WHERE status='subscribed')  AS subscribed,
      COUNT(*) FILTER (WHERE status='unsubscribed') AS unsubscribed
    FROM marketing_subscribers
  `
  const recent = await sql`
    SELECT
      id, email, first_name AS "firstName", last_name AS "lastName",
      status, consent_source AS "consentSource",
      consented_at AS "consentedAt", unsubscribed_at AS "unsubscribedAt",
      resend_contact_id AS "resendContactId",
      sync_status AS "syncStatus", sync_error AS "syncError",
      created_at AS "createdAt"
    FROM marketing_subscribers
    ORDER BY created_at DESC
    LIMIT 50
  `
  const s = stats as any
  return {
    total:        Number(s.total),
    subscribed:   Number(s.subscribed),
    unsubscribed: Number(s.unsubscribed),
    recent:       recent as MarketingSubscriber[],
  }
}
