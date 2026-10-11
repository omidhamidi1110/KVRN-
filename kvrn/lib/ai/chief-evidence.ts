/**
 * Owner-only, read-only and *bounded* evidence for Chief Chat.
 * The server chooses all sources. Neither an owner prompt nor an LLM can choose
 * a table, SQL statement, provider tool, external URL or write operation.
 * This is operational metadata only: no event payloads, agent config JSON,
 * customer records, order rows, tokens, email addresses or provider secrets.
 */
import { sql } from '@/lib/db'
import { getAiCapabilities } from './capabilities'
import { getModelConfig } from './config'
import { collectDailyBriefSnapshot } from './chief'
import { getPrivateInsight, type PrivateInsight } from './private-insights'
import { type ChiefChatTopic, classifyChiefChatRequest, selectChiefChatTopics } from './chief-chat-policy'

export type ChiefEvidence = {
  topic: string
  worker: string
  asOf: string
  source: string
  summary: string
  lines: Array<{ label: string; value: string; state?: string }>
  warnings: string[]
}

const val = (v: unknown): string => v == null ? 'Unknown' : String(v).slice(0, 190)
const iso = (v: unknown): string => {
  if (!v) return 'Not recorded'
  const d = new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : 'Unknown'
}
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

export async function readQaEvidence(): Promise<ChiefEvidence> {
  const [counts, latest, critical] = await Promise.all([
    sql`
      SELECT COUNT(*) FILTER (WHERE enabled)::int AS registered,
        COUNT(*) FILTER (WHERE enabled AND last_passed_at IS NOT NULL)::int AS ever_verified,
        COUNT(*) FILTER (WHERE enabled AND last_passed_at IS NULL)::int AS never_verified,
        COUNT(*) FILTER (WHERE enabled AND last_failed_at IS NOT NULL AND
          (last_passed_at IS NULL OR last_failed_at > last_passed_at))::int AS failing
      FROM qa_features
    ` as Promise<any[]>,
    sql`
      SELECT status, passed_count, failed_count, skipped_count, started_at, environment
      FROM qa_test_runs ORDER BY started_at DESC LIMIT 1
    ` as Promise<any[]>,
    sql`
      SELECT name, criticality, last_passed_at, last_failed_at
      FROM qa_features WHERE enabled AND criticality IN ('critical','high')
      ORDER BY CASE criticality WHEN 'critical' THEN 2 ELSE 1 END DESC, name LIMIT 8
    ` as Promise<any[]>,
  ])
  const c = counts[0] || {}
  const last = latest[0]
  return {
    topic: 'qa', worker: 'Engineering, QA & Security', asOf: new Date().toISOString(),
    source: 'qa_features + qa_test_runs (read-only live DB)',
    summary: 'The registry is a test-results ledger, not a browser runner. A feature without a passing report is unverified, not failed.',
    lines: [
      { label: 'Enabled feature contracts', value: val(c.registered) },
      { label: 'Ever verified', value: val(c.ever_verified) },
      { label: 'Never verified', value: val(c.never_verified), state: num(c.never_verified) ? 'warning' : 'verified' },
      { label: 'Currently failing', value: val(c.failing), state: num(c.failing) ? 'warning' : 'verified' },
      { label: 'Latest reported run', value: last ? `${val(last.status)} / ${val(last.environment)} at ${iso(last.started_at)}; ${val(last.passed_count)} pass, ${val(last.failed_count)} fail, ${val(last.skipped_count)} skip` : 'None reported' },
      ...critical.map((r: any) => ({ label: `QA priority: ${val(r.name)}`, value: `${val(r.criticality)}; last pass ${iso(r.last_passed_at)}; last failure ${iso(r.last_failed_at)}` })),
    ],
    warnings: ['A passing report must originate from a real test runner; Chief cannot declare contracts passed or launch browser tests from a chat reply.'],
  }
}

