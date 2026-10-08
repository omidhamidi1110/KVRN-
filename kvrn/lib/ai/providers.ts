import { createHash } from 'crypto'
import { assertGatewayAuthenticationConfigured, assertGatewayConfigured, estimateCostMicros, type ModelConfig } from './config'
import type { AiModelResult, AiTask, AiVideoInput } from './types'
import { getAiVideoMaxSeconds, validateAiVideoUri } from './capabilities'


function gatewayHeaders(): Record<string, string> {
  const token = process.env.CLOUDFLARE_AI_GATEWAY_TOKEN?.trim()
  if (!token) return {}
  return {
    'cf-aig-authorization': `Bearer ${token}`,
    // Fail closed when BYOK/stored provider credentials are unavailable. Cloudflare
    // otherwise permits eligible third-party requests to fall through to Unified
    // Billing; KVRN intentionally forbids that alternate billing path.
    'cf-aig-no-wholesale': 'true',
  }
}

function storedGatewayKeysEnabled(): boolean {
  return process.env.AI_GATEWAY_USE_STORED_KEYS === 'true'
}

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const safeMs = Number.isFinite(ms) ? Math.max(5_000, Math.min(60_000, Math.floor(ms))) : 30_000
  const timer = setTimeout(() => controller.abort(), safeMs)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024

function normalizedOutputTokens(task: AiTask): number {
  const raw = task.maxOutputTokens == null ? 800 : Number(task.maxOutputTokens)
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 64 || raw > 4096) {
    throw new Error('AI_OUTPUT_LIMIT_INVALID')
  }
  return raw
}

async function providerJson(res: Response, provider: string): Promise<any> {
  const code = provider.toUpperCase().replace(/[^A-Z0-9_:-]/g,'_').slice(0,80)
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`${code}_HTTP_${res.status}`)
  }
  const declared = Number(res.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_JSON_BYTES) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`${code}_RESPONSE_TOO_LARGE`)
  }
  if (!res.body) throw new Error(`${code}_EMPTY_RESPONSE`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_PROVIDER_JSON_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`${code}_RESPONSE_TOO_LARGE`)
    }
    text += decoder.decode(value,{stream:true})
  }
  text += decoder.decode()
  if (!text.trim()) throw new Error(`${code}_EMPTY_RESPONSE`)
  try { return JSON.parse(text) } catch { throw new Error(`${code}_INVALID_JSON`) }
}

export function requestFingerprint(task: AiTask): string {
  return createHash('sha256')
    .update(`${task.agentId}|${task.role}|${task.purpose}|${task.system}|${task.input}|${JSON.stringify(task.media ?? [])}`)
    .digest('hex')
    .slice(0, 32)
}

function normalizedVideoDuration(video: AiVideoInput): number {
  const maxSeconds = getAiVideoMaxSeconds()
  const duration = Number(video.durationSeconds)
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxSeconds) throw new Error('AI_VIDEO_DURATION_NOT_ALLOWED')
  const start = video.startOffsetSeconds == null ? 0 : Number(video.startOffsetSeconds)
  const end = video.endOffsetSeconds == null ? duration : Number(video.endOffsetSeconds)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration) {
    throw new Error('AI_VIDEO_CLIP_NOT_ALLOWED')
  }
  return end - start
}


function validateVideoMedia(task: AiTask): AiVideoInput[] {
  const media = task.media ?? []
  if (!media.length) return []
  if (task.role !== 'video') throw new Error('AI_MEDIA_ROLE_NOT_ALLOWED')
  if (media.length > 1) throw new Error('AI_VIDEO_COUNT_NOT_ALLOWED')
  for (const item of media) {
    if (item.type !== 'video') throw new Error('AI_MEDIA_TYPE_NOT_ALLOWED')
    validateAiVideoUri(item.uri)
    normalizedVideoDuration(item)
    const fps = item.fps ?? 1
    if (!Number.isFinite(fps) || fps <= 0 || fps > 1) throw new Error('AI_VIDEO_FPS_NOT_ALLOWED')
    if (item.processing && item.processing !== 'static') throw new Error('AI_VIDEO_PROCESSING_NOT_ALLOWED')
    if (item.mimeType && !/^video\/[a-z0-9.+-]+$/i.test(item.mimeType)) throw new Error('AI_VIDEO_MIME_NOT_ALLOWED')
  }
  return media
}

