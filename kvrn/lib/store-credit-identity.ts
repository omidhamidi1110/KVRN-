/** Store-credit identity derivation, server-side only.
 * Never give this key or its pepper to a browser, and do not disclose balances
 * until the checkout email is separately verified using an expiring signed link.
 */
const HEX64=/^[0-9a-f]{64}$/
export function normalizeCreditAccountEmail(email:string):string {
  if(typeof email!=='string')throw Error('INVALID_EMAIL')
  const e=email.trim().toLowerCase()
  // Do not collapse dots/plus aliases; only explicit verified checkout identity.
  if(e.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))throw Error('INVALID_EMAIL')
  return e
}
export async function deriveStoreCreditAccountKey(verifiedEmail:string,pepper:string):Promise<string>{
  const email=normalizeCreditAccountEmail(verifiedEmail)
  if(typeof pepper!=='string'||pepper.length<32)throw Error('INVALID_CREDIT_ACCOUNT_SECRET')
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`kvrn-credit-account:v1:${email}`))
  const hex=Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('')
  if(!HEX64.test(hex))throw Error('INVALID_CREDIT_ACCOUNT_KEY')
  return hex
}
