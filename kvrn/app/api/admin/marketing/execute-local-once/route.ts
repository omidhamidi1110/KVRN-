/** Local, manual, one-recipient marketing transport test; NEVER deployed. */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {isConfiguredMarketingOwner} from '@/lib/marketing-owner-approval'
import {localMarketingTransportAllowed,validLocalOwnerTestRequest} from '@/lib/marketing-owner-local-send-gate'
import {attemptTrustedMarketingDeliveryOnce} from '@/lib/marketing-server-execution'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(v:unknown,status=200)=>NextResponse.json(v,{status,headers})

export async function POST(req:NextRequest){
 // Gate before auth and before reading any user input. Even an operator turning
 // on the provider flags cannot make this route send from a deployed build.
 if(!localMarketingTransportAllowed(process.env))return reply({error:'Local test sender disabled.'},404)
 const auth=await requireAdmin(req)
 if(auth.error)return auth.error
 if(!isConfiguredMarketingOwner(auth.identity.email,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
   return reply({error:'Owner authorization required.'},403)
 const parsed=await readAdminMutationJson(req,2200)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized test request.'},parsed.status)
 if(!validLocalOwnerTestRequest(parsed.value))return reply({error:'Invalid one-recipient test reference.'},400)
 try{
  const result=await attemptTrustedMarketingDeliveryOnce(parsed.value.input)
  // Never return a contact, provider raw ID, token or message body to Admin.
  return reply({state:result.state,canRetry:false,costSettled:false,
    attemptId:'attemptId' in result?result.attemptId:null})
 }catch{return reply({error:'Delivery state requires manual reconciliation.',canRetry:false},503)}
}
