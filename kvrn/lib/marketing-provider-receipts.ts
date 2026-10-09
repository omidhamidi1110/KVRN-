/**
 * Marketing provider transport acknowledgements are NOT delivery evidence.
 * A 2xx response means only that the provider processed the HTTP request.
 * No automatic retry, budget settlement or consent grant can result from it.
 *
 * Internal/server-only; intentionally not exposed as an API or cron job.
 */
import {sql} from '@/lib/db'

export type MarketingProvider='twilio'|'resend'
export type ProvisionalProviderResult='acknowledged'|'rejected'|'uncertain'
export type ProvisionalReceiptInput={
 attemptId:string
 provider:MarketingProvider
 result:ProvisionalProviderResult
 referenceDigest:string|null
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST=/^[0-9a-f]{64}$/
const SID=/^(?:SM|MM)[0-9a-f]{32}$/i
const RESEND_ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/

export function validProviderReference(provider:MarketingProvider,raw:unknown):raw is string{
 return typeof raw==='string'&&raw.length<=128&&(
   provider==='twilio'?SID.test(raw):provider==='resend'&&RESEND_ID.test(raw)
 )
}

/** HMAC, not a bare SHA256 of a public provider identifier. */
export async function digestProviderReference(provider:MarketingProvider,reference:string,pepper:string):Promise<string>{
 if(!validProviderReference(provider,reference)||typeof pepper!=='string'||pepper.length<32)
   throw Error('INVALID_PROVIDER_REFERENCE_OR_PEPPER')
 const enc=new TextEncoder()
 const key=await crypto.subtle.importKey('raw',enc.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign'])
 const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(`kvrn:marketing:${provider}:${reference}`)))
 return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')
}
export function validateProvisionalReceipt(raw:unknown):raw is ProvisionalReceiptInput{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false
 const r=raw as Record<string,unknown>
 if(Object.keys(r).length!==4||Object.keys(r).some(k=>!['attemptId','provider','result','referenceDigest'].includes(k)))return false
 if(typeof r.attemptId!=='string'||!UUID.test(r.attemptId)||!['twilio','resend'].includes(String(r.provider))||
    !['acknowledged','rejected','uncertain'].includes(String(r.result)))return false
 if(r.referenceDigest!==null&&(typeof r.referenceDigest!=='string'||!DIGEST.test(r.referenceDigest)))return false
 if(r.result==='acknowledged'&&r.referenceDigest===null)return false
 if(r.result!=='acknowledged'&&r.referenceDigest!==null)return false
 return true
}

/** Offline mapping of *immediate* provider REST results; never final outcome. */
export function classifyProviderResponse(provider:MarketingProvider,httpStatus:unknown,providerReference:unknown):{
 result:ProvisionalProviderResult;reference:string|null;verifiedFinalOutcome:false;canRetry:false
}{
 if(typeof httpStatus!=='number'||!Number.isSafeInteger(httpStatus)||httpStatus<100||httpStatus>599)
  return {result:'uncertain',reference:null,verifiedFinalOutcome:false,canRetry:false}
 if(httpStatus>=200&&httpStatus<300&&validProviderReference(provider,providerReference))
  return {result:'acknowledged',reference:providerReference,verifiedFinalOutcome:false,canRetry:false}
 // 4xx and 5xx cannot prove the request was never accepted; require signed provider
 // evidence before classifying a definite non-submission or refunding reserved cost.
 if(httpStatus>=400&&httpStatus<600)
  return {result:'rejected',reference:null,verifiedFinalOutcome:false,canRetry:false}
 return {result:'uncertain',reference:null,verifiedFinalOutcome:false,canRetry:false}
}

/** Recording is gated and cannot authorize a send; DB separately correlates claim/provider. */
export async function recordProvisionalProviderReceipt(input:ProvisionalReceiptInput):Promise<string>{
 if(process.env.MARKETING_PROVIDER_RECEIPTS_ENABLED!=='true')throw Error('PROVIDER_RECEIPTS_DISABLED')
 if(!validateProvisionalReceipt(input))throw Error('INVALID_PROVISIONAL_RECEIPT')
 const r=await sql`SELECT kvrn_marketing_record_provisional_receipt(
   ${input.attemptId}::uuid,${input.provider},${input.result},${input.referenceDigest})::text AS id`
 if(r.length!==1||!UUID.test(String(r[0].id)))throw Error('PROVISIONAL_RECEIPT_WRITE_FAILED')
 return String(r[0].id)
}
