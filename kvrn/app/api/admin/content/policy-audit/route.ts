/** Admin-only, read-only CMS drift report. No raw policy/customer text exposed. */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {sql} from '@/lib/db'
import {cmsContentEnabled} from '@/lib/content-public'
import {inspectPublishedContent,type PublishedContentAuditRow} from '@/lib/content-policy-audit'
export const dynamic = 'force-dynamic'
const headers={'Cache-Control':'no-store'}
export async function GET(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 try{
   const rows=await sql`
     SELECT e.entity_id,e.entity_type,e.published_at,v.snapshot,v.published_by
       FROM content_entities e
       JOIN content_versions v ON v.entity_type=e.entity_type AND v.entity_id=e.entity_id AND v.version_no=e.published_version_no
      WHERE e.status='published' AND e.entity_type IN ('policy','faq')
      ORDER BY e.entity_type,e.entity_id
   `
   return NextResponse.json({cmsPublicEnabled:cmsContentEnabled(),audit:inspectPublishedContent(rows as unknown as PublishedContentAuditRow[])},{headers})
 }catch{return NextResponse.json({error:'CMS audit is unavailable. No assumptions were made.'},{status:503,headers})}
}
