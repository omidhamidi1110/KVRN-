import {type NextRequest,NextResponse} from 'next/server'
import {getSiteOrigin} from '@/lib/site-origin'
import {creditIdentityConfigured,creditRequestOriginAllowed,creditIdentityCookieName,revokeCreditIdentitySession} from '@/lib/store-credit-customer-identity'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'no-store'}
export async function POST(req:NextRequest){
 if(!creditIdentityConfigured())return NextResponse.json({error:'Not enabled.'},{status:404,headers})
 const origin=getSiteOrigin()
 if(!origin||!creditRequestOriginAllowed(req.headers.get('origin'),origin,req.headers.get('sec-fetch-site')))
  return NextResponse.json({error:'Invalid origin.'},{status:403,headers})
 const production=process.env.NODE_ENV==='production',cookie=creditIdentityCookieName(production)
 try{await revokeCreditIdentitySession(req.cookies.get(cookie)?.value)}catch{
  return NextResponse.json({error:'Could not revoke session.'},{status:503,headers})
 }
 const response=NextResponse.json({ok:true},{headers})
 response.cookies.set(cookie,'',{httpOnly:true,secure:production,sameSite:'strict',path:'/',maxAge:0})
 return response
}
