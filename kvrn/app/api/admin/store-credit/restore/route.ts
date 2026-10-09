import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {isCreditIssuanceOwner} from '@/lib/store-credit-return-issuance'
import {restoreOriginalCreditTenderForReturn,validateRestoreOriginalCreditRequest} from '@/lib/store-credit-split-return-restoration'

export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const respond=(body:unknown,status=200)=>NextResponse.json(body,{status,headers})

/** Intentionally not called by the customer return route or automatic webhook. */
export async function POST(req:NextRequest){
  const {identity,error}=await requireAdmin(req)
  if(error)return error
  if(!isCreditIssuanceOwner(identity.email))return respond({error:'Owner authorization required.'},403)
  const payload=await readAdminMutationJson(req,1024)
  if(!payload.ok)return respond({error:'Invalid or unauthorized request.'},payload.status)
  if(!validateRestoreOriginalCreditRequest(payload.value))
    return respond({error:'Original tender return evidence is incomplete or invalid.'},400)
  try{
    const creditEventId=await restoreOriginalCreditTenderForReturn(payload.value,identity.email)
    return respond({creditEventId},201)
  }catch{
    return respond({error:'Credit restoration blocked: owner/test activation or verified return, original tender, and refund evidence required.'},409)
  }
}
