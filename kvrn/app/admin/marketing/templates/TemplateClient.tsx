'use client'
/** Templates are editorial copy only. No recipient records or provider delivery. */
import {useCallback,useEffect,useState} from 'react'
import Link from 'next/link'
import {AdminPage,AdminPageHeader,AdminCard,AdminNotice,AdminButton,adminButtonClass,adminInputClass,adminSelectClass,adminTextareaClass} from '@/components/admin/ui/AdminUI'
import type {CopyTemplateSummary,CopyTemplateInput,CopyCategory,CopyChannel} from '@/lib/marketing-copy-templates'
import {renderStaticBrandCopy} from '@/lib/marketing-copy-template-tokens'
import {composeMarketingSms} from '@/lib/marketing-message-composer'
const fresh=(channel:CopyChannel='sms'):CopyTemplateInput=>({channel,label:'',category:'launch',subject:channel==='email'?'':null,body:''})
const CATEGORIES:CopyCategory[]=['launch','restock','promotion','update','post_purchase']
export function TemplateClient(){
 const [templates,setTemplates]=useState<CopyTemplateSummary[]>([])
 const [form,setForm]=useState<CopyTemplateInput>(fresh)
 const [selected,setSelected]=useState<CopyTemplateSummary|null>(null)
 const [busy,setBusy]=useState(false)
 const [loading,setLoading]=useState(true)
 const [stale,setStale]=useState(false)
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 const refresh=useCallback(async()=>{
  const r=await fetch('/api/admin/marketing/templates',{cache:'no-store'})
  const data=await r.json().catch(()=>({}))
  if(!r.ok||!Array.isArray(data.templates)||data.sendEnabled!==false)throw Error('Marketing templates are unavailable. Migration 055 must first be applied to isolated staging.')
  setTemplates(data.templates)
 },[])
 useEffect(()=>{let live=true;void refresh().catch(e=>{if(live)setError(e instanceof Error?e.message:'Unable to load templates.')}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[refresh])
 function choose(t:CopyTemplateSummary){setSelected(t);setForm({channel:t.channel,label:t.label,category:t.category,subject:t.subject,body:t.body});setError('');setNotice('');setStale(false)}
 function reset(){setSelected(null);setForm(fresh());setError('');setNotice('');setStale(false)}
 async function mutate(method:'POST'|'PATCH',payload:Record<string,unknown>,success:string){
  if(busy)return
  setBusy(true);setError('');setNotice('')
  try{
   const r=await fetch('/api/admin/marketing/templates',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'})
   const data=await r.json().catch(()=>({}))
   if(!r.ok){
    if(r.status===409){setStale(true);await refresh().catch(()=>undefined);throw Error('Version conflict or state changed. Your unsaved text is preserved. Reselect the current template to reload.')}
    throw Error(typeof data.error==='string'?data.error:'Unable to save the template.')
   }
   await refresh();reset();setNotice(success)
  }catch(e){setError(e instanceof Error?e.message:'Template action failed.')}
  finally{setBusy(false)}
 }
 const safePreview=(()=>{try{return {subject:form.subject?renderStaticBrandCopy(form.subject):'',body:renderStaticBrandCopy(form.body)}}catch{return null}})()
 const composed=safePreview&&form.channel==='sms'?composeMarketingSms(safePreview.body):null
 const segment=composed?.estimate??null
 const previewMissingTokens=!safePreview
 return <AdminPage>
  <AdminPageHeader eyebrow="Marketing / Editorial" title="Copy templates" description="Create and review reusable brand copy. No messages can be sent from this page." actions={<Link href="/admin/marketing" className={adminButtonClass()}>Back to Marketing</Link>}/>
  <AdminNotice tone="warning" title="No sending or approval">A template marked Ready is only approved for reuse in a draft. It is not owner send approval, consent validation, a cost reservation, or a broadcast schedule. Email unsubscribe links and required postal details must be supplied by a compliant sender at delivery time.</AdminNotice>
  {error&&<div className="my-4"><AdminNotice tone="danger">{error}</AdminNotice></div>}
  {notice&&<p className="my-4 text-xs" role="status">{notice}</p>}
  <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
   <AdminCard>
    <h2 className="text-sm font-semibold">{selected?`Edit: ${selected.label}`:'New template'}</h2>
    {selected&&<p className="mt-1 text-xs text-neutral-600">Version {selected.version} · {selected.state}</p>}
    {stale&&<p className="mt-2 text-xs text-red-700" role="alert">Unsaved copy preserved. Reselect the latest version before editing.</p>}
    <div className="mt-4 space-y-3">
     <label className="block text-xs">Channel<select className={'mt-1 '+adminSelectClass} value={form.channel} disabled={busy||!!selected} onChange={e=>setForm(fresh(e.target.value as CopyChannel))}><option value="sms">SMS</option><option value="email">Email</option></select></label>
     <label className="block text-xs">Internal title<input className={'mt-1 '+adminInputClass} maxLength={100} value={form.label} disabled={busy||selected?.state==='archived'} onChange={e=>setForm(p=>({...p,label:e.target.value}))}/></label>
     <label className="block text-xs">Category<select className={'mt-1 '+adminSelectClass} value={form.category} disabled={busy||selected?.state==='archived'} onChange={e=>setForm(p=>({...p,category:e.target.value as CopyCategory}))}>{CATEGORIES.map(c=><option key={c} value={c}>{c.replace('_',' ')}</option>)}</select></label>
     {form.channel==='email'&&<label className="block text-xs">Email subject<input className={'mt-1 '+adminInputClass} maxLength={140} value={form.subject||''} disabled={busy||selected?.state==='archived'} onChange={e=>setForm(p=>({...p,subject:e.target.value}))}/></label>}
     <label className="block text-xs">Message<textarea className={'mt-1 min-h-40 '+adminTextareaClass} maxLength={10000} value={form.body} disabled={busy||selected?.state==='archived'} onChange={e=>setForm(p=>({...p,body:e.target.value}))}/></label>
     <p className="text-xs text-neutral-500">Allowed static tokens: <code>{'{{brand}}'}</code>, <code>{'{{site_url}}'}</code>, <code>{'{{support_email}}'}</code>. Recipient-specific tokens and HTML are blocked.</p>
     <div className="flex flex-wrap gap-2"><AdminButton variant="primary" disabled={busy||stale||selected?.state!=='draft'&&!!selected||!form.label.trim()||!form.body.trim()||previewMissingTokens||form.channel==='email'&&!form.subject?.trim()} onClick={()=>void mutate(selected?'PATCH':'POST',selected?{id:selected.id,expectedVersion:selected.version,input:form}:{...form},'Template saved. No messages were sent.')}>Save draft</AdminButton><AdminButton disabled={busy} onClick={reset}>New</AdminButton></div>
     {selected&&selected.state!=='archived'&&<div className="flex flex-wrap gap-2">
       {selected.state==='draft'&&<AdminButton disabled={busy||stale} onClick={()=>void mutate('PATCH',{id:selected.id,expectedVersion:selected.version,target:'ready'},'Copy marked ready for reuse only.')}>Mark copy ready</AdminButton>}
       {selected.state==='ready'&&<AdminButton disabled={busy||stale} onClick={()=>void mutate('PATCH',{id:selected.id,expectedVersion:selected.version,target:'draft'},'Template returned to draft.')}>Reopen draft</AdminButton>}
       <AdminButton variant="danger" disabled={busy||stale} onClick={()=>{if(window.confirm('Archive this template? This cannot be undone.'))void mutate('PATCH',{id:selected.id,expectedVersion:selected.version,target:'archived'},'Template archived.')}}>Archive</AdminButton>
     </div>}
    </div>
   </AdminCard>
   <div className="min-w-0 space-y-5">
    <AdminCard>
     <h2 className="text-sm font-semibold">Plain-text preview</h2>
     {previewMissingTokens?<p className="mt-2 text-xs text-red-700" role="alert">Unsupported placeholder; preview and save blocked.</p>:<><p className="mt-2 break-words whitespace-pre-wrap text-sm">{safePreview?.subject&&<strong className="block pb-2">{safePreview.subject}</strong>}{safePreview?.body||'Message body appears here.'}</p>{segment&&<p className="mt-3 text-xs text-neutral-600">Estimated {segment.segments} segment(s), {segment.encoding}. Includes brand and required STOP instruction; not a carrier price.{composed&&!composed.validOneSegment?' One-segment policy BLOCKED.':''}</p>}</>}
    </AdminCard>
    <AdminCard>
     <h2 className="text-sm font-semibold">Saved templates</h2>
     <p className="mt-1 text-xs text-neutral-500">Only the last 100 templates appear. No recipients or personal data are shown.</p>
     {loading?<p className="mt-3 text-xs">Loading…</p>:templates.length===0?<p className="mt-3 text-xs">No templates created.</p>:<ul className="mt-3 divide-y divide-neutral-200">{templates.map(t=><li key={t.id} className="flex min-w-0 items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="truncate text-xs font-medium">{t.label}</p><p className="text-[11px] text-neutral-500">{t.channel.toUpperCase()} · {t.state} · v{t.version}</p></div><AdminButton size="sm" disabled={busy} onClick={()=>choose(t)}>View / edit</AdminButton></li>)}</ul>}
    </AdminCard>
   </div>
  </div>
 </AdminPage>
}
