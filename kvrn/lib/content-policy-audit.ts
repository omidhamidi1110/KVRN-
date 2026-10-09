/** Read-only heuristics to identify obviously stale CMS-published legal/FAQ text.
 * This is not legal advice and cannot decide that an entire policy is compliant.
 * It never modifies published content or exposes its full text to the browser.
 */
import { SEED_ACTOR } from './content-seed-actor'
export interface PublishedContentAuditRow {
  entity_id: string
  entity_type: string
  published_at: string | Date | null
  snapshot: unknown
  /** Who published the live version. The migration-030 seed actor means "placeholder, not served by the storefront". */
  published_by?: string | null
}
export interface ContentAuditIssue { entityId: string; code: string; message: string; severity?: 'review' | 'info' }
export interface ContentPolicyAudit {
  inspected: number
  /** Records the storefront would actually serve from the CMS (published by a person). */
  live: number
  /** Seed-published placeholders: stored as published, deliberately NOT served (the coded copy shows instead). */
  placeholders: string[]
  publishedAt: Record<string,string|null>
  issues: ContentAuditIssue[]
  limitations: string[]
}
const mandatory = ['privacy', 'terms', 'cookies', 'shipping-returns'] as const
const staleRules: ReadonlyArray<{ code:string; pattern:RegExp; message:string }> = [
  {code:'old_returns_email',pattern:/returns@kvrn\.shop/i,message:'Replace outdated returns@kvrn.shop contact with support@kvrn.shop after editorial approval.'},
  {code:'old_uk_legal',pattern:/\b(?:HMRC|UK GDPR|Information Commissioner(?:’|')?s Office|UK Information Commissioner|ICO)\b/i,message:'Review outdated UK-specific legal/controller references.'},
  {code:'tracking_guarantee',pattern:/\b(?:all orders include tracking|all orders (?:are|will be) tracked|tracking (?:is|will be) provided for every order)\b/i,message:'Avoid unconditional tracking guarantees; tracking is provided when available.'},
  {code:'old_returns_reply',pattern:/\brespond within 24 hours\b/i,message:'Review outdated 24-hour support response promises; draft target is 1–2 business days.'},
  {code:'unbounded_return_window',pattern:/return window is shown in your order confirmation/i,message:'Clarify the 14-day eligible discretionary store-credit return window.'},
]
const ms = (v:unknown) => {const d=new Date(String(v));return Number.isFinite(d.getTime())?d.toISOString():null}
export function inspectPublishedContent(rows:readonly PublishedContentAuditRow[]):ContentPolicyAudit {
  const publishedAt: Record<string,string|null>={}
  const issues:ContentAuditIssue[]=[]
  const placeholders:string[]=[]
  for (const r of rows) {
    const id=String(r.entity_id)
    if ((r.entity_type!=='policy'&&r.entity_type!=='faq') || id.length>60) continue
    if (r.published_by===SEED_ACTOR) { placeholders.push(id); continue }   // not served: do not lint text nobody can see
    publishedAt[id]=r.published_at ? ms(r.published_at) : null
    const text=JSON.stringify(r.snapshot??'').slice(0,200000)
    for(const rule of staleRules) if(rule.pattern.test(text))issues.push({entityId:id,code:rule.code,message:rule.message})
    if (id === 'shipping-returns' && !/14(?:-|\s+)day/i.test(text)) issues.push({entityId:id,code:'missing_return_window',message:'Confirm the 14-day discretionary store-credit return window is clearly stated.'})
    if (id === 'shipping-returns' && !/store credit/i.test(text)) issues.push({entityId:id,code:'missing_store_credit',message:'Return policy must clearly state eligible discretionary returns are for KVRN store credit.'})
  }
  for(const id of mandatory) if(!(id in publishedAt))issues.push({entityId:id,code:'no_cms_published_version',severity:'info',message:placeholders.includes(id)
    ?'Only the migration placeholder exists; the public page shows the coded copy. This is expected until a person publishes a reviewed version.'
    :'No published version found in CMS. Confirm public fallback and publication plan.'})
  return {
    inspected:Object.keys(publishedAt).length+placeholders.length,live:Object.keys(publishedAt).length,placeholders,publishedAt,issues,
    limitations:[
      'Heuristic text checks cannot establish legal compliance or provider behavior.',
      'No changes are made; the content editor requires a separate draft, preview, legal review and publish decision.',
      'Seed-published placeholders are never served by the storefront; they cannot be published unchanged (the editor refuses).',
    ],
  }
}
