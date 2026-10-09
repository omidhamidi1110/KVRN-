/** Server-only email ownership proof for future store-credit checkout.
 * Never trust a typed checkout email as proof of account ownership.
 * Session and challenge tokens are random, opaque and stored only as hashes.
 * No provider call occurs unless explicitly enabled; redemption remains OFF.
 */
import {sql} from './db'
import {normalizeCreditAccountEmail,deriveStoreCreditAccountKey} from './store-credit-identity'
import {getEmailProvider} from './resend-adapter'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX=/^[a-f0-9]{64}$/
export const CREDIT_SESSION_COOKIE='__Host-kvrn_credit_identity'
export const CREDIT_SESSION_COOKIE_DEV='kvrn_credit_identity_dev'
export const CREDIT_IDENTITY_GENERIC_MESSAGE='If this address is eligible, a verification email will arrive shortly.'
const utf8=new TextEncoder()

export function creditIdentityConfigured(env:Record<string,string|undefined>=process.env):boolean{
 return env.STORE_CREDIT_IDENTITY_EMAIL_ENABLED==='true'&&
  typeof env.STORE_CREDIT_ACCOUNT_PEPPER==='string'&&env.STORE_CREDIT_ACCOUNT_PEPPER.length>=32&&
  typeof env.RESEND_API_KEY==='string'&&env.RESEND_API_KEY.length>=8&&
  typeof env.STORE_CREDIT_IDENTITY_FROM==='string'&&
  /^[A-Za-z0-9 ._-]{1,64}\s*<[a-z0-9._%+-]+@kvrn\.shop>$/i.test(env.STORE_CREDIT_IDENTITY_FROM)
}
export function tokenHex():string{
 const b=new Uint8Array(32);crypto.getRandomValues(b)
 return Array.from(b,v=>v.toString(16).padStart(2,'0')).join('')
}
export async function hashCreditToken(t:string):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',utf8.encode(t))
 return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')
}
export function parseChallengeToken(raw:unknown):{id:string;secret:string}|null{
 if(typeof raw!=='string'||raw.length!==101)return null
 const [id,secret,...extra]=raw.split('.')
 return !extra.length&&UUID.test(id)&&HEX.test(secret)?{id,secret}:null
}
export function parseSessionToken(raw:unknown):string|null{
 return typeof raw==='string'&&HEX.test(raw)?raw:null
}
export function creditRequestOriginAllowed(origin:string|null,siteOrigin:string,secFetchSite:string|null):boolean{
 if(!origin || secFetchSite==='cross-site')return false
 try{
  const expected=new URL(siteOrigin),present=new URL(origin)
  return expected.origin===present.origin && (expected.protocol==='https:'||
   (expected.hostname==='localhost'&&expected.protocol==='http:'))
 }catch{return false}
}
export function creditIdentityCookieName(production:boolean):string{
 return production?CREDIT_SESSION_COOKIE:CREDIT_SESSION_COOKIE_DEV
}

