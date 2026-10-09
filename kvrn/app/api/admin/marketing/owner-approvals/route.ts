import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {getOwnerApprovals,recordOwnerApproval,revokeOwnerApproval,validateOwnerApprovalInput,isConfiguredMarketingOwner} from '@/lib/marketing-owner-approval'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers})
async function authorized(req:NextRequest){
 const auth=await requireAdmin(req)
 if(auth.error)return {error:auth.error,email:null}
 if(!isConfiguredMarketingOwner(auth.identity.email,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
  return {error:reply({error:'Owner permission required.'},403),email:null}
 return {error:null,email:auth.identity.email}
}
export async function GET(req:NextRequest){
 const auth=await authorized(req);if(auth.error)return auth.error
 try{return reply({approvals:await getOwnerApprovals(),canSend:false})}
 catch{return reply({error:'Approval schema unavailable or integrity check failed.'},503)}
}
export async function POST(req:NextRequest){
 const auth=await authorized(req);if(auth.error)return auth.error
 const parsed=await readAdminMutationJson(req,1024)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized request.'},parsed.status)
 if(!validateOwnerApprovalInput(parsed.value))return reply({error:'Invalid approval details.'},400)
 try{return reply({id:await recordOwnerApproval(parsed.value,auth.email!),canSend:false},201)}
 catch{return reply({error:'Approval refused: disabled, stale, duplicate or missing budget evidence.'},409)}
}
export async function DELETE(req:NextRequest){
 const auth=await authorized(req);if(auth.error)return auth.error
 const parsed=await readAdminMutationJson(req,1024)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized request.'},parsed.status)
 const p=parsed.value
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==1||typeof (p as any).id!=='string')return reply({error:'Invalid approval reference.'},400)
 try{return reply({revoked:await revokeOwnerApproval((p as {id:string}).id,auth.email!),canSend:false})}
 catch{return reply({error:'Revocation refused or unavailable.'},409)}
}
