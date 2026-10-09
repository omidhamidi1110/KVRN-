import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {createCopyTemplate,editCopyTemplate,listCopyTemplates,transitionCopyTemplate,validateCopyTemplate} from '@/lib/marketing-copy-templates'
export const dynamic='force-dynamic'
const h={'Cache-Control':'private, no-store, max-age=0'}
const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:h})
export async function GET(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 try{return reply({templates:await listCopyTemplates(),sendEnabled:false})}
 catch{return reply({error:'Templates unavailable or data integrity invalid.'},503)}
}
export async function POST(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 const parsed=await readAdminMutationJson(req,12000)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized JSON request.'},parsed.status)
 if(!validateCopyTemplate(parsed.value))return reply({error:'Invalid template copy.'},400)
 try{return reply({id:await createCopyTemplate(parsed.value),sendEnabled:false},201)}
 catch{return reply({error:'Unable to create template; schema may be unavailable.'},409)}
}
export async function PATCH(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 const parsed=await readAdminMutationJson(req,13000)
 if(!parsed.ok)return reply({error:'Invalid or unauthorized JSON request.'},parsed.status)
 const p=parsed.value
 if(!p||typeof p!=='object'||Array.isArray(p))return reply({error:'Invalid request.'},400)
 const d=p as Record<string,unknown>
 if(Object.keys(d).some(k=>!['id','expectedVersion','input','target'].includes(k))||typeof d.id!=='string'||!Number.isSafeInteger(d.expectedVersion)||Number(d.expectedVersion)<1)
   return reply({error:'Invalid version or template ID.'},400)
 try{
  if('input' in d && !('target' in d)){
   if(!validateCopyTemplate(d.input))return reply({error:'Invalid copy.'},400)
   return reply({version:await editCopyTemplate(d.id,Number(d.expectedVersion),d.input),sendEnabled:false})
  }
  if(!('input' in d)&&['ready','draft','archived'].includes(String(d.target))){
   return reply({version:await transitionCopyTemplate(d.id,Number(d.expectedVersion),d.target as 'ready'|'draft'|'archived'),sendEnabled:false})
  }
  return reply({error:'Exactly one template edit or state transition is required.'},400)
 }catch{return reply({error:'Template version conflict, immutable channel, or backend unavailable.'},409)}
}
