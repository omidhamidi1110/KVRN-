import { assertGatewayAuthenticationConfigured, assertGatewayConfigured, getEvaluationModelConfig, getModelConfig, type ModelConfig } from './config'
import { estimateWorstCaseCostMicros, invokeProvider, requestFingerprint } from './providers'
import { getAiAgentRuntimePolicy, recordModelCall, releaseAiBudget, reserveAiBudget, updateAiActionModel } from './repository'
import type { AiEvaluationModelId, AiModelResult, AiTask } from './types'


function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = Number(process.env[name] ?? fallback)
  const value = Number.isFinite(raw) ? raw : fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function assertTaskEnvelope(task: AiTask): void {
  // Environment variables may tune limits downward/upward within reviewed hard caps,
  // but cannot turn one bad config edit into an unbounded paid request.
  const maxSystemChars = boundedEnvNumber('AI_MAX_SYSTEM_CHARS', 12_000, 1_000, 24_000)
  const maxInputChars = boundedEnvNumber('AI_MAX_INPUT_CHARS', 50_000, 2_000, 100_000)
  const maxOutputTokens = boundedEnvNumber('AI_MAX_OUTPUT_TOKENS', 4_096, 64, 4_096)
  if (typeof task.system !== 'string' || !task.system || task.system.length > maxSystemChars) throw new Error('AI_SYSTEM_PROMPT_TOO_LARGE')
  if (typeof task.input !== 'string' || !task.input || task.input.length > maxInputChars) throw new Error('AI_INPUT_TOO_LARGE')
  const requestedOutput = task.maxOutputTokens == null ? 800 : Number(task.maxOutputTokens)
  if (!Number.isFinite(requestedOutput) || !Number.isInteger(requestedOutput) || requestedOutput < 64) throw new Error('AI_OUTPUT_LIMIT_INVALID')
  if (requestedOutput > maxOutputTokens) throw new Error('AI_OUTPUT_LIMIT_TOO_LARGE')
  if (task.temperature != null && (!Number.isFinite(task.temperature) || task.temperature < 0 || task.temperature > 1)) {
    throw new Error('AI_TEMPERATURE_NOT_ALLOWED')
  }
}

function assertProductionSpendSafety(): void {
  if (process.env.NODE_ENV !== 'production') return
  // Owner requirement: production inference must never run until the external
  // provider/Gateway hard budget has been configured and explicitly confirmed.
  // There is intentionally no production bypass flag for this safety boundary.
  if (process.env.AI_EXTERNAL_BUDGET_CAP_CONFIRMED !== 'true') {
    throw new Error('AI_EXTERNAL_BUDGET_CAP_NOT_CONFIRMED')
  }
  const externalCapUsd = Number(process.env.AI_EXTERNAL_BUDGET_CAP_USD)
  if (!Number.isFinite(externalCapUsd) || externalCapUsd <= 0 || externalCapUsd > 5) {
    throw new Error('AI_EXTERNAL_BUDGET_CAP_INVALID')
  }
}

function safeErrorCode(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 100).toUpperCase()
}

/**
 * The ONLY normal path from KVRN business agents to paid inference.
 *  1. fail closed when AI is disabled
 *  2. choose a role-specific model
 *  3. atomically reserve worst-case budget
 *  4. call through the configured Cloudflare AI Gateway base URL
 *  5. append usage/cost metadata (never prompt/response)
 *  6. release the reservation only after usage/cost is durably ledgered
 */
