import { sql } from '@/lib/db'
import { AI_SYSTEM_ACTOR } from './repository'
import type { AiAgentId } from './types'

type Autonomy = 'shadow' | 'approval' | 'limited' | 'trusted'

type HealthRow = {
  id: AiAgentId
  name: string
  autonomy_level: Autonomy
  executed_count: number | string
  failed_count: number | string
  approval_decisions: number | string
  approval_rejections: number | string
}

export function evaluateAutonomyDowngrade(row: HealthRow): { level: Autonomy; reason: string } | null {
  const current = row.autonomy_level
  if (current === 'shadow' || current === 'approval') return null

  const executed = Number(row.executed_count ?? 0)
  const failed = Number(row.failed_count ?? 0)
  const decisions = Number(row.approval_decisions ?? 0)
  const rejected = Number(row.approval_rejections ?? 0)
  const failureRate = executed > 0 ? failed / executed : 0
  const rejectionRate = decisions > 0 ? rejected / decisions : 0

  // Repeated owner disagreement is a stronger signal than ordinary runtime failure.
  // Five decisions is enough to detect a material mismatch without reacting to one-off taste.
  if (decisions >= 5 && rejectionRate >= 0.25) {
    return { level: 'approval', reason: `OWNER_REJECTION_RATE_${Math.round(rejectionRate * 100)}PCT` }
  }

  // Sustained operational failure makes autonomous execution unsafe. Provider/config outages
  // may contribute to failures, which is fine: the safe response is less autonomy, not more.
  if (executed >= 20 && failureRate >= 0.20) {
    return { level: 'approval', reason: `ACTION_FAILURE_RATE_${Math.round(failureRate * 100)}PCT` }
  }

  // A trusted agent with an emerging failure pattern gets one-step demotion before the
  // stronger rule above becomes necessary.
  if (current === 'trusted' && executed >= 10 && failureRate >= 0.10) {
    return { level: 'limited', reason: `ACTION_FAILURE_RATE_${Math.round(failureRate * 100)}PCT` }
  }

  return null
}

/**
 * Deterministic safety governor. It may only REDUCE autonomy; it never promotes an agent.
 * The owner can review/deliberately restore a level later after the root cause is fixed.
 */
export async function enforceAgentAutonomySafety(days = 14): Promise<{ downgraded: number }> {
  const boundedDays = Math.max(7, Math.min(30, Math.floor(days)))
  const rows = await sql`
    WITH action_stats AS (
      SELECT agent_id,
        COUNT(*) FILTER (WHERE status IN ('running','succeeded','failed'))::int AS executed_count,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed_count
      FROM ai_actions
      WHERE created_at >= NOW() - (${boundedDays}::text || ' days')::interval
      GROUP BY agent_id
    ), approval_stats AS (
      SELECT a.agent_id,
        COUNT(*) FILTER (WHERE ap.state IN ('approved','rejected'))::int AS approval_decisions,
        COUNT(*) FILTER (WHERE ap.state='rejected')::int AS approval_rejections
      FROM ai_approvals ap
      JOIN ai_actions a ON a.id=ap.action_id
      WHERE ap.decided_at >= NOW() - (${boundedDays}::text || ' days')::interval
      GROUP BY a.agent_id
    )
    SELECT ag.id,ag.name,ag.autonomy_level,
      COALESCE(ac.executed_count,0)::int AS executed_count,
      COALESCE(ac.failed_count,0)::int AS failed_count,
      COALESCE(ap.approval_decisions,0)::int AS approval_decisions,
      COALESCE(ap.approval_rejections,0)::int AS approval_rejections
    FROM ai_agents ag
    LEFT JOIN action_stats ac ON ac.agent_id=ag.id
    LEFT JOIN approval_stats ap ON ap.agent_id=ag.id
    WHERE ag.enabled=TRUE AND ag.autonomy_level IN ('limited','trusted')
  ` as HealthRow[]

  let downgraded = 0
  for (const row of rows) {
    const target = evaluateAutonomyDowngrade(row)
    if (!target || target.level === row.autonomy_level) continue

    // The downgrade, audit, and Chief-visible alert must commit together. A
    // later alert failure must not leave an unreported automatic downgrade.
    const changed = await sql`
      WITH changed AS (
        UPDATE ai_agents
        SET autonomy_level=${target.level}, updated_by=${AI_SYSTEM_ACTOR}
        WHERE id=${row.id}
          AND autonomy_level=${row.autonomy_level}
          AND autonomy_level IN ('limited','trusted')
        RETURNING id
      ), audited AS (
        INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
        SELECT ${AI_SYSTEM_ACTOR}, 'ai_autonomy_downgraded', 'ai_agent', id,
               ${JSON.stringify({
                 from: row.autonomy_level,
                 to: target.level,
                 reason: target.reason,
                 windowDays: boundedDays,
                 executed: Number(row.executed_count ?? 0),
                 failed: Number(row.failed_count ?? 0),
                 approvalDecisions: Number(row.approval_decisions ?? 0),
                 approvalRejections: Number(row.approval_rejections ?? 0),
               })}::jsonb
        FROM changed
        RETURNING 1
      ), alerted AS (
        INSERT INTO ai_alerts (source_agent_id,severity,category,title,summary,dedupe_key,metadata)
        SELECT id, 'medium', 'agent_governance', ${`${row.name} autonomy reduced`},
               ${`${row.name} was automatically reduced from ${row.autonomy_level} to ${target.level} after its measured reliability fell outside KVRN's autonomy guardrails.`},
               ${`agent-governance:${row.id}:${target.level}:${new Date().toISOString().slice(0,10)}`},
               ${JSON.stringify({ requiresOwner: false, reason: target.reason, from: row.autonomy_level, to: target.level })}::jsonb
        FROM changed
        ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL
        DO UPDATE SET last_seen_at=NOW(), occurrence_count=ai_alerts.occurrence_count+1
        RETURNING 1
      )
      SELECT id FROM changed
    ` as any[]
    if (!changed.length) continue
    downgraded += 1
  }
  return { downgraded }
}