export function estimateWorstCaseCostMicros(config: ModelConfig, task: AiTask): number {
  // Conservative reservation. Text calls intentionally over-reserve. Video calls add
  // predictable static-processing tokens before the request is allowed to leave KVRN.
  // Reserve one input token per JS character before the extra safety multiplier.
  // This intentionally overestimates ordinary English and remains safer for dense
  // JSON, identifiers and non-English/Unicode text. Over-reserving is preferable
  // to allowing concurrent requests to drift through the owner's $4 cutoff.
  if (typeof task.system !== 'string' || typeof task.input !== 'string') throw new Error('AI_TASK_TEXT_INVALID')
  let estimatedInput = task.system.length + task.input.length
  const media = validateVideoMedia(task)
  for (const video of media) {
    // Current Gemini static-video accounting is ~263 input tokens/sec. Reserve
    // 320/sec to leave headroom for metadata/tokenizer variance and price safety.
    estimatedInput += Math.ceil(normalizedVideoDuration(video) * 320)
  }
  const maxOutput = normalizedOutputTokens(task)
  // Gemini max_output_tokens includes thinking tokens. Reserve the complete requested cap.
  const estimatedOutput = maxOutput
  const base = Math.max(1, estimateCostMicros(config, {
    inputTokens: estimatedInput,
    outputTokens: estimatedOutput,
    cachedInputTokens: 0,
  }))
  const configured = Number(process.env.AI_RESERVATION_SAFETY_MULTIPLIER || 1.5)
  const multiplier = Number.isFinite(configured) ? Math.max(1.25, Math.min(5, configured)) : 1.5
  return Math.ceil(base * multiplier)
}

async function invokeAnthropic(config: ModelConfig, task: AiTask, fetchImpl: typeof fetch): Promise<AiModelResult> {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  assertGatewayAuthenticationConfigured()
  if (!storedGatewayKeysEnabled() && !key) throw new Error('ANTHROPIC_API_KEY_NOT_CONFIGURED')
  const t0 = Date.now()
  const t = timeoutSignal(Number(process.env.AI_PROVIDER_TIMEOUT_MS || 30_000))
  try {
    const res = await fetchImpl(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...gatewayHeaders(),
        ...(storedGatewayKeysEnabled() ? {} : { 'x-api-key': key! }),
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: normalizedOutputTokens(task),
        // Claude 5.5 rejects non-default temperature/top_p/top_k. Haiku's cheap
        // classification path disables thinking so small JSON replies cannot be
        // consumed entirely by hidden thinking tokens; Sonnet keeps adaptive
        // thinking for business reasoning with a bounded effort level.
        ...(config.model.includes('haiku-5-5') && task.role === 'cheap'
          ? { thinking: { type: 'disabled' }, output_config: { effort: 'low' } }
          : config.model.includes('sonnet-5-5')
            ? { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }
            : {}),
        system: task.system,
        messages: [{ role: 'user', content: task.input }],
      }),
      signal: t.signal,
    })
    const payload: any = await providerJson(res, 'ANTHROPIC')
    const text = Array.isArray(payload?.content)
      ? payload.content.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text ?? '')).join('\n').trim()
      : ''
    if (payload?.stop_reason === 'refusal') throw new Error('ANTHROPIC_REFUSAL')
    if (!text) {
      throw new Error(payload?.stop_reason === 'max_tokens' ? 'ANTHROPIC_MAX_TOKENS_NO_TEXT' : 'ANTHROPIC_EMPTY_RESPONSE')
    }
    const usage = {
      inputTokens: Number(payload?.usage?.input_tokens ?? 0),
      outputTokens: Number(payload?.usage?.output_tokens ?? 0),
      cachedInputTokens: Number(payload?.usage?.cache_read_input_tokens ?? 0),
    }
    return {
      provider: 'anthropic', model: config.model, text, usage,
      costMicros: estimateCostMicros(config, usage), latencyMs: Date.now() - t0,
    }
  } finally { t.cancel() }
}

