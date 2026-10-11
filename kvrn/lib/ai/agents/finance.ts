import { sql } from '@/lib/db'
import { createFinancialService } from '@/lib/financials'
import { runAiTask } from '../router'
import { parseStrictJsonObject, sanitizeExternalText } from '../sanitize'
import { createAiAction, markAiAction, upsertAiAlert, resolveAiAlertsByDedupePrefix } from '../repository'

export async function handlePaymentExceptionMonitor(event: { id: string }): Promise<void> {
  const rows = await sql`
    SELECT COUNT(*)::int AS open_count,
           COALESCE(SUM(amount_cents),0)::bigint AS amount_cents,
           MIN(created_at) AS oldest
    FROM payment_exceptions WHERE status='open'
  ` as any[]
  const count = Number(rows[0]?.open_count ?? 0)
  const amountCents = Number(rows[0]?.amount_cents ?? 0)
  const actionId = await createAiAction({
    agentId: 'finance_risk', eventId: event.id, actionType: 'payment_exception_monitor',
    summary: count > 0 ? `${count} open payment exception${count === 1 ? '' : 's'} detected.` : 'No open payment exceptions.',
    evidence: { openCount: count, amountCents, oldestAt: rows[0]?.oldest ?? null },
    riskLevel: count > 0 ? 'high' : 'info', permissionLevel: 'green', status: 'succeeded',
    ownerVisible: count > 0, idempotencyKey: `payment-exception-monitor:${event.id}`,
  })
  if (count > 0) {
    await upsertAiAlert({
      sourceAgentId: 'finance_risk', severity: 'high', category: 'payment',
      title: 'Open payment exception',
      summary: `${count} paid-checkout exception${count === 1 ? '' : 's'} remain unresolved, totaling $${(amountCents / 100).toFixed(2)}.`,
      dedupeKey: 'finance:open-payment-exceptions', actionId,
      metadata: { requiresOwner: true, count, amountCents },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({
      sourceAgentId:'finance_risk', prefix:'finance:open-payment-exceptions', note:'All previously open payment exceptions are resolved.',
    })
  }
  await markAiAction({ actionId, status: 'succeeded', outcome: { openCount: count, amountCents }, completed: true })
}


function range(daysAgoStart: number, daysAgoEnd: number) {
  const day = 24 * 60 * 60 * 1000
  const end = new Date(Date.now() - daysAgoEnd * day)
  const start = new Date(Date.now() - daysAgoStart * day)
  return { start:start.toISOString(), end:end.toISOString() }
}

/**
 * Deterministic CFO health pass. All money comes from KVRN's canonical financial
 * service; the model is allowed to interpret anomalies, never recompute accounting.
 */
export async function handleFinancePerformanceMonitor(event: { id:string }): Promise<void> {
  const service = createFinancialService(sql)
  const [current, previous, sessionRows, attributionRows] = await Promise.all([
    service.getPeriodReport(range(7,0)),
    service.getPeriodReport(range(14,7)),
    sql`SELECT COUNT(*)::int AS sessions_7d FROM analytics_sessions WHERE first_seen_at >= NOW()-INTERVAL '7 days'`,
    sql`
      SELECT COALESCE(NULLIF(lower(attribution->'last_touch'->>'source'),''),'unattributed') AS source,
             COUNT(*)::int AS orders
      FROM orders
      WHERE paid_at >= NOW()-INTERVAL '7 days' AND paid_at < NOW()
      GROUP BY 1 ORDER BY orders DESC
    `,
  ]) as any[]
  const p:any=current.period
  const pp:any=previous.period
  const sessions=Number((sessionRows as any[])[0]?.sessions_7d ?? 0)
  const adSpend=Number(p.advertisingSpendCents ?? 0)
  const netRevenue=Number(p.netRevenueCents ?? 0)
  const contribution=Number(p.contributionProfitCents ?? 0)
  const canonicalContribution=p.canonicalOrderContributionCents == null ? null : Number(p.canonicalOrderContributionCents)
  const canonicalOperating=p.canonicalOperatingProfitCents == null ? null : Number(p.canonicalOperatingProfitCents)
  const mer=adSpend>0 ? netRevenue/adSpend : null
  const contributionPerSession=sessions>0 && canonicalContribution!=null ? canonicalContribution/sessions : null
  const complete=String(p.profitCompleteness)==='complete' && String(current.integrity?.state)==='RECONCILED'
  const previousComplete=String(pp.profitCompleteness)==='complete' && String(previous.integrity?.state)==='RECONCILED'

  const spendNoOrders=adSpend>=10_000 && Number(p.orderCount ?? 0)===0
  const losingAfterMeaningfulSpend=complete && adSpend>=10_000 && canonicalOperating!=null && canonicalOperating <= -10_000
  const contributionDrop=complete && previousComplete && canonicalContribution!=null && pp.canonicalOrderContributionCents!=null
    && Number(pp.canonicalOrderContributionCents)>0
    ? (Number(pp.canonicalOrderContributionCents)-canonicalContribution)/Number(pp.canonicalOrderContributionCents)
    : 0
  const meaningful=spendNoOrders || losingAfterMeaningfulSpend || contributionDrop>=0.5

  const actionId=await createAiAction({
    agentId:'finance_risk', eventId:event.id, actionType:'finance_performance_monitor',
    summary: meaningful ? 'Finance monitor detected a meaningful profitability/advertising anomaly.' : 'Finance performance monitor found no material trigger.',
    evidence:{
      periodDays:7,orderCount:Number(p.orderCount??0),sessions,netRevenueCents:netRevenue,
      canonicalOrderContributionCents:canonicalContribution,canonicalOperatingProfitCents:canonicalOperating,
      knownSoFarContributionCents:contribution,advertisingSpendCents:adSpend,mer,
      contributionPerSessionCents:contributionPerSession,profitCompleteness:p.profitCompleteness,
      integrityState:current.integrity?.state ?? null,attributedOrderCounts:attributionRows,
      triggers:{spendNoOrders,losingAfterMeaningfulSpend,relativeContributionDrop:contributionDrop},
    },
    riskLevel:losingAfterMeaningfulSpend||spendNoOrders?'high':meaningful?'medium':'info',
    permissionLevel:'green',status:'running',ownerVisible:meaningful,idempotencyKey:`finance-performance:${event.id}`,
  })

  if (spendNoOrders || losingAfterMeaningfulSpend) {
    await upsertAiAlert({sourceAgentId:'finance_risk',severity:'high',category:'financial_performance',
      title:spendNoOrders?'Meaningful ad spend with no paid orders':'Canonical operating result is materially negative',
      summary:spendNoOrders
        ? `KVRN recorded $${(adSpend/100).toFixed(2)} of advertising spend in 7 days with no paid orders.`
        : `Canonical 7-day operating result is $${((canonicalOperating??0)/100).toFixed(2)} after $${(adSpend/100).toFixed(2)} of advertising spend.`,
      dedupeKey:`finance:performance:${spendNoOrders?'spend-no-orders':'negative-operating'}`,
      actionId,metadata:{requiresOwner:true,canonical:true}
    })
  }
  if (!spendNoOrders) {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'finance_risk', prefix:'finance:performance:spend-no-orders', note:'Paid orders are no longer absent under meaningful ad spend.' })
  }
  if (!losingAfterMeaningfulSpend) {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'finance_risk', prefix:'finance:performance:negative-operating', note:'The material negative canonical operating-result condition has cleared.' })
  }
  if (!meaningful || process.env.AI_ENABLED!=='true' || !complete) {
    await markAiAction({ actionId,status: meaningful?'skipped':'succeeded',completed:true,outcome:{
      reason:!meaningful?'NO_AI_NEEDED':!complete?'CANONICAL_PROFIT_NOT_EXACT':'AI_DISABLED',
      accountingInterpretationUsed:false,
    }})
  } else {
    try {
      const result=await runAiTask({
        agentId:'finance_risk',role:'finance',purpose:'material_finance_anomaly_interpretation',actionId,
        essential:losingAfterMeaningfulSpend||spendNoOrders,maxOutputTokens:3200,temperature:0,
        system:'You are KVRN Finance & Risk. The supplied numbers are already calculated by canonical KVRN code. Do not recompute or invent accounting. Explain the likely business significance and the next evidence check. Do not recommend spending more money automatically. Return one JSON object only: {"interpretation":string,"confidence":number,"next_check":string,"owner_attention":boolean}.',
        input:JSON.stringify({current:{orders:p.orderCount,sessions,netRevenueCents:netRevenue,canonicalOrderContributionCents:canonicalContribution,canonicalOperatingProfitCents:canonicalOperating,advertisingSpendCents:adSpend,mer,contributionPerSessionCents:contributionPerSession},previous:{orders:pp.orderCount,canonicalOrderContributionCents:pp.canonicalOrderContributionCents,advertisingSpendCents:pp.advertisingSpendCents},triggers:{spendNoOrders,losingAfterMeaningfulSpend,contributionDrop}}),
      })
      const obj=parseStrictJsonObject(result.text)
      await markAiAction({actionId,status:'succeeded',completed:true,outcome:{
        interpretation:sanitizeExternalText(obj?.interpretation,500),confidence:Math.max(0,Math.min(1,Number(obj?.confidence??0))),nextCheck:sanitizeExternalText(obj?.next_check,350)
      }})
    } catch (err) {
      await markAiAction({actionId,status:'failed',completed:true,outcome:{reason:sanitizeExternalText(err instanceof Error?err.message:'FINANCE_AI_FAILED',120)}})
    }
  }


}
