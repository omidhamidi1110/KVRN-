/** Authenticated, same-origin, confirmation-required support email suppression.
 * Does not send messages, export contacts or allow re-enrollment.
 */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {suppressMarketingEmailFromSupport} from '@/lib/marketing-subscribers'
export const dynamic='force-dynamic'
const HEADERS={'Cache-Control':'no-store'}
export async function POST(req:NextRequest){
  const {error}=await requireAdmin(req)
  if(error)return error
  const body=await readAdminMutationJson(req,1024)
  if(!body.ok)return NextResponse.json({error:'Invalid or unauthorized request.'},{status:body.status,headers:HEADERS})
  const input=body.value
  if(!input||typeof input!=='object'||Array.isArray(input))return NextResponse.json({error:'Invalid request.'},{status:400,headers:HEADERS})
  const value=input as Record<string,unknown>
  if(Object.keys(value).some(k=>!['email','confirmed'].includes(k)) || value.confirmed!==true || typeof value.email!=='string'){
    return NextResponse.json({error:'A confirmed support opt-out and email are required.'},{status:400,headers:HEADERS})
  }
  try{
    await suppressMarketingEmailFromSupport(value.email)
    return NextResponse.json({ok:true,providerReconciliationPending:true},{headers:HEADERS})
  }catch(e){
    return NextResponse.json({error:'Unable to save suppression; do not assume this address was blocked.'},{status:503,headers:HEADERS})
  }
}
