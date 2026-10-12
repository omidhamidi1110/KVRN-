
/** Optional owner-triggered, transient web-index discovery. Never scrape TikTok. */
import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {readAdminMutationJson} from '@/lib/admin-mutation-safety'
import {sql} from '@/lib/db'
import {validatedCreatorQuery} from '@/lib/ai/integrations/creator-recruiting'
import {buildBraveCreatorQuery,analyzeBraveCreatorHits} from '@/lib/ai/integrations/creator-relevance'
export const dynamic='force-dynamic'
const response=(obj:unknown,status=200)=>NextResponse.json(obj,{status,headers:{'Cache-Control':'private, no-store, max-age=0'}})
const configured=()=>process.env.BRAVE_CREATOR_SEARCH_ENABLED==='true' && Boolean(process.env.BRAVE_CREATOR_SEARCH_KEY)
function monthlyLimit():number{
  const raw=process.env.BRAVE_CREATOR_MONTHLY_CAP??'100'
  if(!/^\d{1,4}$/.test(raw))return 0
  return Math.min(1000,Number(raw))
}
export async function GET(req:NextRequest){
  const {error}=await requireAdmin(req);if(error)return error
  const cap=monthlyLimit()
  return response({provider:'Brave Search API',connected:configured(),enabled:configured() && cap>0,
    monthlyLimit:cap,notes:'Results are temporary research pointers; independently verify before saving. No TikTok scraping or automatic outreach.'})
}
export async function POST(req:NextRequest){
  const {identity,error}=await requireAdmin(req);if(error)return error
  const parsed=await readAdminMutationJson(req,1024)
  if(!parsed.ok)return response({error:'Invalid or unauthorized search request.'},parsed.status)
  const b=parsed.value as Record<string,unknown>|null
  let searchTopic:string
  try{searchTopic=validatedCreatorQuery(b?.topic)}catch(e){return response({error:e instanceof Error?e.message:'Invalid topic.'},400)}
  if(!configured() || monthlyLimit()===0)return response({error:'Web-index discovery is not connected. Use the free external search links or manually reviewed creators.',reason:'not_connected'},503)
  // Atomic on the quota row, safe across horizontally scaled Cloudflare Workers.
  // Migration 066 must be applied separately before this optional paid-provider call can run.
  try{
    const rows=await sql`
      INSERT INTO ai_creator_discovery_quota(month_utc,used_requests)
      VALUES (DATE_TRUNC('month',NOW() AT TIME ZONE 'UTC')::date,1)
      ON CONFLICT(month_utc) DO UPDATE SET used_requests=ai_creator_discovery_quota.used_requests+1,updated_at=NOW()
      WHERE ai_creator_discovery_quota.used_requests<${monthlyLimit()}
      RETURNING used_requests`
    if(!rows[0])return response({error:'The monthly search limit has been reached.',reason:'quota_reached'},429)
  }catch{return response({error:'Search quota ledger is not available. Do not enable searches until migration 066 is applied.',reason:'quota_not_ready'},503)}
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),7000)
  try{
    const query=buildBraveCreatorQuery(searchTopic)
    const url=new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q',query)
    url.searchParams.set('count','20')
    url.searchParams.set('extra_snippets','true')
    url.searchParams.set('country','US')
    const upstream=await fetch(url.toString(),{method:'GET',signal:controller.signal,cache:'no-store',headers:{
      Accept:'application/json','X-Subscription-Token':process.env.BRAVE_CREATOR_SEARCH_KEY!,
    }})
    if(!upstream.ok)return response({error:'Creator web search is temporarily unavailable.',reason:'provider_unavailable'},502)
    const payload=await upstream.json() as {web?:{results?:Array<{title?:unknown;url?:unknown;description?:unknown}>}}
    // Rank public creator leads; never auto-save them.
    const {results,diagnostics}=analyzeBraveCreatorHits(payload.web?.results??[],searchTopic)
    const providerResults=Array.isArray(payload.web?.results)?payload.web.results.length:0
    // Intentionally do not store results, queries, returned descriptions, provider payloads, or tokens.
    return response({results,providerResults,diagnostics,temporary:true,source:'Brave web index',retained:false,
      warning:'Visit original public creator profiles and verify their information independently. Search result data is not imported into KVRN.'})
  }catch{return response({error:'Search timed out or could not complete.',reason:'provider_timeout'},504)}
  finally{clearTimeout(timer);void identity}
}
