
/** Source-of-truth referral and affiliate metrics; never create alternate commission totals. */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {sql} from '@/lib/db'
export const dynamic='force-dynamic'
export async function GET(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 try{
  const [counts,applications,linked]=await Promise.all([
   sql`SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status='discovered' AND NOT do_not_contact)::int AS needs_review,
       COUNT(*) FILTER (WHERE status IN ('qualified','contact_ready') AND NOT do_not_contact)::int AS ready,
       COUNT(*) FILTER (WHERE status='contacted')::int AS contacted,
       COUNT(*) FILTER (WHERE status='replied')::int AS replied,
       COUNT(*) FILTER (WHERE do_not_contact)::int AS suppressed,
       COUNT(*) FILTER (WHERE next_followup_at<=NOW() AND status='contacted' AND NOT do_not_contact)::int AS followups_due,
       COUNT(*) FILTER (WHERE affiliate_id IS NOT NULL)::int AS linked_affiliates
       FROM ai_creator_prospects WHERE platform='tiktok'`,
   sql`SELECT COUNT(*) FILTER(WHERE status IN ('pending','under_review','needs_info'))::int AS pending_applications,
       COUNT(*) FILTER(WHERE status='approved_onboarding')::int AS approved_applications
       FROM affiliate_applications`,
   sql`SELECT p.id::text AS prospect_id,p.platform_handle,p.affiliate_id::text,
       COUNT(DISTINCT oa.order_id)::int AS attributed_orders
       FROM ai_creator_prospects p LEFT JOIN order_affiliate_attributions oa ON oa.affiliate_id=p.affiliate_id
       WHERE p.platform='tiktok' AND p.affiliate_id IS NOT NULL
       GROUP BY p.id,p.platform_handle,p.affiliate_id LIMIT 200`,
  ])
  // Separate commission query avoids joining fanouts against orders or ledger adjustments.
  const applicantRows=await sql`
    SELECT id::text,status,social_links,created_at FROM affiliate_applications
    WHERE anonymized_at IS NULL AND social_links::text ILIKE '%tiktok.com%'
    ORDER BY created_at DESC LIMIT 30`
  const applicants=applicantRows.map(r=>({id:r.id,status:r.status,createdAt:r.created_at,
    tiktokLinks:(Array.isArray(r.social_links)?r.social_links:[]).filter((v:unknown)=>
      v!==null && typeof v==='object' && (v as {platform?:unknown}).platform==='tiktok'
      && typeof (v as {url?:unknown}).url==='string'
      && /^https:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9._]{2,24}\/?$/.test((v as {url:string}).url))
      .slice(0,3).map((v:{url:string})=>v.url)}))
    .filter(x=>x.tiktokLinks.length>0)
  const ledger=await sql`SELECT ca.affiliate_id::text AS affiliate_id,
       COALESCE(SUM(ca.adjustment_cents),0)::bigint::text AS net_commission_cents
       FROM affiliate_commission_adjustments ca
       WHERE ca.affiliate_id IN (SELECT affiliate_id FROM ai_creator_prospects WHERE affiliate_id IS NOT NULL AND platform='tiktok')
       GROUP BY ca.affiliate_id`
  const commissionMap=new Map(ledger.map(x=>[String(x.affiliate_id),String(x.net_commission_cents)]))
  return NextResponse.json({counts:counts[0],applications:applications[0],applicants,
    linked:linked.map(x=>({prospectId:x.prospect_id,handle:x.platform_handle,affiliateId:x.affiliate_id,
      attributedOrders:Number(x.attributed_orders??0),netCommissionCents:commissionMap.get(String(x.affiliate_id))??'0'})),
    disclaimer:'First-party affiliate attribution and signed commission-adjustment ledger only. No inferred creator-driven revenue, ROI, or profit.'},
    {headers:{'Cache-Control':'private,no-store'}})
 }catch{return NextResponse.json({error:'Funnel reporting unavailable; verify affiliate migrations.'},{status:503})}
}
