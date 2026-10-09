'use client'
import { useCallback, useEffect, useState } from 'react'
import { AdminPage, AdminPageHeader, AdminButton, AdminCard, AdminNotice, AdminLoading, AdminEmpty } from '@/components/admin/ui/AdminUI'

type Review = { id:string; display_name:string; item_label:string; rating:number; headline:string; body:string; status:string; created_at:string }
export function ReviewsAdminClient() {
 const [reviews,setReviews] = useState<Review[]>([])
 const [error,setError] = useState('')
 const [loading,setLoading] = useState(true)
 const [saving,setSaving] = useState<string | null>(null)
 const load = useCallback(async () => {
   setLoading(true)
   try { const r=await fetch('/api/admin/reviews',{cache:'no-store'}); const d=await r.json(); if (!r.ok) throw new Error(d.error ?? 'Could not load.'); setReviews(d.reviews);setError('') }
   catch(e) {setError(e instanceof Error ? e.message : 'Unable to load reviews.')}
   finally {setLoading(false)}
 },[])
 useEffect(()=>{void load()},[load])
 async function decide(id:string,status:'approved'|'rejected'|'pending') {
   setSaving(id);setError('')
   try { const r=await fetch('/api/admin/reviews',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,status})}); const d=await r.json(); if (!r.ok) throw new Error(d.error ?? 'Could not update.');await load() }
   catch(e) { setError(e instanceof Error ? e.message : 'Unable to save.') }
   finally {setSaving(null)}
 }
 return <AdminPage width="wide"><AdminPageHeader title="Product Reviews" description="One moderated review stream across KVRN products." actions={<AdminButton onClick={load}>Refresh</AdminButton>}/>
   <AdminNotice>Only approved reviews appear publicly. The review feed is shared by all products, and each review displays its item category. Do not approve fabricated or misleading reviews.</AdminNotice>
   {error && <p role="alert" className="my-4 text-sm text-red-700">{error}</p>}
   {loading ? <AdminLoading/> : reviews.length===0 ? <AdminEmpty title="No reviews submitted yet."/> : <div className="mt-5 grid gap-3 sm:grid-cols-2">{reviews.map(r=><AdminCard key={r.id} className="min-w-0"><div className="flex flex-wrap items-center justify-between gap-3 text-xs"><span>{'★'.repeat(r.rating)}{'☆'.repeat(5-r.rating)} · {r.item_label}</span><span className="rounded border px-2 py-1 uppercase tracking-widest">{r.status}</span></div><h2 className="mt-3 text-base font-semibold">{r.headline}</h2><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{r.body}</p><p className="mt-3 text-xs text-[#666]">{r.display_name} · {new Date(r.created_at).toLocaleString()}</p><div className="mt-4 flex flex-wrap gap-2"><AdminButton variant="primary" size="sm" disabled={saving!==null || r.status==='approved'} onClick={()=>decide(r.id,'approved')}>Approve</AdminButton><AdminButton size="sm" disabled={saving!==null || r.status==='rejected'} onClick={()=>decide(r.id,'rejected')}>Reject</AdminButton>{r.status!=='pending'&&<AdminButton variant="ghost" size="sm" disabled={saving!==null} onClick={()=>decide(r.id,'pending')}>Return to pending</AdminButton>}</div></AdminCard>)}</div>}
 </AdminPage>
}
