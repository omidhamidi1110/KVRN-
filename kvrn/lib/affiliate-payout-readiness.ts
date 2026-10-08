// lib/affiliate-payout-readiness.ts — Admin-side payout readiness: identity / tax / payout-method status,
// provider account references (masked only), portal access, and payout attempts (failed + retry).
// Server-only. Every mutation is a SQL function that writes its own admin_audit_logs row atomically (034).
//
// NO raw bank, tax, ID or DOB data is accepted or stored anywhere in this module. A provider account is a
// reference string plus a handful of short display strings validated by the database.
import { randomUUID } from 'crypto'
import { getPayoutProvider, isProviderId, type ProviderStatusResult } from '@/lib/affiliate-payout-provider'

type Sql = any

export const READINESS_DOMAINS = ['kyc', 'tax', 'payout_method'] as const
export type ReadinessDomain = typeof READINESS_DOMAINS[number]
export const READINESS_STATUSES: Record<ReadinessDomain, readonly string[]> = {
  kyc: ['not_started', 'pending', 'verified', 'problem'],
  tax: ['not_started', 'pending', 'complete', 'problem'],
  payout_method: ['not_started', 'pending', 'ready', 'failed'],
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** Map a coded SQL exception to a short Admin-safe message + HTTP status. */
export function mapReadinessError(err: unknown): { status: number; message: string } | null {
  const msg = String((err as any)?.message ?? '')
  const table: Array<[string, number, string]> = [
    ['ATTESTATION_NOTE_REQUIRED', 400, 'Add a short note saying how this was confirmed (at least 8 characters).'],
    ['POSITIVE_REQUIRES_ADMIN_OR_PROVIDER', 400, 'Only an Admin or the provider can mark this as complete.'],
    ['BAD_STATUS', 400, 'That status is not valid.'],
    ['BAD_DOMAIN', 400, 'That setting is not valid.'],
    ['NOTE_TOO_LONG', 400, 'Note is too long (300 characters max).'],
    ['PROFILE_NOT_FOUND', 404, 'No affiliate profile found.'],
    ['PROFILE_UNAVAILABLE', 503, 'Affiliate profiles are not available yet.'],
    ['AFFILIATE_NOT_FOUND', 404, 'Affiliate not found.'],
    ['BAD_ACCESS', 400, 'That access level is not valid.'],
    ['BAD_POLICY', 400, 'That paid-ad setting is not valid.'],
    ['REASON_REQUIRED', 400, 'A reason is required.'],
    ['ALREADY_TERMINATED', 409, 'This affiliate is already terminated.'],
    ['NOT_DRAFT', 409, 'Only a draft payout can have attempts.'],
    ['ATTEMPT_ALREADY_SUCCEEDED', 409, 'This payout already succeeded.'],
    ['ATTEMPT_ALREADY_COMPLETED', 409, 'This attempt was already completed with a different result.'],
    ['ATTEMPT_NOT_FOUND', 404, 'Attempt not found.'],
    ['VOID_CANNOT_BE_PAID', 409, 'A void payout cannot be marked paid.'],
    ['NOT_FOUND', 404, 'Payout not found.'],
    ['apa_', 400, 'That provider reference or display detail is not valid.'],
    ['affiliate_payout_accounts_masked_metadata_check', 400, 'Only short display details (brand, last 4 digits) can be saved.'],
    ['affiliate_payout_accounts_provider_account_ref_check', 400, 'That provider reference is not valid.'],
  ]
  for (const [needle, status, message] of table) if (msg.includes(needle)) return { status, message }
  return null
}

export function createAffiliatePayoutReadinessService(sql: Sql) {
  return {
    /** One row per affiliate with its statuses and payable balance. Read-only (no promotion writes). */
    async list(limit = 200) {
      const rows = await sql`
        SELECT a.id, a.code, a.name, a.status AS financial_status,
               p.program_status, p.kyc_status, p.tax_status, p.payout_method_status, p.portal_access,
               p.payout_provider, p.requires_reacceptance,
               (p.affiliate_id IS NOT NULL) AS has_profile,
               COALESCE((SELECT SUM(affiliate_commission_payable(c.id)) FROM affiliate_commissions c
                          WHERE c.affiliate_id = a.id AND c.status IN ('approved','paid') AND NOT c.incomplete),0)::bigint AS payable_cents,
               (SELECT COUNT(*) FROM affiliate_commissions c WHERE c.affiliate_id = a.id AND c.incomplete)::int AS incomplete_count,
               (SELECT COUNT(*) FROM affiliate_fraud_flags f WHERE f.affiliate_id = a.id AND f.status IN ('open','investigating') AND f.freeze_commissions)::int AS frozen_flags
          FROM affiliates a
          LEFT JOIN affiliate_profiles p ON p.affiliate_id = a.id
         ORDER BY a.created_at DESC
         LIMIT ${Math.min(Math.max(limit, 1), 500)}` as any[]
      return rows.map(r => ({
        affiliateId: r.id as string, code: r.code as string, name: r.name as string,
        financialStatus: r.financial_status as string, hasProfile: r.has_profile === true,
        programStatus: (r.program_status ?? null) as string | null,
        kycStatus: (r.kyc_status ?? null) as string | null, taxStatus: (r.tax_status ?? null) as string | null,
        payoutMethodStatus: (r.payout_method_status ?? null) as string | null,
        portalAccess: (r.portal_access ?? null) as string | null,
        payoutProvider: (r.payout_provider ?? null) as string | null,
        requiresReacceptance: r.requires_reacceptance === true,
        payableCents: Number(r.payable_cents), incompleteCount: Number(r.incomplete_count),
        frozenFlags: Number(r.frozen_flags),
      }))
    },

    async detail(affiliateId: string) {
      const [account, events, payouts] = await Promise.all([
        sql`SELECT provider, provider_account_ref, provider_status, kyc_status, tax_status, payout_method_status,
                   masked_metadata, last_synced_at FROM affiliate_payout_accounts
             WHERE affiliate_id = ${affiliateId}::uuid ORDER BY updated_at DESC LIMIT 3` as Promise<any[]>,
        sql`SELECT domain, from_status, to_status, source, actor_email, note, created_at
              FROM affiliate_readiness_events WHERE affiliate_id = ${affiliateId}::uuid
             ORDER BY created_at DESC LIMIT 30` as Promise<any[]>,
        sql`SELECT p.id, p.payout_number, p.status, p.amount_cents, p.paid_at, p.created_at,
                   (SELECT json_agg(json_build_object('id', t.id, 'attemptNo', t.attempt_no, 'status', t.status,
                            'provider', t.provider, 'failureCode', t.failure_code, 'failureNote', t.failure_note,
                            'createdAt', t.created_at, 'completedAt', t.completed_at) ORDER BY t.attempt_no)
                      FROM affiliate_payout_attempts t WHERE t.payout_id = p.id) AS attempts
              FROM affiliate_payouts p WHERE p.affiliate_id = ${affiliateId}::uuid
             ORDER BY p.created_at DESC LIMIT 50` as Promise<any[]>,
      ])
      return {
        accounts: account.map(a => ({
          provider: a.provider, providerAccountRef: a.provider_account_ref ?? null, providerStatus: a.provider_status ?? null,
          kycStatus: a.kyc_status, taxStatus: a.tax_status, payoutMethodStatus: a.payout_method_status,
          masked: a.masked_metadata ?? {}, lastSyncedAt: a.last_synced_at ? new Date(a.last_synced_at).toISOString() : null,
        })),
        events: events.map(e => ({
          domain: e.domain, from: e.from_status, to: e.to_status, source: e.source,
          actor: e.actor_email, note: e.note, at: new Date(e.created_at).toISOString(),
        })),
        payouts: payouts.map(p => ({
          id: p.id as string, payoutNumber: p.payout_number as string, status: p.status as string,
          amountCents: Number(p.amount_cents),
          date: new Date(p.paid_at ?? p.created_at).toISOString(),
          attempts: (p.attempts ?? []) as Array<{ id: string; attemptNo: number; status: string; provider: string; failureCode: string | null; failureNote: string | null; createdAt: string; completedAt: string | null }>,
        })),
      }
    },

    async setReadiness(affiliateId: string, domain: ReadinessDomain, status: string, note: string | null, actor: string) {
      const rows = await sql`SELECT set_affiliate_readiness(${affiliateId}::uuid, ${domain}, ${status}, 'admin', ${actor}, ${note}, 'manual') AS r` as any[]
      return rows[0]?.r
    },

    /** Reference + masked display details only. Validated again by the database CHECK. */
    async setAccount(affiliateId: string, provider: string, ref: string | null, masked: Record<string, string>, actor: string) {
      if (!isProviderId(provider)) throw new Error('BAD_PROVIDER')
      const rows = await sql`SELECT set_affiliate_payout_account(${affiliateId}::uuid, ${provider}, ${ref}, ${JSON.stringify(masked)}::jsonb, ${actor}) AS r` as any[]
      return rows[0]?.r
    },

    async setPortalAccess(affiliateId: string, access: string, reason: string | null, actor: string) {
      const rows = await sql`SELECT set_affiliate_portal_access(${affiliateId}::uuid, ${access}, ${reason}, ${actor}) AS r` as any[]
      return rows[0]?.r
    },

    async revokeSessions(affiliateId: string, reason: string, actor: string) {
      const rows = await sql`SELECT revoke_affiliate_sessions(${affiliateId}::uuid, ${reason}, ${actor}) AS n` as any[]
      return Number(rows[0]?.n ?? 0)
    },

    /** Start (or replay) an attempt. The client supplies a key per button press; a retry uses a NEW key. */
    async recordAttempt(payoutId: string, idempotencyKey: string | null, actor: string) {
      const provider = getPayoutProvider().id
      const key = idempotencyKey && idempotencyKey.length >= 8 ? idempotencyKey : `adm-${randomUUID()}`
      const rows = await sql`SELECT affiliate_record_payout_attempt(${payoutId}::uuid, ${key}, ${provider}, ${actor}) AS r` as any[]
      return rows[0]?.r
    },

    async completeAttempt(
      attemptId: string,
      r: { outcome: 'succeeded' | 'failed'; reference?: string | null; failureCode?: string | null; failureNote?: string | null; paidAt?: string | null; method?: string | null },
      actor: string,
    ) {
      const rows = await sql`SELECT affiliate_complete_payout_attempt(
        ${attemptId}::uuid, ${r.outcome}, ${r.reference ?? null}, ${r.failureCode ?? null}, ${r.failureNote ?? null},
        ${r.paidAt ?? null}::timestamptz, ${r.method ?? null}, ${actor}) AS r` as any[]
      return rows[0]?.r
    },

    /**
     * Apply a status report FROM A PROVIDER (e.g. a future account.updated webhook). Only domains the provider
     * actually reports are touched; source='provider' so a positive state is accepted without an Admin note.
     */
    async applyProviderStatus(affiliateId: string, report: ProviderStatusResult, providerId: string = 'stripe_connect') {
      const out: Array<{ domain: ReadinessDomain; status: string }> = []
      const pairs: Array<[ReadinessDomain, string | null]> = [['kyc', report.kyc], ['tax', report.tax], ['payout_method', report.payoutMethod]]
      for (const [domain, status] of pairs) {
        if (!status) continue
        await sql`SELECT set_affiliate_readiness(${affiliateId}::uuid, ${domain}, ${status}, 'provider', 'system:payout-provider', NULL, ${providerId}) AS r`
        out.push({ domain, status })
      }
      return out
    },
  }
}

export type AffiliatePayoutReadinessService = ReturnType<typeof createAffiliatePayoutReadinessService>
