import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {getDeliveryAttemptAudit} from '@/lib/marketing-attempt-audit'
import {validateAudiencePreviewId} from '@/lib/marketing-audience-preview'
export const dynamic='force-dynamic'
export async function GET(req:NextRequest){
 const {error}=await requireAdmin(req)
 if(error)return error
 const planId=req.nextUrl.searchParams.get('planId')
 if(!validateAudiencePreviewId(planId))return NextResponse.json({error:'Invalid plan reference.'},{status:400,headers:{'Cache-Control':'no-store'}})
 try{return NextResponse.json({audit:await getDeliveryAttemptAudit(planId)},{headers:{'Cache-Control':'private, no-store'}})}
 catch{return NextResponse.json({error:'Attempt evidence unavailable; do not infer that messages were unsent.'},
  {status:503,headers:{'Cache-Control':'private, no-store'}})}
}
