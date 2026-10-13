/** Web checkbox-based marketing opt-in. No provider calls.
 * Unsubscribe and suppression never get overridden by this endpoint.
 * Website consent is not the same as a shipping/checkout phone number.
 */
import {type NextRequest,NextResponse} from 'next/server'
import {readLimitedJson} from '@/lib/limited-json-request'
import {allowPublicApiRequest} from '@/lib/public-api-rate-limit'
import {normalizePhoneE164} from '@/lib/phone'
import {PUBLIC_SMS_SOURCES} from '@/lib/sms-subscribers'
import {sql} from '@/lib/db'
import {isSmsOfferActive,upsertSmsDiscountCode} from '@/lib/discounts'
export const dynamic='force-dynamic'
const h={'Cache-Control':'no-store'}
const unavailable=()=>NextResponse.json({success:false,error:'KVRN text signup is temporarily unavailable while carrier approval is being completed.'},{status:503,headers:h})
export async function POST(req:NextRequest){
 // Keep the web enrollment gate closed until both carrier approval and owner
 // publication/activation. Never implicitly turn on promotional sending.
 if(process.env.TWILIO_A2P_APPROVED!=='true'||
    process.env.TWILIO_SIGNUP_ENABLED!=='true'||
    process.env.NEXT_PUBLIC_SMS_SIGNUP_ENABLED!=='true'||
    process.env.KVRN_SMS_POLICY_PUBLIC_ENABLED!=='true')return unavailable()
 try{
  if(!(await allowPublicApiRequest(sql,{bucket:'sms_web_subscribe',headers:req.headers,limit:5,windowSeconds:600})))
   return NextResponse.json({success:false,error:'Too many attempts.'},{status:429,headers:{...h,'Retry-After':'600'}})
 }catch{return unavailable()}
 const result=await readLimitedJson(req,2048)
 if(!result.ok||!result.value||typeof result.value!=='object'||Array.isArray(result.value))
  return NextResponse.json({success:false,error:'Invalid request.'},{status:400,headers:h})
 const data=result.value as Record<string,unknown>
 const phone=typeof data.phone==='string'?normalizePhoneE164(data.phone):null
 if(!phone||!/^\+1\d{10}$/.test(phone))
  return NextResponse.json({success:false,error:'Enter a valid US mobile number.'},{status:400,headers:h})
 if(data.smsMarketingConsent!==true||data.consentDisclosureVersion!=='2026-10-13')
  return NextResponse.json({success:false,error:'Explicit SMS marketing consent is required.'},{status:400,headers:h})
 const source=typeof data.source==='string'?data.source:''
 if(!PUBLIC_SMS_SOURCES.has(source))
  return NextResponse.json({success:false,error:'Invalid signup source.'},{status:400,headers:h})
 try{
  // One atomic statement; preserve all prior STOP / unsubscribe protections.
  // Consent source and time provide server-side evidence for the shown
  // standalone, unchecked website marketing checkbox.
  const enrolled=await sql`
   INSERT INTO sms_subscribers(phone_e164,status,consent_source,consented_at,twilio_opt_out_state,unsubscribed_at)
   VALUES(${phone},'subscribed',${source},NOW(),NULL,NULL)
   ON CONFLICT(phone_e164) DO UPDATE SET
    status='subscribed',consent_source=EXCLUDED.consent_source,
    consented_at=NOW(),updated_at=NOW()
   WHERE sms_subscribers.status='subscribed'
     AND sms_subscribers.unsubscribed_at IS NULL
     AND sms_subscribers.twilio_opt_out_state IS DISTINCT FROM 'opted_out'
   RETURNING id::text AS id
  ` as Array<{id:string}>
  if(!enrolled[0])
   return NextResponse.json({success:false,error:'This number is not eligible for website re-enrollment. Contact support@kvrn.shop.'},{status:409,headers:h})
  let discountCode:string|null=null
  try{
   const offer=await isSmsOfferActive()
   if(offer.active)discountCode=await upsertSmsDiscountCode({subscriberId:enrolled[0].id,phoneE164:phone})
  }catch{/* Consent remains valid even if optional discount issuance fails. */}
  return NextResponse.json({success:true,discountCode},{headers:h})
 }catch{
  console.error('[sms/web-subscribe] Failed to save consent (redacted).')
  return NextResponse.json({success:false,error:'Signup unavailable. Please try again later.'},{status:503,headers:h})
 }
}
