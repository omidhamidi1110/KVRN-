/** Manual owner-signed, exact-audience email campaign. Disabled until owner
 * deliberately authorizes staging QA and independently approves release.
 */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {isConfiguredMarketingOwner} from '@/lib/marketing-owner-approval'
import {ownerApprovedExecutionAllowed} from '@/lib/marketing-owner-execution-gate'
import {previewApprovedEmailCampaign,executeOwnerApprovedEmailCampaign,validApprovedCampaignExecution} from '@/lib/marketing-owner-campaign-execution'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers})
async function owner(req:NextRequest){
 const auth=await requireAdmin(req)
 if(auth.error)return {email:null,error:auth.error}
 if(!isConfiguredMarketingOwner(auth.identity.email,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
  return {email:null,error:reply({error:'Owner authorization required.'},403)}
 return {email:auth.identity.email,error:null}
}
export async function GET(req:NextRequest){
 const auth=await owner(req);if(auth.error)return auth.error
 const params=req.nextUrl.searchParams
 const planId=params.get('planId')??''
 if([...params.keys()].some(k=>k!=='planId')||params.getAll('planId').length!==1||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(planId))
  return reply({error:'Invalid plan.'},400)
 try{return reply(await previewApprovedEmailCampaign(planId,auth.email!))}
 catch{return reply({error:'Reviewed campaign unavailable.'},503)}
}
export async function POST(req:NextRequest){
 // A separate batch execution release switch is required beyond one-recipient.
 if(!ownerApprovedExecutionAllowed(process.env)||process.env.MARKETING_OWNER_CAMPAIGN_EXECUTION_ENABLED!=='true')
  return reply({error:'Campaign execution unavailable.'},404)
 const auth=await owner(req);if(auth.error)return auth.error
 const input=await readAdminMutationJson(req,900)
 if(!input.ok)return reply({error:'Invalid or unauthorized request.'},input.status)
 if(!validApprovedCampaignExecution(input.value))return reply({error:'Exact audience approval required.'},400)
 try{return reply(await executeOwnerApprovedEmailCampaign(input.value,auth.email!))}
 catch{return reply({error:'Audience changed or current evidence expired. Refresh preview. Never retry a claimed recipient.',canRetry:false},409)}
}
