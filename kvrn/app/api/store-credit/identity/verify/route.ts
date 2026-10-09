import {type NextRequest,NextResponse} from 'next/server'
import {sql} from '@/lib/db'
import {getSiteOrigin} from '@/lib/site-origin'
import {allowPublicApiRequest} from '@/lib/public-api-rate-limit'
import {readLimitedJson} from '@/lib/limited-json-request'
import {creditIdentityConfigured,creditRequestOriginAllowed,creditIdentityCookieName,redeemCreditIdentityToken} from '@/lib/store-credit-customer-identity'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'no-store'}
export async function POST(req:NextRequest){
 if(!creditIdentityConfigured())return NextResponse.json({error:'Not enabled.'},{status:404,headers})
 const origin=getSiteOrigin()
 if(!origin||!creditRequestOriginAllowed(req.headers.get('origin'),origin,req.headers.get('sec-fetch-site')))
  return NextResponse.json({error:'Invalid origin.'},{status:403,headers})
 try{
  if(!await allowPublicApiRequest(sql,{bucket:'credit_identity_verify',headers:req.headers,limit:15,windowSeconds:3600}))
   return NextResponse.json({error:'Too many attempts.'},{status:429,headers})
 }catch{return NextResponse.json({error:'Service unavailable.'},{status:503,headers})}
 const body=await readLimitedJson(req,1024)
 if(!body.ok||!body.value||typeof body.value!=='object'||Array.isArray(body.value))
  return NextResponse.json({error:'Invalid request.'},{status:400,headers})
 let session:string|null=null
 try{session=await redeemCreditIdentityToken((body.value as Record<string,unknown>).token)}catch{}
 if(!session)return NextResponse.json({error:'Verification link invalid or expired.'},{status:400,headers})
 const response=NextResponse.json({ok:true},{headers})
 const production=process.env.NODE_ENV==='production'
 response.cookies.set(creditIdentityCookieName(production),session,{httpOnly:true,secure:production,
  sameSite:'strict',path:'/',maxAge:1800})
 return response
}
