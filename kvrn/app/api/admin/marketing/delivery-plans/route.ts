import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {listStagedDeliveries,stagePrivateDelivery,cancelStagedDelivery} from '@/lib/marketing-staged-delivery'
import {validateAudiencePreviewId} from '@/lib/marketing-audience-preview'
import {validSnapshotRequestKey} from '@/lib/marketing-audience-snapshot'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers})
export async function GET(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 try{return reply({plans:await listStagedDeliveries(),sendingEnabled:false})}
 catch{return reply({error:'Staged delivery plans unavailable; staging migration 050 may be missing.'},503)}
}
export async function POST(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 const parsed=await readAdminMutationJson(req,2000)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized JSON request.'},parsed.status)
 const input=parsed.value
 if(!input||typeof input!=='object'||Array.isArray(input))return reply({error:'Invalid staging input.'},400)
 const d=input as Record<string,unknown>
 if(Object.keys(d).some(k=>!['snapshotId','requestKey'].includes(k)) ||
    !validateAudiencePreviewId(d.snapshotId)||!validSnapshotRequestKey(d.requestKey))return reply({error:'Invalid snapshot or key.'},400)
 try{return reply({id:await stagePrivateDelivery(d.snapshotId,d.requestKey),sendingEnabled:false},201)}
 catch{return reply({error:'Unable to stage: campaign may be stale or recipient consent may have changed.'},409)}
}
export async function DELETE(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 const parsed=await readAdminMutationJson(req,1200)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized JSON request.'},parsed.status)
 const input=parsed.value
 if(!input||typeof input!=='object'||Array.isArray(input))return reply({error:'Invalid cancellation input.'},400)
 const d=input as Record<string,unknown>
 if(Object.keys(d).some(k=>k!=='id')||!validateAudiencePreviewId(d.id))return reply({error:'Invalid plan ID.'},400)
 try{return reply({cancelled:await cancelStagedDelivery(d.id),sendingEnabled:false})}
 catch{return reply({error:'Unable to cancel staged delivery plan.'},409)}
}
