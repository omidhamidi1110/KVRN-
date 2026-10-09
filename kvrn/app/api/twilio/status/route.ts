// POST /api/twilio/status — Twilio Message Status Callback
// Updates sms_messages delivery status. Idempotent.
// SECURITY: Requires TWILIO_AUTH_TOKEN for signature validation.
import { type NextRequest, NextResponse } from 'next/server'
import { validateTwilioSignature, parseFormBody, getWebhookUrl } from '@/lib/twilio'
import { normalizePhoneE164 } from '@/lib/phone'
import { upsertMessageStatus } from '@/lib/sms-subscribers'
import { readLimitedText } from '@/lib/limited-json-request'
import { recordSignedTwilioMarketingAcceptance } from '@/lib/marketing-signed-twilio-outcome'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const read = await readLimitedText(req, 4096)
  if (!read.ok) return new NextResponse('Invalid request.', { status: read.status })
  const sig     = req.headers.get('X-Twilio-Signature') ?? ''
  const url     = getWebhookUrl(req)   // reconstructed public URL Twilio signed

  const params   = parseFormBody(read.value)
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
    // Marketing-only reconciliation of an independently signed callback.
    // The additional flags are OFF until migration 060 and staging QA pass.
    // Transactional SMS continues through the existing status-upsert flow.
    await recordSignedTwilioMarketingAcceptance(sid,status,phoneE164,true)
  } catch {
    // Never log message SIDs, recipient data, or exception strings: driver
    // failures may contain PII. Returning success would lose the callback;
    // a retry is safe because upsertMessageStatus keys on Twilio SID.
    console.error('[twilio/status] Delivery-status storage temporarily failed (redacted).')
    return new NextResponse('Temporary failure; retry required.', { status: 503 })
  }

  return new NextResponse('', { status: 200 })
}
