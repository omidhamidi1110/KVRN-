
'use client'
import {useCallback,useEffect,useMemo,useState} from 'react'
import Link from 'next/link'
import {estimateCreatorOffer,FREE_CREATOR_QUERIES,creatorSearchUrl} from '@/lib/ai/integrations/creator-recruiting'

type Tab='Overview'|'Discover'|'Prospects'|'Outreach'|'Offers & Margin'|'Results'|'Settings'
const tabs:Tab[]=['Overview','Discover','Prospects','Outreach','Offers & Margin','Results','Settings']
type Evidence={category?:string;profileUrl?:string;sampleVideoUrl?:string;notes?:string;preliminaryScore?:number;reviewStatus?:string;
  fitRating?:number;contentRating?:number;consistencyRating?:number;engagementRating?:number;
  outreach?:{draft?:string;approvedAt?:string|null;approvedBy?:string|null;sentAt?:string|null;channel?:string|null}}
type Prospect={id:string;platform_handle:string;status:string;evidence:Evidence;do_not_contact:boolean;affiliate_id:string|null;
  created_at:string;updated_at:string;last_contact_at:string|null;next_followup_at:string|null}
type Activity={id:string;prospect_id:string;direction:string;channel:string;content_summary:string;outcome:string;occurred_at:string}
type Funnel={counts?:Record<string,number>;applications?:Record<string,number>;linked?:Array<{prospectId:string;handle:string;affiliateId:string;attributedOrders:number;netCommissionCents:string}>;applicants?:Array<{id:string;status:string;createdAt:string;tiktokLinks:string[]}>;disclaimer?:string}
type SearchState={connected:boolean;enabled:boolean;monthlyLimit:number;notes?:string}
type SearchResult={title:string;url:string;snippet:string}
const categories:[string,string][]=[['streetwear','Streetwear'],['mens_fashion',"Men's fashion"],['outfits','Outfit styling'],['lifestyle','Lifestyle'],['ugc','UGC reviews'],['other','Other']]
const initialRatings={fitRating:'',contentRating:'',consistencyRating:'',engagementRating:''}
const formatDate=(s?:string|null)=>s?new Date(s).toLocaleString():'—'
const USD=(c:number)=>'$'+(c/100).toFixed(2)
const FIELD='mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-offset-2'
const BUTTON='rounded-lg bg-neutral-950 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40'
const SECOND='rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40'
const card='rounded-2xl border border-neutral-200 bg-white p-4 sm:p-6'
export function CreatorRecruitingClient(){
 const [tab,setTab]=useState<Tab>('Overview')
 const [prospects,setProspects]=useState<Prospect[]>([])
 const [activity,setActivity]=useState<Activity[]>([])
 const [funnel,setFunnel]=useState<Funnel>({})
 const [searchState,setSearchState]=useState<SearchState>({connected:false,enabled:false,monthlyLimit:0})
 const [searchTopic,setSearchTopic]=useState('streetwear outfit creator')
 const [results,setResults]=useState<SearchResult[]>([])
 const [searched,setSearched]=useState(false)
 const [selected,setSelected]=useState('')
 const [handle,setHandle]=useState('')
 const [category,setCategory]=useState('streetwear')
 const [video,setVideo]=useState('')
 const [notes,setNotes]=useState('')
 const [ratings,setRatings]=useState(initialRatings)
 const [actionNote,setActionNote]=useState('')
 const [followup,setFollowup]=useState('')
 const [affiliateLink,setAffiliateLink]=useState('')
 const [reviewTarget,setReviewTarget]=useState('')
 const [busy,setBusy]=useState(false)
 const [loading,setLoading]=useState(true)
 const [message,setMessage]=useState('')
 const [error,setError]=useState('')
 const [offer,setOffer]=useState({salePriceCents:'8000',productCostCents:'5000',couponCents:'1000',commissionRatePct:'10',paymentFeesCents:'279',merchantShippingCents:'598',returnAllowanceCents:'0',creatorIncentiveCents:'0'})
 const [filter,setFilter]=useState('all')
 const load=useCallback(async()=>{
  const [p,f,s]=await Promise.all([
   fetch('/api/admin/ai/creator-prospects',{cache:'no-store'}),
   fetch('/api/admin/ai/creator-funnel',{cache:'no-store'}),
   fetch('/api/admin/ai/creator-discovery',{cache:'no-store'}),
  ])
  const pj=await p.json();if(!p.ok)throw new Error(pj.error??'Prospects unavailable')
  setProspects(Array.isArray(pj.prospects)?pj.prospects:[])
  setActivity(Array.isArray(pj.activity)?pj.activity:[])
  if(f.ok)setFunnel(await f.json())
  if(s.ok)setSearchState(await s.json())
 },[])
 useEffect(()=>{void load().catch(e=>setError(e instanceof Error?e.message:'Load failed')).finally(()=>setLoading(false))},[load])
 const selectedProspect=useMemo(()=>prospects.find(p=>p.id===selected)??null,[prospects,selected])
 const ordered=useMemo(()=>[...prospects].filter(p=>filter==='all'||(filter==='due' ? Boolean(p.next_followup_at && new Date(p.next_followup_at).getTime()<=Date.now() && p.status==='contacted') : filter==='dnc'?p.do_not_contact:p.status===filter)).sort((a,b)=>(b.evidence?.preliminaryScore??-1)-(a.evidence?.preliminaryScore??-1)),[prospects,filter])
 const quality=useMemo(()=>prospects.filter(p=>p.status==='qualified'||p.status==='contact_ready').length,[prospects])
 const estimate=useMemo(()=>{try{return estimateCreatorOffer(Object.fromEntries(Object.entries(offer).map(([k,v])=>[k,Number(v)])) as Parameters<typeof estimateCreatorOffer>[0])}catch{return null}},[offer])
 async function callApi(url:string,body:Record<string,unknown>,method:'POST'|'PATCH'='POST'){
  setBusy(true);setError('');setMessage('')
  try{
   const res=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error??'Request failed')
   await load();setMessage('Saved. No message was sent and no affiliate terms were changed.')
   return true
  }catch(e){setError(e instanceof Error?e.message:'Request failed');return false}
  finally{setBusy(false)}
 }
 async function addCreator(){
  const body={handle,category,sampleVideoUrl:video,notes,
   ...Object.fromEntries(Object.entries(ratings).map(([k,v])=>[k,v===''?null:Number(v)]))}
  if(await callApi('/api/admin/ai/creator-prospects',reviewTarget?{id:reviewTarget,action:'update_review',review:body}:body,reviewTarget?'PATCH':'POST')){
   setHandle('');setVideo('');setNotes('');setRatings(initialRatings);setReviewTarget('');setTab('Prospects')
  }
 }
 async function applyAction(action:string,p:Prospect){
  if(action==='do_not_contact' && !confirm('Permanently suppress this creator from outreach?'))return
  if(action==='mark_contacted'&&!actionNote.trim()){setError('Enter the channel where you personally sent the approved invitation.');return}
  if(action==='record_reply'&&!actionNote.trim()){setError('Summarize the actual reply first.');return}
  const success=await callApi('/api/admin/ai/creator-prospects',{id:p.id,action,outcome:actionNote,nextFollowupAt:followup||null},'PATCH')
  if(success){setActionNote('');setFollowup('')}
 }
 async function search(){
  setBusy(true);setError('');setResults([]);setSearched(false)
  try{
   const r=await fetch('/api/admin/ai/creator-discovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:searchTopic})})
   const j=await r.json().catch(()=>({}))
   if(!r.ok)throw new Error(j.error??'Search unavailable')
   setResults(Array.isArray(j.results)?j.results:[])
   setSearched(true)
  }catch(e){setError(e instanceof Error?e.message:'Search unavailable')}
  finally{setBusy(false)}
 }
 const copy=async(value:string)=>{try{await navigator.clipboard.writeText(value);setMessage('Copied to clipboard. KVRN has not sent it.')}catch{setError('Copy unavailable; select the text manually.')}}
 const count=(key:string)=>Number(funnel.counts?.[key]??0)
 const metric=(title:string,value:number|string,detail?:string)=><div className="rounded-xl border border-neutral-200 bg-white p-4"><div className="text-[11px] uppercase tracking-wider text-neutral-500">{title}</div><div className="mt-2 text-2xl font-semibold">{value}</div>{detail&&<p className="mt-1 text-xs text-neutral-500">{detail}</p>}</div>
 const pipeline=prospects.filter(p=>!p.do_not_contact && ['qualified','contact_ready','contacted','replied','applied'].includes(p.status))
 return <main className="mx-auto max-w-7xl px-4 py-8 text-neutral-950 sm:px-6">
  <div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div>
   <Link href="/admin/ai" className="text-xs text-neutral-500 underline">← AI Operations</Link>
   <p className="mt-4 text-[11px] font-medium uppercase tracking-[.25em] text-neutral-500">KVRN / Creator & Affiliate</p>
   <h1 className="mt-1 text-3xl font-semibold tracking-tight">Creator Recruiting OS</h1>
   <p className="mt-2 max-w-2xl text-sm text-neutral-600">Find promising UGC partners, screen their content and prepare KVRN affiliate invitations. All outreach and financial commitments require your approval.</p>
  </div><span className="rounded-full border border-neutral-200 bg-neutral-100 px-3 py-2 text-xs">Manual outreach · $0 model spend</span></div>
  <nav aria-label="Creator Recruiting sections" className="mb-6 flex gap-2 overflow-x-auto pb-2">{tabs.map(t=><button key={t} onClick={()=>{setTab(t);setError('');setMessage('')}} className={'shrink-0 rounded-full px-4 py-2 text-sm '+(tab===t?'bg-neutral-950 text-white':'border border-neutral-200 bg-white text-neutral-700')}>{t}</button>)}</nav>
  {error&&<div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
  {message&&<div role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{message}</div>}
  {loading&&<div className={card}>Loading your creator pipeline…</div>}
  {!loading&&tab==='Overview'&&<div className="space-y-5">
   <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{metric('Prospects',count('total'))}{metric('Ready to recruit',quality)}{metric('Manual contacts',count('contacted'))}{metric('Follow-ups due',count('followups_due'))}</div>
   <div className="grid gap-5 lg:grid-cols-2"><section className={card}><h2 className="text-lg font-semibold">Your recruiting agent</h2>
    <p className="mt-2 text-sm text-neutral-600">Creator & Affiliate uses KVRN&apos;s existing AI monitoring. This dashboard automatically scores independently reviewed prospects and tracks stages. It does not scrape TikTok or send messages.</p>
    <div className="mt-4 grid gap-2 text-sm"><p>Discovery: <strong>{searchState.enabled?'Optional Brave web index connected':'Manual / approved sources'}</strong></p>
    <p>TikTok One: <strong>Not authorized</strong></p><p>Outreach: <strong>Owner approval and manual send</strong></p><p>Paid reasoning: <strong>Off</strong></p></div>
    <button className={BUTTON+' mt-5'} onClick={()=>setTab('Discover')}>Find creators</button></section>
    <section className={card}><h2 className="text-lg font-semibold">Next actions</h2>
     {pipeline.slice(0,5).length===0?<p className="mt-3 text-sm text-neutral-500">No candidates ready yet. Start with a public creator profile.</p>:<div className="mt-3 divide-y divide-neutral-100">{pipeline.slice(0,5).map(p=><button key={p.id} onClick={()=>{setSelected(p.id);setTab('Outreach')}} className="flex w-full items-center justify-between gap-2 py-3 text-left text-sm"><span>@{p.platform_handle}</span><span className="text-xs text-neutral-500">{p.status} →</span></button>)}</div>}
     <p className="mt-3 text-xs text-neutral-500">{Number(funnel.applications?.pending_applications??0)} open applications in KVRN&apos;s existing affiliate intake (not necessarily TikTok-sourced).</p>
    </section></div>
   <section className={card}><h2 className="text-lg font-semibold">Activity history</h2><div className="mt-2 divide-y">{activity.slice(0,8).map(a=><p key={a.id} className="py-2 text-xs text-neutral-600">{formatDate(a.occurred_at)} · {a.content_summary}</p>)}{activity.length===0&&<p className="py-3 text-sm text-neutral-500">No prospect history yet.</p>}</div></section>
  </div>}
  {!loading&&tab==='Discover'&&<div className="grid gap-5 lg:grid-cols-2"><section className={card}>
   <h2 className="text-lg font-semibold">Search for TikTok creators</h2><p className="mt-1 text-sm text-neutral-600">Use public search engines and permitted creator directories. Search results are not imported automatically; review TikTok profiles yourself.</p>
   <label className="mt-5 block text-sm font-medium">Search topic<input className={FIELD} value={searchTopic} maxLength={120} onChange={e=>setSearchTopic(e.target.value)}/></label>
   <div className="mt-3 flex flex-wrap gap-2">{Object.entries(FREE_CREATOR_QUERIES).map(([key,q])=><button key={key} className={SECOND} onClick={()=>setSearchTopic(q.replace(/^site:tiktok.com\/@ /,''))}>{key}</button>)}</div>
   <div className="mt-5 flex flex-wrap gap-3"><a className={BUTTON} href={creatorSearchUrl('site:tiktok.com/@ '+searchTopic)} target="_blank" rel="noreferrer noopener">Free web search ↗</a>
    <button className={SECOND} disabled={busy||!searchState.enabled} onClick={()=>void search()}>Search Brave in KVRN</button></div>
   {!searchState.enabled&&<p className="mt-3 text-xs text-amber-800">Brave API not connected. External Google search works now; provider search needs a separate key, $0 budget cap, and quota table.</p>}
   <div className="mt-5 space-y-2">{results.map((r,i)=><div key={i} className="rounded-lg border p-3"><a href={r.url} className="break-all text-sm font-semibold underline" target="_blank" rel="noreferrer noopener">{r.title} ↗</a><p className="mt-1 text-xs text-neutral-500">{r.snippet}</p></div>)}</div>
   {searched&&results.length===0&&<p role="status" className="mt-3 text-sm text-neutral-600">No relevant TikTok fashion creators found. Irrelevant results were filtered out. Try another search topic.</p>}
   {results.length>0&&<p className="mt-3 text-xs text-neutral-600">Temporary provider results: not stored. Verify independently and type creator details into the review form.</p>}
  </section><section className={card}><h2 className="text-lg font-semibold">Free creator sources</h2><div className="mt-4 grid gap-3 text-sm">
   <a href="https://afluencer.com/" rel="noreferrer noopener" target="_blank" className="rounded-lg border p-4"><strong>Afluencer ↗</strong><p className="mt-1 text-xs text-neutral-600">Post a collaboration and invite opted-in applicants to apply to KVRN.</p></a>
   <a href="https://www.heepsy.com/" rel="noreferrer noopener" target="_blank" className="rounded-lg border p-4"><strong>Heepsy ↗</strong><p className="mt-1 text-xs text-neutral-600">Free-plan browsing, subject to provider usage limits.</p></a>
   <Link href="/affiliates/apply" className="rounded-lg border p-4"><strong>KVRN affiliate application ↗</strong><p className="mt-1 text-xs text-neutral-600">Your existing opt-in application. No duplicate signup process.</p></Link>
  </div><h3 className="mt-6 text-base font-semibold">Opt-in creator applications</h3>
   <p className="mt-1 text-xs text-neutral-600"> These applicants supplied TikTok links through KVRN&apos;s own affiliate application. Only independently reviewed profiles can be saved to the prospect pipeline.</p>
   <div className="mt-2 max-h-44 divide-y overflow-y-auto">{(funnel.applicants??[]).map(a=><div key={a.id} className="flex items-center justify-between gap-3 py-2 text-xs"><span>{a.tiktokLinks[0]} · {a.status}</span><button className={SECOND} onClick={()=>{setReviewTarget('');setHandle(a.tiktokLinks[0]);setNotes('Opt-in affiliate applicant — independently review creator content before qualifying.');setMessage('Applicant link loaded. Review the profile and add your own scores before saving.')}}>Review</button></div>)}{!funnel.applicants?.length&&<p className="py-3 text-xs text-neutral-500">No TikTok-linked affiliate applications in recent records.</p>}</div>
   <h3 className="mt-6 text-base font-semibold">Manually review a TikTok creator</h3>
   <label className="mt-3 block text-xs">Create new, or update an existing prospect<select className={FIELD} value={reviewTarget} onChange={e=>{const id=e.target.value;setReviewTarget(id);const p=prospects.find(p=>p.id===id);if(p){setHandle(p.platform_handle);setCategory(p.evidence.category??'streetwear');setVideo(p.evidence.sampleVideoUrl??'');setNotes(p.evidence.notes??'');setRatings({fitRating:p.evidence.fitRating?.toString()??'',contentRating:p.evidence.contentRating?.toString()??'',consistencyRating:p.evidence.consistencyRating?.toString()??'',engagementRating:p.evidence.engagementRating?.toString()??''})}}}><option value="">New creator</option>{prospects.filter(p=>!p.do_not_contact&&['discovered','qualified'].includes(p.status)).map(p=><option value={p.id} key={p.id}>@{p.platform_handle}</option>)}</select></label>
   <div className="mt-3 grid gap-3 sm:grid-cols-2">
    <label className="text-xs sm:col-span-2">TikTok handle or profile URL<input className={FIELD} placeholder="@creator" value={handle} onChange={e=>setHandle(e.target.value)}/></label>
    <label className="text-xs sm:col-span-2">Niche<select className={FIELD} value={category} onChange={e=>setCategory(e.target.value)}>{categories.map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
    <label className="text-xs sm:col-span-2">Sample public TikTok video (optional)<input className={FIELD} value={video} onChange={e=>setVideo(e.target.value)} placeholder="https://www.tiktok.com/@.../video/..."/></label>
    {([['fitRating','Brand fit'],['contentRating','Video quality'],['consistencyRating','Posting consistency'],['engagementRating','Visible engagement']] as const).map(([key,label])=><label key={key} className="text-xs">{label} <span className="text-neutral-500">(subjective)</span><select className={FIELD} value={ratings[key]} onChange={e=>setRatings(s=>({...s,[key]:e.target.value}))}><option value="">Not reviewed</option>{[1,2,3,4,5].map(v=><option key={v} value={v}>{v}/5</option>)}</select></label>)}
    <label className="text-xs sm:col-span-2">Your independent observations<textarea className={FIELD} value={notes} maxLength={800} rows={3} onChange={e=>setNotes(e.target.value)}/></label></div>
   <button className={BUTTON+' mt-4'} disabled={busy||!handle.trim()} onClick={()=>void addCreator()}>Save reviewed prospect</button>
   <p className="mt-3 text-xs text-neutral-500">Save only information you independently observed. A Brave search result alone is not sufficient to import a profile.</p>
  </section></div>}
  {!loading&&tab==='Prospects'&&<section className={card}>
   <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Prospect pipeline ({ordered.length})</h2><select aria-label="Filter prospects" className={FIELD+' max-w-48'} value={filter} onChange={e=>setFilter(e.target.value)}>{['all','discovered','qualified','contact_ready','contacted','replied','applied','onboarded','due','dnc'].map(x=><option key={x} value={x}>{x==='all'?'All':x.replace(/_/g,' ')}</option>)}</select></div>
   <div className="mt-4 divide-y">{ordered.map(p=><div key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><a href={'https://www.tiktok.com/@'+p.platform_handle} target="_blank" rel="noreferrer noopener" className="font-semibold underline">@{p.platform_handle} ↗</a>
     <p className="mt-1 text-xs text-neutral-500">{p.evidence?.category??'Unknown'} · {p.status.replace(/_/g,' ')} · {p.do_not_contact?'DO NOT CONTACT':p.evidence?.reviewStatus??'Needs review'}</p>
     <p className="mt-1 text-xs text-neutral-500">{typeof p.evidence?.preliminaryScore==='number'?`${p.evidence.preliminaryScore}/100 subjective fit`:'Unscored'} · Last updated {formatDate(p.updated_at)}</p></div>
     <div className="flex flex-wrap gap-2"><button className={SECOND} disabled={busy||p.status!=='discovered'||p.evidence?.reviewStatus!=='reviewed'||p.do_not_contact} onClick={()=>void applyAction('qualify',p)}>Qualify</button>
     <button className={SECOND} disabled={p.do_not_contact} onClick={()=>{setSelected(p.id);setTab('Outreach')}}>Recruit</button>
     <button className={SECOND} disabled={busy||p.do_not_contact} onClick={()=>void applyAction('do_not_contact',p)}>DNC</button></div></div>)}
    {ordered.length===0&&<p className="py-6 text-sm text-neutral-500">No creator records match this filter.</p>}</div>
   <p className="mt-4 text-xs text-neutral-500">No inferred age, audience demographics, conversion history or creator income. Scores reflect only your review inputs.</p>
  </section>}
  {!loading&&tab==='Outreach'&&<div className="grid gap-5 lg:grid-cols-5"><section className={card+' lg:col-span-2'}>
    <h2 className="text-lg font-semibold">Recruitment queue</h2><p className="mt-2 text-sm text-neutral-600">Approval prepares a message; sending always happens manually.</p>
    <div className="mt-3 max-h-[500px] divide-y overflow-auto">{prospects.filter(p=>!p.do_not_contact && ['qualified','contact_ready','contacted','replied','applied','onboarded'].includes(p.status)).map(p=><button key={p.id} onClick={()=>{setSelected(p.id);setActionNote('')}} className={'w-full px-2 py-3 text-left text-sm '+(selected===p.id?'bg-neutral-100':'')}><strong>@{p.platform_handle}</strong><span className="ml-2 text-xs text-neutral-500">{p.status}</span></button>)}
    </div></section><section className={card+' lg:col-span-3'}>
    {!selectedProspect?<p className="text-sm text-neutral-500">Select a qualified prospect to prepare an invitation.</p>:<>
     <h2 className="text-lg font-semibold">@{selectedProspect.platform_handle}</h2><p className="mt-1 text-xs text-neutral-500">Stage: {selectedProspect.status} · Last contact: {formatDate(selectedProspect.last_contact_at)}</p>
     <div className="mt-4 flex flex-wrap gap-2"><button className={SECOND} disabled={busy||!['qualified','contact_ready'].includes(selectedProspect.status)} onClick={()=>void applyAction('prepare_draft',selectedProspect)}>Prepare draft</button>
      <button className={SECOND} disabled={busy||!selectedProspect.evidence?.outreach?.draft||!['qualified','contact_ready'].includes(selectedProspect.status)} onClick={()=>void applyAction('approve_draft',selectedProspect)}>Approve draft</button></div>
     {selectedProspect.evidence?.outreach?.draft&&<div className="mt-4 rounded-lg bg-neutral-100 p-4"><p className="whitespace-pre-wrap text-sm">{selectedProspect.evidence.outreach.draft}</p>
      <button className={SECOND+' mt-3'} onClick={()=>void copy(selectedProspect.evidence.outreach?.draft??'')}>Copy draft</button><p className="mt-2 text-xs text-neutral-500">{selectedProspect.evidence.outreach?.approvedAt?'Owner approved':'Not approved'} · Never sent by KVRN</p></div>}
     <label className="mt-5 block text-xs">Manual contact channel or reply notes<textarea className={FIELD} value={actionNote} maxLength={500} rows={2} onChange={e=>setActionNote(e.target.value)} placeholder="Example: Sent manually via TikTok DM (no sensitive details)"/></label>
     <label className="mt-3 block text-xs">Optional follow-up date<input type="date" className={FIELD} value={followup} onChange={e=>setFollowup(e.target.value)}/></label>
     <div className="mt-4 flex flex-wrap gap-2">
      <button className={SECOND} disabled={busy||selectedProspect.status!=='contact_ready'||!selectedProspect.evidence?.outreach?.approvedAt} onClick={()=>void applyAction('mark_contacted',selectedProspect)}>Record manually sent</button>
      <button className={SECOND} disabled={busy||selectedProspect.status!=='contacted'} onClick={()=>void applyAction('record_reply',selectedProspect)}>Record reply</button>
      <button className={SECOND} disabled={busy||!['replied','contacted'].includes(selectedProspect.status)} onClick={()=>void applyAction('mark_applied',selectedProspect)}>Mark applied</button>
      <button className={SECOND} disabled={busy||!['applied'].includes(selectedProspect.status)||!selectedProspect.affiliate_id} onClick={()=>void applyAction('mark_onboarded',selectedProspect)}>Mark onboarded</button>
      <button className={SECOND} disabled={busy||!['qualified','contact_ready','contacted','replied','applied'].includes(selectedProspect.status)} onClick={()=>void applyAction('decline',selectedProspect)}>Mark declined</button>
     </div><p className="mt-4 text-xs text-neutral-500">Affiliate applications and approvals remain in the existing Affiliate admin system. This page never creates an affiliate, issues a coupon, or sends messages.</p>
    </>}
   </section></div>}
  {!loading&&tab==='Offers & Margin'&&<div className="grid gap-5 lg:grid-cols-2"><section className={card}><h2 className="text-lg font-semibold">Offer profitability preview</h2><p className="mt-2 text-sm text-neutral-600">Plan a deal before offering free products or a commission. This is a scenario calculator, not the official accounting ledger.</p>
   <div className="mt-4 grid grid-cols-2 gap-3">{([
    ['salePriceCents','Retail price (¢)'],['productCostCents','Product COGS (¢)'],['couponCents','Coupon discount (¢)'],['commissionRatePct','Commission (%)'],['paymentFeesCents','Payment fee (¢)'],['merchantShippingCents','Merchant shipping (¢)'],['returnAllowanceCents','Return reserve (¢)'],['creatorIncentiveCents','Creator incentive (¢)']
   ] as [keyof typeof offer,string][]).map(([key,label])=><label key={key} className="text-xs">{label}<input className={FIELD} inputMode="decimal" type="number" min={0} max={100000000} value={offer[key]} onChange={e=>setOffer(v=>({...v,[key]:e.target.value}))}/></label>)}</div></section>
   <section className={card}><h2 className="text-lg font-semibold">Estimated contribution per order</h2><div className="mt-5 text-4xl font-semibold">{estimate?USD(estimate.contributionCents):'Invalid inputs'}</div>
    <p className={'mt-3 text-sm '+(estimate?.viable?'text-green-800':'text-red-800')}>{estimate?.viable?'Positive estimate':'Nonpositive or invalid estimate: do not approve this offer without finance review.'}</p>
    <p className="mt-2 text-sm text-neutral-600">Estimated commission: {estimate?USD(estimate.commissionCents):'—'}</p>
    <div className="mt-5 rounded-lg bg-neutral-100 p-4 text-xs leading-relaxed text-neutral-600">These figures use assumptions you enter. Real costs, settled revenue, returns, coupons and paid commissions must come from KVRN&apos;s canonical finance data. No affiliate deal or code is activated here.</div>
    <Link href="/admin/financials/affiliates" className="mt-4 inline-block text-sm underline">Manage actual affiliate program ↗</Link></section></div>}
  {!loading&&tab==='Results'&&<div className="space-y-5"><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{metric('Qualified / ready',count('ready'))}{metric('Replies recorded',count('replied'))}{metric('Linked affiliates',count('linked_affiliates'))}{metric('Open affiliate applicants',Number(funnel.applications?.pending_applications??0),'All affiliate sources')}</div>
    <section className={card}><h2 className="text-lg font-semibold">Linked creator attribution</h2><p className="mt-1 text-sm text-neutral-600">These figures use KVRN&apos;s existing order attribution and signed commission ledger, not inferred TikTok Shop sales.</p>
     <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[500px] text-left text-sm"><thead className="border-b text-xs text-neutral-500"><tr><th className="py-3">Creator</th><th>Attributed orders</th><th>Net affiliate commission</th></tr></thead><tbody>{(funnel.linked??[]).map(x=><tr key={x.prospectId} className="border-b"><td className="py-3">@{x.handle}</td><td>{x.attributedOrders}</td><td>{USD(Number(x.netCommissionCents))}</td></tr>)}</tbody></table>{!funnel.linked?.length&&<p className="py-5 text-sm text-neutral-500">No creator-to-affiliate links yet. Affiliate approvals remain in the existing program.</p>}</div>
     <p className="mt-4 text-xs text-neutral-500">{funnel.disclaimer??'First-party data only.'}</p>
     <div className="mt-5 rounded-lg border border-neutral-200 p-4"><h3 className="font-semibold">Link an already approved affiliate</h3><p className="mt-1 text-xs text-neutral-500"> Only use a real affiliate UUID from KVRN&apos;s approved affiliate records. This links reporting; it does not approve a new applicant or issue payment.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2"><select aria-label="Creator to link" className={FIELD} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Select a prospect</option>{prospects.filter(p=>!p.do_not_contact&&!p.affiliate_id&&['applied','onboarded'].includes(p.status)).map(p=><option key={p.id} value={p.id}>@{p.platform_handle}</option>)}</select>
       <input aria-label="Verified affiliate UUID" className={FIELD} placeholder="Approved affiliate UUID" value={affiliateLink} onChange={e=>setAffiliateLink(e.target.value)} /></div>
      <button className={SECOND+' mt-3'} disabled={busy||!selected||!/^[a-f\d-]{36}$/i.test(affiliateLink)} onClick={async()=>{if(await callApi('/api/admin/ai/creator-prospects',{id:selected,action:'link_affiliate',affiliateId:affiliateLink},'PATCH'))setAffiliateLink('')}}>Link approved affiliate</button></div>
     <Link className="mt-3 inline-block text-sm underline" href="/admin/financials/affiliates">Affiliate program reporting ↗</Link>
    </section></div>}
  {!loading&&tab==='Settings'&&<div className="grid gap-5 lg:grid-cols-2"><section className={card}>
   <h2 className="text-lg font-semibold">Connections and permissions</h2><dl className="mt-4 space-y-3 text-sm"><div><dt className="font-medium">Creator discovery</dt><dd className="text-neutral-600">{searchState.enabled?'Owner-triggered Brave search enabled':'Free external searches / manual entry'}</dd></div>
    <div><dt className="font-medium">Brave Search monthly cap</dt><dd className="text-neutral-600">{searchState.monthlyLimit} server-authorized requests</dd></div><div><dt className="font-medium">TikTok API and TikTok Shop</dt><dd className="text-neutral-600">Not authorized / not connected</dd></div>
    <div><dt className="font-medium">Outreach</dt><dd className="text-neutral-600">Draft → approve → send manually. No automatic DM, SMS, or email.</dd></div><div><dt className="font-medium">Paid AI generation</dt><dd className="text-neutral-600">Off; deterministic screening and templates</dd></div></dl>
    <p className="mt-5 text-xs text-neutral-500">Connections require owner-controlled server secrets and a provider account with appropriate usage rights. Never paste API tokens in chat or client-side fields.</p></section>
   <section className={card}><h2 className="text-lg font-semibold">Privacy and safeguards</h2><ul className="mt-3 space-y-3 text-sm text-neutral-600"><li>Do Not Contact blocks further outreach stages permanently from this interface.</li><li>Public creator links do not establish permission for bulk marketing.</li><li>Search results are temporary; only independently reviewed creator information is saved.</li><li>Creator incentives, affiliate rates, discount codes, and product gifts require separate finance approval.</li><li>Promotional content must disclose material relationships.</li></ul>
    <button className={SECOND+' mt-5'} disabled={busy} onClick={()=>void load().catch(e=>setError(String(e)))}>Refresh connections</button></section>
  </div>}
 </main>
}
