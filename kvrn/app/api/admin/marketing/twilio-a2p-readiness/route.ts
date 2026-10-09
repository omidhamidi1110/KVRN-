/** No-write owner-only Twilio A2P status lookup, never permission to send. */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {isConfiguredMarketingOwner} from '@/lib/marketing-owner-approval'
import {readTwilioA2pReadiness} from '@/lib/twilio-a2p-readiness'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
export async function GET(req:NextRequest){
 const auth=await requireAdmin(req)
 if(auth.error)return auth.error
 if(!isConfiguredMarketingOwner(auth.identity.email,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))
  return NextResponse.json({error:'Owner authorization required.'},{status:403,headers})
 if(process.env.TWILIO_A2P_READINESS_ENABLED!=='true')
  return NextResponse.json({error:'Twilio readiness check disabled.'},{status:404,headers})
 if(req.nextUrl.search)return NextResponse.json({error:'No query parameters accepted.'},{status:400,headers})
 try{return NextResponse.json(await readTwilioA2pReadiness(),{headers})}
 catch{return NextResponse.json({error:'Twilio A2P status unverified. No marketing sending authorized.'},{status:503,headers})}
}
