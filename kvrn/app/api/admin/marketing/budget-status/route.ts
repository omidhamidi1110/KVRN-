import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {getMarketingBudgetStatus} from '@/lib/marketing-budget-status'
export const dynamic='force-dynamic'
export async function GET(req:NextRequest){
 const {error}=await requireAdmin(req)
 if(error)return error
 try{return NextResponse.json({budget:await getMarketingBudgetStatus()},
  {headers:{'Cache-Control':'private, no-store'}})}
 catch{return NextResponse.json({error:'Marketing budget cannot be verified; no send is authorized.'},
  {status:503,headers:{'Cache-Control':'private, no-store'}})}
}
