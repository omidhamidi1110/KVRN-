import { sql } from '@/lib/db'
import { buildSupportTriageInput, parseSupportClassification, SUPPORT_TRIAGE_SYSTEM } from './agents/support'
import { runAiEvaluationTask } from './router'
import type { AiEvaluationModelId } from './types'

const MODEL_IDS = new Set<AiEvaluationModelId>(['haiku_5_5','gpt_6_luna'])

function safeCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'AI_EVAL_FAILED')
  return raw.replace(/[^A-Za-z0-9_:-]/g,'_').slice(0,120).toUpperCase()
}

function scoreSupport(actual: ReturnType<typeof parseSupportClassification>, expected: Record<string, unknown>): number {
  if (!actual) return 0
  const checks: boolean[] = []
  if (typeof expected.category === 'string') checks.push(actual.category === expected.category)
  if (typeof expected.urgency === 'string') checks.push(actual.urgency === expected.urgency)
  if (typeof expected.needsOwner === 'boolean') checks.push(actual.needsOwner === expected.needsOwner)
  if (!checks.length) return 0
  return checks.filter(Boolean).length / checks.length
}

function isConfigurationBlock(code: string): boolean {
  return /(?:API_KEY|GATEWAY_TOKEN|BASE_URL).*NOT_CONFIGURED|AI_GATEWAY_REQUIRED|AI_DISABLED|AI_AGENT_DISABLED|AI_BUDGET_LOCKED|AI_OPERATIONAL_CUTOFF|AI_ESSENTIAL_ONLY/.test(code)
}

export async function runSupportTriageEvaluation(input: {
  evaluationModelId: AiEvaluationModelId
  maxCases?: number
}): Promise<{ runId:string; status:string; score:number; passed:number; failed:number; costMicros:number }> {
  if (!MODEL_IDS.has(input.evaluationModelId)) throw new Error('AI_EVAL_MODEL_NOT_ALLOWED')
  const requestedCases = Number(input.maxCases ?? 10)
  const maxCases = Number.isFinite(requestedCases) ? Math.max(1, Math.min(20, Math.floor(requestedCases))) : 10
  const cases = await sql`
    SELECT id,name,input_payload,expected
    FROM ai_eval_cases
    WHERE suite='support_triage' AND enabled=TRUE
    ORDER BY id
    LIMIT ${maxCases}
  ` as any[]
  if (!cases.length) throw new Error('AI_EVAL_NO_CASES')

  const runRows = await sql`
    INSERT INTO ai_eval_runs(suite,evaluation_model_id,status,case_count)
    VALUES ('support_triage',${input.evaluationModelId},'running',${cases.length})
    RETURNING id
  ` as any[]
  const runId = String(runRows[0].id)

  let passed = 0
  let failed = 0
  let costMicros = 0
  let scoreTotal = 0
  let provider: string | null = null
  let model: string | null = null
  let blocked = false

  for (const c of cases) {
    const payload = c.input_payload ?? {}
    let parsed: ReturnType<typeof parseSupportClassification> = null
    let score = 0
    let failureCode: string | null = null
    let caseCost = 0
    let latencyMs: number | null = null
    try {
      const result = await runAiEvaluationTask({
        agentId:'engineering_qa', role:'cheap', purpose:`eval:support_triage:${String(c.id)}`,
        system:SUPPORT_TRIAGE_SYSTEM,
        input:buildSupportTriageInput({
          source:'synthetic_eval',
          hasOrderNumber:Boolean(payload.hasOrderNumber),
          hasAttachments:Boolean(payload.hasAttachments),
          subject:payload.subject,
          body:payload.body,
        }),
        essential:false, maxOutputTokens:260, temperature:0,
      }, input.evaluationModelId)
      provider = result.provider
      model = result.model
      caseCost = result.costMicros
      latencyMs = result.latencyMs
      costMicros += caseCost
      parsed = parseSupportClassification(result.text)
      score = scoreSupport(parsed, c.expected ?? {})
      if (!parsed) failureCode = 'INVALID_MODEL_OUTPUT'
      else if (score < 1) failureCode = 'EXPECTED_FIELDS_MISMATCH'
    } catch (error) {
      failureCode = safeCode(error)
      if (isConfigurationBlock(failureCode)) blocked = true
    }

    const didPass = score >= 1
    scoreTotal += score
    if (didPass) passed += 1
    else failed += 1
    await sql`
      INSERT INTO ai_eval_results(run_id,case_id,passed,score,output_summary,failure_code,cost_micros,latency_ms)
      VALUES (
        ${runId}::uuid,${String(c.id)},${didPass},${score},
        ${JSON.stringify(parsed ? {
          category:parsed.category,urgency:parsed.urgency,needsOwner:parsed.needsOwner,confidence:parsed.confidence,
        } : {})}::jsonb,
        ${failureCode},${caseCost},${latencyMs}
      )
    `
    // Configuration/budget failures will repeat identically and could create unnecessary calls/logs.
    if (blocked) break
  }

  const completedCases = passed + failed
  const aggregateScore = completedCases ? scoreTotal / completedCases : 0
  const status = blocked ? 'blocked' : failed === 0 && completedCases === cases.length ? 'passed' : completedCases < cases.length ? 'partial' : 'failed'
  await sql`
    UPDATE ai_eval_runs SET
      provider=${provider},model=${model},status=${status},case_count=${completedCases},
      passed_count=${passed},failed_count=${failed},score=${aggregateScore},cost_micros=${costMicros},completed_at=NOW()
    WHERE id=${runId}::uuid
  `
  return { runId,status,score:aggregateScore,passed,failed,costMicros }
}

export async function listAiEvalOverview(): Promise<{ runs:any[]; caseCounts:any[] }> {
  const [runs, caseCounts] = await Promise.all([
    sql`
      SELECT id::text,suite,evaluation_model_id,provider,model,status,case_count,passed_count,failed_count,
             score,cost_micros,started_at,completed_at
      FROM ai_eval_runs ORDER BY started_at DESC LIMIT 30
    `,
    sql`
      SELECT suite,target_agent_id,COUNT(*) FILTER (WHERE enabled)::int AS enabled_cases
      FROM ai_eval_cases GROUP BY suite,target_agent_id ORDER BY suite,target_agent_id
    `,
  ]) as any[][]
  return { runs, caseCounts }
}
