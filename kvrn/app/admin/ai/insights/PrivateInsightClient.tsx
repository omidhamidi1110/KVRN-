'use client'
import {useState} from 'react'
import Link from 'next/link'
import {AdminPage,AdminPageHeader,AdminCard,AdminNotice,AdminButton,adminButtonClass} from '@/components/admin/ui/AdminUI'
import type {PrivateInsight,PrivateInsightTopic} from '@/lib/ai/private-insights'
const choices:{id:PrivateInsightTopic;label:string}[]=[
 {id:'marketing-consent',label:'Marketing consent'},
 {id:'store-credit',label:'Store-credit integrity'},
 {id:'ai-budget',label:'AI budget'},
 {id:'inventory-integrity',label:'Inventory integrity'},
 {id:'payment-exceptions',label:'Payment exceptions'},
 {id:'affiliate-integrity',label:'Affiliate integrity'},
 {id:'operations-brief',label:'Operations brief'}]
export function PrivateInsightClient(){
 const [selected,setSelected]=useState<PrivateInsightTopic>('marketing-consent')
 const [result,setResult]=useState<PrivateInsight|null>(null)
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 async function load(topic:PrivateInsightTopic){
  if(busy)return
  setSelected(topic);setBusy(true);setError('');setResult(null)
  try{
   const r=await fetch('/api/admin/ai/private-insights?topic='+encodeURIComponent(topic),{cache:'no-store'})
   const value=await r.json().catch(()=>({}))
   if(!r.ok||value.readOnly!==true||value.externalTransmission!==false||value.modelUsed!==false||!Array.isArray(value.lines))
    throw Error(typeof value.error==='string'?value.error:'Insight did not pass its privacy/safety contract.')
   setResult(value as PrivateInsight)
  }catch(e){setError(e instanceof Error?e.message:'Insight unavailable.')}
  finally{setBusy(false)}
 }
 return <AdminPage width="narrow">
  <AdminPageHeader eyebrow="AI Operations / Safe tools" title="Private operational insights" description="Deterministic, first-party business summaries without AI model calls or external data transfer." actions={<Link href="/admin/ai" className={adminButtonClass()}>AI Operations</Link>}/>
  <AdminNotice tone="info">This tool is not an autonomous AI agent. It uses a fixed, approved set of read-only sources and does not contact a model, send messages, expose customer identities, change credit, or execute arbitrary queries.</AdminNotice>
  <div className="my-5 flex flex-wrap gap-2">{choices.map(c=><AdminButton key={c.id} variant={selected===c.id?'primary':'secondary'} disabled={busy} onClick={()=>void load(c.id)}>{c.label}</AdminButton>)}</div>
  {busy&&<p className="text-xs" role="status">Loading private insights…</p>}
  {error&&<AdminNotice tone="danger">{error}</AdminNotice>}
  {result&&<AdminCard>
    <h2 className="text-sm font-semibold">{choices.find(c=>c.id===result.topic)?.label}</h2>
    <p className="mt-1 text-xs text-neutral-600">{result.summary}</p>
    <dl className="mt-4 divide-y divide-neutral-200">{result.lines.map((m,i)=><div key={m.label+'-'+i} className="flex flex-wrap justify-between gap-3 py-3 text-xs"><dt>{m.label}</dt><dd className={m.state==='warning'?'text-amber-700':m.state==='unknown'?'text-red-700':'font-medium'}>{m.value}</dd></div>)}</dl>
    <h3 className="mt-4 text-xs font-semibold">Limitations</h3>
    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-neutral-600">{result.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>
    <p className="mt-4 text-[11px] text-neutral-500">As of {new Date(result.asOf).toLocaleString()}. Model calls: none. External transmissions: none. Writes: none.</p>
  </AdminCard>}
 </AdminPage>
}
