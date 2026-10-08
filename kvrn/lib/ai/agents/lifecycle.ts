import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { createAiAction, markAiAction, resolveAiAlertsByDedupePrefix, upsertAiAlert } from '../repository'

const STUCK_QUEUE_MINUTES = 30

/**
 * Lifecycle observes the canonical abandoned-checkout subsystem added in migration 032.
 * It never creates/sends recovery messages itself. That avoids a second consent/state
 * machine and keeps Claude's guarded queue + feature flag as the single source of truth.
 */
export async function handleLifecycleRecoveryMonitor(event: { id: string }): Promise<void> {
  const [summaryRows, stuckRows] = await Promise.all([
    sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '7 days')::int AS started_7d,
        COUNT(*) FILTER (WHERE abandoned_at >= NOW()-INTERVAL '7 days')::int AS abandoned_7d,
        COUNT(*) FILTER (WHERE recovery_sent_at >= NOW()-INTERVAL '7 days')::int AS sent_7d,
        COUNT(*) FILTER (WHERE state='recovered' AND recovered_at >= NOW()-INTERVAL '7 days')::int AS recovered_7d,
        COUNT(*) FILTER (WHERE state='send_failed')::int AS failed_now,
        COUNT(*) FILTER (WHERE state='recovery_queued')::int AS queued_now,
        COUNT(*) FILTER (WHERE state='ineligible' AND updated_at >= NOW()-INTERVAL '7 days')::int AS ineligible_7d,
        COUNT(*) FILTER (WHERE state='recovered' AND recovered_at >= NOW()-INTERVAL '7 days' AND recovery_revenue_cents IS NULL)::int AS recovered_revenue_unknown_7d,
        COALESCE(SUM(recovery_revenue_cents) FILTER (
          WHERE state='recovered' AND recovered_at >= NOW()-INTERVAL '7 days' AND recovery_revenue_cents IS NOT NULL
        ),0)::bigint AS recovered_revenue_cents_7d
      FROM abandoned_checkouts
    `,
    sql`
      SELECT COUNT(*)::int AS stuck
      FROM abandoned_checkouts
      WHERE state='recovery_queued'
        AND COALESCE(next_attempt_at, recovery_queued_at, updated_at) < NOW() - (${STUCK_QUEUE_MINUTES}::text || ' minutes')::interval
    `,
  ]) as any[][]

  const r = summaryRows[0] ?? {}
  const stuck = Number(stuckRows[0]?.stuck ?? 0)
  const failed = Number(r.failed_now ?? 0)
  const emailsEnabled = isFeatureEnabled('ABANDONED_CHECKOUT_EMAILS')
  const unhealthy = emailsEnabled && (failed > 0 || stuck > 0)

  const evidence = {
    canonicalSource: 'abandoned_checkouts',
    recoveryEmailsEnabled: emailsEnabled,
    started7d: Number(r.started_7d ?? 0),
    abandoned7d: Number(r.abandoned_7d ?? 0),
    sent7d: Number(r.sent_7d ?? 0),
    recovered7d: Number(r.recovered_7d ?? 0),
    ineligible7d: Number(r.ineligible_7d ?? 0),
    queuedNow: Number(r.queued_now ?? 0),
    failedNow: failed,
    stuckQueuedNow: stuck,
    recoveredRevenueCents7d: Number(r.recovered_revenue_cents_7d ?? 0),
    recoveredRevenueUnknown7d: Number(r.recovered_revenue_unknown_7d ?? 0),
    messageSentByAi: false,
  }

  const actionId = await createAiAction({
    agentId: 'lifecycle', eventId: event.id, actionType: 'recovery_health_monitor',
    summary: 'Checked the canonical abandoned-checkout recovery state machine in read-only mode.',
    evidence,
    riskLevel: unhealthy ? 'medium' : 'info', permissionLevel: 'green', status: 'succeeded',
    ownerVisible: unhealthy,
    idempotencyKey: `lifecycle-recovery:${event.id}`,
  })

  if (unhealthy) {
    await upsertAiAlert({
      sourceAgentId:'lifecycle', actionId, severity:'medium', category:'lifecycle',
      title:'Checkout recovery queue needs attention',
      summary:`Canonical recovery has ${failed} failed send${failed===1?'':'s'} and ${stuck} queued item${stuck===1?'':'s'} stuck over ${STUCK_QUEUE_MINUTES} minutes. AI sent nothing.`,
      dedupeKey:'lifecycle:recovery-health', metadata:{ requiresOwner:false, failed, stuck },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({
      sourceAgentId:'lifecycle', prefix:'lifecycle:recovery-health',
      note: emailsEnabled ? 'Checkout recovery queue is healthy again.' : 'Recovery email feature is disabled; prior send-health incident is no longer active.',
    })
  }

  await markAiAction({
    actionId, status:'succeeded', completed:true,
    outcome:{ ...evidence, shadowMode:true, externalChangeMade:false },
  })
}
