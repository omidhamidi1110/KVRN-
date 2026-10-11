import { createHash } from 'crypto'
import { sql } from '@/lib/db'
import type { AiAgentId, AiAlertInput, AiAlertDisposition, AiPermissionLevel, AiRiskLevel } from './types'

export const AI_SYSTEM_ACTOR = 'ai-chief@kvrn.internal'

function boundedText(value: unknown, max: number, fallback: string): string {
  const text = String(value ?? '').trim()
  return (text || fallback).slice(0, max)
}

function boundedIndexedKey(value: unknown, max = 240): string {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('AI_INDEXED_KEY_REQUIRED')
  if (raw.length <= max) return raw
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 32)
  return `${raw.slice(0, Math.max(1, max - digest.length - 1))}:${digest}`
}

function boundedJsonObject(value: unknown, maxBytes: number, code: string): string {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  let json: string
  try { json = JSON.stringify(candidate) } catch { throw new Error(`${code}_NOT_SERIALIZABLE`) }
  if (new TextEncoder().encode(json).byteLength > maxBytes) throw new Error(`${code}_TOO_LARGE`)
  return json
}


const FORBIDDEN_AI_EVENT_KEY = /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|bearer|credential)$/i

function assertNoSensitiveAiEventKeys(value: unknown, depth = 0): void {
  if (depth > 8 || value == null) return
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveAiEventKeys(item, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_AI_EVENT_KEY.test(key)) throw new Error('AI_EVENT_SENSITIVE_KEY_FORBIDDEN')
    assertNoSensitiveAiEventKeys(child, depth + 1)
  }
}

function validOccurredAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const t = Date.parse(value)
  if (!Number.isFinite(t)) throw new Error('AI_EVENT_OCCURRED_AT_INVALID')
  return new Date(t).toISOString()
}

function nonNegativeInt(value: unknown, max = 2_147_483_647): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(max, Math.floor(n))
}

function nonNegativeSafeInt(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n))
}

export async function createAiAction(input: {
  agentId: AiAgentId
  actionType: string
  summary: string
  eventId?: string | null
  resource?: string | null
  resourceId?: string | null
  evidence?: Record<string, unknown>
  confidence?: number | null
  riskLevel?: AiRiskLevel
  permissionLevel?: AiPermissionLevel
  status?: 'proposed' | 'pending_approval' | 'approved' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'rejected' | 'skipped'
  idempotencyKey?: string | null
  ownerVisible?: boolean
}): Promise<string> {
  const evidence = boundedJsonObject(input.evidence ?? {}, 131_072, 'AI_ACTION_EVIDENCE')
  const summary = boundedText(input.summary, 2_000, 'AI action')
  const idempotencyKey = input.idempotencyKey ? boundedIndexedKey(input.idempotencyKey) : null
  const rows = await sql`
    INSERT INTO ai_actions(
      agent_id, event_id, action_type, resource, resource_id, summary, evidence,
      confidence, risk_level, permission_level, status, idempotency_key, owner_visible
    ) VALUES (
      ${input.agentId}, ${input.eventId ?? null}::uuid, ${input.actionType},
      ${input.resource ?? null}, ${input.resourceId ?? null}, ${summary}, ${evidence}::jsonb,
      ${input.confidence ?? null}, ${input.riskLevel ?? 'low'}, ${input.permissionLevel ?? 'green'},
      ${input.status ?? 'proposed'}, ${idempotencyKey}, ${input.ownerVisible ?? true}
    )
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
    DO UPDATE SET updated_at = ai_actions.updated_at
    RETURNING id
  ` as any[]
  if (!rows[0]?.id) throw new Error('AI_ACTION_CREATE_FAILED')
  return String(rows[0].id)
}

export async function updateAiActionModel(input: {
  actionId: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  estimatedCostMicros: number
}): Promise<void> {
  await sql`
    UPDATE ai_actions SET
      model_provider=${input.provider}, model_name=${input.model},
      input_tokens=${input.inputTokens}, output_tokens=${input.outputTokens},
      estimated_cost_micros=${input.estimatedCostMicros}
    WHERE id=${input.actionId}::uuid
  `
}

export async function markAiAction(input: {
  actionId: string
  status: 'proposed' | 'pending_approval' | 'approved' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'rejected' | 'skipped'
  outcome?: Record<string, unknown>
  completed?: boolean
}): Promise<void> {
  const outcome = boundedJsonObject(input.outcome ?? {}, 65_536, 'AI_ACTION_OUTCOME')
  await sql`
    UPDATE ai_actions SET
      status=${input.status}, outcome=${outcome}::jsonb,
      completed_at=CASE
        WHEN ${input.completed ?? false} THEN NOW()
        WHEN ${input.status}='running' THEN NULL
        ELSE completed_at
      END
    WHERE id=${input.actionId}::uuid
  `
}

export async function recordModelCall(input: {
  actionId?: string | null
  agentId: AiAgentId
  provider: string
  model: string
  purpose: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  costMicros: number
  latencyMs?: number | null
  status: 'succeeded' | 'failed' | 'blocked' | 'skipped'
  errorCode?: string | null
  requestFingerprint?: string | null
  reservationId?: string | null
}): Promise<void> {
  const inputTokens = nonNegativeInt(input.inputTokens)
  const outputTokens = nonNegativeInt(input.outputTokens)
  const cachedInputTokens = Math.min(inputTokens, nonNegativeInt(input.cachedInputTokens ?? 0))
  const costMicros = nonNegativeSafeInt(input.costMicros)
  const latencyMs = input.latencyMs == null ? null : nonNegativeInt(input.latencyMs)
  await sql`
    INSERT INTO ai_model_calls(
      action_id, agent_id, provider, model, purpose,
      input_tokens, output_tokens, cached_input_tokens, cost_micros,
      latency_ms, status, error_code, request_fingerprint, reservation_id
    ) VALUES (
      ${input.actionId ?? null}::uuid, ${input.agentId}, ${boundedText(input.provider, 80, 'unknown')},
      ${boundedText(input.model, 160, 'unknown')}, ${boundedText(input.purpose, 250, 'unspecified')},
      ${inputTokens}, ${outputTokens}, ${cachedInputTokens}, ${costMicros},
      ${latencyMs}, ${input.status}, ${input.errorCode ? boundedText(input.errorCode, 160, 'UNKNOWN') : null},
      ${input.requestFingerprint ? boundedText(input.requestFingerprint, 128, '') : null}, ${input.reservationId ?? null}::uuid
    )
  `
}


