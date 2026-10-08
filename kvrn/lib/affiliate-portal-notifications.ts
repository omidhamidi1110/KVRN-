// lib/affiliate-portal-notifications.ts — affiliate emails: magic link + a small idempotent outbox.
// Server-only.
//
// Two kinds of mail:
//   * Magic link  — sent immediately by the auth service. The link is NEVER stored, logged or queued.
//   * Notifications (setup required, activated, payout sent/failed, compliance warning, re-acceptance) — queued in
//     affiliate_portal_notifications (unique dedupe_key => at-most-once per event) and delivered by drain().
//
// Emails carry no secrets and no sensitive data: payouts are identified by the non-reversible public reference and
// an amount; compliance mail carries the affiliate-facing summary only (never the internal note).
import { getEmailProvider, type EmailProvider } from '@/lib/resend-adapter'
import { getSiteOrigin } from '@/lib/site-origin'
import { sha256Hex } from '@/lib/affiliate-auth'
import { getCurrentDocuments } from '@/lib/affiliate-portal-bridge'

type Sql = any

export const NOTIFICATION_KINDS = [
  'setup_required', 'activated', 'payout_sent', 'payout_failed', 'compliance_warning', 'reacceptance_required',
] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

export const MAX_ATTEMPTS = 5
/** Sweeps only look at recent events so that switching the portal on never mails the whole legacy roster. */
export const SWEEP_WINDOW_DAYS = 14
const STALE_SENDING_MINUTES = 10

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
const usd = (cents: unknown) => `$${(Number(cents ?? 0) / 100).toFixed(2)}`

export function buildFromAddress(): string {
  const name = process.env.RESEND_FROM_NAME ?? 'KVRN'
  const email = process.env.RESEND_FROM_EMAIL ?? 'orders@send.kvrn.shop'
  return process.env.TRANSACTIONAL_EMAIL_FROM ?? `${name} <${email}>`
}
export const REPLY_TO = 'support@kvrn.shop'

function shell(origin: string, heading: string, bodyHtml: string, cta?: { label: string; href: string }): string {
  const button = cta
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(cta.href)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;display:inline-block;">${escapeHtml(cta.label)}</a></p>`
    : ''
  return `<!doctype html><html><body style="margin:0;background:#F5F3EF;font-family:Helvetica,Arial,sans-serif;color:#111;">
<div style="max-width:520px;margin:0 auto;padding:32px 20px;">
<div style="font-size:13px;letter-spacing:.2em;font-weight:700;margin-bottom:24px;">KVRN</div>
<div style="background:#fff;border:1px solid #E8E5E0;border-radius:14px;padding:28px 24px;">
<h1 style="font-size:18px;margin:0 0 14px;">${escapeHtml(heading)}</h1>
<div style="font-size:14px;line-height:1.6;color:#333;">${bodyHtml}</div>${button}
</div>
<p style="font-size:11px;color:#777;margin-top:18px;">KVRN affiliate program. Questions? Reply to this email or write to ${escapeHtml(REPLY_TO)}. <a href="${escapeHtml(origin)}/affiliate/login" style="color:#777;">Portal</a></p>
</div></body></html>`
}

export interface RenderedEmail { subject: string; html: string }

export function renderNotification(kind: NotificationKind, payload: Record<string, any>, origin: string): RenderedEmail {
  const portal = `${origin}/affiliate/login`
  switch (kind) {
    case 'setup_required':
      return {
        subject: 'Finish setting up your KVRN affiliate account',
        html: shell(origin, 'Finish your setup',
          '<p style="margin:0 0 10px;">Your affiliate account is created. Before payouts can start we need identity, tax and payout details confirmed. Sign in to see what is left.</p><p style="margin:0;">You never need to email us documents or bank details.</p>',
          { label: 'Open your portal', href: portal }),
      }
    case 'activated':
      return {
        subject: 'Your KVRN affiliate account is ready',
        html: shell(origin, 'You are all set',
          '<p style="margin:0;">Your identity, tax and payout setup is confirmed. Approved commissions can now be paid out on the normal schedule.</p>',
          { label: 'Open your portal', href: portal }),
      }
    case 'payout_sent':
      return {
        subject: 'Your KVRN affiliate payout was sent',
        html: shell(origin, 'Payout sent',
          `<p style="margin:0 0 10px;">We sent a payout of <strong>${escapeHtml(usd(payload.amount_cents))}</strong>.</p><p style="margin:0;">Reference: ${escapeHtml(payload.payout_ref ?? '')}. A line-by-line statement is in your portal.</p>`,
          { label: 'View statement', href: portal }),
      }
    case 'payout_failed':
      return {
        subject: 'There was a problem with your KVRN payout',
        html: shell(origin, 'Payout needs attention',
          `<p style="margin:0 0 10px;">A payout of <strong>${escapeHtml(usd(payload.amount_cents))}</strong> (reference ${escapeHtml(payload.payout_ref ?? '')}) did not go through.</p><p style="margin:0;">Your commission is safe and still reserved. We will retry, and may ask you to check your payout details.</p>`,
          { label: 'Check payout setup', href: portal }),
      }
    case 'compliance_warning': {
      const sev = payload.severity === 'final' ? 'Final notice' : payload.severity === 'warning' ? 'Warning' : 'Notice'
      return {
        subject: `${sev}: KVRN affiliate program`,
        html: shell(origin, `${sev} about your affiliate content`,
          `<p style="margin:0 0 10px;">${escapeHtml(payload.summary ?? payload.message ?? '')}</p><p style="margin:0;">Please review the program rules in your portal. Reply to this email if you think this is a mistake.</p>`,
          { label: 'Review program rules', href: portal }),
      }
    }
    case 'reacceptance_required':
      return {
        subject: 'Please review updated KVRN affiliate terms',
        html: shell(origin, 'Updated terms',
          '<p style="margin:0;">We updated our affiliate terms or disclosure policy. Please read and accept the new versions to keep receiving payouts. Your sales are still tracked.</p>',
          { label: 'Review and accept', href: portal }),
      }
  }
}

