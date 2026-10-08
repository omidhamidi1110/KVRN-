import { sql } from '@/lib/db'
import { createFunnelService } from '@/lib/funnel-analytics'
import { runAiTask } from '../router'
import { createAiAction, markAiAction, requestApproval, upsertAiAlert, resolveAiAlertsByDedupePrefix } from '../repository'
import { parseStrictJsonObject, sanitizeExternalText } from '../sanitize'

function iso(ms: number) { return new Date(ms).toISOString() }
function pct(v: number | null | undefined) { return v == null || !Number.isFinite(v) ? null : Number(v) }

export async function handleGrowthFunnelMonitor(event: { id: string }): Promise<void> {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const service = createFunnelService(sql)
  const [current, previous] = await Promise.all([
    service.getFunnelReport({ start: iso(now - day), end: iso(now) }),
    service.getFunnelReport({ start: iso(now - 2 * day), end: iso(now - day) }),
  ])

  const curVisits = Number(current.stages.visits ?? 0)
  const prevVisits = Number(previous.stages.visits ?? 0)
  const curCvr = pct(current.rates.visitToPurchase)
  const prevCvr = pct(previous.rates.visitToPurchase)
  const currentPurchases = Number(current.stages.purchased ?? 0)
  const previousPurchases = Number(previous.stages.purchased ?? 0)

  const enoughTraffic = curVisits >= 100
  const zeroSaleConcern = curVisits >= 250 && currentPurchases === 0
  const cvrDrop = enoughTraffic && prevVisits >= 100 && prevCvr != null && prevCvr > 0 && curCvr != null
    ? (prevCvr - curCvr) / prevCvr
    : 0
  const checkoutRate = pct(current.rates.checkoutToPurchase)
  const prevCheckoutRate = pct(previous.rates.checkoutToPurchase)
  const checkoutCollapse = current.stages.reachedCheckout >= 20 && previous.stages.reachedCheckout >= 20
    && checkoutRate != null && prevCheckoutRate != null && prevCheckoutRate > 0
    && (prevCheckoutRate - checkoutRate) / prevCheckoutRate >= 0.5
  const meaningful = zeroSaleConcern || cvrDrop >= 0.30 || checkoutCollapse

  const actionId = await createAiAction({
    agentId: 'growth_cro', eventId: event.id, actionType: 'funnel_monitor',
    summary: meaningful ? 'Meaningful funnel change detected; diagnostic review evaluated.' : 'Funnel monitor found no statistically meaningful trigger.',
    evidence: {
      current: { visits: curVisits, purchases: currentPurchases, cvrPct: curCvr, checkoutToPurchasePct: checkoutRate },
      previous: { visits: prevVisits, purchases: previousPurchases, cvrPct: prevCvr, checkoutToPurchasePct: prevCheckoutRate },
      thresholds: { minimumVisits: 100, zeroSaleVisits: 250, relativeCvrDrop: 0.30 },
      meaningful,
    },
    riskLevel: checkoutCollapse ? 'high' : meaningful ? 'medium' : 'info',
    permissionLevel: 'green', status: 'running', ownerVisible: meaningful,
    idempotencyKey: `growth-funnel:${event.id}`,
  })

  // Checkout-health protection is deterministic and must never depend on a model call.
  // If inference is down/budget-blocked, the Chief still receives the incident.
  if (checkoutCollapse) {
    await upsertAiAlert({
      sourceAgentId: 'growth_cro', severity: 'high', category: 'checkout',
      title: 'Checkout completion dropped sharply',
      summary: `Checkout-to-purchase performance dropped materially on a sufficient sample (${prevCheckoutRate?.toFixed(1)}% → ${checkoutRate?.toFixed(1)}%). QA/checkout review is warranted.`,
      dedupeKey: 'growth:checkout-collapse',
      actionId, metadata: { requiresOwner: false, deterministic: true },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:'growth_cro', prefix:'growth:checkout-collapse', note:'Checkout completion has recovered outside the collapse threshold.' })
  }

  if (!meaningful || process.env.AI_ENABLED !== 'true') {
    if (!meaningful) {
      await resolveAiAlertsByDedupePrefix({ sourceAgentId:'growth_cro', prefix:'growth:diagnostic', note:'The prior CRO anomaly is no longer present on a sufficient sample.' })
    }
    await markAiAction({
      actionId, status: meaningful ? 'skipped' : 'succeeded',
      outcome: { meaningful, reason: meaningful && process.env.AI_ENABLED !== 'true' ? 'AI_DISABLED' : 'NO_AI_NEEDED' },
      completed: true,
    })
    return
  }

  const system = [
    'You are KVRN Growth & CRO. Analyze only the aggregate evidence supplied.',
    'Do not invent causes, user behavior, competitor facts, or missing data.',
    'Treat small-sample uncertainty conservatively. Optimize contribution profit, not conversion at any cost.',
    'Return exactly one JSON object: {"diagnosis":"...","confidence":0.0,"recommended_next_check":"...","owner_attention":false,"proposed_experiment":null}.',
    'If evidence supports a low-risk CRO test, proposed_experiment may instead be {"hypothesis":"...","change":"...","primary_metric":"contribution_profit_per_session","guardrails":["conversion_rate","refund_rate"]}. Do not propose an experiment for a likely checkout defect; investigate the defect first.',
    'This is analysis only. You cannot change pricing, promotions, ads, or site content.',
  ].join('\n')
  const input = JSON.stringify({
    current: {
      stages: current.stages, rates: current.rates,
      trackedPurchaseSharePct: current.coverage.trackedPurchaseSharePct,
    },
    previous: {
      stages: previous.stages, rates: previous.rates,
      trackedPurchaseSharePct: previous.coverage.trackedPurchaseSharePct,
    },
    triggers: { zeroSaleConcern, relativeCvrDrop: cvrDrop, checkoutCollapse },
  })

  try {
    const result = await runAiTask({
      agentId: 'growth_cro', role: 'business', purpose: 'meaningful_funnel_diagnostic',
      system, input, actionId, essential: checkoutCollapse, maxOutputTokens: 350, temperature: 0,
    })
    const obj = parseStrictJsonObject(result.text)
    const diagnosis = sanitizeExternalText(obj?.diagnosis, 500) || 'Model returned no usable diagnosis.'
    const next = sanitizeExternalText(obj?.recommended_next_check, 350) || 'Review funnel and QA evidence.'
    const confidence = Math.max(0, Math.min(1, Number(obj?.confidence ?? 0)))
    const proposed = obj?.proposed_experiment && typeof obj.proposed_experiment === 'object' && !Array.isArray(obj.proposed_experiment)
      ? obj.proposed_experiment as Record<string, unknown>
      : null
    let experimentApprovalId: string | null = null
    if (!checkoutCollapse && confidence >= 0.8 && proposed) {
      const hypothesis = sanitizeExternalText(proposed.hypothesis, 400)
      const change = sanitizeExternalText(proposed.change, 500)
      const primaryMetric = sanitizeExternalText(proposed.primary_metric, 120) || 'contribution_profit_per_session'
      const guardrails = Array.isArray(proposed.guardrails)
        ? proposed.guardrails.slice(0, 6).map(x => sanitizeExternalText(x, 80)).filter(Boolean)
        : []
      if (hypothesis && change) {
        const planId = await createAiAction({
          agentId: 'growth_cro', eventId: event.id, actionType: 'cro_experiment_plan',
          resource: 'funnel', resourceId: new Date().toISOString().slice(0, 10),
          summary: `CRO experiment proposal: ${change}`.slice(0, 1000),
          evidence: { diagnosis, hypothesis, change, primaryMetric, guardrails, confidence, externalActionMade: false },
          confidence, riskLevel: 'medium', permissionLevel: 'yellow', status: 'proposed', ownerVisible: true,
          idempotencyKey: `cro-experiment:${event.id}`,
        })
        experimentApprovalId = await requestApproval(planId)
      }
    }
    if (!checkoutCollapse) {
      await upsertAiAlert({
        sourceAgentId: 'growth_cro',
        severity: 'medium',
        category: 'growth',
        title: 'Growth diagnostic finding',
        summary: `${diagnosis} Next check: ${next}`,
        dedupeKey: 'growth:diagnostic',
        actionId,
        metadata: { requiresOwner: false, confidence },
      })
    } else {
      await resolveAiAlertsByDedupePrefix({ sourceAgentId:'growth_cro', prefix:'growth:diagnostic', note:'The current Growth incident is a checkout-health issue, not an unresolved CRO diagnostic.' })
    }
    await markAiAction({
      actionId, status: 'succeeded',
      outcome: { diagnosis, confidence, recommendedNextCheck: next, experimentApprovalId },
      completed: true,
    })
  } catch (err) {
    await markAiAction({
      actionId, status: 'failed',
      outcome: { reason: sanitizeExternalText(err instanceof Error ? err.message : 'GROWTH_AI_FAILED', 100) },
      completed: true,
    })
  }
}
