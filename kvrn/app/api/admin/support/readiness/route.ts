import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getAiAgentRuntimePolicy } from '@/lib/ai/repository'
import { isPushoverConfigured } from '@/lib/pushover'
import { normalizeEmail } from '@/lib/support-inbox'

export const dynamic = 'force-dynamic'

/** Private, boolean-only readiness checks. Never disclose secrets or mail destinations. */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const forward = (process.env.SUPPORT_FORWARD_TO || '').trim()
  const supportAgent = await getAiAgentRuntimePolicy('support').catch(() => null)
  const config = {
    inboxPersistence: true, // POST /api/contact saves to the existing Support inbox before returning success
    forwardingDestinationConfigured: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forward),
    resendApiKeyConfigured: Boolean(process.env.RESEND_API_KEY),
    inboundEmailIngestConfigured: Boolean(process.env.SUPPORT_EMAIL_INGEST_SECRET),
    // Cloudflare Email Routing + Resend DNS domain verification cannot be inferred from env vars.
    cloudflareRoutingVerified: null,
    resendSendingDomainVerified: null,
    aiSupportAgentEnabled: Boolean(supportAgent?.enabled && supportAgent.status !== 'disabled'),
    aiSupportAutonomyLevel: supportAgent?.autonomyLevel ?? 'unknown',
    aiSupportCanaryReady: process.env.AI_ENABLED === 'true' && supportAgent?.autonomyLevel === 'limited'
      && Boolean(normalizeEmail(forward)) && process.env.AI_CHIEF_NOTIFICATION_GATE === 'true'
      && Boolean(process.env.RESEND_API_KEY) && isPushoverConfigured(),
    aiSupportAutoReplyReady: process.env.AI_ENABLED === 'true'
      && process.env.AI_CHIEF_NOTIFICATION_GATE === 'true'
      && Boolean(supportAgent?.enabled && supportAgent.autonomyLevel === 'trusted')
      && Boolean(process.env.RESEND_API_KEY) && isPushoverConfigured(),
  }
  return NextResponse.json({ config, note: 'Configuration presence only. Provider routing/domain verification requires owner dashboard confirmation; no test email was sent.' }, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