export async function reserveAiBudget(input: {
  agentId: AiAgentId
  estimatedMicros: number
  essential: boolean
}): Promise<{ ok: true; reservationId: string } | { ok: false; reason: string }> {
  const rows = await sql`
    SELECT ai_reserve_budget(${input.agentId}, ${Math.max(0, Math.ceil(input.estimatedMicros))}::bigint, ${input.essential}) AS result
  ` as any[]
  const result = rows[0]?.result ?? {}
  if (result.ok && result.reservation_id) return { ok: true, reservationId: String(result.reservation_id) }
  return { ok: false, reason: String(result.reason ?? 'AI_BUDGET_BLOCKED') }
}

export async function releaseAiBudget(reservationId: string): Promise<void> {
  await sql`SELECT ai_release_budget(${reservationId}::uuid)`
}

/**
 * Deduplicated alert intake. Existing unresolved alerts are incremented rather than duplicated.
 * The Chief Operator later assigns a disposition and is the only layer allowed to push.
 */
export async function upsertAiAlert(input: AiAlertInput): Promise<string> {
  const metadata = boundedJsonObject(input.metadata ?? {}, 32_768, 'AI_ALERT_METADATA')
  const title = boundedText(input.title, 250, 'AI alert')
  const summary = boundedText(input.summary, 2_000, 'AI alert generated.')
  const dedupeKey = boundedIndexedKey(input.dedupeKey)
  const rows = await sql`
    INSERT INTO ai_alerts(
      source_agent_id, action_id, severity, category, title, summary, dedupe_key, metadata
    ) VALUES (
      ${input.sourceAgentId}, ${input.actionId ?? null}::uuid, ${input.severity}, ${boundedText(input.category, 120, 'ai')},
      ${title}, ${summary}, ${dedupeKey}, ${metadata}::jsonb
    )
    ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL
    DO UPDATE SET
      occurrence_count = ai_alerts.occurrence_count + 1,
      last_seen_at = NOW(),
      severity = CASE
        WHEN ai_alerts.severity='critical' OR EXCLUDED.severity='critical' THEN 'critical'
        WHEN ai_alerts.severity='high' OR EXCLUDED.severity='high' THEN 'high'
        WHEN ai_alerts.severity='medium' OR EXCLUDED.severity='medium' THEN 'medium'
        WHEN ai_alerts.severity='low' OR EXCLUDED.severity='low' THEN 'low'
        ELSE 'info' END,
      summary = EXCLUDED.summary,
      metadata = ai_alerts.metadata || EXCLUDED.metadata,
      -- A material escalation is allowed to wake the owner once more even if the
      -- lower-severity version of the same unresolved incident was already pushed.
      disposition = CASE
        WHEN (CASE EXCLUDED.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)
           > (CASE ai_alerts.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)
        THEN 'pending' ELSE ai_alerts.disposition END,
      pushover_status = CASE
        WHEN (CASE EXCLUDED.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)
           > (CASE ai_alerts.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)
        THEN 'not_requested' ELSE ai_alerts.pushover_status END,
      next_notify_after = CASE
        WHEN (CASE EXCLUDED.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)
           > (CASE ai_alerts.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)
        THEN NULL ELSE ai_alerts.next_notify_after END,
      push_attempt_count = CASE
        WHEN (CASE EXCLUDED.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)
           > (CASE ai_alerts.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)
        THEN 0 ELSE ai_alerts.push_attempt_count END
    RETURNING id
  ` as any[]
  return String(rows[0]?.id)
}

export async function setAlertDisposition(input: {
  alertId: string
  disposition: AiAlertDisposition
  pushoverStatus?: 'not_requested' | 'queued' | 'sent' | 'failed' | 'suppressed'
  pushed?: boolean
  nextNotifyAfter?: string | null
  expectedSeverity?: AiRiskLevel
}): Promise<void> {
  await sql`
    UPDATE ai_alerts SET
      disposition=${input.disposition},
      pushover_status=${input.pushoverStatus ?? 'not_requested'},
      pushed_at=CASE WHEN ${input.pushed ?? false} THEN NOW() ELSE pushed_at END,
      next_notify_after=${input.nextNotifyAfter ?? null}::timestamptz
    WHERE id=${input.alertId}::uuid
      AND resolved_at IS NULL
      AND (${input.expectedSeverity ?? null}::text IS NULL OR severity=${input.expectedSeverity ?? null})
  `
}

