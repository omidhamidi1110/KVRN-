/** KVRN Resend webhook signature verification and suppression extraction.
 * This pure module never reaches providers, DB, or logs personal information.
 * Verify signature on RAW request body before parsing payload.
 * Resend uses Svix headers: svix-id/timestamp/signature and whsec_ keys.
 */
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ID=/^[A-Za-z0-9_-]{8,150}$/
const B64=/^[A-Za-z0-9+/=_-]{20,120}$/
const MAX_AGE_SECONDS=300

function b64bytes(value:string):Uint8Array|null{
  try{
    if(!B64.test(value))return null
    const normalized=value.replace(/-/g,'+').replace(/_/g,'/')
    const data=atob(normalized)
    return Uint8Array.from(data, ch=>ch.charCodeAt(0))
  }catch{return null}
}

export async function verifyResendWebhook(payload:string,headers:Headers,secrets:string|readonly string[],now=Date.now()):Promise<string|null>{
  const id=headers.get('svix-id')??''
  const ts=headers.get('svix-timestamp')??''
  const signature=headers.get('svix-signature')??''
  if(!ID.test(id)||!/^\d{10}$/.test(ts)||signature.length>1024)return null
  const stamp=Number(ts)
  if(!Number.isSafeInteger(stamp)||Math.abs(now/1000-stamp)>MAX_AGE_SECONDS)return null
  const candidates=Array.isArray(secrets)?secrets:[secrets]
  // Provider signature-secret rotation can temporarily sign with both keys.
  // Only operator-configured signing secrets are accepted; never infer one.
  if(candidates.length<1||candidates.length>2)return null
  try{
    const signed=new TextEncoder().encode(`${id}.${ts}.${payload}`)
    const signatures=signature.split(/\s+/).filter(s=>s.startsWith('v1,'))
      .map(s=>b64bytes(s.slice(3))).filter((b):b is Uint8Array=>b?.length===32)
    if(!signatures.length)return null
    for(const candidate of candidates){
      if(typeof candidate!=='string'||!candidate.startsWith('whsec_')||candidate.length<24)continue
      const keyData=b64bytes(candidate.slice(6))
      if(!keyData||keyData.length<16)continue
      const key=await crypto.subtle.importKey('raw',keyData as unknown as BufferSource,{name:'HMAC',hash:'SHA-256'},false,['verify'])
      for(const bytes of signatures){
        if(await crypto.subtle.verify('HMAC',key,bytes as unknown as BufferSource,signed as unknown as BufferSource))return id
      }
    }
  }catch{/* fail closed */}
  return null
}

export type ResendSuppression=Readonly<{email:string,reason:'contact_unsubscribed'|'email_complaint'|'permanent_bounce'|'email_suppressed'}>
export function extractResendSuppression(event:unknown):ResendSuppression|null{
  if(!event||typeof event!=='object'||Array.isArray(event))return null
  const obj=event as Record<string,unknown>
  if(typeof obj.type!=='string'||!obj.data||typeof obj.data!=='object'||Array.isArray(obj.data))return null
  const data=obj.data as Record<string,unknown>
  let rawEmail:string|null=null
  let reason:ResendSuppression['reason']|null=null
  if(obj.type==='contact.updated' && data.unsubscribed===true){
    reason='contact_unsubscribed'
    if(typeof data.email==='string')rawEmail=data.email
  }else if(obj.type==='email.complained' || obj.type==='email.suppressed' || obj.type==='email.bounced'){
    const to=data.to
    if(Array.isArray(to)&&to.length===1&&typeof to[0]==='string')rawEmail=to[0]
    // Provider may report temporary bounces; never permanently block those.
    if(obj.type==='email.complained')reason='email_complaint'
    if(obj.type==='email.suppressed')reason='email_suppressed'
    if(obj.type==='email.bounced' && data.bounce && typeof data.bounce==='object' &&
      (data.bounce as Record<string,unknown>).type==='Permanent')reason='permanent_bounce'
  }
  if(!rawEmail||!reason)return null
  const email=rawEmail.trim().toLowerCase()
  if(email.length>254||!EMAIL.test(email))return null
  return {email,reason}
}
