/** Strict, read-only current provider-side email/topic permission. NOT an
 * independent grant of marketing consent. Local immutable consent and an
 * atomically claimed recipient must also be verified before any attempt.
 * Twilio provider opt-out/reassigned-number clearance is deliberately NOT
 * inferred from SMS subscription records or dial codes.
 */
const EMAIL=/^[^\s@<>]{1,64}@[^\s@<>]{1,254}$/
const CONTACT=/^[A-Za-z0-9_-]{6,128}$/
const TOPIC=/^[A-Za-z0-9_-]{6,128}$/
const MAX_BYTES=65536

/** Limit untrusted provider JSON while it is streaming, not after buffering it.
 * A truncated, malformed, missing-body, or oversized response is UNKNOWN => deny.
 */
export async function readBoundedProviderJson(response:Response,maxBytes=MAX_BYTES):Promise<Record<string,unknown>|null>{
 if(!response.ok||!Number.isSafeInteger(maxBytes)||maxBytes<1||!response.body)return null
 const length=response.headers.get('content-length')
 if(length!==null){
  if(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>maxBytes||!Number.isSafeInteger(Number(length)))return null
 }
 const reader=response.body.getReader()
 const chunks:Uint8Array[]=[]
 let count=0
 try{
  while(true){
   const {done,value}=await reader.read()
   if(done)break
   if(!(value instanceof Uint8Array))return null
   count+=value.byteLength
   if(count>maxBytes){await reader.cancel().catch(()=>{});return null}
   chunks.push(value)
  }
  const data=new Uint8Array(count)
  let offset=0
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length}
  const obj:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data))
  return obj&&typeof obj==='object'&&!Array.isArray(obj)?obj as Record<string,unknown>:null
 }catch{return null}
 finally{reader.releaseLock()}
}

async function readResendJson(path:string,key:string):Promise<Record<string,unknown>|null>{
 try{
  const res=await fetch(`https://api.resend.com${path}`,{
   method:'GET',headers:{Authorization:`Bearer ${key}`,'Accept':'application/json'},
   signal:AbortSignal.timeout(5000),
  })
  return await readBoundedProviderJson(res)
 }catch{return null}
}
export async function verifyMarketingProviderPermission(
 channel:'sms'|'email',recipient:string,providerContactId:string|null
):Promise<boolean>{
 if(process.env.MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED!=='true')return false
 // Twilio does not expose authoritative program-level opt-out and reassignment
 // proof through the adapter used here; don't pretend local evidence suffices.
 if(channel==='sms')return false
 if(channel!=='email'||typeof recipient!=='string'||!EMAIL.test(recipient)||
    typeof providerContactId!=='string'||!CONTACT.test(providerContactId))return false
 const key=process.env.RESEND_MARKETING_API_KEY??''
 const topic=process.env.RESEND_MARKETING_TOPIC_ID??''
 if(!key||!TOPIC.test(topic))return false
 const c=await readResendJson(`/contacts/${encodeURIComponent(providerContactId)}`,key)
 const record=(c?.contact&&typeof c.contact==='object'&&!Array.isArray(c.contact)?c.contact:c) as Record<string,unknown>|null
 if(!record||record.id!==providerContactId||record.unsubscribed!==false||
    typeof record.email!=='string'||record.email.toLowerCase()!==recipient.toLowerCase())return false
 const t=await readResendJson(`/contacts/${encodeURIComponent(providerContactId)}/topics`,key)
 if(!t||t.has_more!==false||!Array.isArray(t.data)||t.data.length>100)return false
 const matching=t.data.filter((x:any)=>x&&x.id===topic)
 return matching.length===1&&matching[0].subscription==='opt_in'
}
