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

/**
 * Subscribe (or re-subscribe) a marketing email address.
 * - New address → INSERT with status=subscribed
 * - Existing subscribed → no-op (returns existing id)
 * - Existing unsubscribed → re-subscribe: clear unsubscribed_at, update consent
 * Email must already be normalised before calling.
 */
export async function upsertSubscriber(opts: {
  email:         string    // must be pre-normalised
  firstName?:    string | null
  lastName?:     string | null
  consentSource: string
}): Promise<UpsertResult> {
  const { email, firstName = null, lastName = null, consentSource } = opts

  const rows = await sql`
    INSERT INTO marketing_subscribers
      (email, first_name, last_name, status, consent_source, consented_at, sync_status)
    VALUES
      (${email}, ${firstName}, ${lastName}, 'subscribed', ${consentSource}, NOW(), 'pending')
    ON CONFLICT (email) DO UPDATE
      SET
        status          = 'subscribed',
        consent_source  = EXCLUDED.consent_source,
        consented_at    = CASE
          WHEN marketing_subscribers.status = 'unsubscribed' THEN NOW()
          ELSE marketing_subscribers.consented_at
        END,
        unsubscribed_at = NULL,
        first_name      = COALESCE(EXCLUDED.first_name, marketing_subscribers.first_name),
        last_name       = COALESCE(EXCLUDED.last_name,  marketing_subscribers.last_name),
        sync_status     = CASE
          WHEN marketing_subscribers.status = 'unsubscribed' THEN 'pending'
          WHEN marketing_subscribers.sync_status = 'synced'  THEN 'synced'
          ELSE 'pending'
        END,
        updated_at      = NOW()
    RETURNING id, (xmax = 0) AS is_new
  `
  const row = (rows as any[])[0]
  return { id: row.id as string, isNew: Boolean(row.is_new) }
}

/**
 * Unsubscribe a marketing email. Idempotent — safe to call multiple times.
 * Returns false if the email was not found.
 */
export async function unsubscribeByEmail(email: string): Promise<boolean> {
  const rows = await sql`
    UPDATE marketing_subscribers
    SET status = 'unsubscribed', unsubscribed_at = NOW(),
        sync_status = 'pending', updated_at = NOW()
    WHERE email = ${email}
      AND status = 'subscribed'
    RETURNING id
  `
  return (rows as any[]).length > 0
}

/**
 * Update sync state after a Resend API call.
 */
export async function updateSyncStatus(
  id:               string,
  status:           'synced' | 'failed',
  resendContactId?: string | null,
  error?:           string | null
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
  `
}

/**
 * Fetch subscribers that need Resend sync.
 * Includes: status=subscribed|unsubscribed AND sync_status=pending|failed.
 */
export async function getPendingSyncs(limit = 50): Promise<MarketingSubscriber[]> {
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
    ORDER BY created_at
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
