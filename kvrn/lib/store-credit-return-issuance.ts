/** Owner-reviewed discretionary store credit issuance from verified return data.
 * Never expose raw account HMAC, order email, delivery evidence or owner identity.
 * Staging only until return/Stripe accounting and verified carrier proof are audited.
 */
import {sql} from '@/lib/db'
import {deriveStoreCreditAccountKey} from './store-credit-identity'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY=/^[A-Za-z0-9:_-]{12,120}$/
export type IssueCreditRequest={returnId:string;requestedCents:number;deliveredAt:string;deliveryEvidenceRef:string;requestKey:string;confirmInspectedReturn:boolean}
export function validateCreditIssueRequest(v:unknown):v is IssueCreditRequest{
 if(!v||typeof v!=='object'||Array.isArray(v))return false
 const o=v as Record<string,unknown>
 const keys=['returnId','requestedCents','deliveredAt','deliveryEvidenceRef','requestKey','confirmInspectedReturn']
 if(Object.keys(o).length!==keys.length||Object.keys(o).some(k=>!keys.includes(k)))return false
 if(typeof o.returnId!=='string'||!UUID.test(o.returnId)||!Number.isSafeInteger(o.requestedCents)||!(Number(o.requestedCents)>0))return false
 if(typeof o.requestKey!=='string'||!KEY.test(o.requestKey)||o.confirmInspectedReturn!==true)return false
 if(typeof o.deliveryEvidenceRef!=='string'||o.deliveryEvidenceRef.trim().length<8||o.deliveryEvidenceRef.length>120)return false
 if(typeof o.deliveredAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(o.deliveredAt))return false
 const date=Date.parse(o.deliveredAt)
 return Number.isFinite(date)&&date<=Date.now()
}
async function digest(value:string):Promise<string>{
 const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))
 return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,'0')).join('')
}
export function isCreditIssuanceOwner(identityEmail:string):boolean{
 const owner=process.env.STORE_CREDIT_ISSUANCE_OWNER_EMAIL??''
 return owner.length>0 && identityEmail.trim().toLowerCase()===owner.trim().toLowerCase()
}
export async function issueCreditForInspectedReturn(req:IssueCreditRequest,identityEmail:string):Promise<string>{
 if(process.env.STORE_CREDIT_ISSUANCE_ENABLED!=='true')throw Error('CREDIT_ISSUANCE_DISABLED')
 if(!isCreditIssuanceOwner(identityEmail))throw Error('CREDIT_ISSUANCE_OWNER_REQUIRED')
 if(!validateCreditIssueRequest(req))throw Error('INVALID_CREDIT_ISSUE_INPUT')
 const pepper=process.env.STORE_CREDIT_ACCOUNT_PEPPER??''
 if(pepper.length<32)throw Error('CREDIT_ISSUANCE_IDENTITY_PEPPER_MISSING')
 // Fetch ONLY authoritative order identity; no caller-supplied email or account key.
 // The database procedure independently locks and verifies the return/order again.
 const orders=await sql`SELECT o.customer_email FROM order_returns r JOIN orders o ON o.id=r.order_id
   WHERE r.id=${req.returnId}::uuid LIMIT 1`
 if(orders.length!==1||typeof orders[0].customer_email!=='string')throw Error('CREDIT_ORDER_EMAIL_MISSING')
 const accountKey=await deriveStoreCreditAccountKey(orders[0].customer_email,pepper)
 const evidenceHash=await digest('kvrn:delivery-proof:v1:'+req.deliveryEvidenceRef.trim())
 const actorHash=await digest('kvrn:credit-reviewer:v1:'+identityEmail.trim().toLowerCase())
 const r=await sql`SELECT kvrn_credit_issue_inspected_return(
   ${req.returnId}::uuid, ${accountKey}, ${req.requestedCents},
   ${req.deliveredAt}::timestamptz, ${evidenceHash}, ${actorHash}, ${req.requestKey}
 )::text AS event_id`
 if(r.length!==1||!/^[1-9][0-9]*$/.test(String(r[0]?.event_id)))throw Error('CREDIT_ISSUE_RESULT_INVALID')
 return String(r[0].event_id)
}
