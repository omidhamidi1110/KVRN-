
import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { readAdminMutationJson } from '@/lib/admin-mutation-safety'
import { sql } from '@/lib/db'
import { validateCreatorReview, scoreCreatorReview, creatorAffiliateOutreachDraft, allowedCreatorAction, CREATOR_TRANSITIONS } from '@/lib/ai/integrations/creator-recruiting'

export const dynamic = 'force-dynamic'
const fail=(message:string,status=400)=>NextResponse.json({error:message},{status})
const UUID=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  try{
    const [prospects,activity]=await Promise.all([
      sql`SELECT id::text, platform_handle, status, evidence, do_not_contact, affiliate_id::text, next_followup_at, last_contact_at, created_at, updated_at
          FROM ai_creator_prospects WHERE platform='tiktok' ORDER BY created_at DESC LIMIT 300`,
      sql`SELECT t.id::text, t.prospect_id::text, t.direction, t.channel, t.content_summary, t.outcome, t.occurred_at
          FROM ai_creator_touchpoints t JOIN ai_creator_prospects p ON p.id=t.prospect_id
          WHERE p.platform='tiktok' ORDER BY t.occurred_at DESC LIMIT 150`,
    ])
    return NextResponse.json({prospects,activity,source:'owner_reviewed_first_party',version:1},{headers:{'Cache-Control':'no-store'}})
  }catch{return fail('Creator records are unavailable. Confirm migration 036 is applied.',503)}
}

export async function POST(req:NextRequest){
  const {identity,error}=await requireAdmin(req);if(error)return error
  const parsed=await readAdminMutationJson(req,5000)
  if(!parsed.ok)return fail('Invalid or unauthorized request.',parsed.status)
  let review:ReturnType<typeof validateCreatorReview>
  try{review=validateCreatorReview(parsed.value)}catch(e){return fail(e instanceof Error?e.message:'Invalid creator profile.')}
  const calc=scoreCreatorReview(review)
  const evidence={...review,sourceType:'owner_observed',source:'manual_owner_review',reviewedAt:new Date().toISOString(),reviewer:identity.email,
    preliminaryScore:calc.score,reviewStatus:calc.label,outboundSent:false,scoreDisclaimer:'Subjective screening score, not verified sales or engagement.'}
  try{
    const rows=await sql`WITH created AS (
       INSERT INTO ai_creator_prospects(platform,platform_handle,status,fit_score,evidence)
       VALUES ('tiktok',${review.handle},'discovered',${review.fitRating===null?null:review.fitRating/5},${JSON.stringify(evidence)}::jsonb)
       ON CONFLICT(platform,platform_handle) DO NOTHING RETURNING id::text,platform_handle,status,evidence
      ), audit AS (
       INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
       SELECT ${identity.email},'creator_added','ai_creator_prospect',id,'{"outboundSent":false}'::jsonb FROM created RETURNING 1
      ) SELECT * FROM created`
    if(!rows[0])return fail('Creator already exists. Open its existing record instead.',409)
    return NextResponse.json({prospect:rows[0]},{status:201})
  }catch{return fail('Unable to save creator.',500)}
}

