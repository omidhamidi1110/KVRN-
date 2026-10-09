/** Owner-only manual execution of precisely one previously approved recipient.
 * Off by default. Never performs unattended, recurring, bulk or retry delivery.
 */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {isConfiguredMarketingOwner} from '@/lib/marketing-owner-approval'
import {ownerApprovedExecutionAllowed,validOwnerApprovedExecutionRequest} from '@/lib/marketing-owner-execution-gate'
import {attemptTrustedMarketingDeliveryOnce} from '@/lib/marketing-server-execution'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(v:unknown,status=200)=>NextResponse.json(v,{status,headers})
export async function POST(req:NextRequest){
 // Never consult campaign data, providers or a browser body while off.
 if(!ownerApprovedExecutionAllowed(process.env))return reply({error:'Marketing delivery is disabled.'},404)
 const auth=await requireAdmin(req)
 if(auth.error)return auth.error
 if(!isConfiguredMarketingOwner(auth.identity.email,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
   return reply({error:'Owner authorization required.'},403)
 const parsed=await readAdminMutationJson(req,2400)
 if(!parsed.ok)return reply({error:'Unauthorized execution request.'},parsed.status)
 if(!validOwnerApprovedExecutionRequest(parsed.value))
   return reply({error:'Explicit one-recipient confirmation and approved claim references required.'},400)
 try{
  const result=await attemptTrustedMarketingDeliveryOnce(parsed.value.input)
  // Any provider HTTP success is provisional; never report delivery, billing
  // completion or consent as proven in the initial synchronous response.
  return reply({state:result.state,attemptId:result.attemptId??null,
    canRetry:false,costSettled:false,providerDeliveryVerified:false})
 }catch{return reply({error:'Unknown delivery outcome. Do not retry; investigate provider records.',canRetry:false},503)}
}
