import { sql } from '@/lib/db'
import { createAiAction, markAiAction } from '../repository'

export async function handleMarketIntelFreshness(event: { id: string }): Promise<void> {
  const rows = await sql`
    SELECT t.id, t.name, t.target_type, t.priority,
           MAX(o.observed_at) AS last_observed_at,
           COUNT(o.id) FILTER (WHERE o.observed_at >= NOW()-INTERVAL '30 days')::int AS observations_30d
    FROM ai_market_targets t
    LEFT JOIN ai_market_observations o ON o.target_id=t.id
    WHERE t.active=TRUE
    GROUP BY t.id,t.name,t.target_type,t.priority
    ORDER BY t.priority ASC, t.name
  ` as any[]
  const stale = rows.filter(r => !r.last_observed_at || new Date(r.last_observed_at).getTime() < Date.now()-7*24*60*60*1000)
  const actionId = await createAiAction({
    agentId: 'market_intel', eventId: event.id, actionType: 'market_intel_freshness',
    summary: rows.length ? `Checked freshness for ${rows.length} active market-intelligence targets.` : 'No market-intelligence targets are configured yet.',
    evidence: { activeTargets: rows.length, staleTargets: stale.length, stale: stale.slice(0,20).map(r=>({ id:r.id,name:r.name,type:r.target_type,priority:r.priority,lastObservedAt:r.last_observed_at ?? null })) },
    riskLevel: 'info', permissionLevel: 'green', status: 'succeeded', ownerVisible: false,
    idempotencyKey: `market-intel-freshness:${event.id}`,
  })
  await markAiAction({ actionId, status: 'succeeded', completed: true, outcome: {
    researchTriggered: false,
    reason: process.env.AI_WEB_RESEARCH_ENABLED === 'true' ? 'Approved public market research is enabled and runs as a separate scheduled refresh; this pass only checks evidence freshness.' : 'Public web research is disabled until explicitly connected/enabled.',
  } })
}
