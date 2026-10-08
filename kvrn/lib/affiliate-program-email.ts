// lib/affiliate-program-email.ts — transactional program emails through the existing Resend adapter.
//
// Rows are enqueued in affiliate_email_outbox INSIDE the same SQL transaction as the state change
// (so nothing is lost), then sent best-effort. A failure here never alters any application, affiliate or
// financial state. Content is concise and carries no secrets, no private notes, no tax/KYC/bank data.
// Invite emails contain a one-time token that is NEVER stored: they are sent directly and, if sending
// fails, the Admin resends (which rotates the token).

import type { EmailProvider } from './resend-adapter'
import { getSiteOrigin } from './site-origin'

type Sql = any

export const AFFILIATE_EMAIL_KINDS = [
  'application_received', 'application_approved', 'application_rejected', 'application_needs_info',
  'affiliate_invite', 'affiliate_suspended', 'affiliate_terminated', 'affiliate_activated', 'terms_update',
] as const
export type AffiliateEmailKind = typeof AFFILIATE_EMAIL_KINDS[number]

const MAX_ATTEMPTS = 5
const RETRY_MS = [0, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000]

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function fromAddress(): string {
  const name = process.env.RESEND_FROM_NAME ?? 'KVRN'
  const email = process.env.RESEND_FROM_EMAIL ?? 'orders@send.kvrn.shop'
  return process.env.TRANSACTIONAL_EMAIL_FROM ?? `${name} <${email}>`
}
const replyTo = () => process.env.TRANSACTIONAL_EMAIL_REPLY_TO ?? 'support@kvrn.shop'

const S = {
  body: 'font-family:-apple-system,Helvetica Neue,sans-serif;color:#1A1A1A;background:#FAFAF8;margin:0;padding:0;',
  wrap: 'max-width:560px;margin:0 auto;padding:48px 24px;',
  logo: 'font-size:15px;letter-spacing:0.1em;text-transform:uppercase;font-weight:300;color:#1A1A1A;text-decoration:none;',
  h1: 'font-size:22px;font-weight:300;letter-spacing:-0.02em;margin:32px 0 8px;',
  p: 'font-size:14px;color:#4A4A46;line-height:1.6;margin:0 0 16px;',
  btn: 'display:inline-block;background:#1A1A1A;color:#fff;text-decoration:none;font-size:13px;padding:12px 22px;',
  footer: 'margin-top:40px;font-size:11px;color:#9B9B9B;',
}

function layout(origin: string, title: string, paras: string[], cta?: { label: string; href: string }): string {
  return `<!doctype html><html><body style="${S.body}"><div style="${S.wrap}">
<a href="${esc(origin)}" style="${S.logo}">KVRN</a>
<h1 style="${S.h1}">${esc(title)}</h1>
${paras.map(p => `<p style="${S.p}">${p}</p>`).join('\n')}
${cta ? `<p><a href="${esc(cta.href)}" style="${S.btn}">${esc(cta.label)}</a></p>` : ''}
<p style="${S.footer}">KVRN Affiliate Program. Questions? Reply to this email.</p>
</div></body></html>`
}

export interface RenderInput { kind: AffiliateEmailKind; payload: Record<string, any>; origin?: string; inviteToken?: string }

