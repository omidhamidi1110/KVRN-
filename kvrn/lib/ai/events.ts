import { sql } from '@/lib/db'
import { getAllVariantsForAdmin } from '@/lib/inventory'
import { createFinancialIntegrityService } from '@/lib/financial-integrity'
import { createAiAction, enqueueAiEvent, finishAiEvent, claimAiEvents, getIncompleteAiEventAction, isAiEventAlreadyCompleted, markAiAction, upsertAiAlert, recoverExhaustedAiEvents, touchAiAgentHeartbeat, resolveAiAlertsByDedupePrefix, getAiAgentRuntimePolicy } from './repository'
import { handleSupportInboundEvent } from './agents/support'
import { handleGrowthFunnelMonitor } from './agents/growth'
import { handleLifecycleRecoveryMonitor } from './agents/lifecycle'
import { handleReviewGrowthMonitor } from './agents/review-growth'
import { handlePaymentExceptionMonitor, handleFinancePerformanceMonitor } from './agents/finance'
import { handleProductInventoryForecast } from './agents/product-inventory'
import { handleCreatorAffiliateMonitor } from './agents/creator-affiliate'
import { handleAdsSocialMonitor } from './agents/ads-social'
import { handleVideoPerformanceAnalysis } from './agents/video-performance'
import { handleMarketIntelFreshness } from './agents/market-intel'
import { handleMarketResearch } from './agents/market-research'
import { handleSeoCommerceDataMonitor } from './agents/seo-commerce-data'
import { handleEngineeringQaMonitor } from './agents/engineering-qa'
import { handleExternalIntegrationSync } from './integrations/sync'
import type { AiAgentId } from './types'

function bucket(minutes: number): string {
  const ms = Math.max(1, minutes) * 60_000
  return new Date(Math.floor(Date.now() / ms) * ms).toISOString()
}

const MODEL_CAPABLE_EVENT_TYPES = new Set([
  'support.inbound',
  'finance.performance_monitor',
  'growth.funnel_monitor',
  'ads_social.video_analyze',
  'market_intel.research',
])


