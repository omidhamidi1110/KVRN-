// POST /api/twilio/status — Twilio Message Status Callback
// Updates sms_messages delivery status. Idempotent.
// SECURITY: Requires TWILIO_AUTH_TOKEN for signature validation.
import { type NextRequest, NextResponse } from 'next/server'
import { validateTwilioSignature, parseFormBody, getWebhookUrl } from '@/lib/twilio'
import { normalizePhoneE164 } from '@/lib/phone'
import { upsertMessageStatus } from '@/lib/sms-subscribers'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig     = req.headers.get('X-Twilio-Signature') ?? ''
  const url     = getWebhookUrl(req)   // reconstructed public URL Twilio signed

  const params   = parseFormBody(rawBody)
  const validity = await validateTwilioSignature(url, params, sig)

  if (validity === 'unconfigured') {
    console.error('[twilio/status] TWILIO_AUTH_TOKEN not configured — cannot validate webhook')
    return new NextResponse('Webhook signature validation not configured.', { status: 503 })
  }
  if (validity === 'invalid') {
    console.error('[twilio/status] Invalid Twilio signature')
    return new NextResponse('Forbidden', { status: 403 })
  }

  const sid       = params.MessageSid   ?? ''
  const status    = params.MessageStatus ?? ''
  const errorCode = params.ErrorCode     ?? null
  const rawTo     = params.To            ?? ''

  if (!sid) {
    return new NextResponse('Missing MessageSid.', { status: 400 })
  }

  const phoneE164 = normalizePhoneE164(rawTo) ?? rawTo

  try {
    await upsertMessageStatus({ sid, phone: phoneE164, status, errorCode, direction: 'outbound' })
    if (errorCode) console.log(`[twilio/status] ${sid} status=${status} error=${errorCode}`)
  } catch (err: any) {
    console.error('[twilio/status] DB error:', err?.message?.slice(0, 80))
  }

  return new NextResponse('', { status: 200 })
}
