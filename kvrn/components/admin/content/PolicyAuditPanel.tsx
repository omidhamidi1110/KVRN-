'use client'
import {useEffect,useState} from 'react'
import {AdminNotice} from '@/components/admin/ui/AdminUI'
import type {ContentPolicyAudit} from '@/lib/content-policy-audit'
export function PolicyAuditPanel(){
 const [data,setData]=useState<{cmsPublicEnabled:boolean,audit:ContentPolicyAudit}|null>(null)
 const [status,setStatus]=useState<'loading'|'ready'|'unavailable'>('loading')
 useEffect(()=>{
   let live=true
   void fetch('/api/admin/content/policy-audit',{cache:'no-store'})
     .then(async r=>{if(!r.ok)throw Error('unavailable');return r.json()})
     .then(v=>{if(live){setData(v);setStatus('ready')}})
     .catch(()=>{if(live)setStatus('unavailable')})
   return()=>{live=false}
 },[])
 if(status==='loading')return <p className="mb-4 text-xs text-neutral-500">Checking current CMS publication facts…</p>
 if(status==='unavailable'||!data)return <AdminNotice tone="warning" className="mb-4">Could not check CMS publication consistency. Do not assume published policies match October 6 drafts.</AdminNotice>
 const review=data.audit.issues.filter(i=>i.severity!=='info')
 const info=data.audit.issues.filter(i=>i.severity==='info')
 const issues=review
 return <div className="mb-5 rounded-xl border border-black/10 bg-white p-4 text-xs">
   <h2 className="font-medium text-sm">Policy and FAQ publication audit (read-only)</h2>
   <p className="mt-1 text-neutral-600">CMS public rendering: <b>{data.cmsPublicEnabled?'Enabled':'Disabled (coded fallbacks)'}</b>. Reviewed versions live from the CMS: {data.audit.live}{data.audit.placeholders.length>0?` · placeholders not live: ${data.audit.placeholders.length}`:''}.</p>
   {info.length>0&&<ul className="mt-2 list-inside list-disc space-y-1 text-neutral-600">{info.map((i,n)=><li key={`${i.entityId}-${i.code}-${n}`}><b>{i.entityId}:</b> {i.message}</li>)}</ul>}
   {issues.length===0?<p className="mt-2 text-neutral-600">No configured stale-text patterns found. This does not verify legal compliance.</p>
   :<><p className="mt-2 font-medium text-amber-800">{issues.length} item{issues.length===1?' needs':'s need'} editorial review:</p>
     <ul className="mt-2 list-inside list-disc space-y-1 text-neutral-700">{issues.map((i,n)=><li key={`${i.entityId}-${i.code}-${n}`}><b>{i.entityId}:</b> {i.message}</li>)}</ul></>}
   <p className="mt-3 text-neutral-500">This audit cannot publish, change legal text, or approve SMS/credit operations. Use the versioned editor and obtain legal/owner approval before publishing.</p>
 </div>
}