/** Enqueue cheap deterministic monitors. Unique keys make every cron invocation idempotent. */
export async function enqueueScheduledAiEvents(): Promise<void> {
  await Promise.all([
    enqueueAiEvent({
      eventType: 'inventory.monitor', source: 'scheduler', sourceAgentId: 'product_inventory',
      severity: 'info', subject: 'Inventory health check', payload: {},
      idempotencyKey: `inventory.monitor:${bucket(60)}`,
    }),
    enqueueAiEvent({
      eventType: 'finance.integrity_monitor', source: 'scheduler', sourceAgentId: 'finance_risk',
      severity: 'info', subject: 'Financial integrity health check', payload: {},
      idempotencyKey: `finance.integrity:${bucket(30)}`,
    }),
    enqueueAiEvent({
      eventType: 'finance.payment_exception_monitor', source: 'scheduler', sourceAgentId: 'finance_risk',
      severity: 'info', subject: 'Payment exception health check', payload: {},
      idempotencyKey: `finance.payment-exceptions:${bucket(15)}`,
    }),
    enqueueAiEvent({
      eventType: 'finance.performance_monitor', source: 'scheduler', sourceAgentId: 'finance_risk',
      severity: 'info', subject: 'Profitability and advertising health check', payload: {},
      idempotencyKey: `finance.performance:${bucket(360)}`,
    }),
    enqueueAiEvent({
      eventType: 'growth.funnel_monitor', source: 'scheduler', sourceAgentId: 'growth_cro',
      severity: 'info', subject: 'Funnel health check', payload: {},
      idempotencyKey: `growth.funnel:${bucket(360)}`,
    }),
    enqueueAiEvent({
      eventType: 'lifecycle.recovery_monitor', source: 'scheduler', sourceAgentId: 'lifecycle',
      severity: 'info', subject: 'Checkout recovery candidate check', payload: {},
      idempotencyKey: `lifecycle.recovery:${bucket(360)}`,
    }),
    enqueueAiEvent({
      eventType: 'lifecycle.review_growth_monitor', source: 'scheduler', sourceAgentId: 'lifecycle',
      severity: 'info', subject: 'Neutral post-purchase review eligibility check', payload: {},
      idempotencyKey: `lifecycle.review-growth:${bucket(1440)}`,
    }),
    enqueueAiEvent({
      eventType: 'product_inventory.forecast', source: 'scheduler', sourceAgentId: 'product_inventory',
      severity: 'info', subject: 'Inventory demand forecast', payload: {},
      idempotencyKey: `product_inventory.forecast:${bucket(360)}`,
    }),
    enqueueAiEvent({
      eventType: 'creator_affiliate.monitor', source: 'scheduler', sourceAgentId: 'creator_affiliate',
      severity: 'info', subject: 'Creator and affiliate health check', payload: {},
      idempotencyKey: `creator_affiliate.monitor:${bucket(720)}`,
    }),
    enqueueAiEvent({
      eventType: 'ads_social.monitor', source: 'scheduler', sourceAgentId: 'ads_social',
      severity: 'info', subject: 'Ads and social health check', payload: {},
      idempotencyKey: `ads_social.monitor:${bucket(180)}`,
    }),
    enqueueAiEvent({
      eventType: 'market_intel.freshness', source: 'scheduler', sourceAgentId: 'market_intel',
      severity: 'info', subject: 'Market intelligence freshness check', payload: {},
      idempotencyKey: `market_intel.freshness:${bucket(1440)}`,
    }),
    ...(process.env.AI_WEB_RESEARCH_ENABLED === 'true' ? [enqueueAiEvent({
      eventType: 'market_intel.research', source: 'scheduler', sourceAgentId: 'market_intel',
      severity: 'info', subject: 'Approved public market target refresh', payload: {},
      idempotencyKey: `market_intel.research:${bucket(1440)}`,
    })] : []),
    enqueueAiEvent({
      eventType: 'seo_commerce_data.monitor', source: 'scheduler', sourceAgentId: 'seo_commerce_data',
      severity: 'info', subject: 'SEO and commerce data health check', payload: {},
      idempotencyKey: `seo_commerce_data.monitor:${bucket(360)}`,
    }),
    enqueueAiEvent({
      eventType: 'engineering_qa.monitor', source: 'scheduler', sourceAgentId: 'engineering_qa',
      severity: 'info', subject: 'Regression and feature-verification health check', payload: {},
      idempotencyKey: `engineering_qa.monitor:${bucket(60)}`,
    }),
    ...(process.env.AI_EXTERNAL_SYNC_ENABLED === 'true' ? [
      enqueueAiEvent({ eventType:'integration.sync', source:'scheduler', sourceAgentId:'ads_social', severity:'info', subject:'Meta evidence sync', payload:{integrationId:'meta'}, idempotencyKey:`integration.meta:${bucket(180)}` }),
      enqueueAiEvent({ eventType:'integration.sync', source:'scheduler', sourceAgentId:'ads_social', severity:'info', subject:'TikTok evidence sync', payload:{integrationId:'tiktok'}, idempotencyKey:`integration.tiktok:${bucket(180)}` }),
      enqueueAiEvent({ eventType:'integration.sync', source:'scheduler', sourceAgentId:'seo_commerce_data', severity:'info', subject:'Search Console evidence sync', payload:{integrationId:'google_search_console'}, idempotencyKey:`integration.gsc:${bucket(1440)}` }),
      enqueueAiEvent({ eventType:'integration.sync', source:'scheduler', sourceAgentId:'seo_commerce_data', severity:'info', subject:'Merchant evidence sync', payload:{integrationId:'google_merchant'}, idempotencyKey:`integration.merchant:${bucket(360)}` }),
    ] : []),
  ]).then(() => undefined)
}

