// lib/affiliate-maintenance.ts — the affiliate cron job (called every 5 minutes by cloudflare-cron-wrapper.js via
// /api/internal/affiliate-maintenance). Idempotent; every step is isolated so one failure never blocks the others.
// Returns COUNTS ONLY (no ids, emails or amounts).
//
//   AFFILIATE_PORTAL OFF  → does nothing at all (prior behaviour).
//   AFFILIATE_PORTAL ON   → expired-token / session / rate-event cleanup, notification sweeps + delivery,
//                           self-referral heuristic scan (flags only, never freezes), commission promotion
//                           using the EXISTING per-affiliate function (same rule the lazy path uses).
//   AFFILIATE_AUTO_PAYOUTS ON (and an automation-capable, configured provider) → submit existing DRAFT payouts
//                           through the provider. With the default manual provider this is a no-op.
import { createAffiliateAuthService } from '@/lib/affiliate-auth'
import { createAffiliateNotificationService } from '@/lib/affiliate-portal-notifications'
import { createAffiliateComplianceService } from '@/lib/affiliate-compliance'
import { attemptAutomaticPayout, getPayoutProvider, type PayoutProvider } from '@/lib/affiliate-payout-provider'
import { canPayAffiliate } from '@/lib/affiliate-payout-gate'
import { createAffiliatePayoutReadinessService } from '@/lib/affiliate-payout-readiness'

type Sql = any

export interface MaintenanceDeps {
  portalEnabled: () => boolean
  autoPayoutsEnabled: () => boolean
  provider?: PayoutProvider
  notifications?: ReturnType<typeof createAffiliateNotificationService>
}

export interface MaintenanceResult {
  enabled: boolean
  steps: Record<string, number | string>
}

const PROMOTE_BATCH = 200
const AUTO_PAYOUT_BATCH = 20

async function step<T>(out: Record<string, number | string>, name: string, fn: () => Promise<T>, summarize: (v: T) => Record<string, number>) {
  try {
    const v = await fn()
    for (const [k, n] of Object.entries(summarize(v))) out[`${name}.${k}`] = n
  } catch {
    out[`${name}.error`] = 1
  }
}

export async function runAffiliateMaintenance(sql: Sql, deps: MaintenanceDeps): Promise<MaintenanceResult> {
  if (!deps.portalEnabled()) return { enabled: false, steps: {} }
  const steps: Record<string, number | string> = {}

  await step(steps, 'cleanup', () => createAffiliateAuthService(sql).cleanup(), v => ({ tokens: v.tokens, sessions: v.sessions, rateEvents: v.rateEvents }))

  const notif = deps.notifications ?? createAffiliateNotificationService(sql)
  await step(steps, 'sweep.setup', () => notif.sweepSetupRequired(), n => ({ queued: n }))
  await step(steps, 'sweep.activated', () => notif.sweepActivated(), n => ({ queued: n }))
  await step(steps, 'sweep.warnings', () => notif.sweepComplianceWarnings(), n => ({ queued: n }))
  await step(steps, 'sweep.reacceptance', () => notif.sweepReacceptance(), n => ({ queued: n }))
  await step(steps, 'notify', () => notif.drain(25), v => ({ claimed: v.claimed, sent: v.sent, failed: v.failed, skipped: v.skipped, notConfigured: v.notConfigured ? 1 : 0 }))

  await step(steps, 'selfReferral', () => createAffiliateComplianceService(sql).scanSelfReferral({ sinceDays: 3 }), (v: any) => ({ candidates: Number(v?.candidates ?? 0), created: Number(v?.created ?? 0) }))

  await step(steps, 'promote', async () => {
    const aff = await sql`
      SELECT DISTINCT affiliate_id FROM affiliate_commissions
       WHERE status = 'pending' AND eligible_at <= NOW() AND commission_cents > 0
       LIMIT ${PROMOTE_BATCH}` as any[]
    let promoted = 0
    for (const a of aff) {
      const r = await sql`SELECT promote_eligible_commissions_for_affiliate(${a.affiliate_id}::uuid) AS n` as any[]
      promoted += Number(r[0]?.n ?? 0)
    }
    return { affiliates: aff.length, promoted }
  }, v => v)

  if (deps.autoPayoutsEnabled()) {
    const provider = deps.provider ?? getPayoutProvider()
    await step(steps, 'autoPayouts', async () => {
      const counts = { considered: 0, blocked: 0, submitted: 0, failed: 0, notConfigured: 0, manual: 0, unrecorded: 0 }
      if (!provider.supportsAutomatedPayouts || !provider.isConfigured()) { counts.manual = 1; return counts }
      const readiness = createAffiliatePayoutReadinessService(sql)
      // Drafts with no attempt in flight or completed. A failed draft is retried by an Admin, not blindly here.
      const drafts = await sql`
        SELECT p.id, p.affiliate_id, p.amount_cents FROM affiliate_payouts p
         WHERE p.status = 'draft'
           AND NOT EXISTS (SELECT 1 FROM affiliate_payout_attempts t WHERE t.payout_id = p.id)
         ORDER BY p.created_at LIMIT ${AUTO_PAYOUT_BATCH}` as any[]
      for (const d of drafts) {
        counts.considered++
        const r = await attemptAutomaticPayout(
          { flagEnabled: deps.autoPayoutsEnabled, provider, gate: id => canPayAffiliate(sql, id, { draftPayoutId: d.id }) },
          { id: d.id, affiliateId: d.affiliate_id, amountCents: Number(d.amount_cents), currency: 'USD', providerAccountRef: null, idempotencyKey: `auto-${d.id}` },
        )
        if (r.outcome === 'blocked') { counts.blocked++; continue }
        if (r.outcome === 'not_configured') { counts.notConfigured++; continue }
        if (r.outcome !== 'submitted' && r.outcome !== 'failed') continue
        // The provider call above is idempotent on `auto-<payoutId>`. If recording the result fails here the draft
        // still has no attempt, so the next run re-submits with the SAME key (the provider returns the first result)
        // and records it then. `unrecorded` makes that visible in the counts.
        try {
          const rec = await readiness.recordAttempt(d.id, `auto-${d.id}`, 'system:affiliate-maintenance')
          const attemptId = rec?.attempt_id ?? rec?.attemptId
          if (!attemptId) { counts.unrecorded++; continue }
          await readiness.completeAttempt(attemptId, {
            outcome: r.outcome === 'submitted' ? 'succeeded' : 'failed', reference: r.providerReference ?? null,
            failureCode: r.outcome === 'failed' ? 'provider_failed' : null, method: provider.id,
          }, 'system:affiliate-maintenance')
          counts[r.outcome === 'submitted' ? 'submitted' : 'failed']++
        } catch { counts.unrecorded++ }
      }
      return counts
    }, v => v)
  }
  return { enabled: true, steps }
}
