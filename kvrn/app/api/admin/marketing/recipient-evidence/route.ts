/** Owner-reviewed, per-recipient EMAIL staging evidence. Does not send. */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {isConfiguredMarketingOwner} from '@/lib/marketing-owner-approval'
import {recordReviewedEmailRecipientEvidence,validRecipientEvidenceReview,listReviewedEmailAudience} from '@/lib/marketing-email-recipient-evidence'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers})
export async function POST(req:NextRequest){
 if(process.env.MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED!=='true')
   return reply({error:'Email recipient evidence is disabled.'},404)
 const {identity,error}=await requireAdmin(req)
 if(error)return error
 if(!isConfiguredMarketingOwner(identity.email,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
   return reply({error:'Owner authorization required.'},403)
 const p=await readAdminMutationJson(req,1200)
 if(!p.ok)return reply({error:'Invalid or unauthorized request.'},p.status)
 if(!validRecipientEvidenceReview(p.value))return reply({error:'Recipient legal review missing or invalid.'},400)
 try{return reply(await recordReviewedEmailRecipientEvidence(p.value,identity.email),201)}
 catch{return reply({error:'Evidence rejected: live provider permission, legal review, pricing, consent, quiet-hours, or plan status requires verification.'},409)}
}

export async function GET(req:NextRequest){
 const {identity,error}=await requireAdmin(req)
 if(error)return error
 if(!isConfiguredMarketingOwner(identity.email,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
   return reply({error:'Owner authorization required.'},403)
 const planId=new URL(req.url).searchParams.get('planId')??''
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(planId))
   return reply({error:'Invalid plan reference.'},400)
 try{return reply({planId,recipients:await listReviewedEmailAudience(planId,identity.email),sendingEnabled:false})}
 catch{return reply({error:'Recipient evidence overview unavailable.'},503)}
}
