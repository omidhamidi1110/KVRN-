import { sql } from '@/lib/db'
import { createAiAction, requestApproval, upsertAiAlert } from './repository'
import type { AiAgentId, AiAutonomyLevel, AiPermissionLevel, AiRiskLevel } from './types'

export type ExecutionDecision =
  | { outcome: 'auto_allowed'; reason: string }
  | { outcome: 'shadow_only'; reason: string }
  | { outcome: 'approval_required'; reason: string }
  | { outcome: 'human_only'; reason: string }
  | { outcome: 'blocked'; reason: string }

const RISK_RANK: Record<AiRiskLevel, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }

/**
 * Central authority boundary. Agents may recommend anything, but they cannot turn a
 * recommendation into an external write without this policy layer.
 */
export function decideExecutionPolicy(input: {
  enabled: boolean
  autonomy: AiAutonomyLevel
  permission: AiPermissionLevel
  risk: AiRiskLevel
}): ExecutionDecision {
  if (!input.enabled) return { outcome: 'blocked', reason: 'AGENT_DISABLED' }
  if (input.permission === 'red') return { outcome: 'human_only', reason: 'RED_ACTION_HUMAN_ONLY' }
  if (input.autonomy === 'shadow') return { outcome: 'shadow_only', reason: 'SHADOW_MODE_RECOMMEND_ONLY' }
  if (input.permission === 'yellow') return { outcome: 'approval_required', reason: 'YELLOW_ACTION_REQUIRES_APPROVAL' }
  if (RISK_RANK[input.risk] >= RISK_RANK.high) return { outcome: 'approval_required', reason: 'HIGH_RISK_REQUIRES_APPROVAL' }
  if (input.autonomy === 'approval') return { outcome: 'approval_required', reason: 'AGENT_APPROVAL_MODE' }
  // limited/trusted may autonomously execute only GREEN low/medium-risk actions.
  return { outcome: 'auto_allowed', reason: 'GREEN_ACTION_WITHIN_AUTONOMY' }
}

export async function getAgentExecutionPolicy(agentId: AiAgentId): Promise<{ enabled: boolean; autonomy: AiAutonomyLevel }> {
  const rows = await sql`SELECT enabled, status, autonomy_level FROM ai_agents WHERE id=${agentId} LIMIT 1` as any[]
  const row = rows[0]
  if (!row) return { enabled: false, autonomy: 'shadow' }
  const autonomy = ['shadow','approval','limited','trusted'].includes(String(row.autonomy_level))
    ? String(row.autonomy_level) as AiAutonomyLevel : 'shadow'
  return { enabled: Boolean(row.enabled) && String(row.status) !== 'disabled', autonomy }
}

/**
 * Create a proposal and apply central policy. The caller still needs an explicitly
 * registered executor for auto_allowed; no arbitrary tool/function execution exists.
 */
export async function proposeGovernedAction(input: {
  agentId: AiAgentId
  actionType: string
  summary: string
  permission: AiPermissionLevel
  risk: AiRiskLevel
  evidence?: Record<string, unknown>
  resource?: string | null
  resourceId?: string | null
  idempotencyKey?: string | null
}): Promise<{ actionId: string; decision: ExecutionDecision; approvalId?: string }> {
  const state = await getAgentExecutionPolicy(input.agentId)
  const decision = decideExecutionPolicy({
    enabled: state.enabled, autonomy: state.autonomy, permission: input.permission, risk: input.risk,
  })
  const actionId = await createAiAction({
    agentId: input.agentId, actionType: input.actionType, summary: input.summary,
    permissionLevel: input.permission, riskLevel: input.risk,
    evidence: { ...(input.evidence ?? {}), policyDecision: decision.outcome, policyReason: decision.reason },
    resource: input.resource, resourceId: input.resourceId, idempotencyKey: input.idempotencyKey,
    status: decision.outcome === 'auto_allowed' ? 'approved'
      : decision.outcome === 'blocked' || decision.outcome === 'human_only' ? 'blocked'
      : 'proposed',
  })
  if (decision.outcome === 'human_only') {
    await upsertAiAlert({
      sourceAgentId: input.agentId,
      actionId,
      severity: input.risk === 'critical' ? 'critical' : 'high',
      category: 'human_only_recommendation',
      title: 'Human-only action recommended',
      summary: `${input.summary} This action is Red and cannot be executed through KVRN AI approvals.`,
      dedupeKey: `human-only:${actionId}`,
      metadata: { requiresOwner:true, actionType:input.actionType, policyReason:decision.reason },
    })
    return { actionId, decision }
  }
  if (decision.outcome === 'approval_required') {
    const approvalId = await requestApproval(actionId)
    return { actionId, decision, approvalId }
  }
  return { actionId, decision }
}