/** Builds the sender used by the auth service for magic links. Never logs the link. */
export function createMagicLinkSender(provider?: EmailProvider): (m: { to: string; link: string }) => Promise<boolean> {
  return async ({ to, link }) => {
    try {
      const p = provider ?? getEmailProvider()
      const origin = getSiteOrigin() ?? 'https://kvrn.shop'
      const html = shell(origin, 'Sign in to your affiliate portal',
        '<p style="margin:0 0 10px;">Use the button below to sign in. The link works once and expires in 15 minutes.</p><p style="margin:0;">If you did not request it, you can ignore this email.</p>',
        { label: 'Sign in', href: link })
      const r = await p.send({ from: buildFromAddress(), replyTo: REPLY_TO, to, subject: 'Your KVRN sign-in link', html })
      return r.ok
    } catch {
      return false
    }
  }
}

export function createAffiliateNotificationService(sql: Sql, deps: { provider?: () => EmailProvider; now?: () => Date; origin?: () => string | null } = {}) {
  const origin = () => (deps.origin ? deps.origin() : getSiteOrigin()) ?? 'https://kvrn.shop'

  async function enqueue(affiliateId: string, kind: NotificationKind, dedupeKey: string, payload: Record<string, unknown> = {}) {
    const rows = await sql`
      INSERT INTO affiliate_portal_notifications (affiliate_id, kind, dedupe_key, payload)
      VALUES (${affiliateId}::uuid, ${kind}, ${dedupeKey}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id` as any[]
    return rows.length > 0
  }

  /**
   * Deliver due notifications. Rows are claimed with FOR UPDATE SKIP LOCKED so overlapping cron runs never double-send;
   * the provider idempotency key is stable per notification as a second guard. Failures back off exponentially and
   * stop after MAX_ATTEMPTS (status 'failed', visible in the table).
   */
  async function drain(limit = 25): Promise<{ claimed: number; sent: number; failed: number; skipped: number; notConfigured: boolean }> {
    let provider: EmailProvider
    try { provider = deps.provider ? deps.provider() : getEmailProvider() }
    catch { return { claimed: 0, sent: 0, failed: 0, skipped: 0, notConfigured: true } }

    const claimed = await sql`
      UPDATE affiliate_portal_notifications n
         SET status = 'sending', attempts = n.attempts + 1, updated_at = NOW()
       WHERE n.id IN (
         SELECT id FROM affiliate_portal_notifications
          WHERE attempts < ${MAX_ATTEMPTS}
            AND ((status IN ('queued','failed') AND next_attempt_at <= NOW())
              OR (status = 'sending' AND updated_at < NOW() - (${STALE_SENDING_MINUTES} || ' minutes')::interval))
          ORDER BY next_attempt_at
          LIMIT ${Math.min(Math.max(limit, 1), 100)}
          FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.affiliate_id, n.kind, n.payload, n.attempts` as any[]

    let sent = 0, failed = 0, skipped = 0
    for (const n of claimed) {
      const aff = await sql`SELECT email FROM affiliates WHERE id = ${n.affiliate_id}::uuid` as any[]
      const to = String(aff[0]?.email ?? '').trim()
      if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || !(NOTIFICATION_KINDS as readonly string[]).includes(n.kind)) {
        await sql`UPDATE affiliate_portal_notifications SET status = 'skipped', last_error = 'no deliverable address or unknown kind', updated_at = NOW() WHERE id = ${n.id}::uuid`
        skipped++; continue
      }
      let outcome: { ok: boolean; id?: string; message?: string }
      try {
        const mail = renderNotification(n.kind, n.payload ?? {}, origin())
        const r = await provider.send({
          from: buildFromAddress(), replyTo: REPLY_TO, to, subject: mail.subject, html: mail.html,
          idempotencyKey: `affportal-${n.id}`,
        })
        outcome = r.ok ? { ok: true, id: r.providerMessageId } : { ok: false, message: r.message }
      } catch {
        outcome = { ok: false, message: 'send threw' }
      }
      if (outcome.ok) {
        await sql`UPDATE affiliate_portal_notifications
                     SET status = 'sent', sent_at = NOW(), provider_message_id = ${outcome.id ?? null}, last_error = NULL, updated_at = NOW()
                   WHERE id = ${n.id}::uuid`
        sent++
      } else {
        const mins = Math.min(2 ** Number(n.attempts), 240)
        await sql`UPDATE affiliate_portal_notifications
                     SET status = 'failed', last_error = ${String(outcome.message ?? 'send failed').slice(0, 200)},
                         next_attempt_at = NOW() + (${mins} || ' minutes')::interval, updated_at = NOW()
                   WHERE id = ${n.id}::uuid`
        failed++
      }
    }
    return { claimed: claimed.length, sent, failed, skipped, notConfigured: false }
  }

  async function hasProfiles(): Promise<boolean> {
    const r = await sql`SELECT to_regclass('public.affiliate_profiles') IS NOT NULL AS ok` as any[]
    return r[0]?.ok === true
  }

  /** Newly created affiliates whose identity / tax / payout setup is still open. Once per affiliate. */
  async function sweepSetupRequired(): Promise<number> {
    if (!(await hasProfiles())) return 0
    const rows = await sql`
      INSERT INTO affiliate_portal_notifications (affiliate_id, kind, dedupe_key, payload)
      SELECT p.affiliate_id, 'setup_required', 'setup_required:' || p.affiliate_id::text, '{}'::jsonb
        FROM affiliate_profiles p JOIN affiliates a ON a.id = p.affiliate_id
       WHERE p.portal_access = 'enabled' AND p.program_status = 'active' AND a.status = 'active'
         AND a.email IS NOT NULL
         AND p.created_at > NOW() - (${SWEEP_WINDOW_DAYS} || ' days')::interval
         AND (p.kyc_status <> 'verified' OR p.payout_method_status <> 'ready')
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id` as any[]
    return rows.length
  }

  /** Fully ready (identity verified + payout method ready) shortly after a readiness change. Once per affiliate. */
  async function sweepActivated(): Promise<number> {
    if (!(await hasProfiles())) return 0
    const rows = await sql`
      INSERT INTO affiliate_portal_notifications (affiliate_id, kind, dedupe_key, payload)
      SELECT p.affiliate_id, 'activated', 'activated:' || p.affiliate_id::text, '{}'::jsonb
        FROM affiliate_profiles p JOIN affiliates a ON a.id = p.affiliate_id
       WHERE p.program_status = 'active' AND a.status = 'active' AND a.email IS NOT NULL
         AND p.kyc_status = 'verified' AND p.payout_method_status = 'ready'
         AND EXISTS (SELECT 1 FROM affiliate_readiness_events e
                      WHERE e.affiliate_id = p.affiliate_id
                        AND e.created_at > NOW() - (${SWEEP_WINDOW_DAYS} || ' days')::interval)
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id` as any[]
    return rows.length
  }

  /** Warnings flagged notify_affiliate. Carries the affiliate-facing summary only — never the internal note. */
  async function sweepComplianceWarnings(): Promise<number> {
    const rows = await sql`
      INSERT INTO affiliate_portal_notifications (affiliate_id, kind, dedupe_key, payload)
      SELECT w.affiliate_id, 'compliance_warning', 'compliance_warning:' || w.id::text,
             jsonb_build_object('severity', w.severity, 'summary', LEFT(w.summary, 500))
        FROM affiliate_compliance_warnings w JOIN affiliates a ON a.id = w.affiliate_id
       WHERE w.notify_affiliate AND w.status = 'open' AND a.email IS NOT NULL
         AND w.issued_at > NOW() - (${SWEEP_WINDOW_DAYS} || ' days')::interval
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id` as any[]
    return rows.length
  }

  /** One mail per distinct set of pending document versions (not weekly nagging). */
  async function sweepReacceptance(): Promise<number> {
    if (!(await hasProfiles())) return 0
    const docs = await getCurrentDocuments(sql)
    const versionKey = docs.map((d: any) => `${d.docType}@${d.version}`).sort().join(',')
    if (!versionKey) return 0
    const hash = sha256Hex(versionKey)
    const rows = await sql`
      INSERT INTO affiliate_portal_notifications (affiliate_id, kind, dedupe_key, payload)
      SELECT p.affiliate_id, 'reacceptance_required', 'reacceptance:' || p.affiliate_id::text || ':' || ${hash.slice(0, 16)}, '{}'::jsonb
        FROM affiliate_profiles p JOIN affiliates a ON a.id = p.affiliate_id
       WHERE p.requires_reacceptance AND p.program_status = 'active' AND a.status <> 'terminated' AND a.email IS NOT NULL
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id` as any[]
    return rows.length
  }

  return { enqueue, drain, sweepSetupRequired, sweepActivated, sweepComplianceWarnings, sweepReacceptance }
}

export type AffiliateNotificationService = ReturnType<typeof createAffiliateNotificationService>
