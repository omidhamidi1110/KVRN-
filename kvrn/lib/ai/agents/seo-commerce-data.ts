import { sql } from '@/lib/db'
import { createAiAction, markAiAction, upsertAiAlert, resolveAiAlertsByDedupePrefix } from '../repository'

export async function handleSeoCommerceDataMonitor(event: { id: string }): Promise<void> {
  const [rows,snapshots] = await Promise.all([
    sql`
      SELECT id, provider, enabled, connection_state, last_success_at, last_failure_at, last_error_code
      FROM ai_integrations
      WHERE id IN ('google_search_console','google_merchant')
      ORDER BY id
    `,
    sql`
      SELECT DISTINCT ON (integration_id,dataset)
             integration_id,dataset,captured_at,payload
      FROM ai_external_snapshots
      WHERE integration_id IN ('google_search_console','google_merchant')
      ORDER BY integration_id,dataset,captured_at DESC
    `,
  ]) as any[][]

  const broken = rows.filter((r:any)=>r.enabled && ['failed','degraded'].includes(String(r.connection_state)))
  const stale = rows.filter((r:any)=>
    r.enabled && r.connection_state==='ready' &&
    (!r.last_success_at || new Date(r.last_success_at).getTime()<Date.now()-36*60*60*1000)
  )

  const merchantIssues=snapshots.find((r:any)=>r.integration_id==='google_merchant'&&r.dataset==='product_issues')
  const issueCount=Array.isArray(merchantIssues?.payload?.results)?merchantIssues.payload.results.length:0
  const searchDaily=snapshots.find((r:any)=>r.integration_id==='google_search_console'&&r.dataset==='search_daily')
  const searchRows=Array.isArray(searchDaily?.payload?.rows)?searchDaily.payload.rows:[]
  const searchTotals=searchRows.reduce(
    (a:any,r:any)=>({clicks:a.clicks+Number(r?.clicks||0),impressions:a.impressions+Number(r?.impressions||0)}),
    {clicks:0,impressions:0},
  )

  const unhealthy=[...broken,...stale]
  const actionId = await createAiAction({
    agentId: 'seo_commerce_data', eventId: event.id, actionType: 'seo_commerce_health',
    summary: 'Checked Google search/merchant integration health and latest external evidence.',
    evidence: {
      integrations: rows.map((r:any)=>({
        id:r.id, enabled:r.enabled, state:r.connection_state,
        lastSuccessAt:r.last_success_at ?? null, lastFailureAt:r.last_failure_at ?? null,
        errorCode:r.last_error_code ?? null,
      })),
      merchantProductIssues:issueCount,
      searchConsoleTotals:searchTotals,
    },
    riskLevel: unhealthy.length || issueCount>0 ? 'medium' : 'info',
    permissionLevel: 'green', status: 'succeeded', ownerVisible: unhealthy.length>0 || issueCount>0,
    idempotencyKey: `seo-commerce-monitor:${event.id}`,
  })
  if (unhealthy.length) {
    const ids=[...new Set(unhealthy.map((r:any)=>String(r.id)))].sort()
    await upsertAiAlert({
      sourceAgentId: 'seo_commerce_data', severity: 'medium', category: 'integration',
      title: 'Search/commerce evidence integration degraded',
      summary: `${ids.join(', ')} needs attention because its evidence is failed, degraded, or stale. KVRN commerce remains canonical; no feed/product data was changed automatically.`,
      dedupeKey: 'seo:integration',
      actionId, metadata: { requiresOwner:false, integrations:ids },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'seo_commerce_data', prefix:'seo:integration', note:'Google search/commerce evidence integrations are healthy again.' })
  }
  if (issueCount > 0) {
    await upsertAiAlert({
      sourceAgentId:'seo_commerce_data', severity:'medium', category:'merchant_feed',
      title:'Google Merchant product issues detected',
      summary:`Google Merchant evidence currently contains ${issueCount} product issue${issueCount===1?'':'s'}. Review before scaling Shopping traffic.`,
      dedupeKey:'seo:merchant-product-issues',
      actionId, metadata:{requiresOwner:false,issueCount},
    })
  } else {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'seo_commerce_data', prefix:'seo:merchant-product-issues', note:'Google Merchant no longer reports product issues in the latest complete snapshot.' })
  }
  await markAiAction({ actionId, status: 'succeeded', completed: true, outcome: {
    broken: broken.map((r:any)=>r.id),
    stale: stale.map((r:any)=>r.id),
    merchantProductIssues:issueCount,
    searchConsoleTotals:searchTotals,
    externalChangeMade:false,
  } })

}
