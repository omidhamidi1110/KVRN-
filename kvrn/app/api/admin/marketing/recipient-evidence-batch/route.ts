/** Owner-only Resend contact evidence batch. Never sends messages. */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {isConfiguredMarketingOwner} from '@/lib/marketing-owner-approval'
import {validBatchEvidenceReview,prepareReviewedEmailAudienceBatch} from '@/lib/marketing-email-batch-review'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers})
export async function POST(req:NextRequest){
 if(process.env.MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED!=='true')return reply({error:'Evidence preparation unavailable.'},404)
 const {identity,error}=await requireAdmin(req)
 if(error)return error
 if(!isConfiguredMarketingOwner(identity.email,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
  return reply({error:'Owner authorization required.'},403)
 const parsed=await readAdminMutationJson(req,16000)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized JSON.'},parsed.status)
 if(!validBatchEvidenceReview(parsed.value))return reply({error:'Invalid recipient legal-review batch.'},400)
 try{return reply(await prepareReviewedEmailAudienceBatch(parsed.value,identity.email),201)}
 catch{return reply({error:'Batch evidence preparation unavailable. Nothing has been sent.'},503)}
}