async function invokeOpenAi(config: ModelConfig, task: AiTask, fetchImpl: typeof fetch): Promise<AiModelResult> {
  const key = process.env.OPENAI_API_KEY?.trim()
  assertGatewayAuthenticationConfigured()
  if (!storedGatewayKeysEnabled() && !key) throw new Error('OPENAI_API_KEY_NOT_CONFIGURED')
  const t0 = Date.now()
  const t = timeoutSignal(Number(process.env.AI_PROVIDER_TIMEOUT_MS || 30_000))
  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...gatewayHeaders(),
        ...(storedGatewayKeysEnabled() ? {} : { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({
        model: config.model,
        max_completion_tokens: normalizedOutputTokens(task),
        // GPT-6.1 Sol requires reasoning (none/minimal are unsupported), and OpenAI
        // requires sampling parameters such as temperature to be omitted while
        // reasoning is active. Luna evals use reasoning=none for the cheapest
        // apples-to-apples routine-work comparison.
        ...(config.model.includes('gpt-6-luna')
          ? { reasoning_effort: 'none', temperature: task.temperature ?? 0.2 }
          : config.model.includes('gpt-6.1-sol')
            ? { reasoning_effort: 'high' }
            : {}),
        messages: [
          { role: 'system', content: task.system },
          { role: 'user', content: task.input },
        ],
      }),
      signal: t.signal,
    })
    const payload: any = await providerJson(res, 'OPENAI')
    const text = String(payload?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) throw new Error(payload?.choices?.[0]?.finish_reason === 'length' ? 'OPENAI_MAX_TOKENS_NO_TEXT' : 'OPENAI_EMPTY_RESPONSE')
    const usage = {
      inputTokens: Number(payload?.usage?.prompt_tokens ?? 0),
      outputTokens: Number(payload?.usage?.completion_tokens ?? 0),
      cachedInputTokens: Number(payload?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    }
    return {
      provider: 'openai', model: config.model, text, usage,
      costMicros: estimateCostMicros(config, usage), latencyMs: Date.now() - t0,
    }
  } finally { t.cancel() }
}

function interactionText(payload: any): string {
  const direct = typeof payload?.output_text === 'string' ? payload.output_text.trim() : ''
  if (direct) return direct
  const chunks: string[] = []
  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type !== 'model_output') continue
    for (const part of Array.isArray(step?.content) ? step.content : []) {
      if (part?.type === 'text' && typeof part?.text === 'string') chunks.push(part.text)
    }
  }
  return chunks.join('\n').trim()
}

