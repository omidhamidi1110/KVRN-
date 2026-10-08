import type { AiEvaluationModelId, AiModelRole, AiProvider } from './types'

export type ModelConfig = {
  role: Exclude<AiModelRole, 'none' | 'expert'>
  provider: AiProvider
  model: string
  baseUrl: string
  inputDollarsPerMillion: number
  outputDollarsPerMillion: number
  cachedInputDollarsPerMillion: number
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  // Cost controls are a safety boundary, not a billing estimate convenience.
  // Never let an env typo or stale lower price reduce the reservation below the
  // reviewed code floor. Higher overrides are allowed when provider prices rise.
  return Math.max(fallback, n)
}

function stripSlash(v: string): string {
  return v.replace(/\/+$/, '')
}

/**
 * Gateway base URL examples (provider-native):
 *   Anthropic: .../anthropic  -> adapter appends /v1/messages
 *   OpenAI:    .../openai     -> adapter appends /chat/completions
 *   Google:    .../google-ai-studio -> adapter appends /v1beta/models/...
 * Provider base URLs are intentionally environment-controlled. Production KVRN
 * always requires Cloudflare AI Gateway; there is no production bypass. This keeps
 * every paid request behind one routing, logging and cost-control boundary.
 */
export function getModelConfig(role: Exclude<AiModelRole, 'none' | 'expert'>): ModelConfig {
  switch (role) {
    case 'cheap':
      return {
        role,
        provider: 'anthropic',
        model: process.env.AI_ANTHROPIC_CHEAP_MODEL || 'claude-haiku-5-5',
        baseUrl: stripSlash(process.env.AI_ANTHROPIC_BASE_URL || ''),
        inputDollarsPerMillion: envNum('AI_HAIKU_INPUT_USD_PER_M', 0.10),
        outputDollarsPerMillion: envNum('AI_HAIKU_OUTPUT_USD_PER_M', 0.50),
        cachedInputDollarsPerMillion: envNum('AI_HAIKU_CACHE_INPUT_USD_PER_M', 0.01),
      }
    case 'video':
      return {
        role,
        provider: 'google',
        model: process.env.AI_GOOGLE_VIDEO_MODEL || 'gemini-3.8-flash',
        baseUrl: stripSlash(process.env.AI_GOOGLE_BASE_URL || ''),
        inputDollarsPerMillion: envNum('AI_GEMINI_INPUT_USD_PER_M', 0.75),
        outputDollarsPerMillion: envNum('AI_GEMINI_OUTPUT_USD_PER_M', 3.75),
        cachedInputDollarsPerMillion: envNum('AI_GEMINI_CACHE_INPUT_USD_PER_M', 0.075),
      }
    case 'business':
      return {
        role,
        provider: 'anthropic',
        model: process.env.AI_ANTHROPIC_BUSINESS_MODEL || 'claude-sonnet-5-5',
        baseUrl: stripSlash(process.env.AI_ANTHROPIC_BASE_URL || ''),
        inputDollarsPerMillion: envNum('AI_SONNET_INPUT_USD_PER_M', 2),
        outputDollarsPerMillion: envNum('AI_SONNET_OUTPUT_USD_PER_M', 10),
        cachedInputDollarsPerMillion: envNum('AI_SONNET_CACHE_INPUT_USD_PER_M', 0.20),
      }
    case 'finance':
      return {
        role,
        provider: 'openai',
        model: process.env.AI_OPENAI_FINANCE_MODEL || 'gpt-6.1-sol',
        baseUrl: stripSlash(process.env.AI_OPENAI_BASE_URL || ''),
        inputDollarsPerMillion: envNum('AI_SOL_INPUT_USD_PER_M', 2),
        outputDollarsPerMillion: envNum('AI_SOL_OUTPUT_USD_PER_M', 10),
        cachedInputDollarsPerMillion: envNum('AI_SOL_CACHE_INPUT_USD_PER_M', 0.10),
      }
  }
}

export function assertGatewayAuthenticationConfigured(): void {
  const token = process.env.CLOUDFLARE_AI_GATEWAY_TOKEN?.trim()
  // Production KVRN always uses an authenticated Cloudflare AI Gateway. Stored
  // provider keys also require Gateway authentication outside production. Keeping
  // this check separate lets the router fail before reserving any AI budget.
  if ((process.env.NODE_ENV === 'production' || process.env.AI_GATEWAY_USE_STORED_KEYS === 'true') && !token) {
    throw new Error('CLOUDFLARE_AI_GATEWAY_TOKEN_NOT_CONFIGURED')
  }
}

