// lib/sms-subscribers.ts — SMS subscriber service
// Neon is the source of truth for SMS marketing consent.
// SMS consent is completely independent from email marketing consent.
// Server-only.

import { sql } from './db'

/** Sources accepted from the PUBLIC /api/sms/subscribe endpoint. */
export const PUBLIC_SMS_SOURCES = new Set([
  'homepage', 'waitlist', 'footer', 'giveaway', 'checkout',
])

/** All valid sources including internal-only ones (Twilio webhook, admin code). */
export const ALL_SMS_SOURCES = new Set([
  'homepage', 'waitlist', 'footer', 'giveaway', 'checkout', 'manual_admin', 'sms_keyword',
])

/** @deprecated Use PUBLIC_SMS_SOURCES or ALL_SMS_SOURCES explicitly */
export const ALLOWED_SMS_SOURCES = ALL_SMS_SOURCES

export interface SmsSubscriber {
  id:             string
  phoneE164:      string
  status:         'subscribed' | 'unsubscribed'
  consentSource:  string
  consentedAt:    string
  unsubscribedAt: string | null
  syncStatus:     'synced' | 'pending' | 'failed' | null
  createdAt:      string
}

/** Enrollment is intentionally NOT available via a general-purpose subscriber helper.
 * Only confirmKeywordSms() (signed JOIN -> YES) may create marketing consent.
 * Historical/import consent must be reviewed and migrated through a separately
 * approved process; arbitrary admin/API upserts can never create it.
 */

/**
 * Unsubscribe a phone number. Idempotent.
 * Typically called when Twilio delivers a STOP keyword.
 * Returns false if number was not found.
 */
export async function unsubscribeSmsPhone(
  phoneE164: string,
  source: 'sms_keyword' | 'api' = 'api'
): Promise<boolean> {
  const rows = await sql`
    UPDATE sms_subscribers
    SET status = 'unsubscribed', unsubscribed_at = NOW(),
        twilio_opt_out_state = 'opted_out', updated_at = NOW()
    WHERE phone_e164 = ${phoneE164}
      AND status = 'subscribed'
    RETURNING id
  `
  return (rows as any[]).length > 0
}

/** Durable inbound STOP, including numbers that were never in the subscriber table.
 * An unknown STOP creates a SUPPRESSED row, not a valid opt-in. The schema requires
 * consented_at; for a suppression-only row this timestamp MUST NOT be treated as
 * evidence of affirmative marketing consent. No new marketing path reads it as proof.
 */
export async function suppressInboundSmsPhone(phoneE164: string): Promise<void> {
  await sql`
    INSERT INTO sms_subscribers
      (phone_e164, status, consent_source, consented_at, unsubscribed_at, twilio_opt_out_state)
    VALUES (${phoneE164}, 'unsubscribed', 'sms_keyword', NOW(), NOW(), 'opted_out')
    ON CONFLICT (phone_e164) DO UPDATE
      SET status = 'unsubscribed', unsubscribed_at = NOW(),
          twilio_opt_out_state = 'opted_out', updated_at = NOW()
  `
}

/** START/UNSTOP do not grant marketing consent. Verified YES is required. */

/** Returns true if the phone is locally marked subscribed. */
export async function isLocallySubscribed(phoneE164: string): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM sms_subscribers
    WHERE phone_e164 = ${phoneE164} AND status = 'subscribed'
    LIMIT 1
  `
  return (rows as any[]).length > 0
}

/** Update last sent message SID. */
export async function recordMessageSid(
  phoneE164: string,
  messageSid: string
): Promise<void> {
  await sql`
    UPDATE sms_subscribers
    SET last_twilio_message_sid = ${messageSid}, updated_at = NOW()
    WHERE phone_e164 = ${phoneE164}
  `
}

/** Admin stats. */
export async function getSmsStats(): Promise<{
  total: number
  subscribed: number
  unsubscribed: number
  recent: SmsSubscriber[]
  legacy: { total: number; reviewRequired: number; suppressed: number; keywordReported: number } | null
}> {
  const [stats] = await sql`
    SELECT
      COUNT(*)                                     AS total,
      COUNT(*) FILTER (WHERE status='subscribed')  AS subscribed,
      COUNT(*) FILTER (WHERE status='unsubscribed') AS unsubscribed
    FROM sms_subscribers
  `
  const recent = await sql`
    SELECT id, phone_e164 AS "phoneE164", status,
           consent_source AS "consentSource",
           consented_at AS "consentedAt", unsubscribed_at AS "unsubscribedAt",
           sync_status AS "syncStatus", created_at AS "createdAt"
    FROM sms_subscribers
    ORDER BY created_at DESC
    LIMIT 50
  `
  let legacy: { total: number; reviewRequired: number; suppressed: number; keywordReported: number } | null = null
  try {
    const [r] = await sql`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE record_state='review_required') AS review_required,
        COUNT(*) FILTER (WHERE record_state='suppressed') AS suppressed,
        COUNT(*) FILTER (WHERE reported_keyword IS NOT NULL AND reported_keyword <> '') AS keyword_reported
      FROM legacy_sms_import_contacts
    `
    legacy = { total: Number(r.total), reviewRequired: Number(r.review_required),
      suppressed: Number(r.suppressed), keywordReported: Number(r.keyword_reported) }
  } catch (e) {
    // Additive migration 066 may not be installed yet. Never report reviewed opt-in eligibility.
    console.warn('[sms] legacy subscriber quarantine is not available')
  }
  const s = stats as any
  return {
    total:        Number(s.total),
    subscribed:   Number(s.subscribed),
    unsubscribed: Number(s.unsubscribed),
    recent:       recent as SmsSubscriber[],
    legacy,
  }
}

/** Upsert a message status record (idempotent). */
export async function upsertMessageStatus(opts: {
  sid:     string
  phone:   string
  status:  string
  errorCode?: string | null
  direction?: string
}): Promise<void> {
  await sql`
    INSERT INTO sms_messages (twilio_message_sid, phone_e164, direction, status, error_code)
    VALUES (${opts.sid}, ${opts.phone}, ${opts.direction ?? 'outbound'}, ${opts.status}, ${opts.errorCode ?? null})
    ON CONFLICT (twilio_message_sid) DO UPDATE
      SET status = EXCLUDED.status, error_code = EXCLUDED.error_code, updated_at = NOW()
  `
}
