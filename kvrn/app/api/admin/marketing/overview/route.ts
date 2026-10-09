import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {getMarketingOverview} from '@/lib/marketing-overview'
export const dynamic='force-dynamic'
export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  try{return NextResponse.json(await getMarketingOverview(),{headers:{'Cache-Control':'no-store'}})}
  catch{return NextResponse.json({error:'Marketing consent statistics unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}})}
}
