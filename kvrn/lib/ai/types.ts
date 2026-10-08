export type AiAgentId =
  | 'chief'
  | 'growth_cro'
  | 'ads_social'
  | 'creator_affiliate'
  | 'market_intel'
  | 'lifecycle'
  | 'support'
  | 'product_inventory'
  | 'finance_risk'
  | 'seo_commerce_data'
  | 'engineering_qa'

export type AiModelRole = 'none' | 'cheap' | 'video' | 'business' | 'finance' | 'expert'
export type AiRiskLevel = 'info' | 'low' | 'medium' | 'high' | 'critical'
export type AiPermissionLevel = 'green' | 'yellow' | 'red'
export type AiAutonomyLevel = 'shadow' | 'approval' | 'limited' | 'trusted'
export type AiAlertDisposition =
  | 'pending'
  | 'log'
  | 'dashboard'
  | 'digest'
  | 'pushover'
  | 'critical_pushover'
  | 'suppressed'

export type AiProvider = 'anthropic' | 'openai' | 'google'
export type AiEvaluationModelId = 'haiku_5_5' | 'gpt_6_luna'

export type AiVideoInput = {
  type: 'video'
  /** Public YouTube URL or a Gemini File API URI. Arbitrary remote URLs are not accepted. */
  uri: string
  /** Required for Gemini File API URIs; optional for YouTube URLs. */
  mimeType?: string
  /** Required so KVRN can reserve a deterministic worst-case budget before inference. */
  durationSeconds: number
  /** Social-video analysis is intentionally static/predictable for cost safety. */
  processing?: 'static'
  /** Optional static sampling rate. KVRN caps this at 1 FPS. */
  fps?: number
  startOffsetSeconds?: number
  endOffsetSeconds?: number
}

export type AiTask = {
  agentId: AiAgentId
  role: Exclude<AiModelRole, 'none' | 'expert'>
  purpose: string
  system: string
  input: string
  actionId?: string | null
  essential?: boolean
  maxOutputTokens?: number
  temperature?: number
  /** Multimodal input is currently restricted to role='video' and the Google adapter. */
  media?: AiVideoInput[]
}

export type AiModelUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export type AiModelResult = {
  provider: AiProvider
  model: string
  text: string
  usage: AiModelUsage
  costMicros: number
  latencyMs: number
}

export type AiBudgetMode = 'normal' | 'reduced' | 'essential_only' | 'locked'

export type AiBudgetSnapshot = {
  monthSpendMicros: number
  activeReservationMicros: number
  orphanedReservationMicros: number
  effectiveCommittedMicros: number
  targetMonthlyMicros: number
  warning1Micros: number
  warning2Micros: number
  essentialOnlyMicros: number
  operationalCutoffMicros: number
  absoluteCeilingMicros: number
  manuallyLocked: boolean
  mode: AiBudgetMode
  remainingToOperationalCutoffMicros: number
}

export type AiAlertInput = {
  sourceAgentId: AiAgentId
  severity: AiRiskLevel
  category: string
  title: string
  summary: string
  dedupeKey: string
  actionId?: string | null
  metadata?: Record<string, unknown>
}
