import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {validateCampaignDraft,listCampaignDrafts,createCampaignDraft,editCampaignDraft,setCampaignDraftState} from '@/lib/marketing-campaign-drafts'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'no-store'}
const fail=(msg:string,status:number)=>NextResponse.json({error:msg},{status,headers})
export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  try{return NextResponse.json({drafts:await listCampaignDrafts(),sendsEnabled:false},{headers})}
  catch{return fail('Marketing drafts unavailable. Migration 038 may not be applied.',503)}
}
export async function POST(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  const read=await readAdminMutationJson(req)
  if(!read.ok)return fail('Invalid or unauthorized JSON request.',read.status)
  const input=read.value
  const v=validateCampaignDraft(input);if(!v.ok)return fail(v.error,400)
  try{return NextResponse.json({draft:await createCampaignDraft(v.value)},{status:201,headers})}
  catch{return fail('Unable to create draft.',503)}
}
export async function PATCH(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  const read=await readAdminMutationJson(req)
  if(!read.ok)return fail('Invalid or unauthorized JSON request.',read.status)
  const input=read.value as any
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.id!=='string'||!Number.isSafeInteger(input.version)||input.version<1)return fail('Invalid draft reference.',400)
  try{
    if(input.action==='edit'){
      const v=validateCampaignDraft(input.draft);if(!v.ok)return fail(v.error,400)
      await editCampaignDraft(input.id,input.version,v.value)
    }else if(['review','reopen','archive'].includes(input.action)){
      await setCampaignDraftState(input.id,input.version,input.action)
    }else return fail('Unknown action.',400)
    return NextResponse.json({ok:true},{headers})
  }catch(e:any){return fail(e?.message==='CAMPAIGN_DRAFT_CONFLICT'?'Draft changed. Refresh before editing.':'Draft operation failed.',409)}
}