export async function PATCH(req:NextRequest){
  const {identity,error}=await requireAdmin(req);if(error)return error
  const parsed=await readAdminMutationJson(req,5000)
  if(!parsed.ok)return fail('Invalid or unauthorized request.',parsed.status)
  const b=parsed.value as Record<string,unknown>|null
  const id=typeof b?.id==='string'?b.id:''
  const action=typeof b?.action==='string'?b.action:''
  if(!UUID.test(id)||!['qualify','prepare_draft','approve_draft','mark_contacted','record_reply','mark_applied','mark_onboarded','decline','reject','do_not_contact','link_affiliate','update_review'].includes(action))return fail('Unknown action or creator.')
  if(action==='update_review'){
    let review:ReturnType<typeof validateCreatorReview>
    try{review=validateCreatorReview(b?.review)}catch(e){return fail(e instanceof Error?e.message:'Invalid creator review.')}
    const scores=scoreCreatorReview(review)
    try{
      const updated=await sql`WITH changed AS (
        UPDATE ai_creator_prospects SET
          status=CASE WHEN ${scores.label}='needs_review' THEN 'discovered' ELSE status END,
          fit_score=${review.fitRating===null?null:review.fitRating/5},
          evidence=evidence || ${JSON.stringify({...review,reviewStatus:scores.label,
            preliminaryScore:scores.score,reviewer:identity.email,reviewedAt:new Date().toISOString(),
            source:'manual_owner_review',sourceType:'owner_observed'})}::jsonb
        WHERE id=${id}::uuid AND platform='tiktok' AND platform_handle=${review.handle} AND NOT do_not_contact
          AND status IN ('discovered','qualified')
        RETURNING id::text,status
      ), audit AS (
        INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
        SELECT ${identity.email},'creator_review_updated','ai_creator_prospect',id,
          ${JSON.stringify({scores:scores.score,quality:scores.label,outboundSent:false})}::jsonb FROM changed RETURNING 1
      ) SELECT * FROM changed`
      if(!updated[0])return fail('Review update requires a matching unsuppressed discovered or qualified creator.',409)
      return NextResponse.json({ok:true,reviewUpdated:true})
    }catch{return fail('Could not update creator review.',500)}
  }
  // Only link an independently verified, active canonical affiliate identity.
  if(action==='link_affiliate'){
    const affiliateId=typeof b?.affiliateId==='string'?b.affiliateId:''
    if(!UUID.test(affiliateId))return fail('A real affiliate UUID is required.')
    try{
      const updated=await sql`WITH checked AS (
        SELECT a.id FROM affiliates a WHERE a.id=${affiliateId}::uuid AND a.status='active'
        AND EXISTS(SELECT 1 FROM affiliate_profiles ap WHERE ap.affiliate_id=a.id AND ap.program_status='active')
      ), changed AS (
        UPDATE ai_creator_prospects SET affiliate_id=${affiliateId}::uuid
        WHERE id=${id}::uuid AND status='applied' AND platform='tiktok' AND affiliate_id IS NULL AND NOT do_not_contact
        AND EXISTS(SELECT 1 FROM checked)
        AND NOT EXISTS(SELECT 1 FROM ai_creator_prospects other WHERE other.affiliate_id=${affiliateId}::uuid AND other.id<>${id}::uuid)
        RETURNING id::text,status
      ), audit AS (
        INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
        SELECT ${identity.email},'creator_linked_approved_affiliate','ai_creator_prospect',id,
               ${JSON.stringify({affiliateId,outboundSent:false})}::jsonb FROM changed RETURNING 1
      ) SELECT * FROM changed`
      if(!updated[0])return fail('Only an applied, unsuppressed creator can link to a real active affiliate profile.',409)
      return NextResponse.json({ok:true,linked:true})
    }catch{return fail('Could not verify and link affiliate.',500)}
  }
  const outcome=typeof b?.outcome==='string'?b.outcome.trim():''
  if(outcome.length>500)return fail('Note exceeds 500 characters.')
  if(action==='record_reply' && outcome.length<2)return fail('Briefly summarize the actual creator reply.')
  if(action==='mark_contacted' && outcome.length<2)return fail('Record the channel used for your manual contact.')
  const followup=typeof b?.nextFollowupAt==='string' && /^\d{4}-\d\d-\d\d$/.test(b.nextFollowupAt)?b.nextFollowupAt:null
  try{
    const found=await sql`SELECT id::text,status,do_not_contact,evidence,affiliate_id::text,platform_handle FROM ai_creator_prospects WHERE id=${id}::uuid AND platform='tiktok' LIMIT 1`
    const old=found[0]
    if(!old)return fail('Creator not found.',404)
    const evidence=(old.evidence??{}) as Record<string,unknown>
    const outreach=(evidence.outreach??{}) as Record<string,unknown>
    const reviewed=evidence.reviewStatus==='reviewed'
    const approved=Boolean(outreach.approvedAt)
    if(action==='mark_onboarded' && !old.affiliate_id)return fail('Link a verified active affiliate first.',409)
    if(!allowedCreatorAction(String(old.status),action,Boolean(old.do_not_contact),reviewed,approved))return fail('This transition is not allowed. Review its status, ratings, or suppression.',409)
    let nextStatus=String(old.status)
    let updateEvidence:Record<string,unknown>|null=null
    if(action==='do_not_contact')nextStatus='do_not_contact'
    else if(action==='prepare_draft'){
      const draft=creatorAffiliateOutreachDraft(String(old.platform_handle))
      updateEvidence={outreach:{draft,preparedAt:new Date().toISOString(),approvedAt:null,approvedBy:null,sentAt:null,channel:null}}
    }else if(action==='approve_draft'){
      if(typeof outreach.draft!=='string'||!outreach.draft.trim())return fail('Create a draft before approving it.',409)
      nextStatus='contact_ready'
      updateEvidence={outreach:{...outreach,approvedAt:new Date().toISOString(),approvedBy:identity.email}}
    }else if(action==='mark_contacted'){
      nextStatus='contacted'
      updateEvidence={outreach:{...outreach,sentAt:new Date().toISOString(),channel:outcome}}
    }else if(action in CREATOR_TRANSITIONS)nextStatus=CREATOR_TRANSITIONS[action as keyof typeof CREATOR_TRANSITIONS].to
    // Concurrency-safe conditional updates. DNC is permanent and blocks all other actions.
    const nextEvidence=updateEvidence?JSON.stringify(updateEvidence):'{}'
    const rows=await sql`WITH changed AS (
       UPDATE ai_creator_prospects SET status=${nextStatus},do_not_contact=CASE WHEN ${action}='do_not_contact' THEN TRUE ELSE do_not_contact END,
       evidence=evidence||${nextEvidence}::jsonb,
       last_contact_at=CASE WHEN ${action}='mark_contacted' THEN NOW() ELSE last_contact_at END,
       next_followup_at=CASE WHEN ${action}='mark_contacted' THEN COALESCE(${followup}::date::timestamptz, NOW()+INTERVAL '7 days') WHEN ${action} IN ('record_reply','decline','do_not_contact','mark_onboarded') THEN NULL ELSE next_followup_at END
       WHERE id=${id}::uuid AND status=${String(old.status)} AND do_not_contact=FALSE AND platform='tiktok'
         AND (${action}!='approve_draft' OR evidence->'outreach'->>'draft' IS NOT NULL)
       RETURNING id::text,status,do_not_contact
      ), log AS (
       INSERT INTO ai_creator_touchpoints(prospect_id,direction,channel,content_summary,outcome)
       SELECT id::uuid,'internal','owner_review',LEFT(${action+' '+outcome},1000),${action} FROM changed RETURNING 1
      ), audit AS (
       INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
       SELECT ${identity.email},${'creator_'+action},'ai_creator_prospect',id,${JSON.stringify({from:old.status,to:nextStatus,outboundSent:false})}::jsonb FROM changed RETURNING 1
      ) SELECT * FROM changed`
    if(!rows[0])return fail('Creator record changed. Refresh and retry.',409)
    return NextResponse.json({ok:true,prospect:rows[0],outboundSent:false})
  }catch{return fail('Unable to update creator. No message was sent.',500)}
}
