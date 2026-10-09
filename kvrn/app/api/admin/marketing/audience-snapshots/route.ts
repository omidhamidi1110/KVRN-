import {NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {createPrivateAudienceSnapshot,listPrivateAudienceSnapshots,validSnapshotRequestKey,validSnapshotVersion} from '@/lib/marketing-audience-snapshot'
import {validateAudiencePreviewId} from '@/lib/marketing-audience-preview'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers})
export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  try{return reply({snapshots:await listPrivateAudienceSnapshots(),sendingEnabled:false})}
  catch{return reply({error:'Private audience snapshots unavailable; migration 049 may not be applied.'},503)}
}
export async function POST(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  const parsed=await readAdminMutationJson(req,2000)
  if(!parsed.ok)return reply({error:'Invalid or unauthorized JSON request.'},parsed.status)
  const input=parsed.value as Record<string,unknown>
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['campaignId','version','requestKey'].includes(k))
    ||!validateAudiencePreviewId(input.campaignId)||!validSnapshotVersion(input.version)||!validSnapshotRequestKey(input.requestKey))
      return reply({error:'Invalid audience snapshot reference or request key.'},400)
  try{return reply({id:await createPrivateAudienceSnapshot(input.campaignId,input.version,input.requestKey),sendingEnabled:false},201)}
  catch{return reply({error:'Unable to freeze audience. Review status, consent evidence or recipient cap failed.'},409)}
}