export function renderAffiliateEmail(i: RenderInput): { subject: string; html: string } {
  const origin = i.origin ?? getSiteOrigin() ?? 'https://kvrn.shop'
  const p = i.payload ?? {}
  const hi = p.displayName ? `Hi ${esc(p.displayName)},` : 'Hi,'
  const note = p.message ? `<em>${esc(p.message)}</em>` : ''
  switch (i.kind) {
    case 'application_received':
      return { subject: 'We received your KVRN affiliate application', html: layout(origin, 'Application received', [
        hi, 'Thanks for applying. We review every application personally and will email you once we have decided. This usually takes a few business days.',
        'Nothing more is needed from you right now.']) }
    case 'application_approved':
      return { subject: 'Your KVRN affiliate application was approved', html: layout(origin, 'You’re approved', [
        hi, p.activated ? 'Your application was approved and your affiliate account is active.' : 'Your application was approved. A few setup steps remain before your code goes live, including payout setup.',
        ...(note ? [note] : []), 'Sign in with this email address to see your status and next steps.'],
        { label: 'Open the affiliate portal', href: `${origin}/affiliate/login` }) }
    case 'application_rejected':
      return { subject: 'About your KVRN affiliate application', html: layout(origin, 'Application update', [
        hi, 'Thank you for your interest in the KVRN affiliate program. We are not able to move forward with your application at this time.',
        ...(note ? [note] : []), 'You are welcome to apply again in the future.']) }
    case 'application_needs_info':
      return { subject: 'We need a little more information', html: layout(origin, 'More information needed', [
        hi, 'To finish reviewing your KVRN affiliate application we need a bit more information:', note || '',
        'Reply to this email with the details and we will take it from there.'].filter(Boolean)) }
    case 'affiliate_invite': {
      const href = `${origin}/affiliates/apply#invite=${encodeURIComponent(i.inviteToken ?? '')}`
      return { subject: 'You’re invited to the KVRN affiliate program', html: layout(origin, 'You’re invited', [
        hi, 'We’d like to invite you to the KVRN affiliate program. To accept, complete a short form where you confirm you are 18 or older and review the program terms and disclosure policy.',
        'This is an invitation to apply, not an approval. This link works once and expires.'], { label: 'Complete your application', href }) }
    }
    case 'affiliate_suspended':
      return { subject: 'Your KVRN affiliate account is paused', html: layout(origin, 'Account paused', [
        hi, 'Your affiliate code and links are paused. Your earnings history remains available in the portal.', ...(note ? [note] : []),
        'If you have questions, reply to this email.']) }
    case 'affiliate_terminated':
      return { subject: 'Your KVRN affiliate agreement has ended', html: layout(origin, 'Agreement ended', [
        hi, 'Your KVRN affiliate agreement has ended and your code and links are no longer active. Your earnings and payout history stay available in the portal.',
        ...(note ? [note] : [])]) }
    case 'affiliate_activated':
      return { subject: p.reinstated ? 'Your KVRN affiliate account is active again' : 'Your KVRN affiliate account is active', html: layout(origin, p.reinstated ? 'Account active again' : 'You’re live', [
        hi, p.reinstated ? 'Your affiliate code and links are active again.' : 'Your affiliate code and referral link are now active. Payouts require identity, tax and payout setup, which you can complete in the portal.'],
        { label: 'Open the affiliate portal', href: `${origin}/affiliate/login` }) }
    case 'terms_update':
      return { subject: 'Please review the updated KVRN affiliate terms', html: layout(origin, 'Updated terms', [
        hi, 'We updated the KVRN affiliate program documents. Please review and accept the new version to keep your account in good standing and eligible for payouts.'],
        { label: 'Review and accept', href: `${origin}/affiliate/login` }) }
  }
}

function safeError(m: unknown): string {
  return String((m as any)?.message ?? m ?? 'error').slice(0, 200).replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
}

export type SendResult = 'sent' | 'failed' | 'skipped' | 'not_due'

/** Claim one outbox row atomically and send it. Never throws. */
export async function processAffiliateEmail(sql: Sql, provider: EmailProvider, id: string): Promise<SendResult> {
  try {
    const claimed = await sql`
      UPDATE affiliate_email_outbox
         SET status = 'sending', attempt_count = attempt_count + 1
       WHERE id = ${id}::uuid AND attempt_count < ${MAX_ATTEMPTS}
         AND ((status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
              OR (status = 'sending' AND updated_at < now() - interval '15 minutes'))
       RETURNING id, kind, recipient_email, payload, idempotency_key, attempt_count` as any[]
    const row = claimed[0]
    if (!row) return 'not_due'
    if (row.kind === 'affiliate_invite') {
      await sql`UPDATE affiliate_email_outbox SET status = 'skipped', last_error = 'Invite token is not stored; resend the invite from Admin.' WHERE id = ${row.id}::uuid`
      return 'skipped'
    }
    if (!(AFFILIATE_EMAIL_KINDS as readonly string[]).includes(row.kind)) {
      await sql`UPDATE affiliate_email_outbox SET status = 'skipped', last_error = 'Unknown email kind.' WHERE id = ${row.id}::uuid`
      return 'skipped'
    }
    const { subject, html } = renderAffiliateEmail({ kind: row.kind, payload: row.payload ?? {} })
    const res = await provider.send({ from: fromAddress(), replyTo: replyTo(), to: row.recipient_email, subject, html, idempotencyKey: row.idempotency_key })
    if (res.ok) {
      await sql`UPDATE affiliate_email_outbox SET status = 'sent', provider_message_id = ${res.providerMessageId}, sent_at = now(), last_error = NULL, next_attempt_at = NULL WHERE id = ${row.id}::uuid`
      return 'sent'
    }
    const retry = RETRY_MS[row.attempt_count] ?? null
    await sql`UPDATE affiliate_email_outbox SET status = 'failed', last_error = ${safeError(res.message)},
              next_attempt_at = ${retry === null ? null : new Date(Date.now() + retry).toISOString()} WHERE id = ${row.id}::uuid`
    return 'failed'
  } catch (err) {
    console.error('[affiliate-email] processing error', safeError(err))
    return 'failed'
  }
}

