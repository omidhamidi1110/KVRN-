import { sql } from '@/lib/db'
import { createAiAction, getAiRuntimeSettings, markAiAction, upsertAiAlert, resolveAiAlertsByDedupePrefix } from '../repository'

const EVIDENCE_STALE_MS = 6 * 60 * 60 * 1000
const DISCREPANCY_MIN_CENTS = 500
const DISCREPANCY_MIN_RATIO = 0.10

function finiteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function providerSpendUsd(row: any): number | null {
  // Meta returns spend at the row root; TikTok integrated reporting returns it
  // under metrics. Keep both shapes explicit so a provider format change becomes
  // a visible data-quality problem instead of silently turning into $0 spend.
  return finiteNonNegative(row?.spend ?? row?.metrics?.spend)
}

function ageMs(value: unknown): number | null {
  if (!value) return null
  const t = new Date(String(value)).getTime()
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null
}

export async function handleAdsSocialMonitor(event: { id: string }): Promise<void> {
  const settings = await getAiRuntimeSettings().catch(() => null)
  const timezone = settings?.businessTimezone ?? process.env.AI_BUSINESS_TIMEZONE ?? 'America/Los_Angeles'
  const [spendRows, socialRows, integrationRows, externalRows] = await Promise.all([
    sql`
      WITH local_day AS (SELECT (NOW() AT TIME ZONE ${timezone})::date AS d)
      SELECT platform,
             ROUND(COALESCE(SUM(
               spend_cents::numeric
               * (LEAST(period_end, l.d) - GREATEST(period_start, l.d - 6) + 1)::numeric
               / NULLIF((period_end - period_start + 1), 0)::numeric
             ),0))::bigint AS spend_7d
      FROM ad_spend CROSS JOIN local_day l
      WHERE voided_at IS NULL
        AND period_start <= l.d
        AND period_end >= l.d - 6
      GROUP BY platform
      ORDER BY platform
    `,
    sql`
      SELECT platform, COUNT(*)::int AS snapshots,
             MAX(captured_at) AS last_captured_at
      FROM ai_social_snapshots
      WHERE captured_at >= NOW()-INTERVAL '7 days'
      GROUP BY platform
    `,
    sql`
      SELECT id, enabled, connection_state, last_success_at, last_failure_at
      FROM ai_integrations WHERE id IN ('meta','tiktok')
    `,
    sql`
      SELECT DISTINCT ON (integration_id,dataset)
             integration_id,dataset,period_start,period_end,captured_at,payload
      FROM ai_external_snapshots
      WHERE integration_id IN ('meta','tiktok') AND dataset='ads_performance'
      ORDER BY integration_id,dataset,captured_at DESC
    `,
  ]) as any[][]

  const canonicalByPlatform = new Map<string, number>()
  for (const row of spendRows) canonicalByPlatform.set(String(row.platform), Number(row.spend_7d ?? 0))
  const canonicalSpend7dCents = [...canonicalByPlatform.values()].reduce((sum, cents) => sum + cents, 0)
  const integrationById = new Map(integrationRows.map((r:any) => [String(r.id), r]))

  const failedEnabled = integrationRows.filter((r:any)=>r.enabled && ['failed','degraded'].includes(String(r.connection_state)))
  const staleEnabled = integrationRows.filter((r:any)=>
    r.enabled && r.connection_state==='ready' &&
    (!r.last_success_at || ageMs(r.last_success_at) === null || (ageMs(r.last_success_at) ?? Infinity) > EVIDENCE_STALE_MS)
  )

  const providerEvidence = externalRows.map((r:any)=>{
    const rows=Array.isArray(r.payload?.rows)?r.payload.rows:[]
    let reportedSpendUsd = 0
    let invalidSpendRows = 0
    for (const row of rows) {
      const spend = providerSpendUsd(row)
      if (spend === null) invalidSpendRows += 1
      else reportedSpendUsd += spend
    }
    const evidenceAgeMs = ageMs(r.captured_at)
    const integration = integrationById.get(String(r.integration_id)) as any
    return {
      integrationId:String(r.integration_id),
      capturedAt:r.captured_at,
      periodStart:r.period_start,
      periodEnd:r.period_end,
      rowCount:rows.length,
      invalidSpendRows,
      evidenceFresh:evidenceAgeMs !== null && evidenceAgeMs <= EVIDENCE_STALE_MS,
      integrationReady:Boolean(integration?.enabled && integration?.connection_state === 'ready'),
      reportedSpendUsd:Number(reportedSpendUsd.toFixed(2)),
    }
  })

  const evidenceProblems = providerEvidence.filter((e:any) =>
    e.integrationReady && (!e.evidenceFresh || e.invalidSpendRows > 0)
  )
  const snapshotIds = new Set(providerEvidence.map((e:any) => String(e.integrationId)))
  const missingSnapshotIds = integrationRows
    .filter((r:any) => r.enabled && r.connection_state === 'ready' && !snapshotIds.has(String(r.id)))
    .map((r:any) => String(r.id))

  const discrepancyDiagnostics = providerEvidence
    .filter((e:any) => e.integrationReady && e.evidenceFresh && e.invalidSpendRows === 0)
    .map((e:any) => {
      const canonicalCents = e.integrationId === 'meta'
        ? (canonicalByPlatform.get('meta') ?? 0) + (canonicalByPlatform.get('instagram') ?? 0)
        : e.integrationId === 'tiktok'
          ? (canonicalByPlatform.get('tiktok') ?? 0)
          : 0
      const providerCents = Math.round(e.reportedSpendUsd * 100)
      const differenceCents = providerCents - canonicalCents
      const denominator = Math.max(providerCents, canonicalCents, 1)
      const differenceRatio = Math.abs(differenceCents) / denominator
      return {
        integrationId:e.integrationId,
        canonicalCents,
        providerCents,
        differenceCents,
        differenceRatio:Number(differenceRatio.toFixed(4)),
        material:Math.abs(differenceCents) >= DISCREPANCY_MIN_CENTS && differenceRatio >= DISCREPANCY_MIN_RATIO,
      }
    })
  const materialDiscrepancies = discrepancyDiagnostics.filter((d:any)=>d.material)

  const unhealthyIds = [...new Set([
    ...failedEnabled.map((r:any)=>String(r.id)),
    ...staleEnabled.map((r:any)=>String(r.id)),
    ...evidenceProblems.map((e:any)=>String(e.integrationId)),
    ...missingSnapshotIds,
  ])].sort()

  const actionId = await createAiAction({
    agentId: 'ads_social', eventId: event.id, actionType: 'ads_social_health',
    summary: 'Checked canonical ad-spend records, social snapshot freshness, and provider evidence health.',
    evidence: {
      canonicalSpend7dCents,
      platformRows: spendRows.map((r:any)=>({
        platform:r.platform,
        spend7dCents:Number(r.spend_7d ?? 0),
      })),
      socialSnapshots: socialRows,
      failedEnabledIntegrations: failedEnabled.map((r:any)=>r.id),
      staleEnabledIntegrations: staleEnabled.map((r:any)=>r.id),
      providerEvidence,
      missingSnapshotIntegrations:missingSnapshotIds,
      discrepancyDiagnostics,
      note:'Provider-reported values are diagnostic evidence only; canonical KVRN ad_spend remains authoritative for accounting and is never overwritten here.',
    },
    riskLevel: unhealthyIds.length || materialDiscrepancies.length ? 'medium' : 'info', permissionLevel: 'green', status: 'succeeded',
    ownerVisible: unhealthyIds.length > 0 || materialDiscrepancies.length > 0,
    idempotencyKey: `ads-social-monitor:${event.id}`,
  })

  if (unhealthyIds.length) {
    await upsertAiAlert({
      sourceAgentId: 'ads_social', severity: 'medium', category: 'integration',
      title: 'Ads/social evidence integration degraded',
      summary: `${unhealthyIds.join(', ')} has failed, stale, or malformed evidence. Paid campaigns are not being changed automatically.`,
      dedupeKey: 'ads-social:integration',
      actionId, metadata: { requiresOwner: false, integrations:unhealthyIds },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({
      sourceAgentId:'ads_social', prefix:'ads-social:integration', note:'Meta/TikTok evidence integrations are healthy again.',
    })
  }

  if (materialDiscrepancies.length) {
    await upsertAiAlert({
      sourceAgentId:'ads_social', severity:'medium', category:'data_quality',
      title:'Ad spend evidence differs from KVRN records',
      summary:'Fresh provider-reported ad spend materially differs from KVRN canonical ad-spend records. Treat this as a reconciliation diagnostic; no financial records or campaigns were changed.',
      dedupeKey:'ads-social:spend-discrepancy', actionId,
      metadata:{ requiresOwner:false, discrepancies:materialDiscrepancies },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({
      sourceAgentId:'ads_social', prefix:'ads-social:spend-discrepancy', note:'Provider and KVRN ad-spend evidence are within the diagnostic tolerance again.',
    })
  }

  await markAiAction({ actionId, status: 'succeeded', completed: true, outcome: {
    canonicalSpend7dCents,
    providerEvidence,
    materialDiscrepancies,
    externalChangeMade: false,
  } })
}
