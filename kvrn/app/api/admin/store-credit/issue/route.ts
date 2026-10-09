import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {isCreditIssuanceOwner,issueCreditForInspectedReturn,validateCreditIssueRequest} from '@/lib/store-credit-return-issuance'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(v:unknown,status=200)=>NextResponse.json(v,{status,headers})
export async function POST(req:NextRequest){
 const {identity,error}=await requireAdmin(req);if(error)return error
 if(!isCreditIssuanceOwner(identity.email))return reply({error:'Owner authorization required.'},403)
 const parsed=await readAdminMutationJson(req,1024)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized request.'},parsed.status)
 if(!validateCreditIssueRequest(parsed.value))return reply({error:'Return evidence missing or invalid.'},400)
 try{return reply({creditEventId:await issueCreditForInspectedReturn(parsed.value,identity.email),redemptionEnabled:false},201)}
 catch{return reply({error:'Store-credit issuance blocked: disabled or return/payment/inspection/ledger evidence is insufficient.'},409)}
}