/** Process due rows (used by the maintenance handler and the Admin "retry" action). */
export async function drainAffiliateEmailOutbox(sql: Sql, provider: EmailProvider, limit = 25): Promise<{ processed: number; sent: number; failed: number }> {
  const rows = await sql`
    SELECT id FROM affiliate_email_outbox
     WHERE attempt_count < ${MAX_ATTEMPTS}
       AND ((status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
            OR (status = 'sending' AND updated_at < now() - interval '15 minutes'))
     ORDER BY created_at LIMIT ${limit}` as any[]
  let sent = 0, failed = 0
  for (const r of rows) {
    const o = await processAffiliateEmail(sql, provider, r.id)
    if (o === 'sent') sent++
    if (o === 'failed') failed++
  }
  return { processed: rows.length, sent, failed }
}

/**
 * Best-effort immediate send for rows just enqueued by a state change. Resolves quietly when no
 * provider is configured (the row stays pending for the retry job). Never throws.
 */
export async function sendQueuedAffiliateEmails(sql: Sql, getProvider: () => EmailProvider, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  let provider: EmailProvider
  try { provider = getProvider() } catch { return }
  for (const id of ids) await processAffiliateEmail(sql, provider, id)
}

/** Outbox rows created for an application / affiliate (to send right after the transaction). */
export async function pendingOutboxIds(sql: Sql, f: { applicationId?: string | null; affiliateId?: string | null }): Promise<string[]> {
  const rows = await sql`
    SELECT id FROM affiliate_email_outbox
     WHERE status = 'pending'
       AND ((${f.applicationId ?? null}::uuid IS NOT NULL AND application_id = ${f.applicationId ?? null}::uuid)
         OR (${f.affiliateId ?? null}::uuid IS NOT NULL AND affiliate_id = ${f.affiliateId ?? null}::uuid))
     ORDER BY created_at` as any[]
  return rows.map(r => r.id)
}

/** Send an invite email directly (token in memory only) and record the outcome without the token. */
export async function sendInviteEmail(
  sql: Sql, getProvider: () => EmailProvider,
  invite: { id: string; email: string; displayName: string; sendCount: number }, token: string,
): Promise<'sent' | 'failed'> {
  const key = `invite:${invite.id}:${invite.sendCount}`
  await sql`INSERT INTO affiliate_email_outbox (kind, recipient_email, payload, status, idempotency_key, attempt_count)
            VALUES ('affiliate_invite', ${invite.email}, ${JSON.stringify({ displayName: invite.displayName })}::jsonb, 'sending', ${key}, 1)
            ON CONFLICT (idempotency_key) DO NOTHING`
  try {
    const provider = getProvider()
    const { subject, html } = renderAffiliateEmail({ kind: 'affiliate_invite', payload: { displayName: invite.displayName }, inviteToken: token })
    const res = await provider.send({ from: fromAddress(), replyTo: replyTo(), to: invite.email, subject, html, idempotencyKey: key })
    if (res.ok) {
      await sql`UPDATE affiliate_email_outbox SET status = 'sent', sent_at = now(), provider_message_id = ${res.providerMessageId} WHERE idempotency_key = ${key}`
      await sql`UPDATE affiliate_invites SET email_status = 'sent', email_sent_at = now() WHERE id = ${invite.id}::uuid`
      return 'sent'
    }
    await sql`UPDATE affiliate_email_outbox SET status = 'failed', last_error = ${safeError(res.message)} WHERE idempotency_key = ${key}`
  } catch (err) {
    await sql`UPDATE affiliate_email_outbox SET status = 'failed', last_error = ${safeError(err)} WHERE idempotency_key = ${key}`
  }
  await sql`UPDATE affiliate_invites SET email_status = 'failed' WHERE id = ${invite.id}::uuid`
  return 'failed'
}
