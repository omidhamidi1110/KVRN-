/**
 * Claimed, one-recipient provider transport. NO public route, cron caller, or
 * automatic retry. A caller must first run the atomic claim (migration 058).
 * Provider HTTP responses are provisional, NOT signed/final delivery evidence.
 *
 * The trusted resolver MUST read the claimed attempt from the database, verify
 * exact recipient/copy association, refreshed opt-outs, country/timezone rules,
 * provider topic status, owner approval and budget. Never resolve user JSON.
 */
import {evaluateRecipientDeliveryWindow,type RecipientDeliveryWindow} from './marketing-delivery-window'
import {digestProviderReference,validProviderReference,type MarketingProvider,type ProvisionalProviderResult} from './marketing-provider-receipts'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX=/^[0-9a-f]{64}$/
const EMAIL=/^[^\s@<>]{1,64}@[^\s@<>]{1,254}$/
const E164=/^\+[1-9][0-9]{7,14}$/
export type ClaimedTransportEnvelope={
 attemptId:string;provider:MarketingProvider;channel:'sms'|'email';
 recipient:string;finalBody:string;approvedMessageSha256:string;
 recipientWindow:RecipientDeliveryWindow;
 /** Id used only for independently signed List-Unsubscribe, never sent in Admin JSON. */
 emailSubscriberId?:string;
 subject?:string;
 unsubscribeUrl?:string;
 /** Trusted independent checks have already succeeded just before resolving. */
 suppressionFresh:boolean;consentFresh:boolean;ownerApprovalFresh:boolean;budgetReservationFresh:boolean;
}
export type ProviderOneShotResponse={ok:boolean;providerMessageId?:string}
export interface TrustedClaimedTransportDependencies {
 /** Must throw on any DB/provider read error, stale record, or revoked consent. */
 resolveClaimedEnvelope:(attemptId:string)=>Promise<ClaimedTransportEnvelope>
 /** Called only with vetted transport payload; must NOT automatically retry. */
 sendOneSms:(recipient:string,body:string)=>Promise<ProviderOneShotResponse>
 /** List-Unsubscribe must also be present in message body. */
 sendOneEmail:(recipient:string,subject:string,html:string,unsubscribeUrl:string)=>Promise<ProviderOneShotResponse>
 /** Must persist the provisional result against a correlated DB claim. */
 recordProvisional:(receipt:{attemptId:string;provider:MarketingProvider;result:ProvisionalProviderResult;referenceDigest:string|null})=>Promise<void>
 utcNow:()=>Date
}
export type ClaimedTransportResult={kind:'outcome_unknown';canRetry:false;receiptRecorded:boolean;networkAttempted:boolean}
const blocked:ClaimedTransportResult={kind:'outcome_unknown',canRetry:false,receiptRecorded:false,networkAttempted:false}

export async function hashFinalApprovedCopy(body:string,channel:'sms'|'email'='sms',subject?:string):Promise<string>{
 if(channel==='email'&&(!subject||subject.length>140))throw Error('EMAIL_SUBJECT_REQUIRED_FOR_APPROVAL')
 const material=channel==='email'?`KVRN-EMAIL:v1\0${subject}\0${body}`:`KVRN-SMS:v1\0${body}`
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(material))
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')
}
/** Controlled layer after the atomic DB claim. Never returns provider_accepted. */
export async function submitClaimedProviderOnce(
 attemptId:string,deps:TrustedClaimedTransportDependencies
):Promise<ClaimedTransportResult>{
 if(process.env.MARKETING_SEND_ENABLED!=='true'||process.env.MARKETING_PROVIDER_DELIVERY_ENABLED!=='true'||
    process.env.MARKETING_PROVIDER_RECEIPTS_ENABLED!=='true'||
    process.env.MARKETING_OWNER_SEND_RELEASE_ENABLED!=='true'||!UUID.test(attemptId)||
    !deps||typeof deps.resolveClaimedEnvelope!=='function'||typeof deps.recordProvisional!=='function'||
    typeof deps.sendOneSms!=='function'||typeof deps.sendOneEmail!=='function')return blocked
 let x:ClaimedTransportEnvelope
 try{x=await deps.resolveClaimedEnvelope(attemptId)}catch{return blocked}
 if(x.attemptId!==attemptId||!['sms','email'].includes(x.channel)||
    x.provider!==(x.channel==='sms'?'twilio':'resend')||
    typeof x.finalBody!=='string'||x.finalBody.length<1||x.finalBody.length>10000||
    !HEX.test(x.approvedMessageSha256)||
    !x.suppressionFresh||!x.consentFresh||!x.ownerApprovalFresh||!x.budgetReservationFresh||
    !x.recipientWindow||typeof deps.utcNow!=='function')return blocked
 try{if(!evaluateRecipientDeliveryWindow(x.recipientWindow,deps.utcNow()).allowed)return blocked}catch{return blocked}
 try{if(await hashFinalApprovedCopy(x.finalBody,x.channel,x.subject)!==x.approvedMessageSha256)return blocked}catch{return blocked}
 if(x.channel==='sms'){
   if(process.env.TWILIO_A2P_APPROVED!=='true'||process.env.TWILIO_MARKETING_SEND_ENABLED!=='true'||
      !E164.test(x.recipient)||!/^KVRN\s*[:\-—]/.test(x.finalBody)||
      !/\bReply STOP to opt out\.?\s*$/i.test(x.finalBody))return blocked
 }else{
   if(process.env.RESEND_MARKETING_SEND_ENABLED!=='true'||!EMAIL.test(x.recipient)||
      !x.subject||x.subject.length>140||!x.emailSubscriberId||!UUID.test(x.emailSubscriberId)||
      !x.unsubscribeUrl||!/^https:\/\/kvrn\.shop\/email-preferences\?token=v1\.[a-zA-Z0-9._-]{70,160}$/.test(x.unsubscribeUrl)||
      !x.finalBody.includes(x.unsubscribeUrl))return blocked
 }
 // Do not throw a transport/network error into a caller that might retry.
 // Before the network call, the DB claim has already been persisted by the
 // coordinator. Even a timeout after this line means permanently uncertain.
 let result:ProviderOneShotResponse|undefined
 try{
  result=x.channel==='sms'?await deps.sendOneSms(x.recipient,x.finalBody):
    await deps.sendOneEmail(x.recipient,x.subject!,x.finalBody,x.unsubscribeUrl!)
 }catch{}
 let classified:ProvisionalProviderResult='uncertain'
 let digest:string|null=null
 if(result?.ok===true&&validProviderReference(x.provider,result.providerMessageId)){
  try{
   const pepper=process.env.MARKETING_PROVIDER_REFERENCE_PEPPER??''
   digest=await digestProviderReference(x.provider,result.providerMessageId,pepper)
   classified='acknowledged'
  }catch{}
 }
 let recorded=false
 try{await deps.recordProvisional({attemptId,provider:x.provider,result:classified,referenceDigest:digest});recorded=true}catch{}
 return {kind:'outcome_unknown',canRetry:false,receiptRecorded:recorded,networkAttempted:true}
}
