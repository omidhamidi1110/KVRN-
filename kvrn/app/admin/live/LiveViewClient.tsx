'use client'
import {useCallback,useEffect,useState} from 'react'
import {AdminPage,AdminPageHeader,AdminCard,AdminNotice} from '@/components/admin/ui/AdminUI'
import type {LiveAnalyticsSummary} from '@/lib/live-analytics'

const num=(value:number)=>value.toLocaleString('en-US')
export function LiveViewClient(){
  const [report,setReport]=useState<LiveAnalyticsSummary|null>(null)
  const [error,setError]=useState('')
  const [paused,setPaused]=useState(false)
  const load=useCallback(async()=>{
    try {
      const response=await fetch('/api/admin/analytics/live',{cache:'no-store'})
      if(!response.ok)throw new Error('unavailable')
      setReport(await response.json());setError('')
    } catch {setError('Live View data could not be loaded.');}
  },[])
  useEffect(()=>{void load()},[load])
  useEffect(()=>{
    if(paused)return
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void load()},30000)
    return()=>clearInterval(timer)
  },[paused,load])
  const cards:[string,string,string][] = report?[
    ['Recently observed',num(report.recentlyObservedSessions),'Unique consenting sessions with events in 5 minutes'],
    ['Active consenting tabs',num(report.activeConsentingSessions),'Consent-only recent foreground presence, past 90 seconds'],
    ['Viewed product',num(report.productViewSessions),'Sessions with a product view in 5 minutes'],
    ['Added to cart',num(report.cartSessions),'Sessions with a cart addition in 5 minutes'],
    ['Started checkout',num(report.checkoutSessions),'Sessions with recorded checkout in 5 minutes'],
    ['Tracked purchases',num(report.purchasesLast30Minutes),'Consent-covered purchases in 30 minutes'],
    ['Paid orders today',num(report.ordersPaidToday),'All paid orders, Pacific time'],
    ['Gross paid today',report.grossPaidTodayCents===null?'Unknown':`$${(report.grossPaidTodayCents/100).toFixed(2)}`,'Before refunds, fees, COGS and expenses'],
  ]:[]
  return <AdminPage>
    <AdminPageHeader title="Live View" description="Privacy-aware, near-live first-party store activity. No personal visitor information or exact locations."/>
    <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
      <button type="button" onClick={()=>void load()} className="rounded border border-neutral-300 px-3 py-2">Refresh now</button>
      <button type="button" onClick={()=>setPaused(v=>!v)} className="rounded border border-neutral-300 px-3 py-2" aria-pressed={paused}>{paused?'Resume auto-refresh':'Pause auto-refresh'}</button>
      <span aria-live="polite">{report?`Last updated ${new Date(report.asOf).toLocaleTimeString()}`:'Awaiting data'}</span>
    </div>
    {error&&<AdminNotice tone="danger">{error}</AdminNotice>}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label,value,subtitle])=><AdminCard key={label}><p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p><p className="mt-2 text-xs text-neutral-500">{subtitle}</p></AdminCard>)}
    </div>
    {report&&<>
      <AdminCard>
        <h2 className="font-semibold">Observed shopping activity (last 30 minutes)</h2>
        <p className="mt-1 text-xs text-neutral-500">Counts use unique consenting tracked sessions, except purchase events deduplicated by authoritative order ID. Stages do not represent a verified conversion cohort.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{([
          ['Sessions with activity',report.observedFunnel30m.sessionsWithEvents],
          ['Viewed a product',report.observedFunnel30m.productViewSessions],
          ['Added to cart',report.observedFunnel30m.addToCartSessions],
          ['Started checkout',report.observedFunnel30m.checkoutStartSessions],
          ['Tracked purchases',report.observedFunnel30m.authoritativePurchaseEvents],
        ] as const).map(([title,n])=><div key={title} className="min-w-0 rounded border border-neutral-200 p-3">
          <p className="text-xs text-neutral-500">{title}</p><p className="mt-2 text-xl font-semibold tabular-nums">{num(n)}</p>
        </div>)}</div>
      </AdminCard>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {([
          ['Devices',report.devices.map(v=>[v.device,v.sessions] as const)],
          ['Top viewed products (30m)',report.products.map(v=>[v.name,v.views] as const)],
          ['UTM sources (30m)',report.sources.map(v=>[v.source,v.sessions] as const)],
        ] as const).map(([title,items])=><AdminCard key={title}><h2 className="font-semibold">{title}</h2><div className="mt-3 space-y-2 text-sm">{items.length===0?<p className="text-neutral-500">No tracked activity.</p>:items.map(([name,n],i)=><div key={i} className="flex justify-between gap-3"><span className="min-w-0 truncate" title={name}>{name}</span><span className="tabular-nums">{n}</span></div>)}</div></AdminCard>)}
      </div>
      <div className="mt-5 text-xs text-neutral-500"><h2 className="font-semibold">Data limitations</h2><ul className="mt-2 list-inside list-disc space-y-1">{report.limitations.map(s=><li key={s}>{s}</li>)}</ul></div>
    </>}
  </AdminPage>
}
