// POST /api/twilio/incoming — Twilio inbound SMS webhook
// Handles keyword-driven consent changes (STOP/START/HELP).
// Twilio Advanced Opt-Out may already handle standard keywords at the Messaging Service level.
// This webhook mirrors Twilio's consent state into Neon.
//
// SECURITY: Requires Twilio webhook signature validation via TWILIO_AUTH_TOKEN.
// See lib/twilio.ts. If TWILIO_AUTH_TOKEN is not set, the route fails closed.
import { type NextRequest, NextResponse } from 'next/server'
import { validateTwilioSignature, parseFormBody, getWebhookUrl } from '@/lib/twilio'
import { normalizePhoneE164 } from '@/lib/phone'
import { unsubscribeSmsPhone, resubscribeSmsPhone, upsertSmsSubscriber } from '@/lib/sms-subscribers'
import { upsertSmsDiscountCode, isSmsOfferActive } from '@/lib/discounts'

export const dynamic = 'force-dynamic'

const STOP_KEYWORDS  = new Set(['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'])
const START_KEYWORDS = new Set(['START','YES','UNSTOP','JOIN'])
const HELP_KEYWORDS  = new Set(['HELP'])

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig     = req.headers.get('X-Twilio-Signature') ?? ''
  const url     = getWebhookUrl(req)   // reconstructed public URL Twilio signed

  const params  = parseFormBody(rawBody)
  const validity = await validateTwilioSignature(url, params, sig)

  if (validity === 'unconfigured') {
    // TWILIO_AUTH_TOKEN not set — cannot validate. Fail closed.
    console.error('[twilio/incoming] TWILIO_AUTH_TOKEN not configured — cannot validate webhook')
    return new NextResponse('Webhook signature validation not configured.', { status: 503 })
  }
  if (validity === 'invalid') {
    console.error('[twilio/incoming] Invalid Twilio signature')
    return new NextResponse('Forbidden', { status: 403 })
  }

  const rawFrom = params.From ?? ''
  const body    = (params.Body ?? '').trim().toUpperCase().split(/\s+/)[0]  // first word

  const phoneE164 = normalizePhoneE164(rawFrom)
  if (!phoneE164) {
    // Cannot normalize — log and return empty TwiML
    console.error('[twilio/incoming] Could not normalize From number')
    return new NextResponse(EMPTY_TWIML, { headers: { 'Content-Type': 'text/xml' } })
  }

  try {
    if (STOP_KEYWORDS.has(body)) {
      // Mirror Twilio opt-out into Neon
      await unsubscribeSmsPhone(phoneE164, 'sms_keyword')
      console.log('[twilio/incoming] STOP received — local unsubscribe recorded')
      // Twilio Advanced Opt-Out handles the automated "You have been unsubscribed" reply.
      // Return empty TwiML to avoid double-responding.

    } else if (START_KEYWORDS.has(body)) {
      // Re-subscribe or create subscriber record
      const existed = await resubscribeSmsPhone(phoneE164, 'sms_keyword')
      let smsSubscriberId: string | null = null
      if (!existed) {
        // First-time subscriber via keyword
        const sub = await upsertSmsSubscriber({ phoneE164, consentSource: 'sms_keyword' })
        smsSubscriberId = sub.id
      } else {
        // Re-subscribe: look up existing subscriber id
        const rows = await (await import('@/lib/db')).sql`
          SELECT id FROM sms_subscribers WHERE phone_e164 = ${phoneE164} LIMIT 1
        `
        smsSubscriberId = (rows as any[])[0]?.id ?? null
      }
      // Generate/retrieve unique SMS discount code (stored for future welcome SMS)
      // Does NOT send while A2P is pending — code stored only
      if (smsSubscriberId) {
        try {
          const offer = await isSmsOfferActive()
          if (offer.active) await upsertSmsDiscountCode({ subscriberId: smsSubscriberId, phoneE164 })
        } catch (discErr: any) {
          console.error('[twilio/incoming] discount code error (non-fatal):', discErr?.message?.slice(0, 60))
        }
      }
      console.log('[twilio/incoming] START/JOIN received — local subscribe recorded')

    } else if (HELP_KEYWORDS.has(body)) {  // HELP keywords — no consent change
      // HELP: do not alter consent state; Twilio handles reply
      console.log('[twilio/incoming] HELP received — consent unchanged')
    }
    // All other inbound messages: log and return empty TwiML
  } catch (err: any) {
    console.error('[twilio/incoming] DB error:', err?.message?.slice(0, 80))
    // Return empty TwiML even on error — do not expose internal errors to Twilio
  }

  return new NextResponse(EMPTY_TWIML, {
    headers: { 'Content-Type': 'text/xml' },
  })
}
