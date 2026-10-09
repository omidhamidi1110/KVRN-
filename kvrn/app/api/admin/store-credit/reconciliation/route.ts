import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {reconcileStoreCreditLedger} from '@/lib/store-credit-reconciliation'
export const dynamic='force-dynamic'
export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req)
  if(error)return error
  try{
    return NextResponse.json(await reconcileStoreCreditLedger(),{headers:{'Cache-Control':'no-store'}})
  }catch{
    // No partial totals or database error details may leak through an Admin response.
    return NextResponse.json({status:'unavailable',transactionalOperationsEnabled:false,
      message:'Store-credit ledger could not be fully reconciled. No balances should be relied on.'},
      {status:503,headers:{'Cache-Control':'no-store'}})
  }
}