/** Snapshot agent status + recent failures WITHOUT raw event payloads or PII. */
export async function readWorkforceEvidence(): Promise<ChiefEvidence> {
  const [agents, summary, failures] = await Promise.all([
    sql`
      SELECT a.id, a.name, a.enabled, a.autonomy_level, a.model_role, a.last_heartbeat_at,
        (SELECT MAX(e.processed_at) FROM ai_events e WHERE e.source_agent_id=a.id AND e.status='processed') AS last_processed_at,
        (SELECT COUNT(*)::int FROM ai_events e WHERE e.source_agent_id=a.id AND e.status='discarded' AND e.processed_at >= NOW()-INTERVAL '24 hours') AS discarded_24h,
        (SELECT COUNT(*)::int FROM ai_actions ac WHERE ac.agent_id=a.id AND ac.status='failed' AND ac.created_at >= NOW()-INTERVAL '24 hours') AS failed_actions_24h
      FROM ai_agents a ORDER BY a.name LIMIT 20
    ` as Promise<any[]>,
    sql`
      SELECT (SELECT COUNT(*)::int FROM ai_events WHERE status IN ('pending','failed','processing')) AS queued_or_retrying,
        (SELECT COUNT(*)::int FROM ai_approvals WHERE state='pending') AS pending_approvals,
        (SELECT COUNT(*)::int FROM ai_alerts WHERE resolved_at IS NULL) AS open_alerts,
        (SELECT COUNT(*)::int FROM ai_alerts WHERE resolved_at IS NULL AND severity='critical') AS critical_alerts
    ` as Promise<any[]>,
    sql`
      SELECT source_agent_id, event_type, last_error_code, processed_at
      FROM ai_events WHERE status='discarded' AND processed_at >= NOW()-INTERVAL '24 hours'
      ORDER BY processed_at DESC LIMIT 6
    ` as Promise<any[]>,
  ])
  const s = summary[0] || {}
  return {
    topic: 'ai-workforce', worker: 'Chief Operator + Engineering, QA & Security',
    asOf: new Date().toISOString(), source: 'ai_agents + ai_events + ai_actions + ai_approvals + ai_alerts (live DB)',
    summary: `${agents.length} registered agents are visible. Enabled state, scheduled heartbeats and completed events do not by themselves prove that every agent can perform every intended action.`,
    lines: [
      { label: 'Work queue (pending/retry/processing)', value: val(s.queued_or_retrying) },
      { label: 'Pending owner approvals', value: val(s.pending_approvals) },
      { label: 'Open alerts / critical', value: `${val(s.open_alerts)} / ${val(s.critical_alerts)}` },
      ...agents.map((a: any) => ({
        label: `Agent ${val(a.name)}`,
        value: `${a.enabled ? 'enabled' : 'disabled'}; autonomy ${val(a.autonomy_level)}; role ${val(a.model_role)}; heartbeat ${iso(a.last_heartbeat_at)}; last completed event ${iso(a.last_processed_at)}; discarded 24h ${num(a.discarded_24h)}; failed actions 24h ${num(a.failed_actions_24h)}`,
        state: num(a.discarded_24h) || num(a.failed_actions_24h) ? 'warning' : a.enabled ? 'verified' : 'unknown',
      })),
      ...failures.map((f: any) => ({
        label: `Discarded ${val(f.source_agent_id)}`,
        value: `${val(f.event_type)}: ${val(f.last_error_code)} at ${iso(f.processed_at)}`,
        state: 'warning',
      })),
    ],
    warnings: ['Discarded events within 24 hours may be historical; use timestamps and last_error_code to distinguish historical from ongoing failures.', 'Task implementation, dispatch permissions and external credentials are NOT proven by an enabled flag.'],
  }
}

export async function readRoutingEvidence(): Promise<ChiefEvidence> {
  const capabilities = getAiCapabilities()
  const models = (['cheap','business','finance','video'] as const).map(role => {
    const cfg = getModelConfig(role)
    let routed = false
    try {
      const u = new URL(cfg.baseUrl)
      routed = u.protocol === 'https:' && u.hostname === 'gateway.ai.cloudflare.com'
    } catch { /* missing URL */ }
    return { label: `${role} model`, value: `${cfg.provider} / ${cfg.model}; Cloudflare Gateway ${routed ? 'configured' : 'not verified'}` }
  })
  return {
    topic: 'ai-routing', worker: 'Chief Operator', asOf: new Date().toISOString(),
    source: 'getModelConfig + getAiCapabilities (server configuration, secrets excluded)',
    summary: 'These are configuration checks. They do not prove live API connectivity, model health, video support or successful message delivery.',
    lines: [
      ...models,
      { label: 'Paid AI enabled', value: process.env.AI_ENABLED === 'true' ? 'Yes' : 'No' },
      { label: 'External sync gate', value: process.env.AI_EXTERNAL_SYNC_ENABLED === 'true' ? 'Enabled' : 'Disabled' },
      { label: 'Web research gate', value: process.env.AI_WEB_RESEARCH_ENABLED === 'true' ? 'Enabled' : 'Disabled' },
      { label: 'Phone delivery gate', value: process.env.AI_CHIEF_NOTIFICATION_GATE === 'true' ? 'Enabled' : 'Disabled' },
      ...capabilities.map(c => ({ label: c.label, value: `${c.status} (${c.department})` })),
    ],
    warnings: ['Model routing and external connections are configurations, not proof of end-to-end inference or data freshness.', 'Live credentials, Gateway provider keys and original connection records are deliberately never transmitted to the model.'],
  }
}

