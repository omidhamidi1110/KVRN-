import {NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {previewCampaignAudience,validateAudiencePreviewId} from '@/lib/marketing-audience-preview'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff'}
export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  const id=req.nextUrl.searchParams.get('campaignId')
  if(!validateAudiencePreviewId(id))return NextResponse.json({error:'Invalid campaign ID.'},{status:400,headers})
  try{return NextResponse.json(await previewCampaignAudience(id),{headers})}
  catch(e){
    const reason=e instanceof Error?e.message:''
    if(reason==='CAMPAIGN_NOT_FOUND')return NextResponse.json({error:'Campaign not found.'},{status:404,headers})
    if(reason==='CAMPAIGN_NOT_REVIEWED'||reason==='AUDIENCE_REQUIRES_VERIFIED_ORDER_CONSENT_JOIN')
      return NextResponse.json({error:'Audience preview is available only for reviewed campaigns with independently verified consent segments.'},{status:422,headers})
    // Do not leak database/provider identifiers in error bodies or logs.
    return NextResponse.json({error:'Audience evidence unavailable. Check unapplied consent migrations in staging.'},{status:503,headers})
  }
}
