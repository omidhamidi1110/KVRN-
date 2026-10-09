/** Internal recipient staging is not sending permission. Never expose contacts. */
import {sql} from '@/lib/db'
import {validateAudiencePreviewId} from './marketing-audience-preview'
import {validSnapshotRequestKey} from './marketing-audience-snapshot'

export type StagedDeliverySummary={
  id:string;snapshotId:string;state:'staged'|'cancelled';memberCount:number;createdAt:string
  dispatchAuthorized:false;warnings:string[]
}
export async function stagePrivateDelivery(snapshotId:string,requestKey:string):Promise<string>{
 if(!validateAudiencePreviewId(snapshotId)||!validSnapshotRequestKey(requestKey))throw Error('INVALID_STAGING_INPUT')
 const rows=await sql`SELECT kvrn_marketing_stage_delivery_plan(${snapshotId}::uuid,${requestKey}) AS id`
 if(rows.length!==1||!validateAudiencePreviewId(rows[0]?.id))throw Error('STAGING_FAILED')
 return String(rows[0].id)
}
export async function cancelStagedDelivery(planId:string):Promise<boolean>{
 if(!validateAudiencePreviewId(planId))throw Error('INVALID_STAGING_INPUT')
 const rows=await sql`SELECT kvrn_marketing_cancel_staged_delivery(${planId}::uuid) AS cancelled`
 return rows[0]?.cancelled===true
}
export async function listStagedDeliveries():Promise<StagedDeliverySummary[]>{
 const rows=await sql`SELECT p.id,p.snapshot_id,p.state,p.created_at,
   (SELECT COUNT(*)::int FROM marketing_staged_delivery_items i WHERE i.plan_id=p.id) AS members
   FROM marketing_staged_delivery_plans p ORDER BY p.created_at DESC LIMIT 30`
 return rows.map(r=>{
   const members=Number(r.members)
   if(!Number.isSafeInteger(members)||members<1||members>50)throw Error('STAGED_RECIPIENT_COUNT_INTEGRITY')
   if(r.state!=='staged'&&r.state!=='cancelled')throw Error('STAGED_STATE_INTEGRITY')
   return {id:String(r.id),snapshotId:String(r.snapshot_id),state:r.state,memberCount:members,
    createdAt:new Date(r.created_at).toISOString(),dispatchAuthorized:false as const,
    warnings:[
     'Staged only: no provider send queue, message bodies or customer contact details are produced.',
     'Current consent, recipient jurisdiction, quiet hours, owner approval, verified price and atomic budget must all be rechecked.',
    ]}
 })
}
