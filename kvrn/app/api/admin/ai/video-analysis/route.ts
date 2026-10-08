import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { enqueueAiEventWithAudit } from '@/lib/ai/repository'
import { getAiVideoMaxSeconds, validateAiVideoUri } from '@/lib/ai/capabilities'

export const dynamic = 'force-dynamic'
const PLATFORMS = new Set(['tiktok','instagram','meta_ads','youtube','x','other'])


async function stableSha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function safeVideoUri(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try { return validateAiVideoUri(raw).toString() } catch { return null }
}

function boundedMetrics(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const safe: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 25)) {
    const k = key.trim().slice(0, 80)
    if (!k) continue
    if (typeof raw === 'number' && Number.isFinite(raw)) safe[k] = raw
    else if (typeof raw === 'boolean') safe[k] = raw
    else if (typeof raw === 'string') safe[k] = raw.slice(0, 200)
  }
  return safe
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body:any
  try { body=await req.json() } catch { return NextResponse.json({error:'Invalid JSON.'},{status:400}) }
  const platform = PLATFORMS.has(String(body?.platform ?? '').toLowerCase()) ? String(body.platform).toLowerCase() : 'other'
  const videoUri = safeVideoUri(body?.videoUri)
  const durationSeconds = Number(body?.durationSeconds)
  const maxSeconds = getAiVideoMaxSeconds()
  if (!videoUri) return NextResponse.json({error:'Use a public YouTube URL or a trusted Gemini File API video URI.'},{status:400})
  if (!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>maxSeconds) {
    return NextResponse.json({error:`Video duration must be between 1 and ${maxSeconds} seconds.`},{status:400})
  }
  const contentId = typeof body?.contentId==='string' ? body.contentId.trim().slice(0,240) : null
  const mimeType = typeof body?.mimeType==='string' ? body.mimeType.trim().slice(0,80) : undefined
  const metrics = boundedMetrics(body?.metrics)
  const uriFingerprint = (await stableSha256(videoUri)).slice(0, 24)
  const eventId = await enqueueAiEventWithAudit({
    eventType:'ads_social.video_analyze', source:'admin', sourceAgentId:'ads_social', severity:'info',
    subject:`Analyze ${platform} video performance`,
    payload:{ platform, contentId, videoUri, durationSeconds, mimeType, metrics },
    idempotencyKey:`video-analysis:${platform}:${contentId || uriFingerprint}:${Math.floor(Date.now()/3600000)}`,
    audit:{
      actorEmail:identity.email, action:'ai_video_analysis_queued', resource:'ai_social_video',
      resourceId:contentId ?? 'manual', payload:{platform,contentId,durationSeconds},
    },
  })
  return NextResponse.json({queued:Boolean(eventId),eventId})
}