export async function isAiAlertOpen(alertId: string): Promise<boolean> {
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1 FROM ai_alerts
      WHERE id=${alertId}::uuid AND resolved_at IS NULL
    ) AS open
  ` as any[]
  return Boolean(rows[0]?.open)
}

export async function listPendingChiefAlerts(limit = 25): Promise<any[]> {
  return sql`
    SELECT id, source_agent_id, action_id, severity, category, title, summary,
           dedupe_key, disposition, pushover_status, occurrence_count, push_attempt_count,
           first_seen_at, last_seen_at, next_notify_after, metadata
    FROM ai_alerts
    WHERE resolved_at IS NULL
      AND (disposition='pending' OR (disposition IN ('pushover','critical_pushover') AND pushover_status IN ('queued','failed')))
      AND (next_notify_after IS NULL OR next_notify_after <= NOW())
    ORDER BY
      CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END DESC,
      last_seen_at ASC
    LIMIT ${Math.max(1, Math.min(100, limit))}
  ` as Promise<any[]>
}


export async function resolveAiAlert(input: {
  alertId: string
  actorEmail: string
  note?: string | null
}): Promise<boolean> {
  const rows = await sql`
    WITH resolved AS (
      UPDATE ai_alerts SET
        resolved_at=NOW(),
        resolution_note=${input.note ?? null},
        next_notify_after=NULL
      WHERE id=${input.alertId}::uuid AND resolved_at IS NULL
      RETURNING id
    ), audited AS (
      INSERT INTO admin_audit_logs(actor_email, action, resource, resource_id, payload)
      SELECT ${input.actorEmail}, 'ai_alert_resolved', 'ai_alert', id::text,
             ${JSON.stringify({ note: input.note ?? null })}::jsonb
      FROM resolved
      RETURNING 1
    )
    SELECT id::text FROM resolved
  ` as any[]
  return Boolean(rows[0]?.id)
}

/** Resolve a deterministic incident family when its underlying condition is gone. */
export async function resolveAiAlertsByDedupePrefix(input: {
  sourceAgentId: AiAgentId
  prefix: string
  note: string
}): Promise<number> {
  const prefix = boundedIndexedKey(input.prefix, 180)
  const note = boundedText(input.note, 500, 'Condition cleared automatically.')
  const rows = await sql`
    WITH resolved AS (
      UPDATE ai_alerts SET
        resolved_at=NOW(), resolution_note=${note}, next_notify_after=NULL
      WHERE source_agent_id=${input.sourceAgentId}
        AND resolved_at IS NULL
        AND LEFT(dedupe_key, char_length(${prefix}))=${prefix}
      RETURNING id
    ), audited AS (
      INSERT INTO admin_audit_logs(actor_email, action, resource, resource_id, payload)
      SELECT ${AI_SYSTEM_ACTOR}, 'ai_alert_auto_resolved', 'ai_alert', id::text,
             jsonb_build_object('note',${note}::text)
      FROM resolved
      RETURNING 1
    )
    SELECT id::text FROM resolved
  ` as any[]
  return rows.length
}



export async function requestApproval(actionId: string, ttlHours = 72): Promise<string> {
  const boundedTtlHours = Number.isFinite(ttlHours) ? Math.max(1, Math.min(168, Math.floor(ttlHours))) : 72
  const rows = await sql`
    WITH updated AS (
      UPDATE ai_actions SET status='pending_approval'
      WHERE id=${actionId}::uuid AND status IN ('proposed','pending_approval')
        AND permission_level <> 'red'
      RETURNING id
    )
    INSERT INTO ai_approvals(action_id, expires_at)
    SELECT id, NOW() + make_interval(hours => ${boundedTtlHours}) FROM updated
    ON CONFLICT (action_id) DO UPDATE SET
      state='pending',
      requested_at=NOW(),
      expires_at=EXCLUDED.expires_at,
      decided_at=NULL,
      decided_by=NULL,
      decision_note=NULL
    RETURNING id
  ` as any[]
  if (!rows[0]?.id) throw new Error('AI_APPROVAL_CREATE_FAILED')
  return String(rows[0].id)
}


export async function expireStaleAiApprovals(): Promise<number> {
  const rows = await sql`
    WITH expired AS (
      UPDATE ai_approvals SET
        state='expired', decided_at=NOW(), decision_note=COALESCE(decision_note,'Expired automatically because the recommendation became stale.')
      WHERE state='pending' AND expires_at IS NOT NULL AND expires_at <= NOW()
      RETURNING action_id
    )
    UPDATE ai_actions a SET
      status='blocked', completed_at=NOW(),
      outcome=COALESCE(a.outcome,'{}'::jsonb) || jsonb_build_object('code','APPROVAL_EXPIRED')
    FROM expired e
    WHERE a.id=e.action_id AND a.status='pending_approval'
    RETURNING a.id
  ` as any[]
  return rows.length
}

export async function decideApproval(input: {
  approvalId: string
  decision: 'approved' | 'rejected'
  actorEmail: string
  note?: string | null
}): Promise<{ actionId: string } | null> {
  // Move approval, action and audit state atomically so a Worker crash cannot leave
  // an approved approval pointing at a still-pending action (or vice versa).
  const rows = await sql`
    WITH decided AS (
      UPDATE ai_approvals SET
        state=${input.decision}, decided_at=NOW(), decided_by=${input.actorEmail}, decision_note=${input.note ?? null}
      WHERE id=${input.approvalId}::uuid AND state='pending'
        AND (expires_at IS NULL OR expires_at > NOW())
        AND EXISTS (
          SELECT 1 FROM ai_actions a
          WHERE a.id=ai_approvals.action_id AND a.status='pending_approval' AND a.permission_level <> 'red'
        )
      RETURNING action_id
    ), updated AS (
      UPDATE ai_actions a SET
        status=${input.decision === 'approved' ? 'approved' : 'rejected'},
        completed_at=CASE WHEN ${input.decision === 'rejected'} THEN NOW() ELSE a.completed_at END
      FROM decided d
      WHERE a.id=d.action_id AND a.status='pending_approval'
      RETURNING a.id
    ), audited AS (
      INSERT INTO admin_audit_logs(actor_email, action, resource, resource_id, payload)
      SELECT ${input.actorEmail}, ${`ai_action_${input.decision}`}, 'ai_action', id::text,
             ${JSON.stringify({ approvalId: input.approvalId })}::jsonb
      FROM updated
      RETURNING 1
    )
    SELECT id::text FROM updated
  ` as any[]
  if (!rows[0]?.id) return null
  return { actionId: String(rows[0].id) }
}



export async function claimApprovedAiActions(limit = 10): Promise<any[]> {
  return sql`
    WITH picked AS (
      SELECT id FROM ai_actions
      WHERE status='approved' AND permission_level <> 'red'
      ORDER BY updated_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${Math.max(1, Math.min(50, limit))}
    )
    UPDATE ai_actions a SET status='running'
    FROM picked p WHERE a.id=p.id
    RETURNING a.id, a.agent_id, a.action_type, a.resource, a.resource_id, a.summary,
              a.evidence, a.confidence, a.risk_level, a.permission_level, a.idempotency_key
  ` as Promise<any[]>
}


export type AiRuntimeSettings = {
  businessTimezone: string
  dailyBriefHourLocal: number
  quietHoursEnabled: boolean
  quietHoursStartLocal: number
  quietHoursEndLocal: number
  noncriticalPushLimitDay: number
}

export async function getAiRuntimeSettings(): Promise<AiRuntimeSettings> {
  const rows = await sql`
    SELECT
      CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name=ai_runtime_settings.business_timezone)
           THEN business_timezone ELSE 'America/Los_Angeles' END AS business_timezone,
      daily_brief_hour_local, quiet_hours_enabled,
      quiet_hours_start_local, quiet_hours_end_local, noncritical_push_limit_day
    FROM ai_runtime_settings WHERE id=1 LIMIT 1
  ` as any[]
  const r = rows[0] ?? {}
  return {
    businessTimezone: String(r.business_timezone ?? 'America/Los_Angeles'),
    dailyBriefHourLocal: Number(r.daily_brief_hour_local ?? 19),
    quietHoursEnabled: r.quiet_hours_enabled !== false,
    quietHoursStartLocal: Number(r.quiet_hours_start_local ?? 22),
    quietHoursEndLocal: Number(r.quiet_hours_end_local ?? 8),
    noncriticalPushLimitDay: Number(r.noncritical_push_limit_day ?? 3),
  }
}

export async function isValidAiBusinessTimezone(timezone: string): Promise<boolean> {
  const value = String(timezone ?? '').trim()
  if (!value || value.length > 100) return false
  const rows = await sql`
    SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=${value}) AS ok
  ` as any[]
  return Boolean(rows[0]?.ok)
}

export async function updateAiRuntimeSettings(input: {
  businessTimezone: string
  dailyBriefHourLocal: number
  quietHoursEnabled: boolean
  quietHoursStartLocal: number
  quietHoursEndLocal: number
  noncriticalPushLimitDay: number
  actorEmail: string
}): Promise<AiRuntimeSettings> {
  const payload = JSON.stringify({
    businessTimezone: input.businessTimezone,
    dailyBriefHourLocal: input.dailyBriefHourLocal,
    quietHoursEnabled: input.quietHoursEnabled,
    quietHoursStartLocal: input.quietHoursStartLocal,
    quietHoursEndLocal: input.quietHoursEndLocal,
    noncriticalPushLimitDay: input.noncriticalPushLimitDay,
  })
  await sql`
    WITH changed AS (
      INSERT INTO ai_runtime_settings(
        id, business_timezone, daily_brief_hour_local, quiet_hours_enabled,
        quiet_hours_start_local, quiet_hours_end_local, noncritical_push_limit_day, updated_by
      ) VALUES (
        1, ${input.businessTimezone}, ${input.dailyBriefHourLocal}, ${input.quietHoursEnabled},
        ${input.quietHoursStartLocal}, ${input.quietHoursEndLocal}, ${input.noncriticalPushLimitDay}, ${input.actorEmail}
      )
      ON CONFLICT (id) DO UPDATE SET
        business_timezone=EXCLUDED.business_timezone,
        daily_brief_hour_local=EXCLUDED.daily_brief_hour_local,
        quiet_hours_enabled=EXCLUDED.quiet_hours_enabled,
        quiet_hours_start_local=EXCLUDED.quiet_hours_start_local,
        quiet_hours_end_local=EXCLUDED.quiet_hours_end_local,
        noncritical_push_limit_day=EXCLUDED.noncritical_push_limit_day,
        updated_by=EXCLUDED.updated_by
      RETURNING id
    )
    INSERT INTO admin_audit_logs(actor_email, action, resource, resource_id, payload)
    SELECT ${input.actorEmail}, 'update', 'ai_runtime_settings', id::text, ${payload}::jsonb
    FROM changed
  `
  return getAiRuntimeSettings()
}


export async function touchAiAgentHeartbeat(agentId: AiAgentId): Promise<void> {
  await sql`UPDATE ai_agents SET last_heartbeat_at=NOW() WHERE id=${agentId}`
}

export async function getAiAdminOverview(): Promise<any> {
  const settings = await getAiRuntimeSettings().catch(() => null)
  const timezone = settings?.businessTimezone ?? process.env.AI_BUSINESS_TIMEZONE ?? 'America/Los_Angeles'
  const [agentRows, actionRows, approvalRows, alertRows, modelRows, qaRows] = await Promise.all([
    sql`
      SELECT ag.id, ag.name, ag.department, ag.enabled, ag.autonomy_level, ag.model_role,
             ag.last_heartbeat_at, ag.updated_at,
             CASE
               WHEN NOT ag.enabled THEN 'disabled'
               WHEN EXISTS (
                 SELECT 1 FROM ai_events e
                 WHERE e.source_agent_id=ag.id AND e.status='processing' AND e.available_at > NOW()
               ) THEN 'active'
               WHEN EXISTS (
                 SELECT 1 FROM ai_actions a WHERE a.agent_id=ag.id AND a.status='pending_approval'
               ) THEN 'waiting'
               WHEN EXISTS (
                 SELECT 1 FROM ai_events e
                 WHERE e.source_agent_id=ag.id AND e.status='discarded' AND e.processed_at >= NOW()-INTERVAL '24 hours'
               ) THEN 'error'
               ELSE 'idle'
             END AS status
      FROM ai_agents ag ORDER BY ag.name
    `,
    sql`
      WITH bounds AS (
        SELECT (date_trunc('day', NOW() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS day_start
      )
      SELECT
        COUNT(*) FILTER (WHERE created_at >= b.day_start)::int AS today_actions,
        COUNT(*) FILTER (WHERE status='pending_approval')::int AS pending_actions,
        COUNT(*) FILTER (WHERE status='failed' AND created_at >= NOW()-INTERVAL '24 hours')::int AS failed_24h
      FROM ai_actions CROSS JOIN bounds b
    `,
    sql`SELECT COUNT(*)::int AS n FROM ai_approvals WHERE state='pending'`,
    sql`
      SELECT COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
             COUNT(*) FILTER (WHERE resolved_at IS NULL AND severity='critical')::int AS critical
      FROM ai_alerts
    `,
    sql`
      WITH bounds AS (
        SELECT
          (date_trunc('day', NOW() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS day_start,
          (date_trunc('month', NOW() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS month_start,
          ((date_trunc('month', NOW() AT TIME ZONE ${timezone}) + INTERVAL '1 month') AT TIME ZONE ${timezone}) AS month_end
      )
      SELECT COALESCE(SUM(cost_micros),0)::bigint AS month_cost,
             COALESCE(SUM(cost_micros) FILTER (WHERE created_at >= b.day_start),0)::bigint AS today_cost,
             COUNT(*) FILTER (WHERE created_at >= b.day_start)::int AS today_calls
      FROM ai_model_calls CROSS JOIN bounds b
      WHERE created_at >= b.month_start AND created_at < b.month_end
    `,
    sql`
      SELECT COUNT(*) FILTER (WHERE enabled)::int AS features,
             COUNT(*) FILTER (WHERE enabled AND last_passed_at IS NULL)::int AS never_passed,
             COUNT(*) FILTER (WHERE enabled AND last_failed_at IS NOT NULL AND (last_passed_at IS NULL OR last_failed_at > last_passed_at))::int AS currently_failing
      FROM qa_features
    `,
  ]) as any[][]

  return {
    agents: agentRows,
    actions: actionRows[0] ?? {},
    approvals: Number(approvalRows[0]?.n ?? 0),
    alerts: alertRows[0] ?? {},
    usage: modelRows[0] ?? {},
    qa: qaRows[0] ?? {},
  }
}

export async function listAiActions(limit = 100): Promise<any[]> {
  return sql`
    SELECT a.id, a.agent_id, ag.name AS agent_name, a.action_type, a.resource, a.resource_id,
           a.summary, a.confidence, a.risk_level, a.permission_level, a.status,
           a.model_provider, a.model_name, a.input_tokens, a.output_tokens,
           a.estimated_cost_micros, a.owner_visible, a.created_at, a.completed_at
    FROM ai_actions a
    JOIN ai_agents ag ON ag.id=a.agent_id
    WHERE a.owner_visible
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  ` as Promise<any[]>
}

export async function listAiApprovals(limit = 100): Promise<any[]> {
  return sql`
    SELECT ap.id, ap.action_id, ap.state, ap.requested_at, ap.expires_at,
           a.agent_id, ag.name AS agent_name, a.action_type, a.summary, a.evidence,
           a.confidence, a.risk_level, a.permission_level
    FROM ai_approvals ap
    JOIN ai_actions a ON a.id=ap.action_id
    JOIN ai_agents ag ON ag.id=a.agent_id
    WHERE ap.state='pending'
    ORDER BY ap.requested_at ASC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  ` as Promise<any[]>
}

export async function listAiAlerts(limit = 100): Promise<any[]> {
  return sql`
    SELECT al.id, al.source_agent_id, ag.name AS agent_name, al.severity, al.category,
           al.title, al.summary, al.disposition, al.pushover_status, al.occurrence_count,
           al.first_seen_at, al.last_seen_at, al.pushed_at, al.resolved_at
    FROM ai_alerts al JOIN ai_agents ag ON ag.id=al.source_agent_id
    ORDER BY al.last_seen_at DESC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  ` as Promise<any[]>
}


type AiEventInput = {
  eventType: string
  source: string
  subject: string
  sourceAgentId?: AiAgentId | null
  severity?: AiRiskLevel
  payload?: Record<string, unknown>
  idempotencyKey?: string | null
  occurredAt?: string | null
}

function normalizeAiEventInput(input: AiEventInput) {
  assertNoSensitiveAiEventKeys(input.payload ?? {})
  return {
    payload: boundedJsonObject(input.payload ?? {}, 131_072, 'AI_EVENT_PAYLOAD'),
    eventType: boundedText(input.eventType, 120, 'event'),
    source: boundedText(input.source, 120, 'internal'),
    subject: boundedText(input.subject, 500, 'AI event'),
    idempotencyKey: input.idempotencyKey ? boundedIndexedKey(input.idempotencyKey) : null,
    occurredAt: validOccurredAt(input.occurredAt),
  }
}

export async function enqueueAiEvent(input: AiEventInput): Promise<string | null> {
  const { payload, eventType, source, subject, idempotencyKey, occurredAt } = normalizeAiEventInput(input)
  const rows = await sql`
    INSERT INTO ai_events(event_type, source, source_agent_id, severity, subject, payload, idempotency_key, occurred_at)
    VALUES (${eventType}, ${source}, ${input.sourceAgentId ?? null}, ${input.severity ?? 'info'},
            ${subject}, ${payload}::jsonb, ${idempotencyKey},
            COALESCE(${occurredAt}::timestamptz, NOW()))
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id
  ` as any[]
  return rows[0]?.id ? String(rows[0].id) : null
}

export async function enqueueAiEventWithAudit(input: AiEventInput & {
  audit: { actorEmail: string; action: string; resource: string; resourceId: string; payload?: Record<string, unknown> }
}): Promise<string | null> {
  const { payload, eventType, source, subject, idempotencyKey, occurredAt } = normalizeAiEventInput(input)
  const auditPayload = boundedJsonObject(input.audit.payload ?? {}, 16_384, 'AI_EVENT_AUDIT_PAYLOAD')
  const rows = await sql`
    WITH created AS (
      INSERT INTO ai_events(event_type, source, source_agent_id, severity, subject, payload, idempotency_key, occurred_at)
      VALUES (${eventType}, ${source}, ${input.sourceAgentId ?? null}, ${input.severity ?? 'info'},
              ${subject}, ${payload}::jsonb, ${idempotencyKey},
              COALESCE(${occurredAt}::timestamptz, NOW()))
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id
    ), audited AS (
      INSERT INTO admin_audit_logs(actor_email, action, resource, resource_id, payload)
      SELECT ${boundedText(input.audit.actorEmail, 320, AI_SYSTEM_ACTOR)},
             ${boundedText(input.audit.action, 160, 'ai_event_queued')},
             ${boundedText(input.audit.resource, 160, 'ai_event')},
             ${boundedText(input.audit.resourceId, 300, 'unknown')},
             ${auditPayload}::jsonb
      FROM created
      RETURNING 1
    )
    SELECT id FROM created
  ` as any[]
  return rows[0]?.id ? String(rows[0].id) : null
}

export async function recoverExhaustedAiEvents(): Promise<number> {
  // A Worker can die after claiming the final allowed attempt. Without this recovery
  // that row would remain `processing` forever because it can no longer be reclaimed.
  // Make the terminal transition and owner-visible Engineering/QA alert atomic.
  const rows = await sql`
    WITH exhausted AS (
      UPDATE ai_events SET
        status='discarded',
        processed_at=NOW(),
        last_error_code=COALESCE(last_error_code,'AI_EVENT_ATTEMPTS_EXHAUSTED'),
        payload=payload - 'videoUri' - 'signedUrl'
      WHERE status IN ('pending','failed','processing')
        AND attempts >= 8
        AND available_at <= NOW()
      RETURNING id,event_type,source,source_agent_id,attempts,last_error_code
    ), alerted AS (
      INSERT INTO ai_alerts(
        source_agent_id,severity,category,title,summary,dedupe_key,metadata,
        disposition,pushover_status,next_notify_after
      )
      SELECT
        'engineering_qa','high','event_queue','AI event exhausted retry limit',
        LEFT('Event ' || event_type || ' could not complete after ' || attempts::text ||
             ' attempts and was stopped instead of retrying forever.',2000),
        'ai-event-exhausted:' || id::text,
        jsonb_build_object(
          'eventId',id::text,'eventType',event_type,'source',source,
          'sourceAgentId',source_agent_id,'attempts',attempts,'lastErrorCode',last_error_code,
          'requiresOwner',true
        ),
        'pending','not_requested',NULL
      FROM exhausted
      ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL
      DO UPDATE SET
        occurrence_count=ai_alerts.occurrence_count+1,
        last_seen_at=NOW(),
        severity='high',
        summary=EXCLUDED.summary,
        metadata=ai_alerts.metadata || EXCLUDED.metadata,
        disposition='pending',pushover_status='not_requested',next_notify_after=NULL
      RETURNING id
    )
    SELECT id::text FROM exhausted
  ` as any[]
  return rows.length
}

export type AiEventLane = 'fast' | 'slow' | 'all'

export async function claimAiEvents(limit = 10, lane: AiEventLane = 'all'): Promise<any[]> {
  // Slow events may perform external network I/O and/or paid inference. Keeping them
  // in a separate lane prevents one 5-minute Chief cycle from claiming ten 30-second
  // jobs and overlapping the next scheduled invocation. High-severity support events
  // still sort ahead of routine slow sync/research work inside their lane.
  const safeLane: AiEventLane = lane === 'fast' || lane === 'slow' ? lane : 'all'
  // available_at doubles as a processing lease deadline while status='processing'.
  // If a Worker dies mid-event, another cycle may safely reclaim it after 10 minutes.
  // Event handlers are required to be idempotent; processAiEvents also skips a retry
  // when a completed action proves the prior worker finished business logic.
  return sql`
    WITH picked AS (
      SELECT id FROM ai_events
      WHERE (
          (status IN ('pending','failed') AND available_at <= NOW())
          OR (status='processing' AND available_at <= NOW())
        )
        AND attempts < 8
        AND (
          ${safeLane} = 'all'
          OR (${safeLane} = 'slow' AND event_type IN (
            'support.inbound',
            'finance.performance_monitor',
            'growth.funnel_monitor',
            'ads_social.video_analyze',
            'market_intel.research',
            'integration.sync'
          ))
          OR (${safeLane} = 'fast' AND event_type NOT IN (
            'support.inbound',
            'finance.performance_monitor',
            'growth.funnel_monitor',
            'ads_social.video_analyze',
            'market_intel.research',
            'integration.sync'
          ))
        )
      ORDER BY
        CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END DESC,
        available_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${Math.max(1, Math.min(50, limit))}
    )
    UPDATE ai_events e SET
      status='processing',
      attempts=e.attempts+1,
      last_error_code=NULL,
      available_at=NOW() + INTERVAL '10 minutes'
    FROM picked p WHERE e.id=p.id
    RETURNING e.id, e.event_type, e.source, e.source_agent_id, e.severity, e.subject,
              e.payload, e.idempotency_key, e.attempts, e.occurred_at
  ` as Promise<any[]>
}

export async function getIncompleteAiEventAction(eventId: string): Promise<{ id:string; actionType:string; status:string } | null> {
  const rows = await sql`
    SELECT id::text, action_type, status
    FROM ai_actions
    WHERE event_id=${eventId}::uuid
      AND completed_at IS NULL
      AND status IN ('proposed','pending_approval','approved','running')
    ORDER BY created_at ASC
    LIMIT 1
  ` as any[]
  if (!rows[0]?.id) return null
  return { id:String(rows[0].id), actionType:String(rows[0].action_type), status:String(rows[0].status) }
}

export async function isAiEventAlreadyCompleted(eventId: string): Promise<boolean> {
  const rows = await sql`
    SELECT EXISTS(
      SELECT 1 FROM ai_actions
      WHERE event_id=${eventId}::uuid
        AND completed_at IS NOT NULL
        AND (
          status IN ('succeeded','skipped','blocked','rejected')
          OR (status='failed' AND outcome->>'retryable' IS DISTINCT FROM 'true')
        )
    ) AS done
  ` as any[]
  return Boolean(rows[0]?.done)
}

export async function finishAiEvent(input: {
  eventId: string
  ok: boolean
  errorCode?: string | null
  retry?: boolean
}): Promise<void> {
  if (input.ok) {
    await sql`
      UPDATE ai_events SET
        status='processed', processed_at=NOW(), last_error_code=NULL,
        -- Media/provider URIs are transient execution inputs, not durable audit data.
        payload=payload - 'videoUri' - 'signedUrl'
      WHERE id=${input.eventId}::uuid AND status='processing'
    `
    return
  }
  const retry = input.retry !== false
  const errorCode = boundedText(input.errorCode ?? 'AI_EVENT_FAILED', 120, 'AI_EVENT_FAILED')
  await sql`
    WITH changed AS (
      UPDATE ai_events SET
        status=CASE WHEN ${retry} AND attempts < 8 THEN 'failed' ELSE 'discarded' END,
        last_error_code=${errorCode},
        available_at=CASE WHEN ${retry} AND attempts < 8
          THEN NOW() + make_interval(secs => LEAST(3600, (30 * power(2, LEAST(attempts, 6)))::int))
          ELSE available_at END,
        processed_at=CASE WHEN ${retry} AND attempts < 8 THEN NULL ELSE NOW() END,
        payload=CASE WHEN ${retry} AND attempts < 8 THEN payload ELSE payload - 'videoUri' - 'signedUrl' END
      WHERE id=${input.eventId}::uuid AND status='processing'
      RETURNING id,event_type,source_agent_id,severity,subject,last_error_code,status
    ), alerted AS (
      INSERT INTO ai_alerts(source_agent_id,severity,category,title,summary,dedupe_key,metadata)
      SELECT
        COALESCE(source_agent_id,'engineering_qa'),
        CASE WHEN severity IN ('high','critical') THEN 'high' ELSE 'medium' END,
        'ai_event_dead_letter','AI event could not complete',
        LEFT(subject || ' was discarded after a processing failure. Error: ' || COALESCE(last_error_code,'UNKNOWN'),2000),
        'ai-event-discarded:' || md5(event_type || ':' || COALESCE(last_error_code,'UNKNOWN')),
        jsonb_build_object('eventId',id::text,'eventType',event_type,'errorCode',last_error_code,'requiresOwner',severity IN ('high','critical'))
      FROM changed WHERE status='discarded'
      ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL
      DO UPDATE SET occurrence_count=ai_alerts.occurrence_count+1,last_seen_at=NOW(),summary=EXCLUDED.summary,metadata=ai_alerts.metadata||EXCLUDED.metadata
      RETURNING 1
    )
    SELECT id FROM changed
  `
}

const AGENT_MODEL_ROLE_ALLOWLIST: Record<AiAgentId, Array<'cheap' | 'video' | 'business' | 'finance'>> = {
  chief: ['cheap','business'],
  growth_cro: ['business'],
  ads_social: ['cheap','video','business'],
  creator_affiliate: ['cheap','business'],
  market_intel: ['cheap','video','business'],
  lifecycle: ['cheap','business'],
  support: ['cheap','business'],
  product_inventory: ['business'],
  finance_risk: ['finance','business'],
  seo_commerce_data: ['cheap','business'],
  engineering_qa: ['cheap','business'],
}

export async function getAiAgentRuntimePolicy(agentId: AiAgentId): Promise<{
  enabled: boolean
  status: string
  autonomyLevel: string
  configuredModelRole: string
  allowedModelRoles: Array<'cheap' | 'video' | 'business' | 'finance'>
} | null> {
  const rows = await sql`
    SELECT enabled,status,autonomy_level,model_role FROM ai_agents WHERE id=${agentId} LIMIT 1
  ` as any[]
  if (!rows[0]) return null
  return {
    enabled: Boolean(rows[0].enabled),
    status: String(rows[0].status),
    autonomyLevel: String(rows[0].autonomy_level),
    configuredModelRole: String(rows[0].model_role),
    allowedModelRoles: AGENT_MODEL_ROLE_ALLOWLIST[agentId] ?? [],
  }
}


export async function refreshAiAgentMetrics(
  timezone = process.env.AI_BUSINESS_TIMEZONE || 'America/Los_Angeles',
): Promise<void> {
  await sql`
    WITH bounds AS (
      SELECT
        (date_trunc('day', NOW() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS start_at,
        ((date_trunc('day', NOW() AT TIME ZONE ${timezone}) + INTERVAL '1 day') AT TIME ZONE ${timezone}) AS end_at,
        (NOW() AT TIME ZONE ${timezone})::date AS business_date
    ), action_stats AS (
      SELECT a.agent_id,
        COUNT(*)::int AS proposed_count,
        COUNT(*) FILTER (WHERE a.status IN ('running','succeeded','failed'))::int AS executed_count,
        COUNT(*) FILTER (WHERE a.status='succeeded')::int AS succeeded_count,
        COUNT(*) FILTER (WHERE a.status='failed')::int AS failed_count
      FROM ai_actions a, bounds b
      WHERE a.created_at >= b.start_at AND a.created_at < b.end_at
      GROUP BY a.agent_id
    ), override_stats AS (
      SELECT a.agent_id,
        COUNT(*) FILTER (WHERE ap.state='rejected')::int AS owner_override_count
      FROM ai_approvals ap
      JOIN ai_actions a ON a.id=ap.action_id
      CROSS JOIN bounds b
      WHERE ap.decided_at >= b.start_at AND ap.decided_at < b.end_at
      GROUP BY a.agent_id
    ), escalation_stats AS (
      SELECT source_agent_id AS agent_id,
        COUNT(*) FILTER (WHERE severity IN ('high','critical'))::int AS escalation_count
      FROM ai_alerts al, bounds b
      WHERE al.first_seen_at >= b.start_at AND al.first_seen_at < b.end_at
      GROUP BY source_agent_id
    ), cost_stats AS (
      SELECT agent_id, COALESCE(SUM(cost_micros),0)::bigint AS ai_cost_micros
      FROM ai_model_calls mc, bounds b
      WHERE mc.created_at >= b.start_at AND mc.created_at < b.end_at
        AND mc.status IN ('succeeded','failed')
      GROUP BY agent_id
    )
    INSERT INTO ai_agent_metrics(
      agent_id,business_date,proposed_count,executed_count,succeeded_count,failed_count,
      owner_override_count,escalation_count,ai_cost_micros,notes
    )
    SELECT ag.id,b.business_date,
      COALESCE(a.proposed_count,0),COALESCE(a.executed_count,0),COALESCE(a.succeeded_count,0),COALESCE(a.failed_count,0),
      COALESCE(o.owner_override_count,0),COALESCE(e.escalation_count,0),COALESCE(c.ai_cost_micros,0),
      jsonb_build_object('timezone',${timezone},'source','deterministic_daily_rollup')
    FROM ai_agents ag
    CROSS JOIN bounds b
    LEFT JOIN action_stats a ON a.agent_id=ag.id
    LEFT JOIN override_stats o ON o.agent_id=ag.id
    LEFT JOIN escalation_stats e ON e.agent_id=ag.id
    LEFT JOIN cost_stats c ON c.agent_id=ag.id
    ON CONFLICT (agent_id,business_date) DO UPDATE SET
      proposed_count=EXCLUDED.proposed_count,
      executed_count=EXCLUDED.executed_count,
      succeeded_count=EXCLUDED.succeeded_count,
      failed_count=EXCLUDED.failed_count,
      owner_override_count=EXCLUDED.owner_override_count,
      escalation_count=EXCLUDED.escalation_count,
      ai_cost_micros=EXCLUDED.ai_cost_micros,
      notes=EXCLUDED.notes
  `
}

export async function listAiAgentPerformance(days = 30): Promise<any[]> {
  const boundedDays = Math.max(1, Math.min(365, Math.floor(days)))
  const settings = await getAiRuntimeSettings().catch(() => null)
  const timezone = settings?.businessTimezone ?? process.env.AI_BUSINESS_TIMEZONE ?? 'America/Los_Angeles'
  return sql`
    WITH local_day AS (
      SELECT (NOW() AT TIME ZONE ${timezone})::date AS business_date
    )
    SELECT ag.id, ag.name, ag.department, ag.autonomy_level, ag.enabled,
      COALESCE(SUM(m.proposed_count),0)::int AS proposed_count,
      COALESCE(SUM(m.executed_count),0)::int AS executed_count,
      COALESCE(SUM(m.succeeded_count),0)::int AS succeeded_count,
      COALESCE(SUM(m.failed_count),0)::int AS failed_count,
      COALESCE(SUM(m.owner_override_count),0)::int AS owner_override_count,
      COALESCE(SUM(m.escalation_count),0)::int AS escalation_count,
      COALESCE(SUM(m.ai_cost_micros),0)::bigint AS ai_cost_micros,
      CASE WHEN COALESCE(SUM(m.executed_count),0) > 0
        THEN ROUND(100.0 * SUM(m.succeeded_count)::numeric / NULLIF(SUM(m.executed_count),0),1)
        ELSE NULL END AS success_rate_pct
    FROM ai_agents ag
    CROSS JOIN local_day d
    LEFT JOIN ai_agent_metrics m ON m.agent_id=ag.id AND m.business_date >= d.business_date - ${boundedDays - 1}::int
    GROUP BY ag.id,ag.name,ag.department,ag.autonomy_level,ag.enabled
    ORDER BY ag.name
  ` as Promise<any[]>
}