async function handleInventoryMonitor(event: any): Promise<void> {
  const variants = await getAllVariantsForAdmin() as any[]
  const active = variants.filter(v => v.active)
  const soldOut = active.filter(v => Number(v.available_quantity ?? 0) <= 0)
  const low = active.filter(v => {
    const n = Number(v.available_quantity ?? 0)
    return n > 0 && n <= 2
  })
  const actionId = await createAiAction({
    agentId: 'product_inventory', eventId: String(event.id), actionType: 'inventory_monitor',
    summary: `Inventory monitor checked ${active.length} active variants.`,
    evidence: { activeVariants: active.length, soldOut: soldOut.length, lowStock: low.length },
    riskLevel: soldOut.length > 0 ? 'medium' : low.length > 0 ? 'low' : 'info',
    permissionLevel: 'green', status: 'succeeded', ownerVisible: soldOut.length > 0 || low.length > 0,
    idempotencyKey: `inventory-action:${event.id}`,
  })
  if (soldOut.length > 0) {
    const ids = soldOut.map(v => String(v.id ?? v.variant_id ?? '')).sort().filter(Boolean)
    await upsertAiAlert({
      sourceAgentId: 'product_inventory', severity: 'medium', category: 'inventory',
      title: 'Active variants are sold out',
      summary: `${soldOut.length} active variant${soldOut.length === 1 ? ' is' : 's are'} sold out. Review replenishment if these products should remain available.`,
      dedupeKey: 'inventory:soldout',
      actionId, metadata: { soldOutCount: soldOut.length, affectedVariantIds: ids.slice(0,100), requiresOwner: false },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({
      sourceAgentId:'product_inventory', prefix:'inventory:soldout', note:'Previously sold-out active variants are no longer sold out.',
    })
  }
  await markAiAction({ actionId, status: 'succeeded', outcome: { soldOut: soldOut.length, lowStock: low.length }, completed: true })
}

async function handleFinancialIntegrityMonitor(event: any): Promise<void> {
  const summary = await createFinancialIntegrityService(sql).getSummary()
  const exceptions = Number(summary.entities.exception ?? 0)
  const incomplete = Number(summary.entities.incomplete ?? 0)

  const actionId = await createAiAction({
    agentId: 'finance_risk', eventId: String(event.id), actionType: 'financial_integrity_monitor',
    summary: 'Checked canonical financial-integrity state.',
    evidence: { exceptions, incomplete },
    riskLevel: exceptions > 0 ? 'high' : incomplete > 0 ? 'medium' : 'info',
    permissionLevel: 'green', status: 'succeeded', ownerVisible: exceptions > 0 || incomplete > 0,
    idempotencyKey: `finance-integrity-action:${event.id}`,
  })
  if (exceptions > 0) {
    await upsertAiAlert({
      sourceAgentId: 'finance_risk', severity: 'high', category: 'financial_integrity',
      title: 'Financial reconciliation exception',
      summary: `${exceptions} canonical financial-integrity exception${exceptions === 1 ? '' : 's'} require review.`,
      dedupeKey: 'finance:integrity:exceptions', actionId,
      metadata: { exceptions, incomplete, requiresOwner: true },
    })
  } else {
    await resolveAiAlertsByDedupePrefix({
      sourceAgentId:'finance_risk', prefix:'finance:integrity:exceptions', note:'Canonical financial-integrity exceptions have cleared.',
    })
  }
  await markAiAction({ actionId, status: 'succeeded', outcome: { exceptions, incomplete }, completed: true })
}

async function dispatchAiEvent(event: any): Promise<void> {
  switch (String(event.event_type)) {
    case 'support.inbound':
      await handleSupportInboundEvent({ id: String(event.id), payload: event.payload ?? {} })
      return
    case 'inventory.monitor':
      await handleInventoryMonitor(event)
      return
    case 'finance.integrity_monitor':
      await handleFinancialIntegrityMonitor(event)
      return
    case 'finance.payment_exception_monitor':
      await handlePaymentExceptionMonitor({ id: String(event.id) })
      return
    case 'finance.performance_monitor':
      await handleFinancePerformanceMonitor({ id: String(event.id) })
      return
    case 'growth.funnel_monitor':
      await handleGrowthFunnelMonitor({ id: String(event.id) })
      return
    case 'lifecycle.recovery_monitor':
      await handleLifecycleRecoveryMonitor({ id: String(event.id) })
      return
    case 'lifecycle.review_growth_monitor':
      await handleReviewGrowthMonitor({ id: String(event.id) })
      return
    case 'product_inventory.forecast':
      await handleProductInventoryForecast({ id: String(event.id) })
      return
    case 'creator_affiliate.monitor':
      await handleCreatorAffiliateMonitor({ id: String(event.id) })
      return
    case 'ads_social.monitor':
      await handleAdsSocialMonitor({ id: String(event.id) })
      return
    case 'ads_social.video_analyze':
      await handleVideoPerformanceAnalysis({ id: String(event.id), payload: event.payload ?? {} })
      return
    case 'market_intel.freshness':
      await handleMarketIntelFreshness({ id: String(event.id) })
      return
    case 'market_intel.research':
      await handleMarketResearch({ id: String(event.id) })
      return
    case 'seo_commerce_data.monitor':
      await handleSeoCommerceDataMonitor({ id: String(event.id) })
      return
    case 'engineering_qa.monitor':
      await handleEngineeringQaMonitor({ id: String(event.id) })
      return
    case 'integration.sync':
      await handleExternalIntegrationSync({ id:String(event.id), payload:event.payload ?? {} })
      return
    default:
      // Unknown events are discarded rather than retried forever. Their source remains visible in ai_events.
      throw Object.assign(new Error('AI_EVENT_UNSUPPORTED'), { nonRetryable: true })
  }
}

export async function processAiEvents(limit = 10): Promise<{ processed: number; failed: number }> {
  await recoverExhaustedAiEvents()
  let processed = 0
  let failed = 0

  const handleBatch = async (events: any[]) => {
    for (const event of events) {
      try {
        if (event.source_agent_id) {
          const agentId = String(event.source_agent_id) as AiAgentId
          const policy = await getAiAgentRuntimePolicy(agentId)
          // Admin disable is a true server-side kill switch for the department, not
          // merely a model-call toggle. Close already-queued work without invoking
          // deterministic handlers, external syncs, or paid inference.
          if (!policy?.enabled || policy.status === 'disabled') {
            await finishAiEvent({ eventId:String(event.id), ok:true })
            processed += 1
            continue
          }
          await touchAiAgentHeartbeat(agentId)
        }
        // If a previous attempt of a model-capable event died after creating its
        // action, the provider outcome is ambiguous. Never automatically replay that
        // paid request: fail the stale action and require a fresh event/manual retry.
        if (Number(event.attempts ?? 0) > 1 && MODEL_CAPABLE_EVENT_TYPES.has(String(event.event_type))) {
          const incomplete = await getIncompleteAiEventAction(String(event.id))
          if (incomplete) {
            await upsertAiAlert({
              sourceAgentId: String(event.source_agent_id ?? 'engineering_qa') as AiAgentId,
              actionId: incomplete.id,
              severity: event.severity === 'critical' || event.severity === 'high' ? 'high' : 'medium',
              category: 'ai_paid_replay_blocked',
              title: 'Ambiguous paid AI retry blocked',
              summary: 'A prior Worker attempt ended before a paid AI task could be confirmed. KVRN blocked automatic replay to avoid duplicate provider spend.',
              dedupeKey: `paid-replay-blocked:${event.id}`,
              metadata: { requiresOwner: event.severity === 'critical' || event.severity === 'high', eventType:String(event.event_type), actionType:incomplete.actionType },
            })
            await markAiAction({ actionId:incomplete.id, status:'failed', completed:true, outcome:{ code:'AMBIGUOUS_PAID_REPLAY_BLOCKED', automaticReplay:false } })
            await finishAiEvent({ eventId:String(event.id), ok:true })
            processed += 1
            continue
          }
        }

        // Crash-recovery guard: if the previous Worker completed the event's business
        // action but died before marking the queue row processed, do not repeat paid
        // inference or side effects. Close the queue item instead.
        if (await isAiEventAlreadyCompleted(String(event.id))) {
          await finishAiEvent({ eventId: String(event.id), ok: true })
          processed += 1
          continue
        }
        await dispatchAiEvent(event)
        await finishAiEvent({ eventId: String(event.id), ok: true })
        processed += 1
      } catch (err: any) {
        failed += 1
        const message = err instanceof Error ? err.message : 'AI_EVENT_FAILED'
        await finishAiEvent({
          eventId: String(event.id), ok: false,
          errorCode: message.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 100).toUpperCase(),
          retry: err?.nonRetryable !== true,
        }).catch(() => {})
      }
    }
  }

  // Drain cheap local monitors first. Slow/network/model-capable work is intentionally
  // restricted to one claimed event per cycle. This bounds cron wall time and also
  // makes runaway paid inference much harder even before the dollar budget gate.
  const fastLimit = Math.max(1, Math.min(12, Number.isFinite(limit) ? Math.floor(limit) : 10))
  await handleBatch(await claimAiEvents(fastLimit, 'fast'))
  await handleBatch(await claimAiEvents(1, 'slow'))

  return { processed, failed }
}