async function runAiTaskWithConfig(task: AiTask, config: ModelConfig, fetchImpl: typeof fetch): Promise<AiModelResult> {
  if (process.env.AI_ENABLED !== 'true') throw new Error('AI_DISABLED')
  assertTaskEnvelope(task)
  assertProductionSpendSafety()

  // Server-side runtime policy is authoritative. UI state cannot be bypassed by an agent module.
  const policy = await getAiAgentRuntimePolicy(task.agentId)
  if (!policy?.enabled || policy.status === 'disabled') throw new Error('AI_AGENT_DISABLED')
  if (!policy.allowedModelRoles.includes(task.role)) throw new Error('AI_MODEL_ROLE_NOT_ALLOWED')
  // Validate provider/Gateway/model routing before reserving money. Configuration
  // mistakes never left KVRN, so they must not consume the owner's monthly AI budget.
  assertGatewayConfigured(config)
  assertGatewayAuthenticationConfigured()
  const estimatedMicros = estimateWorstCaseCostMicros(config, task)
  const reservation = await reserveAiBudget({
    agentId: task.agentId,
    estimatedMicros,
    essential: Boolean(task.essential),
  })

  if (reservation.ok === false) {
    await recordModelCall({
      actionId: task.actionId,
      agentId: task.agentId,
      provider: config.provider,
      model: config.model,
      purpose: task.purpose,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
      status: 'blocked',
      errorCode: reservation.reason,
      requestFingerprint: requestFingerprint(task),
    }).catch(() => {})
    throw new Error(reservation.reason)
  }

  let ledgerRecorded = false
  try {
    const result = await invokeProvider(config, task, fetchImpl)
    const usageValues = [result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedInputTokens]
    const usageIsTrustworthy = usageValues.every(v => Number.isFinite(v) && v >= 0)
      && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0 || result.usage.cachedInputTokens > 0)
    // If a provider/API version stops returning complete, valid usage metadata, never
    // interpret the partial record as a cheap/free call. Keep the reserved worst case.
    const accountedCostMicros = usageIsTrustworthy && Number.isFinite(result.costMicros) && result.costMicros >= 0
      ? Math.max(1, result.costMicros)
      : estimatedMicros
    await recordModelCall({
      actionId: task.actionId,
      agentId: task.agentId,
      provider: result.provider,
      model: result.model,
      purpose: task.purpose,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      costMicros: accountedCostMicros,
      latencyMs: result.latencyMs,
      status: 'succeeded',
      requestFingerprint: requestFingerprint(task),
      reservationId: reservation.reservationId,
    })
    ledgerRecorded = true
    if (task.actionId) {
      await updateAiActionModel({
        actionId: task.actionId,
        provider: result.provider,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCostMicros: accountedCostMicros,
      }).catch(() => {})
    }
    return { ...result, costMicros: accountedCostMicros }
  } catch (err) {
    const errorCode = safeErrorCode(err)
    // A timeout / HTTP failure can happen after the provider accepted work. When exact
    // usage is unavailable, count the already-reserved worst-case amount rather than
    // optimistically recording $0. Pure configuration failures never left KVRN and cost $0.
    const definitelyNotBilled = /(?:API_KEY|GATEWAY_TOKEN|BASE_URL).*NOT_CONFIGURED|AI_GATEWAY_REQUIRED/.test(errorCode)
    const conservativeCostMicros = definitelyNotBilled ? 0 : estimatedMicros
    try {
      await recordModelCall({
        actionId: task.actionId,
        agentId: task.agentId,
        provider: config.provider,
        model: config.model,
        purpose: task.purpose,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: conservativeCostMicros,
        status: 'failed',
        errorCode,
        requestFingerprint: requestFingerprint(task),
        reservationId: reservation.reservationId,
      })
      ledgerRecorded = true
    } catch {
      // Keep the reservation unreleased. It will become a conservatively charged
      // orphan after expiry, preventing a provider-success/DB-failure crash from
      // disappearing from the monthly safety budget.
    }
    throw err
  } finally {
    if (ledgerRecorded) await releaseAiBudget(reservation.reservationId).catch(() => {})
  }
}


/** Normal production routing: role determines the configured model. */
export async function runAiTask(task: AiTask, fetchImpl: typeof fetch = fetch): Promise<AiModelResult> {
  return runAiTaskWithConfig(task, getModelConfig(task.role), fetchImpl)
}

/**
 * Manual evaluation-only model override. This is intentionally not exposed to business agents:
 * only the strict evaluation allowlist can select a challenger model, and the same DB budget
 * reservation, Gateway requirement, usage ledger and agent policy still apply.
 */
export async function runAiEvaluationTask(
  task: AiTask,
  evaluationModelId: AiEvaluationModelId,
  fetchImpl: typeof fetch = fetch,
): Promise<AiModelResult> {
  if (!task.purpose.startsWith('eval:')) throw new Error('AI_EVAL_PURPOSE_REQUIRED')
  if (task.role !== 'cheap') throw new Error('AI_EVAL_ROLE_NOT_ALLOWED')
  return runAiTaskWithConfig(task, getEvaluationModelConfig(evaluationModelId), fetchImpl)
}