async function invokeGoogle(config: ModelConfig, task: AiTask, fetchImpl: typeof fetch): Promise<AiModelResult> {
  const key = process.env.GOOGLE_AI_API_KEY?.trim()
  assertGatewayAuthenticationConfigured()
  if (!storedGatewayKeysEnabled() && !key) throw new Error('GOOGLE_AI_API_KEY_NOT_CONFIGURED')
  const media = validateVideoMedia(task)
  const t0 = Date.now()
  const t = timeoutSignal(Number(process.env.AI_PROVIDER_TIMEOUT_MS || 30_000))
  try {
    const version = (process.env.AI_GOOGLE_API_VERSION || 'v1beta').trim()
    if (version !== 'v1beta') throw new Error('AI_GOOGLE_API_VERSION_NOT_VETTED')
    const headers = {
      'content-type': 'application/json',
      ...gatewayHeaders(),
      ...(storedGatewayKeysEnabled() ? {} : { 'x-goog-api-key': key! }),
    }

    if (media.length) {
      const video = media[0]
      const processing: Record<string, unknown> = { type: 'static' }
      if (video.fps != null) processing.fps = video.fps
      if (video.startOffsetSeconds != null) processing.start_offset = video.startOffsetSeconds
      if (video.endOffsetSeconds != null) processing.end_offset = video.endOffsetSeconds
      const videoInput: Record<string, unknown> = {
        type: 'video', uri: validateAiVideoUri(video.uri).toString(), processing,
      }
      if (video.mimeType) videoInput.mime_type = video.mimeType

      // Interactions is the current Gemini multimodal surface for direct YouTube/File API video.
      // Cloudflare AI Gateway supports appending provider-native endpoints to its Google base URL.
      const res = await fetchImpl(`${config.baseUrl}/${version}/interactions`, {
        method: 'POST', headers,
        body: JSON.stringify({
          model: config.model,
          system_instruction: task.system,
          input: [videoInput, { type: 'text', text: task.input }],
          generation_config: {
            temperature: task.temperature ?? 0.2,
            thinking_level: 'low',
            max_output_tokens: normalizedOutputTokens(task),
          },
        }),
        signal: t.signal,
      })
      const payload: any = await providerJson(res, 'GOOGLE')
      if (payload?.status && !['completed','succeeded'].includes(String(payload.status))) {
        throw new Error(`GOOGLE_INTERACTION_${String(payload.status).toUpperCase()}`)
      }
      const text = interactionText(payload)
      if (!text) throw new Error('GOOGLE_EMPTY_RESPONSE')
      const usage = {
        inputTokens: Number(payload?.usage?.total_input_tokens ?? 0),
        // Thinking is separately reported and billable; include it in output-priced usage.
        outputTokens: Number(payload?.usage?.total_output_tokens ?? 0) + Number(payload?.usage?.total_thought_tokens ?? 0),
        cachedInputTokens: Number(payload?.usage?.total_cached_tokens ?? 0),
      }
      return {
        provider: 'google', model: config.model, text, usage,
        costMicros: estimateCostMicros(config, usage), latencyMs: Date.now() - t0,
      }
    }

    const url = `${config.baseUrl}/${version}/models/${encodeURIComponent(config.model)}:generateContent`
    const res = await fetchImpl(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: task.system }] },
        contents: [{ role: 'user', parts: [{ text: task.input }] }],
        generationConfig: {
          temperature: task.temperature ?? 0.2,
          maxOutputTokens: normalizedOutputTokens(task),
        },
      }),
      signal: t.signal,
    })
    const payload: any = await providerJson(res, 'GOOGLE')
    const parts = payload?.candidates?.[0]?.content?.parts
    const text = Array.isArray(parts) ? parts.map((p: any) => String(p?.text ?? '')).join('\n').trim() : ''
    if (!text) throw new Error(payload?.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'GOOGLE_MAX_TOKENS_NO_TEXT' : 'GOOGLE_EMPTY_RESPONSE')
    const usage = {
      inputTokens: Number(payload?.usageMetadata?.promptTokenCount ?? 0),
      outputTokens: Number(payload?.usageMetadata?.candidatesTokenCount ?? 0) + Number(payload?.usageMetadata?.thoughtsTokenCount ?? 0),
      cachedInputTokens: Number(payload?.usageMetadata?.cachedContentTokenCount ?? 0),
    }
    return {
      provider: 'google', model: config.model, text, usage,
      costMicros: estimateCostMicros(config, usage), latencyMs: Date.now() - t0,
    }
  } finally { t.cancel() }
}

export async function invokeProvider(
  config: ModelConfig,
  task: AiTask,
  fetchImpl: typeof fetch = fetch,
): Promise<AiModelResult> {
  assertGatewayConfigured(config)
  if (config.provider === 'anthropic') return invokeAnthropic(config, task, fetchImpl)
  if (config.provider === 'openai') return invokeOpenAi(config, task, fetchImpl)
  return invokeGoogle(config, task, fetchImpl)
}
