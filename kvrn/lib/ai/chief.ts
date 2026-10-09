import { sql } from '@/lib/db'
import { createFinancialService } from '@/lib/financials'
import { createFunnelService } from '@/lib/funnel-analytics'
import { getAllVariantsForAdmin } from '@/lib/inventory'
import { sendPushoverNotification } from '@/lib/pushover'
import { getAffiliatePayoutReminder } from '@/lib/affiliate-payout-reminders'
import { getAiBudgetSnapshot, formatUsdMicros } from './budget'
import { processApprovedAiActions } from './executors'
import { enforceAgentAutonomySafety } from './governance'
import {
  listPendingChiefAlerts,
  setAlertDisposition,
  isAiAlertOpen,
  upsertAiAlert,
  refreshAiAgentMetrics,
  getAiRuntimeSettings,
  type AiRuntimeSettings,
  resolveAiAlertsByDedupePrefix,
} from './repository'
import type { AiAlertDisposition, AiRiskLevel } from './types'

export const DEFAULT_AI_TIMEZONE = 'America/Los_Angeles'
const DEFAULT_DAILY_BRIEF_HOUR = 19
const ALERT_RETRY_MINUTES = 30
const PUSHOVER_TIMEOUT_MS = 8_000
const MAX_FAST_PUSH_ATTEMPTS = 3
const CRITICAL_SLOW_RETRY_MINUTES = 6 * 60

