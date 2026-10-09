/** RFC 8058 List-Unsubscribe-Post route.
 * GET/HEAD and link-scanners are read-only; a valid email-client POST uses the
 * same canonical suppression writer as the public confirmation form.
 * No re-enrollment, contact lookup response, marketing send, or provider writes.
 */
import {type NextRequest,NextResponse} from 'next/server'
import {readLimitedText} from '@/lib/limited-json-request'
import {verifyMarketingUnsubscribe} from '@/lib/marketing-unsubscribe'
import {validMarketingOneClickBody} from '@/lib/marketing-one-click-unsubscribe'
import {revokeMarketingSubscriberById} from '@/lib/marketing-subscribers'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}
const reply=(status:number)=>new NextResponse(null,{status,headers})
export async function POST(req:NextRequest){
 // The one-click sender is permitted to omit Origin. Authorization derives only
 // from the server-signed token, not from caller-supplied form fields.
 const token=req.nextUrl.searchParams.get('token')??''
 if(req.nextUrl.searchParams.size!==1||token.length>160||!/^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token))return reply(400)
 const input=await readLimitedText(req,128)
 if(!input.ok||!validMarketingOneClickBody(req.headers.get('content-type'),input.value))return reply(400)
 const subscriberId=await verifyMarketingUnsubscribe(token)
 if(!subscriberId)return reply(400)
 try{
  await revokeMarketingSubscriberById(subscriberId)
  return reply(204)
 }catch{
  // Never return 2xx when a suppression write failed. Clients may retry this
  // POST; the same signed id revokes idempotently, never creates consent.
  return reply(503)
 }
}
export async function GET(){return reply(405)}
export async function HEAD(){return reply(405)}
