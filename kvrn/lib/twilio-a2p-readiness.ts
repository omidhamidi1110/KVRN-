/** Server-private, read-only Twilio A2P 10DLC registration status.
 * Real Twilio GET when explicitly enabled by owner; never registers campaigns,
 * changes service opt-outs or authorizes recipient messaging.
 * Official endpoint: /v1/Services/{MG}/Compliance/Usa2p/{QE}.
 */
import {readBoundedProviderJson} from './marketing-provider-permission'
const AC=/^AC[0-9a-fA-F]{32}$/
const MG=/^MG[0-9a-fA-F]{32}$/
const QE=/^QE[0-9a-fA-F]{32}$/
const KEY=/^SK[0-9a-fA-F]{32}$/
const STATUSES=new Set(['PENDING','IN_PROGRESS','FAILED','VERIFIED'])
export type TwilioA2pReadiness={asOf:string;campaignStatus:'PENDING'|'IN_PROGRESS'|'FAILED'|'VERIFIED';
 campaignVerified:boolean;smsMarketingSendingAuthorized:false;
 serviceRegistrationMatched:true;warnings:string[]}
export function interpretTwilioA2pResponse(raw:Record<string,unknown>,refs:{accountSid:string;serviceSid:string;campaignSid:string}):TwilioA2pReadiness{
 if(raw.account_sid!==refs.accountSid||raw.messaging_service_sid!==refs.serviceSid||raw.sid!==refs.campaignSid||
  typeof raw.campaign_status!=='string'||!STATUSES.has(raw.campaign_status))throw Error('TWILIO_A2P_UNVERIFIED_RESPONSE')
 const campaignStatus=raw.campaign_status as TwilioA2pReadiness['campaignStatus']
 return {asOf:new Date().toISOString(),campaignStatus,campaignVerified:campaignStatus==='VERIFIED',
  smsMarketingSendingAuthorized:false,serviceRegistrationMatched:true,warnings:[
   'A2P campaign verification does not verify an individual recipient consent, opt-out, reassignment, jurisdiction or daily budget.',
   'Twilio Advanced Opt-Out blocked numbers are not queryable via its normal REST API. Local STOP logs and external compliance checks remain required.',
   'No sending, consent upload, re-opt-in, provider configuration or registration changes are performed by this read-only check.'
  ]}
}
export async function readTwilioA2pReadiness():Promise<TwilioA2pReadiness>{
 if(process.env.TWILIO_A2P_READINESS_ENABLED!=='true')throw Error('TWILIO_A2P_READINESS_DISABLED')
 const accountSid=process.env.TWILIO_ACCOUNT_SID??''
 const serviceSid=process.env.TWILIO_MESSAGING_SERVICE_SID??''
 const campaignSid=process.env.TWILIO_A2P_CAMPAIGN_SID??''
 const key=process.env.TWILIO_API_KEY??''
 const secret=process.env.TWILIO_API_SECRET??''
 if(!AC.test(accountSid)||!MG.test(serviceSid)||!QE.test(campaignSid)||!KEY.test(key)||secret.length<16||secret.length>256)
  throw Error('TWILIO_A2P_CREDENTIALS_UNAVAILABLE')
 const url=`https://messaging.twilio.com/v1/Services/${serviceSid}/Compliance/Usa2p/${campaignSid}`
 let result:Record<string,unknown>|null=null
 try{
  const res=await fetch(url,{method:'GET',headers:{Authorization:'Basic '+Buffer.from(key+':'+secret).toString('base64'),Accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'})
  result=await readBoundedProviderJson(res,24_576)
 }catch{}
 if(!result)throw Error('TWILIO_A2P_PROVIDER_UNAVAILABLE')
 return interpretTwilioA2pResponse(result,{accountSid,serviceSid,campaignSid})
}
