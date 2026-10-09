/** Signed Resend unsubscribe and hard-bounce suppression only.
 * Separate from transactional order email and all sending APIs.
 * Migration 045 and provider webhook are NOT activated by this code.
 */
import {type NextRequest,NextResponse} from 'next/server'
import {readLimitedText} from '@/lib/limited-json-request'
import {verifyResendWebhook,extractResendSuppression} from '@/lib/resend-webhook-suppression'
import {sql} from '@/lib/db'
import {recordSignedResendMarketingDelivery} from '@/lib/marketing-signed-resend-outcome'
export const dynamic='force-dynamic'
const HEADERS={'Cache-Control':'no-store'}
const json=(data:object,status=200)=>NextResponse.json(data,{status,headers:HEADERS})
export async function POST(req:NextRequest){
  if(process.env.RESEND_MARKETING_WEBHOOK_SUPPRESSION_ENABLED!=='true')return json({error:'Not enabled.'},503)
  const secret=process.env.RESEND_MARKETING_WEBHOOK_SECRET??''
  if(!secret)return json({error:'Not configured.'},503)
  const previousSecret=process.env.RESEND_MARKETING_WEBHOOK_PREVIOUS_SECRET??''
  const read=await readLimitedText(req,16_384)
  if(!read.ok)return json({error:'Invalid webhook body.'},read.status)
  const eventId=await verifyResendWebhook(read.value,req.headers,previousSecret && previousSecret!==secret?[secret,previousSecret]:secret)
  if(!eventId)return json({error:'Invalid webhook signature.'},401)
  let event:unknown
  try{event=JSON.parse(read.value)}catch{return json({error:'Invalid JSON.'},400)}
  const suppression=extractResendSuppression(event)
  if(!suppression){
    // Refuse to acknowledge a potentially suppressing event with missing/ambiguous
    // address, so Resend can retry after the implementation is corrected.
    if(event && typeof event==='object' && !Array.isArray(event)){
      const object=event as Record<string,unknown>
      const data=object.data && typeof object.data==='object' ? object.data as Record<string,unknown> : null
      if((object.type==='contact.updated' && data?.unsubscribed===true) ||
        object.type==='email.complained' || object.type==='email.suppressed' ||
        (object.type==='email.bounced' && (!data?.bounce || typeof data.bounce!=='object' ||
          (data.bounce as Record<string,unknown>).type==='Permanent'))){
        return json({error:'Suppression event requires review and retry.'},422)
      }
    }
    // A separately flagged marketing-delivery audit; this never changes
    // unsubscribe/bounce handling or transactional message logic.
    try{
      const recorded=await recordSignedResendMarketingDelivery(event,true)
      return json({ok:true,action:recorded==='recorded'?'verified_delivery_recorded':'ignored'})
    }catch{return json({error:'Could not persist delivery evidence; retry required.'},503)}
  }
  try{
    await sql`SELECT kvrn_resend_suppress_marketing(${eventId},${suppression.email},${suppression.reason})`
    return json({ok:true,action:'suppression_recorded'})
  }catch{
    // Return 503 for provider retry with the SAME signed event ID.
    // Do not leak addresses or message contents in logs or responses.
    return json({error:'Could not persist suppression; retry required.'},503)
  }
}
