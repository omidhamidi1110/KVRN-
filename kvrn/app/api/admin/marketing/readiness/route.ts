import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {MARKETING_RELEASE_GATES,MARKETING_DRAFT_CAPS} from '@/lib/marketing-suite-readiness'
import {auditStagedMarketingPlan} from '@/lib/marketing-plan-audit'
import {validateAudiencePreviewId} from '@/lib/marketing-audience-preview'
export const dynamic='force-dynamic'
export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  const planId=req.nextUrl.searchParams.get('planId')
  if(planId!==null){
    if(!validateAudiencePreviewId(planId))return NextResponse.json({error:'Invalid plan reference.'},{status:400,headers:{'Cache-Control':'private, no-store'}})
    try{return NextResponse.json({audit:await auditStagedMarketingPlan(planId),sendsEnabled:false},{headers:{'Cache-Control':'private, no-store'}})}
    catch{return NextResponse.json({error:'Audit unavailable; missing schema or inconsistent evidence.'},{status:503,headers:{'Cache-Control':'private, no-store'}})}
  }
  return NextResponse.json({sendsEnabled:false,autonomousAiEnabled:false,releaseGates:MARKETING_RELEASE_GATES,proposedLimits:MARKETING_DRAFT_CAPS},
    {headers:{'Cache-Control':'private, no-store'}})
}