/** Uses Chief's existing canonical daily-brief aggregation, not parallel new finance math. */
export async function readBusinessHealthEvidence(): Promise<ChiefEvidence> {
  const snapshot = await collectDailyBriefSnapshot()
  const missing = new Set(snapshot.dataWarnings)
  const known = (source: string, v: unknown) => missing.has(source) ? 'Unavailable (source failed)' : val(v)
  const cash = (source: string, v: unknown) => missing.has(source) || v == null ? 'Unknown' : `$${(Number(v) / 100).toFixed(2)}`
  const percent = (source: string, v: unknown) => missing.has(source) || v == null ? 'Unknown' : `${val(v)}%`
  return {
    topic: 'business-health', worker: 'Chief Operator', asOf: new Date().toISOString(),
    source: 'collectDailyBriefSnapshot: canonical financial + funnel + support + inventory summaries (today in configured business timezone)',
    summary: `Operational aggregates for ${snapshot.businessDate}, ${snapshot.timezone}. Zero is only reported for sources successfully read. No customer, order or support content is exposed.`,
    lines: [
      {label:'Paid order count today',value:known('finance',snapshot.orderCount)},
      {label:'Net revenue today',value:cash('finance',snapshot.revenueCents)},
      {label:'Order contribution',value:missing.has('finance') || snapshot.profitCompleteness !== 'complete' ? 'Unknown / not fully reconciled' : cash('finance',snapshot.contributionProfitCents)},
      {label:'Recorded advertising spend',value:cash('finance',snapshot.advertisingSpendCents)},
      {label:'Visits today',value:known('funnel',snapshot.visits)},
      {label:'Purchases in funnel',value:known('funnel',snapshot.purchases)},
      {label:'Visit-to-purchase conversion',value:percent('funnel',snapshot.conversionPct)},
      {label:'Open support threads',value:known('support',snapshot.unresolvedSupport)},
      {label:'Low stock variants',value:known('inventory',snapshot.lowStockVariants)},
      {label:'Sold out variants',value:known('inventory',snapshot.soldOutVariants)},
      {label:'Pending owner approvals',value:known('approvals',snapshot.pendingApprovals)},
    ],
    warnings: [
      ...snapshot.dataWarnings.map(src => `${src} data source was unavailable; any placeholder zeros from that source are not evidence.`),
      'Today’s conversion and revenue aggregates are not proof that payment, fulfillment, support reply or external advertising integrations work end-to-end.',
    ],
  }
}

export function insightToEvidence(insight: PrivateInsight, worker: string): ChiefEvidence {
  return { topic: insight.topic, worker, asOf: insight.asOf,
    source: `getPrivateInsight(${insight.topic}) (first-party canonical read-only aggregate)`,
    summary: insight.summary, lines: insight.lines.map(l => ({ ...l })), warnings: insight.warnings }
}

export async function collectChiefEvidence(message: string, previousOwnerMessage?: string): Promise<{
  routeLabel: string; evidence: ChiefEvidence[]; unavailable: string[]; multiSource: boolean
}> {
  const topics = selectChiefChatTopics(message, previousOwnerMessage)
  const labels: Record<ChiefChatTopic, string> = {
    'qa':'Engineering, QA & Security', 'ai-budget':'Chief Operator', 'business-health':'Chief Operator',
    'inventory-integrity':'Product, Inventory & Supply', 'payment-exceptions':'Finance, Attribution & Risk',
    'affiliate-integrity':'Creator & Affiliate', 'marketing-consent':'Customer Support / Lifecycle Revenue',
    'marketing-delivery':'Ads & Social', 'store-credit':'Finance, Attribution & Risk',
    'operations-brief':'Chief Operator', 'ai-workforce':'Chief Operator', 'ai-routing':'Chief Operator',
  }
  const reads = topics.map(async (topic): Promise<ChiefEvidence> => {
    if (topic === 'qa') return readQaEvidence()
    if (topic === 'ai-workforce') return readWorkforceEvidence()
    if (topic === 'ai-routing') return readRoutingEvidence()
    if (topic === 'business-health') return readBusinessHealthEvidence()
    return insightToEvidence(await getPrivateInsight(topic), labels[topic])
  })
  const results = await Promise.allSettled(reads)
  const evidence: ChiefEvidence[] = []
  const unavailable: string[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') evidence.push(result.value)
    else unavailable.push(topics[i])
  })
  if (!evidence.length) throw new Error('CHIEF_EVIDENCE_UNAVAILABLE')
  return { routeLabel: topics.length > 1 ? 'Chief Operator · Multi-department report' : (evidence[0]?.worker || classifyChiefChatRequest(message).worker),
    evidence, unavailable, multiSource: topics.length > 1 }
}
