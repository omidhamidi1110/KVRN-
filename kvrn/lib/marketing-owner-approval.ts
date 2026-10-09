/** Explicit owner approval is distinct from editorial review, consent and actual dispatch. */
import {sql} from '@/lib/db'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY=/^[A-Za-z0-9:_-]{12,120}$/
const HEX=/^[0-9a-f]{64}$/
export function isConfiguredMarketingOwner(identityEmail:string,configuredEmail:string):boolean{
 if(!configuredEmail||!identityEmail)return false
 return identityEmail.trim().toLowerCase()===configuredEmail.trim().toLowerCase()
}
async function hashOwnerIdentity(identityEmail:string):Promise<string>{
 const v=identityEmail.trim().toLowerCase()
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`kvrn:marketing-owner:v1:${v}`))
 return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('')
}
export type OwnerApprovalInput={planId:string;requestKey:string;maximumCostMicros:number}
export function validateOwnerApprovalInput(input:unknown):input is OwnerApprovalInput {
 if(!input||typeof input!=='object'||Array.isArray(input))return false
 const v=input as Record<string,unknown>
 return Object.keys(v).length===3&&Object.keys(v).every(k=>['planId','requestKey','maximumCostMicros'].includes(k))
  &&typeof v.planId==='string'&&UUID.test(v.planId)&&typeof v.requestKey==='string'&&KEY.test(v.requestKey)
  &&typeof v.maximumCostMicros==='number'&&Number.isSafeInteger(v.maximumCostMicros)
  &&v.maximumCostMicros>=1&&v.maximumCostMicros<=2_000_000
}
export async function recordOwnerApproval(input:OwnerApprovalInput,ownerIdentity:string):Promise<string>{
 if(process.env.MARKETING_OWNER_APPROVAL_WRITES_ENABLED!=='true')throw Error('OWNER_APPROVAL_DISABLED')
 if(!isConfiguredMarketingOwner(ownerIdentity,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))throw Error('OWNER_IDENTITY_UNVERIFIED')
 if(!validateOwnerApprovalInput(input))throw Error('OWNER_APPROVAL_BAD_REQUEST')
 const hash=await hashOwnerIdentity(ownerIdentity)
 if(!HEX.test(hash))throw Error('OWNER_HASH_FAILED')
 const r=await sql`SELECT kvrn_marketing_owner_approve(
   ${input.planId}::uuid,${hash},${input.requestKey},${input.maximumCostMicros}
 )::text AS id`
 if(r.length!==1||!UUID.test(String(r[0]?.id)))throw Error('OWNER_APPROVAL_DB_ERROR')
 return String(r[0].id)
}
export async function revokeOwnerApproval(id:string,ownerIdentity:string):Promise<boolean>{
 if(process.env.MARKETING_OWNER_APPROVAL_WRITES_ENABLED!=='true')throw Error('OWNER_APPROVAL_DISABLED')
 if(!isConfiguredMarketingOwner(ownerIdentity,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))throw Error('OWNER_IDENTITY_UNVERIFIED')
 if(!UUID.test(id))throw Error('OWNER_APPROVAL_BAD_REQUEST')
 const r=await sql`SELECT kvrn_marketing_owner_revoke(${id}::uuid) AS revoked`
 return r.length===1&&r[0].revoked===true
}
export type ApprovalSummary={id:string;planId:string;state:'approved'|'revoked';recipientCount:number;maximumCostMicros:number;expiresAt:string;dispatchEnabled:false}
export async function getOwnerApprovals():Promise<ApprovalSummary[]>{
 const r=await sql`SELECT id,plan_id,state,recipient_count,maximum_cost_micros::text AS maximum_cost_micros,expires_at
   FROM marketing_owner_approvals ORDER BY approved_at DESC LIMIT 30`
 return r.map(x=>{
  const maximumCostMicros=Number(x.maximum_cost_micros),recipientCount=Number(x.recipient_count)
  if(!UUID.test(String(x.id))||!UUID.test(String(x.plan_id))||!['approved','revoked'].includes(x.state)
    ||!Number.isSafeInteger(maximumCostMicros)||maximumCostMicros<1||maximumCostMicros>2_000_000
    ||!Number.isSafeInteger(recipientCount)||recipientCount<1||recipientCount>50)throw Error('OWNER_APPROVAL_INTEGRITY')
  return {id:String(x.id),planId:String(x.plan_id),state:x.state,recipientCount,maximumCostMicros,
   expiresAt:new Date(x.expires_at).toISOString(),dispatchEnabled:false as const}
 })
}
