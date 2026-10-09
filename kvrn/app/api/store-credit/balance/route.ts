import {creditRedemptionEnabled} from '@/lib/store-credit-checkout-redemption'
import {type NextRequest,NextResponse} from 'next/server'
import {creditIdentityConfigured,creditIdentityCookieName,readVerifiedCreditBalance} from '@/lib/store-credit-customer-identity'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store'}
export async function GET(req:NextRequest){
 if(!creditIdentityConfigured())return NextResponse.json({error:'Not enabled.'},{status:404,headers})
 try{
  const token=req.cookies.get(creditIdentityCookieName(process.env.NODE_ENV==='production'))?.value
  const balance=await readVerifiedCreditBalance(token)
  if(!balance)return NextResponse.json({error:'Verify email first.',redemptionEnabled:creditRedemptionEnabled()},{status:401,headers})
  return NextResponse.json({currency:'usd',...balance,redemptionEnabled:creditRedemptionEnabled()},{headers})
 }catch{return NextResponse.json({error:'Balance unavailable.'},{status:503,headers})}
}
