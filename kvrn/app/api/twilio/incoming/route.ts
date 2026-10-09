/** Twilio inbound consent events; NEVER trust browser-supplied STOP/YES.
 * Verified Twilio signatures are required, and A2P + keyword confirmation must be
 * explicitly enabled before new enrollment. No marketing provider sends here.
 */
import {type NextRequest,NextResponse} from 'next/server'
import {validateTwilioSignature,parseFormBody,getWebhookUrl} from '@/lib/twilio'
import {normalizePhoneE164} from '@/lib/phone'
import {readLimitedText} from '@/lib/limited-json-request'
import {suppressInboundSmsPhone} from '@/lib/sms-subscribers'
import {upsertSmsDiscountCode,isSmsOfferActive} from '@/lib/discounts'
import {KEYWORD_STARTS,KEYWORD_CONFIRMS,KEYWORD_STOPS,parseSmsKeyword,canAcceptSmsKeywordOptin,startKeywordConfirmation,clearPendingKeyword,confirmKeywordSms} from '@/lib/sms-double-optin'
export const dynamic='force-dynamic'
const asXml=(message?:string)=>new NextResponse(message
  ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`
  : '<?xml version="1.0" encoding="UTF-8"?><Response/>',
  {headers:{'Content-Type':'text/xml; charset=utf-8','Cache-Control':'no-store'}})
export async function POST(req:NextRequest){
  // Enforce a byte cap *while reading*; Twilio does not need large POST bodies.
  const read=await readLimitedText(req,4096)
  if(!read.ok)return new NextResponse('Invalid request.',{status:read.status})
  const params=parseFormBody(read.value)
  const signature=req.headers.get('X-Twilio-Signature')??''
  const verified=await validateTwilioSignature(getWebhookUrl(req),params,signature)
  if(verified==='unconfigured')return new NextResponse('Webhook not configured.',{status:503})
  if(verified!=='valid')return new NextResponse('Forbidden',{status:403})
  const phone=normalizePhoneE164(params.From??'')
  if(!phone)return asXml()
  const rawText=String(params.Body??'').trim()
  const keyword=parseSmsKeyword(rawText)
  // A signed STOP must not be acknowledged as processed if Neon failed to
  // persist the suppression. Let Twilio retry the event (upsert is idempotent).
  // Advanced Opt-Out may additionally block the number at the provider level.
  if(KEYWORD_STOPS.has(keyword)){
    try{
      await suppressInboundSmsPhone(phone)
    }catch{
      console.error('[twilio/incoming] STOP persistence failed (redacted).')
      return new NextResponse('Temporary failure; retry required.',{status:503})
    }
    try { await clearPendingKeyword(phone) } catch { /* optional table absent */ }
    return asXml()
  }
  try{
    if(keyword==='HELP')return asXml() // configured Twilio Messaging Service owns HELP.
    const enabled=canAcceptSmsKeywordOptin(process.env)
    if(KEYWORD_STARTS.has(keyword)){
      if(!enabled)return asXml() // no signup, no send, no silent consent
      // Token is only honored if embedded in verified inbound text.
      const token=rawText.match(/TK-([A-Za-z0-9_-]{20,40})/)?.[1]??null
      await startKeywordConfirmation(phone,token)
      return asXml('KVRN: Reply YES within 30 minutes to confirm recurring marketing texts. Must be 18+. Msg and data rates may apply. STOP to cancel. Consent not required to buy.')
    }
    if(KEYWORD_CONFIRMS.has(keyword)){
      if(!enabled)return asXml()
      const subscriberId=await confirmKeywordSms(phone,params.MessageSid??params.SmsMessageSid??'')
      if(!subscriberId)return asXml('KVRN: No pending signup. Text JOIN to begin, then reply YES to confirm.')
      try{
        const offer=await isSmsOfferActive()
        if(offer.active)await upsertSmsDiscountCode({subscriberId,phoneE164:phone})
      }catch{ /* A discount failure must never alter consent or emit PII */ }
      return asXml('KVRN: You are subscribed to recurring marketing texts. Frequency varies. Msg and data rates may apply. Reply STOP to unsubscribe or HELP for help.')
    }
    return asXml()
  }catch{
    // JOIN/YES database errors must not be acknowledged as completed consent.
    // Twilio can retry with its original signed MessageSid; future retries of YES
    // are idempotent because sms_keyword_consent_proofs has a UNIQUE SID.
    // Never log phone, message body, claim token, discount or provider details.
    console.error('[twilio/incoming] Keyword consent persistence failed (redacted).')
    return new NextResponse('Temporary failure; retry required.',{status:503})
  }
}
