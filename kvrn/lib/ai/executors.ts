import { sql } from '@/lib/db'
import { claimApprovedAiActions, expireStaleAiApprovals, markAiAction, upsertAiAlert } from './repository'
import type { AiAgentId } from './types'

type ApprovedAction = {
  id: string
  agent_id: AiAgentId
  action_type: string
  resource?: string | null
  resource_id?: string | null
  summary: string
  evidence?: Record<string, unknown> | null
  confidence?: number | string | null
  risk_level: string
  permission_level: string
  idempotency_key?: string | null
}

type ExecutorResult = { ok: true; outcome?: Record<string, unknown> } | { ok: false; code: string; outcome?: Record<string, unknown> }
type ActionExecutor = (action: ApprovedAction) => Promise<ExecutorResult>

/**
 * Explicit allowlist of runtime action executors.
 *
 * Security invariant: approval alone never grants arbitrary execution. A proposed
 * action can only change an external/internal system if its action_type is wired
 * here to a narrowly-scoped executor. New executors require source review + QA.
 */
function decisionOnlyExecutor(expectedType: string): ActionExecutor {
  return async (action) => {
    if (action.action_type !== expectedType) return { ok:false, code:'ACTION_TYPE_MISMATCH' }
    return { ok:true, outcome:{ ownerDecisionRecorded:true, externalActionMade:false, note:'Approval accepts the recommendation only; it does not perform an external purchase/change.' } }
  }
}

const EXECUTORS: Readonly<Record<string, ActionExecutor>> = Object.freeze({
  // These are intentionally decision-only. They make the Approvals inbox useful while
  // preserving the rule that KVRN AI cannot place inventory orders, send money, or make
  // unreviewed external changes merely because an owner approved a recommendation.
  inventory_reorder_plan: decisionOnlyExecutor('inventory_reorder_plan'),
  creator_sample_plan: decisionOnlyExecutor('creator_sample_plan'),
  cro_experiment_plan: decisionOnlyExecutor('cro_experiment_plan'),
})

function safeCode(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? 'UNKNOWN')
  return msg.replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 120) || 'AI_EXECUTOR_FAILED'
}

async function runOne(action: ApprovedAction): Promise<void> {
  if (action.permission_level === 'red') {
    await upsertAiAlert({
      sourceAgentId: action.agent_id, actionId: action.id, severity:'critical', category:'permission_violation',
      title:'Red AI action blocked',
      summary:'A human-only Red action reached the executor boundary and was blocked. Review the approval/action history.',
      dedupeKey:`red-action-executor-block:${action.id}`, metadata:{requiresOwner:true,actionType:action.action_type},
    })
    await markAiAction({ actionId:action.id, status:'blocked', completed:true, outcome:{code:'RED_ACTION_HUMAN_ONLY'} })
    return
  }
  const executor = EXECUTORS[action.action_type]
  if (!executor) {
    // Alert first; if the Worker dies before the terminal action write, stale-action
    // recovery will still see the running action rather than silently losing notice.
    await upsertAiAlert({
      sourceAgentId: action.agent_id,
      actionId: action.id,
      severity: 'high',
      category: 'approved_action_blocked',
      title: 'Approved action could not execute',
      summary: `${action.summary} The owner approval was recorded, but KVRN has no reviewed executor for ${action.action_type}.`,
      dedupeKey: `approved-action-no-executor:${action.action_type}`,
      metadata: { actionType: action.action_type, actionId: action.id },
    })
    await markAiAction({
      actionId: action.id,
      status: 'blocked',
      completed: true,
      outcome: { code: 'NO_REGISTERED_EXECUTOR', approvalRecorded: true },
    })
    return
  }

  try {
    const result = await executor(action)
    if (result.ok === true) {
      await markAiAction({ actionId: action.id, status: 'succeeded', completed: true, outcome: result.outcome ?? {} })
      return
    }
    const failure = result as Extract<ExecutorResult, { ok: false }>
    await upsertAiAlert({
      sourceAgentId: action.agent_id,
      actionId: action.id,
      severity: 'high',
      category: 'approved_action_failed',
      title: 'Approved AI action failed',
      summary: `${action.summary} Executor failed with ${failure.code}.`,
      dedupeKey: `approved-action-failed:${action.action_type}:${action.resource_id ?? action.resource ?? 'global'}`,
      metadata: { actionType: action.action_type, actionId: action.id, code: failure.code },
    })
    await markAiAction({
      actionId: action.id, status: 'failed', completed: true,
      outcome: { code: failure.code, ...(failure.outcome ?? {}) },
    })
  } catch (error) {
    const code = safeCode(error)
    await upsertAiAlert({
      sourceAgentId: action.agent_id,
      actionId: action.id,
      severity: 'high',
      category: 'approved_action_failed',
      title: 'Approved AI action failed',
      summary: `${action.summary} Executor raised ${code}.`,
      dedupeKey: `approved-action-exception:${action.action_type}:${action.resource_id ?? action.resource ?? 'global'}`,
      metadata: { actionType: action.action_type, actionId: action.id, code },
    })
    await markAiAction({ actionId: action.id, status: 'failed', completed: true, outcome: { code } })
  }
}


async function recoverStaleRunningActions(): Promise<number> {
  // Recovery is one atomic DB statement: either both the terminal action state and
  // its owner-visible alert exist, or neither does. This closes the crash window
  // between marking an action failed and creating its alert.
  const rows = await sql`
    WITH stale AS (
      UPDATE ai_actions SET
        status='failed',
        completed_at=NOW(),
        outcome=COALESCE(outcome,'{}'::jsonb) || jsonb_build_object('code','STALE_EXECUTION_RECOVERED')
      WHERE status='running'
        AND updated_at < NOW() - INTERVAL '15 minutes'
      RETURNING id,agent_id,action_type,summary,resource,resource_id
    ), alerted AS (
      INSERT INTO ai_alerts(
        source_agent_id,action_id,severity,category,title,summary,dedupe_key,metadata,
        disposition,pushover_status,next_notify_after
      )
      SELECT
        agent_id,id,'high','approved_action_stale','Approved AI action needs review',
        LEFT(summary || ' Execution did not finish cleanly and was stopped rather than replayed automatically.',2000),
        'approved-action-stale:' || id::text,
        jsonb_build_object('actionType',action_type,'resource',resource,'resourceId',resource_id,'requiresOwner',true),
        'pending','not_requested',NULL
      FROM stale
      ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL
      DO UPDATE SET
        occurrence_count=ai_alerts.occurrence_count+1,
        last_seen_at=NOW(),
        severity='high',
        summary=EXCLUDED.summary,
        metadata=ai_alerts.metadata || EXCLUDED.metadata,
        disposition='pending', pushover_status='not_requested', next_notify_after=NULL
      RETURNING action_id
    )
    SELECT id::text FROM stale
  ` as any[]
  return rows.length
}

export async function processApprovedAiActions(limit = 10): Promise<{ claimed: number }> {
  await expireStaleAiApprovals()
  await recoverStaleRunningActions()
  const actions = await claimApprovedAiActions(limit) as ApprovedAction[]
  for (const action of actions) await runOne(action)
  return { claimed: actions.length }
}

export function hasRegisteredAiExecutor(actionType: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXECUTORS, actionType)
}