export function assertGatewayConfigured(config: ModelConfig): void {
  if (!config.baseUrl) throw new Error(`AI_${config.provider.toUpperCase()}_BASE_URL_NOT_CONFIGURED`)

  if (process.env.NODE_ENV === 'production') {
    // Price reservations are role-specific, so production must not silently swap a
    // role to an unpriced/unbenchmarked model via an environment typo. Add/swap a
    // model here only after its KVRN eval + current pricing have been reviewed.
    const vetted = new Set([
      'cheap:anthropic:claude-haiku-5-5',
      'cheap:openai:gpt-6-luna', // manual eval challenger only
      'business:anthropic:claude-sonnet-5-5',
      'finance:openai:gpt-6.1-sol',
      'video:google:gemini-3.8-flash',
    ])
    if (!vetted.has(`${config.role}:${config.provider}:${config.model}`)) {
      throw new Error('AI_MODEL_NOT_VETTED_FOR_ROLE')
    }
  }

  let parsed: URL
  try { parsed = new URL(config.baseUrl) } catch { throw new Error('AI_BASE_URL_INVALID') }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('AI_BASE_URL_INVALID')

  if (process.env.NODE_ENV !== 'production') return

  // Production is intentionally provider-native Cloudflare AI Gateway only. Do not
  // use substring checks here: `gateway.ai.cloudflare.com.attacker.example` must fail.
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'gateway.ai.cloudflare.com') {
    throw new Error('AI_GATEWAY_REQUIRED')
  }
  if (parsed.port && parsed.port !== '443') throw new Error('AI_GATEWAY_REQUIRED')

  const expectedSuffix = config.provider === 'anthropic'
    ? '/anthropic'
    : config.provider === 'openai'
      ? '/openai'
      : '/google-ai-studio'
  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  if (!normalizedPath.endsWith(expectedSuffix)) throw new Error('AI_GATEWAY_PROVIDER_PATH_INVALID')
}

/** Convert provider usage into USD micros ($1 = 1,000,000 micros). */
export function estimateCostMicros(
  config: ModelConfig,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number {
  const safe = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }
  const input = safe(usage.inputTokens)
  const output = safe(usage.outputTokens)
  const cached = Math.min(input, safe(usage.cachedInputTokens ?? 0))
  const uncached = input - cached
  // Algebra: tokens * ($ per 1M tokens) / 1M * 1M micros/$ = tokens * price.
  return Math.max(0, Math.ceil(
    uncached * config.inputDollarsPerMillion
    + cached * config.cachedInputDollarsPerMillion
    + output * config.outputDollarsPerMillion,
  ))
}


/** Strict allowlist used only by the manual KVRN evaluation arena. */
export function getEvaluationModelConfig(id: AiEvaluationModelId): ModelConfig {
  if (id === 'haiku_5_5') {
    return {
      role:'cheap', provider:'anthropic',
      model:process.env.AI_EVAL_HAIKU_MODEL || process.env.AI_ANTHROPIC_CHEAP_MODEL || 'claude-haiku-5-5',
      baseUrl:stripSlash(process.env.AI_ANTHROPIC_BASE_URL || ''),
      inputDollarsPerMillion:envNum('AI_HAIKU_INPUT_USD_PER_M',0.10),
      outputDollarsPerMillion:envNum('AI_HAIKU_OUTPUT_USD_PER_M',0.50),
      cachedInputDollarsPerMillion:envNum('AI_HAIKU_CACHE_INPUT_USD_PER_M',0.01),
    }
  }
  return {
    role:'cheap', provider:'openai',
    model:process.env.AI_EVAL_LUNA_MODEL || 'gpt-6-luna',
    baseUrl:stripSlash(process.env.AI_OPENAI_BASE_URL || ''),
    inputDollarsPerMillion:envNum('AI_LUNA_INPUT_USD_PER_M',0.10),
    outputDollarsPerMillion:envNum('AI_LUNA_OUTPUT_USD_PER_M',0.50),
    cachedInputDollarsPerMillion:envNum('AI_LUNA_CACHE_INPUT_USD_PER_M',0.01),
  }
}