function siteAdminUrl(path = '/admin/ai'): string | null {
  const base = (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? '').trim()
  if (!base) return null
  try {
    const u = new URL(path, base)
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 'Unknown'
  return `$${(cents / 100).toFixed(2)}`
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${Number(v).toFixed(1)}%`
}

function severityRank(s: AiRiskLevel): number {
  return ({ info: 1, low: 2, medium: 3, high: 4, critical: 5 } as const)[s]
}

export function classifyChiefAlert(alert: {
  severity: AiRiskLevel
  category: string
  metadata?: Record<string, unknown> | null
}): AiAlertDisposition {
  const meta = alert.metadata ?? {}
  const requiresOwner = meta.requiresOwner === true || meta.requiresApproval === true
  if (alert.severity === 'critical') return 'critical_pushover'
  if (alert.severity === 'high') return 'pushover'
  if (requiresOwner) return 'pushover'

  const ownerCategories = new Set([
    'approval', 'security', 'checkout', 'payment', 'financial_integrity', 'site_outage',
    'data_exposure', 'budget', 'legal', 'chargeback', 'inventory_purchase',
  ])
  if (alert.severity === 'medium' && ownerCategories.has(alert.category)) return 'pushover'
  if (alert.severity === 'medium') return 'digest'
  if (alert.severity === 'low') return 'digest'
  return 'log'
}


function overnightEmergency(alert: { severity: AiRiskLevel; category: string }): boolean {
  if (alert.severity === 'critical') return true
  return new Set([
    'security','fraud_security','checkout','payment','site_outage','data_exposure',
    'financial_integrity','financial_performance',
  ]).has(alert.category)
}

function pushLimitExempt(alert: { severity: AiRiskLevel; category: string; metadata?: Record<string, unknown> | null }): boolean {
  const meta = alert.metadata ?? {}
  // Any HIGH/CRITICAL alert has already crossed the Chief's importance threshold;
  // the anti-spam ceiling must never demote it merely because ordinary pushes happened first.
  if (severityRank(alert.severity) >= severityRank('high') || meta.requiresOwner === true || meta.requiresApproval === true) return true
  return new Set(['security','checkout','payment','site_outage','data_exposure','financial_integrity','legal','chargeback','inventory_purchase']).has(alert.category)
}

async function getChiefPushWindow(settings: AiRuntimeSettings): Promise<{
  quietNow: boolean
  quietUntil: string | null
  noncriticalPushedToday: number
}> {
  const rows = await sql`
    WITH local AS (
      SELECT NOW() AT TIME ZONE ${settings.businessTimezone} AS t
    ), bounds AS (
      SELECT t,
        EXTRACT(HOUR FROM t)::int AS h,
        (date_trunc('day', t) AT TIME ZONE ${settings.businessTimezone}) AS day_start
      FROM local
    )
    SELECT
      (${settings.quietHoursEnabled} AND ${settings.quietHoursStartLocal} <> ${settings.quietHoursEndLocal}
        AND (CASE
          WHEN ${settings.quietHoursStartLocal} < ${settings.quietHoursEndLocal}
            THEN h >= ${settings.quietHoursStartLocal} AND h < ${settings.quietHoursEndLocal}
          ELSE h >= ${settings.quietHoursStartLocal} OR h < ${settings.quietHoursEndLocal}
        END)) AS quiet_now,
      CASE WHEN (${settings.quietHoursEnabled} AND ${settings.quietHoursStartLocal} <> ${settings.quietHoursEndLocal}
        AND (CASE
          WHEN ${settings.quietHoursStartLocal} < ${settings.quietHoursEndLocal}
            THEN h >= ${settings.quietHoursStartLocal} AND h < ${settings.quietHoursEndLocal}
          ELSE h >= ${settings.quietHoursStartLocal} OR h < ${settings.quietHoursEndLocal}
        END))
      THEN (
        (date_trunc('day', t)
          + CASE
              WHEN ${settings.quietHoursStartLocal} < ${settings.quietHoursEndLocal} THEN INTERVAL '0 day'
              WHEN h >= ${settings.quietHoursStartLocal} THEN INTERVAL '1 day'
              ELSE INTERVAL '0 day'
            END
          + make_interval(hours => ${settings.quietHoursEndLocal})
        ) AT TIME ZONE ${settings.businessTimezone}
      ) ELSE NULL END AS quiet_until,
      (SELECT COUNT(*)::int FROM ai_alerts
        WHERE pushed_at >= day_start
          AND disposition='pushover'
          AND severity <> 'critical') AS pushed_today
    FROM bounds
  ` as any[]
  return {
    quietNow: Boolean(rows[0]?.quiet_now),
    quietUntil: rows[0]?.quiet_until ? new Date(rows[0].quiet_until).toISOString() : null,
    noncriticalPushedToday: Number(rows[0]?.pushed_today ?? 0),
  }
}

export async function processChiefAlerts(limit = 25): Promise<{
  processed: number
  pushed: number
  failed: number
}> {
  const rows = await listPendingChiefAlerts(limit)
  const settings = await getAiRuntimeSettings()
  const pushWindow = await getChiefPushWindow(settings)
  let noncriticalPushedToday = pushWindow.noncriticalPushedToday
  let processed = 0
  let pushed = 0
  let failed = 0

  for (const row of rows) {
    processed += 1
    const disposition: AiAlertDisposition = row.disposition === 'pending'
      ? classifyChiefAlert({ severity: row.severity, category: row.category, metadata: row.metadata })
      : row.disposition

    if (disposition !== 'pushover' && disposition !== 'critical_pushover') {
      await setAlertDisposition({
        alertId: String(row.id),
        disposition,
        pushoverStatus: disposition === 'log' || disposition === 'suppressed' ? 'suppressed' : 'not_requested',
        expectedSeverity: row.severity,
      })
      continue
    }

    if (process.env.AI_CHIEF_NOTIFICATION_GATE !== 'true') {
      // Dry-run mode: classify/dedupe/store the alert, but do not let the new Chief
      // path send Pushover yet. Legacy owner notifications remain active until the
      // rollout gate is explicitly flipped.
      await setAlertDisposition({
        alertId: String(row.id), disposition, pushoverStatus: 'suppressed', expectedSeverity: row.severity,
      })
      continue
    }

    if (disposition !== 'critical_pushover' && pushWindow.quietNow && !overnightEmergency(row)) {
      await setAlertDisposition({
        alertId: String(row.id), disposition, pushoverStatus: 'queued', nextNotifyAfter: pushWindow.quietUntil, expectedSeverity: row.severity,
      })
      continue
    }

    if (disposition !== 'critical_pushover'
        && noncriticalPushedToday >= settings.noncriticalPushLimitDay
        && !pushLimitExempt(row)) {
      await setAlertDisposition({ alertId: String(row.id), disposition: 'digest', pushoverStatus: 'suppressed', expectedSeverity: row.severity })
      continue
    }

    // Claim this alert before network I/O. A second cron invocation cannot send it concurrently.
    const claimed = await sql`
      UPDATE ai_alerts SET
        disposition=${disposition},
        pushover_status='queued',
        push_attempt_count=push_attempt_count+1,
        next_notify_after=NOW() + INTERVAL '5 minutes'
      WHERE id=${String(row.id)}::uuid
        AND resolved_at IS NULL
        AND severity=${row.severity}
        AND (
          pushover_status IN ('not_requested','failed')
          OR (pushover_status='queued' AND next_notify_after <= NOW())
        )
        AND (next_notify_after IS NULL OR next_notify_after <= NOW())
      RETURNING id
    ` as any[]
    if (claimed.length === 0) continue

    // An incident can resolve while waiting for its send lease. Re-check immediately
    // before network I/O so a resolved incident does not generate a stale owner push.
    // (A vanishingly small resolve-after-check race is still possible during the HTTP call;
    // disposition writes below are resolution-aware and never reopen the incident.)
    if (!(await isAiAlertOpen(String(row.id)))) continue

    const suffix = Number(row.occurrence_count ?? 1) > 1 ? `\nSeen ${Number(row.occurrence_count)} times.` : ''
    const result = await sendPushoverNotification({
      title: `${disposition === 'critical_pushover' ? 'CRITICAL — ' : ''}${String(row.title)}`,
      message: `${String(row.summary)}${suffix}`,
      priority: disposition === 'critical_pushover' ? 1 : 0,
      url: siteAdminUrl('/admin/ai?tab=alerts'),
      urlTitle: 'Open KVRN AI',
    }, { timeoutMs: PUSHOVER_TIMEOUT_MS })

    if (result.outcome === 'sent') {
      pushed += 1
      if (disposition !== 'critical_pushover') noncriticalPushedToday += 1
      await setAlertDisposition({
        alertId: String(row.id), disposition, pushoverStatus: 'sent', pushed: true, expectedSeverity: row.severity,
      })
    } else {
      failed += 1
      const attemptNumber = Number(row.push_attempt_count ?? 0) + 1
      if (disposition !== 'critical_pushover' && attemptNumber >= MAX_FAST_PUSH_ATTEMPTS) {
        // Avoid notification storms when transport outcomes are ambiguous. The unresolved
        // item remains in the dashboard/daily digest instead of being retried forever.
        await setAlertDisposition({ alertId: String(row.id), disposition: 'digest', pushoverStatus: 'suppressed', expectedSeverity: row.severity })
      } else {
        const delayMinutes = disposition === 'critical_pushover' && attemptNumber >= MAX_FAST_PUSH_ATTEMPTS
          ? CRITICAL_SLOW_RETRY_MINUTES
          : ALERT_RETRY_MINUTES
        const retryAt = new Date(Date.now() + delayMinutes * 60_000).toISOString()
        await setAlertDisposition({
          alertId: String(row.id), disposition, pushoverStatus: 'failed', nextNotifyAfter: retryAt, expectedSeverity: row.severity,
        })
      }
    }
  }

  return { processed, pushed, failed }
}

export async function getBusinessDayContext(
  timezone = process.env.AI_BUSINESS_TIMEZONE || DEFAULT_AI_TIMEZONE,
): Promise<{ businessDate: string; start: string; end: string; localHour: number; timezone: string }> {
  const rows = await sql`
    SELECT
      to_char(NOW() AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS business_date,
      ((date_trunc('day', NOW() AT TIME ZONE ${timezone})) AT TIME ZONE ${timezone}) AS start_at,
      ((date_trunc('day', NOW() AT TIME ZONE ${timezone}) + INTERVAL '1 day') AT TIME ZONE ${timezone}) AS end_at,
      EXTRACT(HOUR FROM NOW() AT TIME ZONE ${timezone})::int AS local_hour
  ` as any[]
  const row = rows[0]
  if (!row) throw new Error('AI_BUSINESS_DAY_UNAVAILABLE')
  return {
    businessDate: String(row.business_date),
    start: new Date(row.start_at).toISOString(),
    end: new Date(row.end_at).toISOString(),
    localHour: Number(row.local_hour),
    timezone,
  }
}

export type DailyBriefSnapshot = {
  businessDate: string
  timezone: string
  revenueCents: number
  orderCount: number
  contributionProfitCents: number | null
  profitCompleteness: string
  advertisingSpendCents: number
  visits: number
  reachedCart: number
  reachedCheckout: number
  purchases: number
  conversionPct: number | null
  unresolvedSupport: number
  lowStockVariants: number
  soldOutVariants: number
  pendingApprovals: number
  openCriticalAlerts: number
  openHighAlerts: number
  digestAlerts: number
  qaFailingFeatures: number
  qaNeverVerifiedFeatures: number
  aiActionsToday: number
  creatorRepliesWaiting: number
  affiliateApplicationsWaiting: number
  manualPayoutDrafts: number
  manualPayoutDraftCents: number | null
  manualPayoutReviewCommissions: number
  manualPayoutReviewCents: number | null
  topAttentionTitles: string[]
  aiSpendTodayMicros: number
  aiSpendMonthMicros: number
  aiMode: string
  dataWarnings: string[]
}

export async function collectDailyBriefSnapshot(
  timezone = process.env.AI_BUSINESS_TIMEZONE || DEFAULT_AI_TIMEZONE,
): Promise<DailyBriefSnapshot> {
  const day = await getBusinessDayContext(timezone)
  const range = { start: day.start, end: day.end }

  const results = await Promise.allSettled([
    createFinancialService(sql).getPeriodReport(range),
    createFunnelService(sql).getFunnelReport(range),
    sql`SELECT COUNT(*)::int AS n FROM support_threads WHERE status='open'`,
    getAllVariantsForAdmin(),
    sql`SELECT COUNT(*)::int AS n FROM ai_approvals WHERE state='pending'`,
    sql`
      SELECT COUNT(*) FILTER (WHERE resolved_at IS NULL AND severity='critical')::int AS critical,
             COUNT(*) FILTER (WHERE resolved_at IS NULL AND severity='high')::int AS high,
             COUNT(*) FILTER (WHERE resolved_at IS NULL AND disposition='digest')::int AS digest
      FROM ai_alerts
    `,
    getAiBudgetSnapshot(),
    sql`
      SELECT COALESCE(SUM(cost_micros),0)::bigint AS n FROM ai_model_calls
      WHERE created_at >= ${day.start}::timestamptz AND created_at < ${day.end}::timestamptz
        AND status IN ('succeeded','failed')
    `,
    sql`
      SELECT
        (SELECT COUNT(*)::int FROM ai_actions
          WHERE created_at >= ${day.start}::timestamptz AND created_at < ${day.end}::timestamptz) AS ai_actions_today,
        (SELECT COUNT(*)::int FROM qa_features
          WHERE enabled AND last_failed_at IS NOT NULL
            AND (last_passed_at IS NULL OR last_failed_at > last_passed_at)) AS qa_failing,
        (SELECT COUNT(*)::int FROM qa_features
          WHERE enabled AND last_passed_at IS NULL) AS qa_never_verified,
        (SELECT COUNT(*)::int FROM ai_creator_prospects
          WHERE status='replied' AND NOT do_not_contact) AS creator_replies_waiting,
        (SELECT COUNT(*)::int FROM affiliate_applications
          WHERE status IN ('pending','under_review','needs_info')) AS affiliate_applications_waiting
    `,
    sql`
      SELECT title FROM ai_alerts
      WHERE resolved_at IS NULL
        AND (severity IN ('critical','high') OR disposition='digest')
      ORDER BY CASE severity WHEN 'critical' THEN 3 WHEN 'high' THEN 2 ELSE 1 END DESC, last_seen_at DESC
      LIMIT 3
    `,
    getAffiliatePayoutReminder(),
  ])

  const dataWarnings: string[] = []
  const pick = <T,>(index: number, label: string, fallback: T): T => {
    const result = results[index]
    if (result?.status === 'fulfilled') return result.value as T
    dataWarnings.push(label)
    const reason = result?.status === 'rejected' ? result.reason : 'unknown'
    console.error(`[ai-chief] daily brief ${label} unavailable:`, String((reason as any)?.message ?? reason).slice(0, 120))
    return fallback
  }

  const financial: any = pick(0, 'finance', {
    period: { netRevenueCents: 0, orderCount: 0, canonicalOrderContributionCents: null, profitCompleteness: 'unavailable', advertisingSpendCents: 0 },
  })
  const funnel: any = pick(1, 'funnel', {
    stages: { visits: 0, reachedCart: 0, reachedCheckout: 0, purchased: 0 },
    rates: { visitToPurchase: null },
  })
  const supportRows: any[] = pick(2, 'support', [{ n: 0 }])
  const variants: any[] = pick(3, 'inventory', [])
  const approvalRows: any[] = pick(4, 'approvals', [{ n: 0 }])
  const alertRows: any[] = pick(5, 'alerts', [{ critical: 0, high: 0, digest: 0 }])
  const budget: any = pick(6, 'ai_budget', { monthSpendMicros: 0, mode: 'unknown' })
  const spendTodayRows: any[] = pick(7, 'ai_spend', [{ n: 0 }])
  const operationsRows: any[] = pick(8, 'ai_operations', [{ qa_failing: 0, qa_never_verified: 0, ai_actions_today: 0, creator_replies_waiting: 0, affiliate_applications_waiting: 0 }])
  const attentionRows: any[] = pick(9, 'attention', [])
  const manualPayout: any = pick(10, 'affiliate_payouts', {
    draftPayouts: 0, draftAmountCents: null,
    reviewCommissions: 0, reviewAmountCents: null,
  })

  const activeVariants = variants.filter(v => v.active)
  const lowStockVariants = activeVariants.filter(v => {
    const n = Number(v.available_quantity ?? 0)
    return n > 0 && n <= 2
  }).length
  const soldOutVariants = activeVariants.filter(v => Number(v.available_quantity ?? 0) <= 0).length

  return {
    businessDate: day.businessDate,
    timezone: day.timezone,
    revenueCents: Number(financial.period?.netRevenueCents ?? 0),
    orderCount: Number(financial.period?.orderCount ?? 0),
    contributionProfitCents: financial.period?.canonicalOrderContributionCents ?? null,
    profitCompleteness: String(financial.period?.profitCompleteness ?? 'unavailable'),
    advertisingSpendCents: Number(financial.period?.advertisingSpendCents ?? 0),
    visits: Number(funnel.stages?.visits ?? 0),
    reachedCart: Number(funnel.stages?.reachedCart ?? 0),
    reachedCheckout: Number(funnel.stages?.reachedCheckout ?? 0),
    purchases: Number(funnel.stages?.purchased ?? 0),
    conversionPct: funnel.rates?.visitToPurchase ?? null,
    unresolvedSupport: Number(supportRows[0]?.n ?? 0),
    lowStockVariants,
    soldOutVariants,
    pendingApprovals: Number(approvalRows[0]?.n ?? 0),
    openCriticalAlerts: Number(alertRows[0]?.critical ?? 0),
    openHighAlerts: Number(alertRows[0]?.high ?? 0),
    digestAlerts: Number(alertRows[0]?.digest ?? 0),
    qaFailingFeatures: Number(operationsRows[0]?.qa_failing ?? 0),
    qaNeverVerifiedFeatures: Number(operationsRows[0]?.qa_never_verified ?? 0),
    aiActionsToday: Number(operationsRows[0]?.ai_actions_today ?? 0),
    creatorRepliesWaiting: Number(operationsRows[0]?.creator_replies_waiting ?? 0),
    affiliateApplicationsWaiting: Number(operationsRows[0]?.affiliate_applications_waiting ?? 0),
    manualPayoutDrafts: Number(manualPayout.draftPayouts ?? 0),
    manualPayoutDraftCents: manualPayout.draftAmountCents ?? null,
    manualPayoutReviewCommissions: Number(manualPayout.reviewCommissions ?? 0),
    manualPayoutReviewCents: manualPayout.reviewAmountCents ?? null,
    topAttentionTitles: attentionRows.map(r => String(r.title)).filter(Boolean).slice(0, 3),
    aiSpendTodayMicros: Number(spendTodayRows[0]?.n ?? 0),
    aiSpendMonthMicros: Number(budget.monthSpendMicros ?? 0),
    aiMode: String(budget.mode ?? 'unknown'),
    dataWarnings,
  }
}

export function formatDailyBrief(snapshot: DailyBriefSnapshot): string {
  const profit = snapshot.profitCompleteness === 'complete'
    ? money(snapshot.contributionProfitCents)
    : 'Unknown / not reconciled'
  const attention: string[] = []
  if (snapshot.openCriticalAlerts > 0) attention.push(`${snapshot.openCriticalAlerts} critical alert${snapshot.openCriticalAlerts === 1 ? '' : 's'}`)
  if (snapshot.openHighAlerts > 0) attention.push(`${snapshot.openHighAlerts} high alert${snapshot.openHighAlerts === 1 ? '' : 's'}`)
  if (snapshot.digestAlerts > 0) attention.push(`${snapshot.digestAlerts} digest item${snapshot.digestAlerts === 1 ? '' : 's'}`)
  if (snapshot.pendingApprovals > 0) attention.push(`${snapshot.pendingApprovals} approval${snapshot.pendingApprovals === 1 ? '' : 's'}`)
  if (snapshot.qaFailingFeatures > 0) attention.push(`${snapshot.qaFailingFeatures} failing QA feature${snapshot.qaFailingFeatures === 1 ? '' : 's'}`)
  if (snapshot.qaNeverVerifiedFeatures > 0) attention.push(`${snapshot.qaNeverVerifiedFeatures} QA feature${snapshot.qaNeverVerifiedFeatures === 1 ? '' : 's'} never verified`)
  if (snapshot.unresolvedSupport > 0) attention.push(`${snapshot.unresolvedSupport} open support thread${snapshot.unresolvedSupport === 1 ? '' : 's'}`)
  if (snapshot.creatorRepliesWaiting > 0) attention.push(`${snapshot.creatorRepliesWaiting} creator repl${snapshot.creatorRepliesWaiting === 1 ? 'y' : 'ies'} waiting`)
  if (snapshot.affiliateApplicationsWaiting > 0) attention.push(`${snapshot.affiliateApplicationsWaiting} affiliate application${snapshot.affiliateApplicationsWaiting === 1 ? '' : 's'} waiting`)
  if (!snapshot.dataWarnings.includes('affiliate_payouts')) {
    if (snapshot.manualPayoutDrafts > 0) attention.push(`${snapshot.manualPayoutDrafts} unpaid affiliate payout draft${snapshot.manualPayoutDrafts === 1 ? '' : 's'} (${money(snapshot.manualPayoutDraftCents)})`)
    if (snapshot.manualPayoutReviewCommissions > 0) attention.push(`${snapshot.manualPayoutReviewCommissions} commission balance${snapshot.manualPayoutReviewCommissions === 1 ? '' : 's'} for manual payout review (${money(snapshot.manualPayoutReviewCents)}; subject to readiness checks)`)
  }
  if (snapshot.soldOutVariants > 0) attention.push(`${snapshot.soldOutVariants} sold-out variant${snapshot.soldOutVariants === 1 ? '' : 's'}`)
  else if (snapshot.lowStockVariants > 0) attention.push(`${snapshot.lowStockVariants} low-stock variant${snapshot.lowStockVariants === 1 ? '' : 's'}`)

  const top = snapshot.topAttentionTitles.length
    ? `Top: ${snapshot.topAttentionTitles.join(' • ')}`
    : null
  const missing = new Set(snapshot.dataWarnings)
  const financeLine = missing.has('finance')
    ? 'Revenue/Orders/Ads unavailable'
    : `Revenue ${money(snapshot.revenueCents)} • Orders ${snapshot.orderCount} • Ads ${money(snapshot.advertisingSpendCents)}`
  const funnelLine = missing.has('funnel')
    ? `Funnel unavailable • Contribution ${profit}`
    : `Visits ${snapshot.visits} • CVR ${pct(snapshot.conversionPct)} • Contribution ${profit}`
  const opsLine = [
    missing.has('ai_operations') ? 'Ops/QA unavailable' : `Ops ${snapshot.aiActionsToday} AI actions • QA ${snapshot.qaFailingFeatures ? `${snapshot.qaFailingFeatures} failing` : snapshot.qaNeverVerifiedFeatures ? `${snapshot.qaNeverVerifiedFeatures} unverified` : 'healthy'}`,
    missing.has('support') ? 'Support unavailable' : `Support ${snapshot.unresolvedSupport} open`,
  ].join(' • ')
  const aiLine = missing.has('ai_spend') || missing.has('ai_budget')
    ? 'AI spend/status unavailable'
    : `AI ${formatUsdMicros(snapshot.aiSpendTodayMicros)} today / ${formatUsdMicros(snapshot.aiSpendMonthMicros)} month • ${snapshot.aiMode}`
  return [
    financeLine,
    funnelLine,
    opsLine,
    aiLine,
    snapshot.dataWarnings.length ? `Data partial: ${snapshot.dataWarnings.join(', ')}` : null,
    attention.length ? `Needs attention: ${attention.join(' • ')}` : 'Nothing requires your attention.',
    top,
  ].filter(Boolean).join('\n')
}

async function claimDailyBrief(snapshot: DailyBriefSnapshot, summary: string): Promise<boolean> {
  const payload = JSON.stringify(snapshot)
  await sql`
    INSERT INTO ai_daily_briefs(business_date, timezone, summary, payload, pushover_status)
    VALUES (${snapshot.businessDate}::date, ${snapshot.timezone}, ${summary}, ${payload}::jsonb, 'pending')
    ON CONFLICT (business_date) DO NOTHING
  `
  const rows = await sql`
    UPDATE ai_daily_briefs SET pushover_status='sending', generated_at=NOW(), summary=${summary}, payload=${payload}::jsonb
    WHERE business_date=${snapshot.businessDate}::date AND pushover_status IN ('pending','failed','skipped')
    RETURNING business_date
  ` as any[]
  return rows.length > 0
}

export async function sendDailyChiefBriefIfDue(): Promise<{
  due: boolean
  sent: boolean
  businessDate?: string
  reason?: string
}> {
  const settings = await getAiRuntimeSettings()
  const day = await getBusinessDayContext(settings.businessTimezone)
  const hour = settings.dailyBriefHourLocal
  if (day.localHour < hour) return { due: false, sent: false, businessDate: day.businessDate, reason: 'before_daily_hour' }

  // Recover a prior worker that died after claiming the daily push but before recording the result.
  await sql`
    UPDATE ai_daily_briefs SET pushover_status='failed'
    WHERE business_date=${day.businessDate}::date
      AND pushover_status='sending'
      AND generated_at < NOW() - INTERVAL '15 minutes'
  `
  const existing = await sql`
    SELECT pushover_status, generated_at FROM ai_daily_briefs WHERE business_date=${day.businessDate}::date LIMIT 1
  ` as any[]
  if (existing[0]?.pushover_status === 'sent') {
    return { due: false, sent: false, businessDate: day.businessDate, reason: 'already_sent' }
  }
  if (existing[0]?.pushover_status === 'sending') {
    return { due: false, sent: false, businessDate: day.businessDate, reason: 'already_claimed' }
  }
  if (existing[0]?.pushover_status === 'failed' && existing[0]?.generated_at) {
    const lastAttempt = new Date(existing[0].generated_at).getTime()
    if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < ALERT_RETRY_MINUTES * 60_000) {
      return { due: false, sent: false, businessDate: day.businessDate, reason: 'daily_retry_cooldown' }
    }
  }

  if (process.env.AI_CHIEF_NOTIFICATION_GATE !== 'true' && existing[0]?.pushover_status === 'skipped') {
    return { due: false, sent: false, businessDate: day.businessDate, reason: 'dry_run_already_generated' }
  }

  const snapshot = await collectDailyBriefSnapshot(settings.businessTimezone)
  const summary = formatDailyBrief(snapshot)

  if (process.env.AI_CHIEF_NOTIFICATION_GATE !== 'true') {
    const payload = JSON.stringify(snapshot)
    await sql`
      INSERT INTO ai_daily_briefs(business_date, timezone, summary, payload, pushover_status, generated_at)
      VALUES (${snapshot.businessDate}::date, ${snapshot.timezone}, ${summary}, ${payload}::jsonb, 'skipped', NOW())
      ON CONFLICT (business_date) DO UPDATE SET
        timezone=EXCLUDED.timezone,
        summary=EXCLUDED.summary,
        payload=EXCLUDED.payload,
        pushover_status='skipped',
        generated_at=NOW(),
        sent_at=NULL
    `
    return { due: true, sent: false, businessDate: snapshot.businessDate, reason: 'chief_gate_disabled_dry_run' }
  }

  if (!(await claimDailyBrief(snapshot, summary))) {
    return { due: false, sent: false, businessDate: snapshot.businessDate, reason: 'claim_lost' }
  }

  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: snapshot.timezone, month: 'short', day: 'numeric',
  }).format(new Date())
  const result = await sendPushoverNotification({
    title: `KVRN Daily — ${dateLabel}`,
    message: summary,
    priority: snapshot.openCriticalAlerts > 0 ? 1 : 0,
    url: siteAdminUrl('/admin/ai'),
    urlTitle: 'Open KVRN AI',
  }, { timeoutMs: PUSHOVER_TIMEOUT_MS })

  if (result.outcome === 'sent') {
    await sql`
      UPDATE ai_daily_briefs SET pushover_status='sent', sent_at=NOW()
      WHERE business_date=${snapshot.businessDate}::date
    `
    return { due: true, sent: true, businessDate: snapshot.businessDate }
  }

  await sql`
    UPDATE ai_daily_briefs SET pushover_status='failed'
    WHERE business_date=${snapshot.businessDate}::date
  `
  return { due: true, sent: false, businessDate: snapshot.businessDate, reason: result.outcome === 'failed' ? result.reason : result.reason }
}

/** When enabled, a newly pending MANUAL payout can generate one owner alert.
 * Existing Chief dedupe, quiet-hours and rate controls own notification delivery.
 * Nothing here can create a payout, transfer money, or contact affiliates.
 */
export async function emitManualAffiliatePayoutAlert(): Promise<void> {
  // Do not generate a notification that would be permanently suppressed while off.
  if (process.env.AI_CHIEF_NOTIFICATION_GATE !== 'true') return
  const summary = await getAffiliatePayoutReminder()
  if (summary.draftPayouts === 0) {
    await resolveAiAlertsByDedupePrefix({
      sourceAgentId: 'chief', prefix: 'manual-affiliate-payout:',
      note: 'No unpaid affiliate payout drafts remain.',
    })
    return
  }
  if (summary.draftAmountCents === null) throw new Error('AFFILIATE_PAYOUT_REMINDER_AMOUNT_UNKNOWN')
  await upsertAiAlert({
    sourceAgentId: 'chief', severity: 'medium', category: 'approval',
    title: 'Manual affiliate payout needs review',
    summary: `${summary.draftPayouts} affiliate payout draft(s) for ${summary.draftAffiliates} affiliate(s), totalling ${money(summary.draftAmountCents)}, remain unpaid. Review readiness and pay externally before recording payment in Admin > Financials > Affiliates. No automatic funds transfer is enabled.`,
    dedupeKey: 'manual-affiliate-payout:unpaid-drafts',
    metadata: { requiresOwner: true, manualOnly: true },
  })
}

/** Create deduplicated budget warnings; Chief decides whether they actually push. */
export async function emitBudgetThresholdAlert(): Promise<void> {
  const b = await getAiBudgetSnapshot()
  const resolve = async (prefix: string, note: string) => {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'chief', prefix, note })
  }

  if (b.effectiveCommittedMicros >= b.operationalCutoffMicros) {
    await Promise.all([
      resolve('ai-budget:warning1','A higher AI budget tier superseded this warning.'),
      resolve('ai-budget:warning2','A higher AI budget tier superseded this warning.'),
      resolve('ai-budget:essential','The operational cutoff superseded essential-only mode.'),
    ])
    await upsertAiAlert({
      sourceAgentId: 'chief', severity: 'critical', category: 'budget',
      title: 'AI spending stopped',
      summary: `AI inference reached the ${formatUsdMicros(b.operationalCutoffMicros)} operational cutoff. Paid model calls are blocked until the monthly budget window resets.`,
      dedupeKey: 'ai-budget:cutoff', metadata: { requiresOwner: true },
    })
  } else if (b.effectiveCommittedMicros >= b.essentialOnlyMicros) {
    await Promise.all([
      resolve('ai-budget:warning1','A higher AI budget tier superseded this warning.'),
      resolve('ai-budget:warning2','A higher AI budget tier superseded this warning.'),
      resolve('ai-budget:cutoff','The prior operational-cutoff incident is no longer active.'),
    ])
    await upsertAiAlert({
      sourceAgentId: 'chief', severity: 'high', category: 'budget',
      title: 'AI essential-only mode',
      summary: `AI committed spend is ${formatUsdMicros(b.effectiveCommittedMicros)} (${formatUsdMicros(b.monthSpendMicros)} finalized) this month. Optional inference is disabled before the ${formatUsdMicros(b.operationalCutoffMicros)} cutoff.`,
      dedupeKey: 'ai-budget:essential', metadata: { requiresOwner: false },
    })
  } else if (b.effectiveCommittedMicros >= b.warning2Micros) {
    await Promise.all([
      resolve('ai-budget:warning1','A higher AI budget tier superseded this warning.'),
      resolve('ai-budget:essential','AI spend is below essential-only mode.'),
      resolve('ai-budget:cutoff','AI spend is below the operational cutoff.'),
    ])
    await upsertAiAlert({
      sourceAgentId: 'chief', severity: 'medium', category: 'budget',
      title: 'AI spend elevated',
      summary: `AI committed spend is ${formatUsdMicros(b.effectiveCommittedMicros)} (${formatUsdMicros(b.monthSpendMicros)} finalized) this month. Nonessential research should remain reduced.`,
      dedupeKey: 'ai-budget:warning2',
    })
  } else if (b.effectiveCommittedMicros >= b.warning1Micros) {
    await Promise.all([
      resolve('ai-budget:warning2','AI spend is below the second warning threshold.'),
      resolve('ai-budget:essential','AI spend is below essential-only mode.'),
      resolve('ai-budget:cutoff','AI spend is below the operational cutoff.'),
    ])
    await upsertAiAlert({
      sourceAgentId: 'chief', severity: 'low', category: 'budget',
      title: 'AI spend passed first warning',
      summary: `AI committed spend is ${formatUsdMicros(b.effectiveCommittedMicros)} (${formatUsdMicros(b.monthSpendMicros)} finalized) this month. No action is required yet.`,
      dedupeKey: 'ai-budget:warning1',
    })
  } else {
    await Promise.all([
      resolve('ai-budget:warning1','The monthly AI budget reset or spend fell below the first warning threshold.'),
      resolve('ai-budget:warning2','The monthly AI budget reset or spend fell below the second warning threshold.'),
      resolve('ai-budget:essential','The monthly AI budget is no longer in essential-only mode.'),
      resolve('ai-budget:cutoff','The monthly AI operational cutoff is no longer active.'),
    ])
  }
}

export async function runChiefCycle(): Promise<{
  executions: { claimed: number }
  alerts: { processed: number; pushed: number; failed: number }
  daily: { due: boolean; sent: boolean; businessDate?: string; reason?: string }
}> {
  // Run the safety governor before claiming approved actions. A failed governor
  // blocks execution but must not prevent the Chief's mandatory daily brief.
  const maintenanceErrors: string[] = []
  let governanceReady = false
  try {
    await enforceAgentAutonomySafety()
    governanceReady = true
  } catch (error) {
    maintenanceErrors.push('governance')
    console.error('[ai-chief] autonomy safety governor failed:', String(error instanceof Error ? error.message : error).slice(0, 120))
  }
  // Approved actions are claimed only after the safety governor has succeeded.
  const executions = governanceReady ? await processApprovedAiActions(10) : { claimed: 0 }
  try {
    await emitBudgetThresholdAlert()
  } catch (error) {
    maintenanceErrors.push('budget_alert')
    console.error('[ai-chief] budget threshold alert failed:', String(error instanceof Error ? error.message : error).slice(0, 120))
  }
  try {
    await emitManualAffiliatePayoutAlert()
  } catch (error) {
    maintenanceErrors.push('affiliate_payout_alert')
    console.error('[ai-chief] payout reminder alert failed:', String(error instanceof Error ? error.message : error).slice(0, 120))
  }
  const alerts = await processChiefAlerts()
  try {
    const runtimeSettings = await getAiRuntimeSettings()
    await refreshAiAgentMetrics(runtimeSettings.businessTimezone)
  } catch (error) {
    maintenanceErrors.push('agent_metrics')
    console.error('[ai-chief] agent metrics refresh failed:', String(error instanceof Error ? error.message : error).slice(0, 120))
  }
  const daily = await sendDailyChiefBriefIfDue()
  // The cron endpoint must not report a clean cycle if safety work failed.
  // Throw after the daily brief so a maintenance outage cannot hide owner notices.
  if (maintenanceErrors.length) throw new Error(`AI_CHIEF_MAINTENANCE_FAILED:${maintenanceErrors.join(',')}`)
  return { executions, alerts, daily }
}
