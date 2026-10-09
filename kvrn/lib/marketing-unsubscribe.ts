/** Opaque, tamper-evident link to unsubscribe a known KVRN marketing contact.
 * Only KVRN server-side send generation may mint these. It never contains an email.
 * Replays only reassert a suppression; no automatic re-subscription exists here.
 */
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN=/^v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/
function secret():string|null{
  const value=process.env.MARKETING_UNSUBSCRIBE_SECRET??''
  return value.length>=32?value:null
}
async function key():Promise<CryptoKey>{
  const value=secret()
  if(!value)throw Error('MARKETING_UNSUBSCRIBE_NOT_CONFIGURED')
  return crypto.subtle.importKey('raw',new TextEncoder().encode(value),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])
}
export async function signMarketingUnsubscribe(subscriberId:string):Promise<string>{
  if(!ID.test(subscriberId))throw Error('INVALID_SUBSCRIBER_ID')
  const id=subscriberId.toLowerCase()
  const payload=`KVRN-MARKETING-UNSUBSCRIBE:v1:${id}`
  const mac=await crypto.subtle.sign('HMAC',await key(),new TextEncoder().encode(payload))
  return `v1.${id}.${Buffer.from(mac).toString('base64url')}`
}
export async function verifyMarketingUnsubscribe(token:string):Promise<string|null>{
  if(!secret()||token.length>160)return null
  const match=TOKEN.exec(token)
  if(!match||!ID.test(match[1]))return null
  try{
    const id=match[1].toLowerCase(), signature=Buffer.from(match[2],'base64url')
    if(signature.length!==32)return null
    const signed=`KVRN-MARKETING-UNSUBSCRIBE:v1:${id}`
    const ok=await crypto.subtle.verify('HMAC',await key(),signature,new TextEncoder().encode(signed))
    return ok?id:null
  }catch{return null}
}
