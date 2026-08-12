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

/**
 * Subscribe (or re-subscribe) a phone number.
 * Idempotent: existing subscribed row → no-op.
 * Existing unsubscribed row → re-subscribes.
 */
export async function upsertSmsSubscriber(opts: {
  phoneE164:     string   // must be pre-normalized E.164
  consentSource: string
}): Promise<{ id: string; isNew: boolean }> {
  const rows = await sql`
    INSERT INTO sms_subscribers (phone_e164, status, consent_source, consented_at)
    VALUES (${opts.phoneE164}, 'subscribed', ${opts.consentSource}, NOW())
    ON CONFLICT (phone_e164) DO UPDATE
      SET
        status          = 'subscribed',
        consent_source  = EXCLUDED.consent_source,
        consented_at    = CASE
          WHEN sms_subscribers.status = 'unsubscribed' THEN NOW()
          ELSE sms_subscribers.consented_at
        END,
        unsubscribed_at = NULL,
        updated_at      = NOW()
    RETURNING id, (xmax = 0) AS is_new
  `
  const row = (rows as any[])[0]
  return { id: row.id as string, isNew: Boolean(row.is_new) }
}

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

/** Re-subscribe a phone number (e.g. after Twilio START keyword). */
export async function resubscribeSmsPhone(
  phoneE164: string,
  source = 'sms_keyword'
): Promise<boolean> {
  const rows = await sql`
    UPDATE sms_subscribers
    SET status = 'subscribed', unsubscribed_at = NULL,
        consent_source = ${source}, consented_at = NOW(),
        twilio_opt_out_state = 'opted_in', updated_at = NOW()
    WHERE phone_e164 = ${phoneE164}
      AND status = 'unsubscribed'
    RETURNING id
  `
  return (rows as any[]).length > 0
}

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
  const s = stats as any
  return {
    total:        Number(s.total),
    subscribed:   Number(s.subscribed),
    unsubscribed: Number(s.unsubscribed),
    recent:       recent as SmsSubscriber[],
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