export async function requestCreditIdentityEmail(email:unknown,siteOrigin:string):Promise<void>{
 if(!creditIdentityConfigured())throw Error('CREDIT_IDENTITY_DISABLED')
 const normalized=normalizeCreditAccountEmail(email as string)
 const accountKey=await deriveStoreCreditAccountKey(normalized,process.env.STORE_CREDIT_ACCOUNT_PEPPER!)
 // Rate by account HMAC as well as IP: a single attacker must not spam an
 // individual's inbox using different IP addresses. All responses generic.
 const allowed=await sql`SELECT public_api_rate_allow('credit_identity_email',${accountKey},3,3600)::boolean AS ok`
 if(allowed.length!==1||allowed[0]?.ok!==true)return
 const secret=tokenHex()
 const digest=await hashCreditToken(secret)
 const rows=await sql`INSERT INTO store_credit_identity_challenges(account_key,token_sha256)
   VALUES(${accountKey},${digest}) RETURNING id::text AS id`
 if(rows.length!==1||!UUID.test(String(rows[0].id)))throw Error('CREDIT_IDENTITY_CHALLENGE_NOT_CREATED')
 // Link fragment never goes to a server or third-party Referer. Browser uses a
 // same-origin POST to exchange the challenge for an HttpOnly cookie.
 const link=`${siteOrigin}/store-credit/verify#token=${rows[0].id}.${secret}`
 const r=await getEmailProvider().send({
  from:process.env.STORE_CREDIT_IDENTITY_FROM!,replyTo:'support@kvrn.shop',to:normalized,
  subject:'Verify your KVRN store credit',
  html:`<p>Use this one-time link to verify your email address and view your KVRN store credit.</p>`+
   `<p><a href="${link}">Verify my email</a></p>`+
   `<p>This link expires after 10 minutes. If you did not request it, ignore this email.</p>`,
 })
 if(!r.ok)throw Error('CREDIT_IDENTITY_EMAIL_NOT_ACCEPTED')
}
export async function redeemCreditIdentityToken(raw:unknown):Promise<string|null>{
 if(!creditIdentityConfigured())return null
 const parsed=parseChallengeToken(raw)
 if(!parsed)return null
 const session=tokenHex()
 const [challengeDigest,sessionDigest]=await Promise.all([hashCreditToken(parsed.secret),hashCreditToken(session)])
 const rows=await sql`SELECT kvrn_credit_redeem_identity_challenge(
   ${parsed.id}::uuid,${challengeDigest},${sessionDigest}) AS redeemed`
 return rows.length===1&&rows[0]?.redeemed===true?session:null
}
export async function resolveVerifiedCreditAccount(rawCookie:unknown,checkoutEmail?:string):Promise<string|null>{
 if(!creditIdentityConfigured())return null
 const token=parseSessionToken(rawCookie)
 if(!token)return null
 const digest=await hashCreditToken(token)
 const rows=await sql`SELECT kvrn_credit_verified_account_key(${digest}) AS account_key`
 const key=rows[0]?.account_key
 if(rows.length!==1||typeof key!=='string'||!HEX.test(key))return null
 if(checkoutEmail!==undefined){
  const candidate=await deriveStoreCreditAccountKey(checkoutEmail,process.env.STORE_CREDIT_ACCOUNT_PEPPER!)
  // The browser's verified identity must be EXACTLY the checkout email.
  // HMAC key comparison does not expose raw email to the DB lookup.
  if(candidate!==key)return null
 }
 return key
}
export async function readVerifiedCreditBalance(rawCookie:unknown):Promise<{
 availableCents:number;outstandingCents:number;heldCents:number}|null>{
 const accountKey=await resolveVerifiedCreditAccount(rawCookie)
 if(!accountKey)return null
 const rows=await sql`SELECT a.id::text AS account_id,
  COALESCE(SUM(CASE WHEN l.event_type='issue' THEN l.amount_cents ELSE 0 END),0)::text AS issued,
  COALESCE(SUM(CASE WHEN l.event_type='capture' THEN l.amount_cents ELSE 0 END),0)::text AS captured,
  COALESCE(SUM(CASE WHEN l.event_type='hold' THEN l.amount_cents
    WHEN l.event_type IN ('capture','release') THEN -l.amount_cents ELSE 0 END),0)::text AS held
  FROM store_credit_accounts a LEFT JOIN store_credit_ledger l ON l.account_id=a.id
  WHERE a.account_key=${accountKey} GROUP BY a.id`
 if(rows.length===0)return {availableCents:0,outstandingCents:0,heldCents:0}
 if(rows.length!==1)throw Error('CREDIT_IDENTITY_DUPLICATE_ACCOUNTS')
 const cents=(v:unknown)=>{
  if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v)||!Number.isSafeInteger(Number(v)))
   throw Error('CREDIT_IDENTITY_INVALID_LEDGER_AMOUNT')
  return BigInt(v)
 }
 const issued=cents(rows[0].issued),captured=cents(rows[0].captured),held=cents(rows[0].held)
 if(captured>issued||held>issued-captured)throw Error('CREDIT_IDENTITY_UNBALANCED_LEDGER')
 const outstanding=issued-captured,available=outstanding-held
 if(outstanding>BigInt(Number.MAX_SAFE_INTEGER)||available>BigInt(Number.MAX_SAFE_INTEGER))
  throw Error('CREDIT_IDENTITY_AMOUNT_OVERFLOW')
 return {availableCents:Number(available),outstandingCents:Number(outstanding),heldCents:Number(held)}
}
export async function revokeCreditIdentitySession(rawCookie:unknown):Promise<void>{
 const token=parseSessionToken(rawCookie)
 if(!token)return
 const digest=await hashCreditToken(token)
 await sql`SELECT kvrn_credit_revoke_identity_session(${digest})`
}
