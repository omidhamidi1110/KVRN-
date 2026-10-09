import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

/** Private, boolean-only readiness checks. Never disclose secrets or mail destinations. */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const forward = (process.env.SUPPORT_FORWARD_TO || '').trim()
  const config = {
    inboxPersistence: true, // POST /api/contact saves to the existing Support inbox before returning success
    forwardingDestinationConfigured: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forward),
    resendApiKeyConfigured: Boolean(process.env.RESEND_API_KEY),
    inboundEmailIngestConfigured: Boolean(process.env.SUPPORT_EMAIL_INGEST_SECRET),
    // Cloudflare Email Routing + Resend DNS domain verification cannot be inferred from env vars.
    cloudflareRoutingVerified: null,
    resendSendingDomainVerified: null,
  }
  return NextResponse.json({ config, note: 'Configuration presence only. Provider routing/domain verification requires owner dashboard confirmation; no test email was sent.' }, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
