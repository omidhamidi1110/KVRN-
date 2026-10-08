import { sql } from '@/lib/db'
import { createAiAction, markAiAction, upsertAiAlert, resolveAiAlertsByDedupePrefix } from '../repository'

export async function handleEngineeringQaMonitor(event: { id: string }): Promise<void> {
  const rows = await sql`
    SELECT id,name,area,criticality,last_passed_at,last_failed_at,enabled
    FROM qa_features
    WHERE enabled=TRUE
    ORDER BY CASE criticality WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC, name
  ` as any[]
  const failing = rows.filter(r => r.last_failed_at && (!r.last_passed_at || new Date(r.last_failed_at).getTime() > new Date(r.last_passed_at).getTime()))
  const never = rows.filter(r => !r.last_passed_at)
  const criticalFail = failing.filter(r => r.criticality==='critical')

  const actionId = await createAiAction({
    agentId: 'engineering_qa', eventId: event.id, actionType: 'qa_regression_health',
    summary: `Checked automated feature-verification state for ${rows.length} registered features.`,
    evidence: {
      features: rows.length,
      currentlyFailing: failing.length,
      neverVerified: never.length,
      criticalFailing: criticalFail.map(r=>({ id:r.id,name:r.name })),
      failing: failing.slice(0,20).map(r=>({ id:r.id,name:r.name,criticality:r.criticality,lastFailedAt:r.last_failed_at,lastPassedAt:r.last_passed_at })),
    },
    riskLevel: criticalFail.length ? 'critical' : failing.length ? 'high' : never.length ? 'low' : 'info',
    permissionLevel: 'green', status: 'succeeded', ownerVisible: failing.length > 0,
    idempotencyKey: `engineering-qa-monitor:${event.id}`,
  })
  if (criticalFail.length) {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'engineering_qa', prefix:'qa:failing', note:'Noncritical QA incident superseded by the current critical regression state.' })
    await upsertAiAlert({
      sourceAgentId: 'engineering_qa', severity: 'critical', category: 'site_outage',
      title: 'Critical regression test failing',
      summary: `${criticalFail.length} critical feature${criticalFail.length===1?' is':'s are'} currently failing automated verification: ${criticalFail.slice(0,5).map(r=>r.name).join(', ')}.`,
      dedupeKey: 'qa:critical',
      actionId, metadata: { requiresOwner:true, featureIds:criticalFail.map(r=>r.id).slice(0,50) },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'engineering_qa', prefix:'qa:critical', note:'Critical automated regression failures have cleared.' })
    if (failing.length) {
      await upsertAiAlert({
        sourceAgentId: 'engineering_qa', severity: 'high', category: 'qa',
        title: 'Regression test failure',
        summary: `${failing.length} registered feature${failing.length===1?' is':'s are'} currently failing automated verification. Engineering review is required.`,
        dedupeKey: 'qa:failing',
        actionId, metadata: { requiresOwner:false, featureIds:failing.map(r=>r.id).slice(0,50) },
      })
    } else {
      await resolveAiAlertsByDedupePrefix({ sourceAgentId:'engineering_qa', prefix:'qa:failing', note:'Automated regression failures have cleared.' })
    }
  }
  await markAiAction({ actionId, status: 'succeeded', completed: true, outcome: { failing:failing.length, neverVerified:never.length } })

}
