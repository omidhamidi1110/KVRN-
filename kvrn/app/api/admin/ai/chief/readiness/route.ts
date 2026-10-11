import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getModelConfig } from '@/lib/ai/config'
import { getAiBudgetSnapshot } from '@/lib/ai/budget'
import { getAiAgentRuntimePolicy } from '@/lib/ai/repository'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

/** Read-only, owner-authenticated operational preflight. No provider requests, secrets or writes. */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const [chief, budget] = await Promise.all([
      getAiAgentRuntimePolicy('chief'), getAiBudgetSnapshot(),
    ])
    const base = 'https://gateway.ai.cloudflare.com/v1/5c2f1f1df8ff752572878665e985280b/kvrn-ai-prod/'
    const gateways = {
      anthropic: getModelConfig('cheap').baseUrl === `${base}anthropic`,
      openai: getModelConfig('finance').baseUrl === `${base}openai`,
      google: getModelConfig('video').baseUrl === `${base}google-ai-studio`,
    }
    // Visible model routing is a configuration check only. A successful text ping
    // does not prove Gemini's separate multimodal Interactions API works for video.
    const videoModel = getModelConfig('video')
    const videoRouting = {
      agent: 'ads_social',
      provider: videoModel.provider,
      model: videoModel.model,
      apiVersion: process.env.AI_GOOGLE_API_VERSION || 'v1beta',
      configured: gateways.google && videoModel.provider === 'google' &&
        videoModel.model === 'gemini-3.8-flash' &&
        (process.env.AI_GOOGLE_API_VERSION || 'v1beta') === 'v1beta',
      videoRequestTested: false,
    }
    const blockers: string[] = []
    if (process.env.AI_ENABLED !== 'true') blockers.push('AI_ENABLED is OFF')
    if (process.env.AI_EXTERNAL_BUDGET_CAP_CONFIRMED !== 'true' || Number(process.env.AI_EXTERNAL_BUDGET_CAP_USD) > 5 || Number(process.env.AI_EXTERNAL_BUDGET_CAP_USD) <= 0) blockers.push('External spending cap not confirmed in Worker configuration')
    if (!process.env.CLOUDFLARE_AI_GATEWAY_TOKEN) blockers.push('Gateway authentication secret missing')
    if (process.env.AI_GATEWAY_USE_STORED_KEYS !== 'true') blockers.push('Stored provider-key routing is OFF')
    if (!gateways.anthropic) blockers.push('Anthropic Gateway URL missing or incorrect')
    if (!chief?.enabled || chief.status === 'disabled') blockers.push('Chief agent is disabled')
    if (!chief?.allowedModelRoles.includes('cheap')) blockers.push('Chief cheap-model role not permitted')
    if (budget.mode === 'locked' || budget.mode === 'essential_only') blockers.push('Internal budget restricted or locked')
    return NextResponse.json({
      paidAvailable: blockers.length === 0,
      status: blockers.length ? 'blocked' : 'ready', blockers,
      models: {
        cheap: getModelConfig('cheap').model,
        business: getModelConfig('business').model,
        finance: getModelConfig('finance').model,
        video: getModelConfig('video').model,
      },
      gateways, videoRouting,
      budgetMode: budget.mode,
    }, { headers: NO_STORE })
  } catch {
    return NextResponse.json({ paidAvailable: false, status: 'error', blockers: ['Readiness database unavailable'],
      models: {cheap: 'claude-haiku-5-5',business: 'claude-sonnet-5-5',finance: 'gpt-6.1-sol',video: 'gemini-3.8-flash'}, videoRouting: null }, { headers: NO_STORE })
  }
}
