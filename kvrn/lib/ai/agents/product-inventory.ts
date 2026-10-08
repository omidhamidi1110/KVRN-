import { sql } from '@/lib/db'
import { createAiAction, markAiAction, upsertAiAlert, resolveAiAlertsByDedupePrefix } from '../repository'
import { proposeGovernedAction } from '../policy'

const DAY_MS = 24 * 60 * 60 * 1000

function finiteNumber(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export async function handleProductInventoryForecast(event: { id: string }): Promise<void> {
  const rows = await sql`
    WITH sold AS (
      SELECT oi.variant_id,
             COALESCE(SUM(oi.quantity) FILTER (WHERE o.paid_at >= NOW() - INTERVAL '7 days'),0)::int AS qty_7d,
             COALESCE(SUM(oi.quantity) FILTER (WHERE o.paid_at >= NOW() - INTERVAL '30 days'),0)::int AS qty_30d
      FROM order_items oi
      JOIN orders o ON o.id=oi.order_id AND o.payment_status='paid'
      WHERE oi.variant_id IS NOT NULL
      GROUP BY oi.variant_id
    )
    SELECT pv.id, pv.sku, pv.color_name, pv.size, pv.active,
           pv.stock_on_hand, pv.reserved_quantity,
           GREATEST(0, pv.stock_on_hand - pv.reserved_quantity)::int AS available_quantity,
           COALESCE(s.qty_7d,0)::int AS qty_7d,
           COALESCE(s.qty_30d,0)::int AS qty_30d,
           sp.supplier_name,sp.lead_time_days,sp.safety_buffer_days,sp.target_cover_days,sp.moq_units,sp.active AS supply_profile_active
    FROM product_variants pv
    LEFT JOIN sold s ON s.variant_id=pv.id
    LEFT JOIN ai_supply_profiles sp ON sp.variant_id=pv.id AND sp.active=TRUE
    WHERE pv.active=TRUE
    ORDER BY pv.sku
  ` as any[]

  const forecast = rows.map(r => {
    const available = finiteNumber(r.available_quantity)
    const qty7 = finiteNumber(r.qty_7d)
    const qty30 = finiteNumber(r.qty_30d)
    // Favor the recent 7-day velocity when it exists; fall back to 30-day average.
    const dailyVelocity = qty7 > 0 ? qty7 / 7 : qty30 > 0 ? qty30 / 30 : 0
    const daysRemaining = dailyVelocity > 0 ? available / dailyVelocity : null
    const leadTimeDays = r.lead_time_days == null ? null : finiteNumber(r.lead_time_days)
    const safetyBufferDays = r.safety_buffer_days == null ? null : finiteNumber(r.safety_buffer_days)
    const targetCoverDays = r.target_cover_days == null ? null : finiteNumber(r.target_cover_days)
    const moqUnits = r.moq_units == null ? null : Math.max(1, finiteNumber(r.moq_units,1))
    const reorderTriggerDays = leadTimeDays == null ? null : leadTimeDays + (safetyBufferDays ?? 0)
    const reorderNeeded = dailyVelocity > 0 && daysRemaining !== null && reorderTriggerDays !== null && daysRemaining <= reorderTriggerDays
    const rawRecommended = reorderNeeded && targetCoverDays !== null ? Math.max(0, Math.ceil(dailyVelocity * targetCoverDays - available)) : 0
    const recommendedUnits = rawRecommended > 0 && moqUnits ? Math.ceil(rawRecommended / moqUnits) * moqUnits : rawRecommended
    return {
      id: String(r.id), sku: String(r.sku), color: String(r.color_name), size: String(r.size),
      available, qty7, qty30, dailyVelocity, daysRemaining,
      supplierName:r.supplier_name ?? null,leadTimeDays,safetyBufferDays,targetCoverDays,moqUnits,reorderTriggerDays,reorderNeeded,recommendedUnits,
    }
  })

  const soldOut = forecast.filter(v => v.available <= 0)
  const reorderRisk = forecast.filter(v => v.reorderNeeded)
  const urgent = forecast.filter(v => v.available > 0 && v.daysRemaining !== null && v.daysRemaining <= 14)
  const watch = forecast.filter(v => v.available > 0 && v.daysRemaining !== null && v.daysRemaining > 14 && v.daysRemaining <= 30)

  const actionId = await createAiAction({
    agentId: 'product_inventory', eventId: event.id, actionType: 'inventory_demand_forecast',
    summary: `Forecasted stock runway for ${forecast.length} active variants.`,
    evidence: {
      activeVariants: forecast.length,
      soldOut: soldOut.length,
      projectedUnder14Days: urgent.length,
      projectedUnder30Days: watch.length,
      supplierLeadTimeRisks: reorderRisk.length,
      configuredSupplyProfiles: forecast.filter(v=>v.leadTimeDays!==null).length,
      methodology: '7d velocity when nonzero; otherwise 30d velocity; deterministic planning estimate; reorder risk compares runway with lead time + safety buffer',
    },
    riskLevel: soldOut.length > 0 || urgent.length > 0 || reorderRisk.length > 0 ? 'medium' : watch.length > 0 ? 'low' : 'info',
    permissionLevel: 'green', status: 'succeeded', ownerVisible: soldOut.length > 0 || urgent.length > 0 || reorderRisk.length > 0,
    idempotencyKey: `inventory-forecast:${event.id}`,
  })
  if (urgent.length > 0 || reorderRisk.length > 0) {
    const top = (reorderRisk.length ? reorderRisk : urgent).sort((a,b)=>(a.daysRemaining ?? 999)-(b.daysRemaining ?? 999)).slice(0,5)
    const withRecommendations = top.filter(v=>v.recommendedUnits>0)
    let ownerActionId = actionId
    let approvalId: string | undefined
    if (withRecommendations.length > 0) {
      const plan = await proposeGovernedAction({
        agentId:'product_inventory', actionType:'inventory_reorder_plan',
        summary:`Review reorder planning estimate for ${withRecommendations.length} at-risk variant${withRecommendations.length===1?'':'s'}.`,
        permission:'yellow', risk:'medium', resource:'inventory_reorder_plan',
        evidence:{
          recommendationOnly:true, neverAutoPurchase:true,
          recommendations:withRecommendations.map(v=>({
            variantId:v.id,sku:v.sku,recommendedUnits:v.recommendedUnits,available:v.available,
            dailyVelocity:Number(v.dailyVelocity.toFixed(4)),daysRemaining:v.daysRemaining==null?null:Number(v.daysRemaining.toFixed(1)),
            supplierName:v.supplierName,leadTimeDays:v.leadTimeDays,safetyBufferDays:v.safetyBufferDays,moqUnits:v.moqUnits,
          })),
        },
        idempotencyKey:`inventory-reorder-plan:${new Date(Math.floor(Date.now()/DAY_MS)*DAY_MS).toISOString().slice(0,10)}`,
      })
      ownerActionId = plan.actionId
      approvalId = plan.approvalId
    }
    await upsertAiAlert({
      sourceAgentId: 'product_inventory', severity: 'medium', category: 'inventory_purchase',
      title: reorderRisk.length ? 'Inventory may miss supplier lead time' : 'Inventory runway needs review',
      summary: reorderRisk.length
        ? `${reorderRisk.length} variant${reorderRisk.length===1?' is':'s are'} inside supplier lead-time + safety-buffer windows. ${withRecommendations.length ? `Planning estimate: ${withRecommendations.map(v=>`${v.sku} +${v.recommendedUnits}`).join(', ')}.` : ''}`
        : `${urgent.length} active variant${urgent.length === 1 ? '' : 's'} are projected below 14 days of stock at recent sales velocity. Fastest: ${top.map(v => `${v.sku} ~${Math.max(1, Math.round(v.daysRemaining ?? 0))}d`).join(', ')}.`,
      dedupeKey: 'inventory:runway',
      actionId:ownerActionId,
      metadata: { requiresOwner: true, approvalId:approvalId ?? null, affected: top.map(v => v.id), recommendationOnly: true, neverAutoPurchase:true },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'product_inventory', prefix:'inventory:runway', note:'Inventory runway is no longer inside the configured risk window.' })
  }

  await markAiAction({
    actionId, status: 'succeeded', completed: true,
    outcome: {
      soldOut: soldOut.slice(0, 20),
      urgent: urgent.sort((a,b)=>(a.daysRemaining ?? 999)-(b.daysRemaining ?? 999)).slice(0,20),
      reorderRecommendations: reorderRisk.sort((a,b)=>(a.daysRemaining ?? 999)-(b.daysRemaining ?? 999)).slice(0,20),
      watchCount: watch.length,
    },
  })
}
