import {NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {listEditorialPlans,planEditorialCampaign,cancelEditorialPlan,validateEditorialTime,isValidEditorialVersion} from '@/lib/marketing-editorial-calendar'
import {validateAudiencePreviewId} from '@/lib/marketing-audience-preview'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const response=(body:unknown,status=200)=>NextResponse.json(body,{status,headers})
export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  try{return response({plans:await listEditorialPlans(),deliveryEnabled:false,kind:'editorial_only'})}
  catch{return response({error:'Calendar unavailable. Migration 048 may not be applied.'},503)}
}
export async function POST(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  const read=await readAdminMutationJson(req,2000)
  if(!read.ok)return response({error:'Invalid or unauthorized request.'},read.status)
  const body=read.value as Record<string,unknown>
  const plannedFor=validateEditorialTime(body?.plannedFor)
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['campaignId','version','plannedFor'].includes(k))||
     !validateAudiencePreviewId(body.campaignId)||!isValidEditorialVersion(body.version)||!plannedFor)
     return response({error:'Invalid campaign, version or UTC time.'},400)
  try{return response({id:await planEditorialCampaign(body.campaignId,body.version,plannedFor),deliveryEnabled:false},201)}
  catch{return response({error:'Unable to add editorial plan. Check campaign version, reviewed copy or an existing plan.'},409)}
}
export async function DELETE(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  const read=await readAdminMutationJson(req,1000)
  if(!read.ok)return response({error:'Invalid or unauthorized request.'},read.status)
  const body=read.value as Record<string,unknown>
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!validateAudiencePreviewId(body.id))return response({error:'Invalid plan ID.'},400)
  try{return response({cancelled:await cancelEditorialPlan(body.id)})}
  catch{return response({error:'Unable to cancel editorial plan.'},503)}
}
