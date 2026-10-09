import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {storeCreditReadiness} from '@/lib/store-credit-readiness'
import {isCreditIssuanceOwner} from '@/lib/store-credit-return-issuance'
export const dynamic='force-dynamic'
export async function GET(req:NextRequest){
 const {identity,error}=await requireAdmin(req);if(error)return error
 const readiness=await storeCreditReadiness()
 return NextResponse.json({...readiness,issuanceAvailable:readiness.status==='foundation-only'&&process.env.STORE_CREDIT_ISSUANCE_ENABLED==='true'&&isCreditIssuanceOwner(identity.email)},{headers:{'Cache-Control':'no-store'}})
}
