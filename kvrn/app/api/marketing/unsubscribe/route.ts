/** Consent revocation needs a signed contact-specific link. GET never modifies state,
 * preventing security scanners from silently clicking an unsubscribe link.
 */
import {type NextRequest,NextResponse} from 'next/server'
import {verifyMarketingUnsubscribe} from '@/lib/marketing-unsubscribe'
import {revokeMarketingSubscriberById} from '@/lib/marketing-subscribers'
import {readLimitedText} from '@/lib/limited-json-request'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}
const go=(req:NextRequest,q:string)=>NextResponse.redirect(new URL(`/email-preferences?${q}`, process.env.NODE_ENV==='production'?'https://kvrn.shop':req.nextUrl.origin),{status:303,headers})
export async function POST(req:NextRequest){
  const origin=req.headers.get('origin')
  if(origin){try{if(new URL(origin).origin!==req.nextUrl.origin)return go(req,'error=1')}catch{return go(req,'error=1')}}
  if(!/application\/x-www-form-urlencoded(?:\s*;|\s*$)/i.test(req.headers.get('content-type')??''))return go(req,'error=1')
  const read=await readLimitedText(req,1024) // also enforces length for chunked POST
  if(!read.ok)return go(req,'error=1')
  const form=new URLSearchParams(read.value)
  const token=form.get('token')
  const id=typeof token==='string'?await verifyMarketingUnsubscribe(token):null
  if(!id)return go(req,'error=1')
  try{
    // Canonical unsubscribe must work before optional migration 044 is installed.
    await revokeMarketingSubscriberById(id)
    return go(req,'done=1')
  }catch{return go(req,'error=1')}
}
export async function GET(){return NextResponse.json({error:'Method not allowed.'},{status:405,headers})}
