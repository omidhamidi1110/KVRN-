'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type Agent = {
  id: string
  name: string
  department: string
  enabled: boolean
  autonomy_level: string
  status: string
  model_role: string
  last_heartbeat_at?: string | null
}

type Action = {
  id: string
  agent_id: string
  agent_name: string
  action_type: string
  summary: string
  confidence: number | string | null
  risk_level: string
  permission_level: string
  status: string
  model_provider?: string | null
  model_name?: string | null
  estimated_cost_micros: number | string
  created_at: string
}

type Approval = {
  id: string
  action_id: string
  agent_name: string
  summary: string
  confidence: number | string | null
  risk_level: string
  permission_level: string
  requested_at: string
}

type Alert = {
  id: string
  agent_name: string
  severity: string
  category: string
  title: string
  summary: string
  disposition: string
  pushover_status: string
  occurrence_count: number
  last_seen_at: string
  resolved_at?: string | null
}

type Capability = { id: string; department: string; label: string; status: string; note: string }
type IntegrationState = {
  id: string; department: string; provider: string; enabled: boolean; connection_state: string
  last_success_at?: string | null; last_failure_at?: string | null; last_error_code?: string | null
}
type MarketTarget = {
  id: string; name: string; target_type: string; canonical_url: string | null; marketplace?: string | null
  active: boolean; priority: number; last_observed_at?: string | null; observation_count: number
}
type SupplyProfile = {
  variant_id:string; product_name:string; sku:string; color_name:string; size:string; supplier_name?:string|null
  lead_time_days?:number|null; safety_buffer_days?:number|null; target_cover_days?:number|null; moq_units?:number|null
  planning_unit_quote_cents?:number|null; profile_active:boolean
}

type SocialAnalysis = {
  id:string; platform:string; content_id?:string|null; content_kind:string; captured_at:string
  metrics?: { observedMetrics?:Record<string,unknown>; analysis?:Record<string,unknown>; model?:string; provider?:string; aiCostMicros?:number; durationSeconds?:number }
}

type AgentPerformance = {
  id: string; name: string; department: string; autonomy_level: string; enabled: boolean
  proposed_count: number; executed_count: number; succeeded_count: number; failed_count: number
  owner_override_count: number; escalation_count: number; ai_cost_micros: number | string
  success_rate_pct: number | string | null
}
type QaFeature = {
  id: string; name: string; area: string; criticality: string; enabled: boolean; production_safe: boolean
  last_passed_at?: string | null; last_failed_at?: string | null; test_count: number
}
type QaRun = {
  id: string; trigger_type: string; environment: string; commit_sha?: string | null; status: string
  total_count: number; passed_count: number; failed_count: number; skipped_count: number; started_at: string; completed_at?: string | null
}

type EvalRun = {
  id:string; suite:string; evaluation_model_id:string; provider?:string|null; model?:string|null; status:string
  case_count:number; passed_count:number; failed_count:number; score:number|string|null; cost_micros:number|string
  started_at:string; completed_at?:string|null
}

type Data = {
  overview: {
    agents: Agent[]
    actions: { today_actions: number; pending_actions: number; failed_24h: number }
    approvals: number
    alerts: { open: number; critical: number }
    usage: { month_cost: number | string; today_cost: number | string; today_calls: number }
    qa: { features: number; never_passed: number; currently_failing: number }
  }
  budget: {
    monthSpendMicros: number
    activeReservationMicros: number
    orphanedReservationMicros: number
    effectiveCommittedMicros: number
    targetMonthlyMicros: number
    warning1Micros: number
    warning2Micros: number
    essentialOnlyMicros: number
    operationalCutoffMicros: number
    absoluteCeilingMicros: number
    manuallyLocked: boolean
    mode: string
    remainingToOperationalCutoffMicros: number
  }
  actions: Action[]
  approvals: Approval[]
  alerts: Alert[]
  performance: AgentPerformance[]
  qaDetail: { features: QaFeature[]; runs: QaRun[] }
  capabilities: Capability[]
  integrations: IntegrationState[]
  marketTargets: MarketTarget[]
  supplyProfiles: SupplyProfile[]
  socialAnalyses: SocialAnalysis[]
  evals: { runs: EvalRun[]; caseCounts: Array<{suite:string;target_agent_id:string;enabled_cases:number}> }
  latestBrief: null | {
    business_date: string
    summary: string
    pushover_status: string
    generated_at: string
    sent_at: string | null
  }
  settings: {
    businessTimezone: string
    dailyBriefHourLocal: number
    quietHoursEnabled: boolean
    quietHoursStartLocal: number
    quietHoursEndLocal: number
    noncriticalPushLimitDay: number
  }
}

type Tab = 'overview' | 'approvals' | 'agents' | 'activity' | 'alerts' | 'spend' | 'performance' | 'qa' | 'evals' | 'social' | 'research' | 'supply' | 'connections' | 'settings'

function usd(micros: number | string | null | undefined) {
  return `$${(Number(micros ?? 0) / 1_000_000).toFixed(2)}`
}

function dateTime(v: string | null | undefined) {
  if (!v) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(v))
}

function badgeClass(kind: string) {
  if (['healthy','idle','succeeded','sent','trusted','green','low','info','normal'].includes(kind)) return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (['active','running','approved','limited'].includes(kind)) return 'border-blue-200 bg-blue-50 text-blue-700'
  if (['waiting','pending','pending_approval','approval','medium','reduced','essential_only','yellow'].includes(kind)) return 'border-amber-200 bg-amber-50 text-amber-700'
  if (['critical','high','failed','error','locked','disabled','red','rejected','blocked'].includes(kind)) return 'border-red-200 bg-red-50 text-red-700'
  return 'border-black/10 bg-black/[0.03] text-black/55'
}

function Badge({ value }: { value: string }) {
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-medium uppercase tracking-[0.10em] ${badgeClass(value)}`}>{value.replaceAll('_', ' ')}</span>
}

function Card({ label, value, note, danger = false }: { label: string; value: string | number; note?: string; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-black/[0.07] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      <p className="text-[9px] font-medium uppercase tracking-[0.16em] text-black/35">{label}</p>
      <p className={`mt-4 text-[28px] font-medium tracking-[-0.04em] ${danger ? 'text-red-600' : 'text-[#171717]'}`}>{value}</p>
      {note && <p className="mt-1 text-[11px] text-black/35">{note}</p>}
    </div>
  )
}

export function AiOperationsClient() {
  const [data, setData] = useState<Data | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [settingsDraft, setSettingsDraft] = useState<Data['settings'] | null>(null)
  const [researchDraft, setResearchDraft] = useState({ name:'', canonicalUrl:'', targetType:'competitor', marketplace:'', priority:3 })
  const [videoDraft, setVideoDraft] = useState({ platform:'youtube', videoUri:'', durationSeconds:60, contentId:'' })
  const [supplyDraft, setSupplyDraft] = useState<Record<string,{supplierName:string;leadTimeDays:number;safetyBufferDays:number;targetCoverDays:number;moqUnits:number;planningUnitQuoteCents:string;active:boolean}>>({})

  const load = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/ai/overview', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Unable to load AI Operations.')
      setData(json)
      setSettingsDraft(json.settings)
    } catch (e: any) {
      setError(String(e?.message ?? 'Unable to load AI Operations.'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const systemStatus = useMemo(() => {
    if (!data) return 'unknown'
    if (data.budget.mode === 'locked' || Number(data.overview.alerts.critical) > 0) return 'attention'
    if (Number(data.overview.actions.failed_24h) > 0 || Number(data.overview.qa.currently_failing) > 0) return 'degraded'
    return 'healthy'
  }, [data])

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusy(id)
    try {
      const res = await fetch(`/api/admin/ai/approvals/${id}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Decision failed.')
      await load(true)
    } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setBusy('') }
  }

  async function resolveAlert(id: string) {
    setBusy(`alert:${id}`)
    try {
      const res = await fetch(`/api/admin/ai/alerts/${id}/resolve`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Alert resolve failed.')
      await load(true)
    } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setBusy('') }
  }

  async function toggleBudgetLock() {
    if (!data) return
    setBusy('budget')
    try {
      const res = await fetch('/api/admin/ai/budget', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manuallyLocked: !data.budget.manuallyLocked }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Budget lock update failed.')
      await load(true)
    } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setBusy('') }
  }

  async function updateAgent(agent: Agent, patch: { enabled?: boolean; autonomyLevel?: string }) {
    setBusy(agent.id)
    try {
      const res = await fetch('/api/admin/ai/agents', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agent.id, ...patch }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Agent update failed.')
      await load(true)
    } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setBusy('') }
  }

  function supplyValues(p: SupplyProfile) {
    return supplyDraft[p.variant_id] || { supplierName:p.supplier_name||'', leadTimeDays:Number(p.lead_time_days??30), safetyBufferDays:Number(p.safety_buffer_days??14), targetCoverDays:Number(p.target_cover_days??60), moqUnits:Number(p.moq_units??1), planningUnitQuoteCents:p.planning_unit_quote_cents==null?'':String(p.planning_unit_quote_cents), active:p.profile_active }
  }

  async function saveSupplyProfile(p: SupplyProfile) {
    const d=supplyValues(p); setBusy(`supply:${p.variant_id}`)
    try {
      const res=await fetch('/api/admin/ai/supply-profiles',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({variantId:p.variant_id,...d})})
      const json=await res.json(); if(!res.ok) throw new Error(json.error||'Unable to save supply profile.')
      setSupplyDraft(prev=>{const n={...prev};delete n[p.variant_id];return n}); await load(true)
    } catch(e:any){setError(String(e?.message??e))} finally{setBusy('')}
  }

  async function createMarketTarget() {
    if (!researchDraft.name.trim() || !researchDraft.canonicalUrl.trim()) { setError('Research target name and URL are required.'); return }
    setBusy('research:create')
    try {
      const res = await fetch('/api/admin/ai/market-targets', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(researchDraft) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Unable to create research target.')
      setResearchDraft({ name:'', canonicalUrl:'', targetType:'competitor', marketplace:'', priority:3 })
      await load(true)
    } catch (e:any) { setError(String(e?.message ?? e)) } finally { setBusy('') }
  }

  async function updateMarketTarget(target: MarketTarget, patch: Record<string, unknown>) {
    setBusy(`research:${target.id}`)
    try {
      const res = await fetch('/api/admin/ai/market-targets', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:target.id,...patch}) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Unable to update research target.')
      await load(true)
    } catch (e:any) { setError(String(e?.message ?? e)) } finally { setBusy('') }
  }


  async function queueVideoAnalysis() {
    if (!videoDraft.videoUri.trim()) { setError('Video URL is required.'); return }
    setBusy('video:queue')
    try {
      const res=await fetch('/api/admin/ai/video-analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(videoDraft)})
      const json=await res.json(); if(!res.ok) throw new Error(json.error||'Unable to queue video analysis.')
      setVideoDraft({...videoDraft,videoUri:'',contentId:''})
      await load(true)
    } catch(e:any){setError(String(e?.message??e))} finally{setBusy('')}
  }

  async function runEvaluation(evaluationModelId: 'haiku_5_5' | 'gpt_6_luna') {
    setBusy(`eval:${evaluationModelId}`)
    try {
      const res = await fetch('/api/admin/ai/evals', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({suite:'support_triage',evaluationModelId,maxCases:10}),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Evaluation failed.')
      await load(true)
    } catch (e:any) { setError(String(e?.message ?? e)) }
    finally { setBusy('') }
  }

  async function saveSettings() {
    if (!settingsDraft) return
    setBusy('settings')
    try {
      const res = await fetch('/api/admin/ai/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settingsDraft),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Settings update failed.')
      await load(true)
    } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setBusy('') }
  }

  if (loading) return (
    <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">
      <div className="animate-pulse"><div className="h-8 w-56 rounded bg-black/10"/><div className="mt-8 grid grid-cols-2 gap-3 xl:grid-cols-4">{[0,1,2,3].map(i=><div key={i} className="h-32 rounded-xl bg-white border border-black/[0.06]"/>)}</div></div>
    </div>
  )

  const agents = data?.overview.agents ?? []
  const active = agents.filter(a => a.status === 'active').length
  const waiting = agents.filter(a => a.status === 'waiting').length
  const enabled = agents.filter(a => a.enabled).length
  const spendPct = data ? Math.min(100, (data.budget.effectiveCommittedMicros / data.budget.operationalCutoffMicros) * 100) : 0

  const tabs: Array<[Tab, string]> = [
    ['overview','Overview'], ['approvals','Approvals'], ['agents','Agents'], ['activity','Activity'],
    ['alerts','Alerts'], ['spend','Spend'], ['performance','Performance'], ['qa','QA'], ['evals','Evals'], ['social','Social'], ['research','Research'], ['supply','Supply'], ['connections','Connections'], ['settings','Settings'],
  ]

  return (
    <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">
      <div className="mb-7 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-black/35">KVRN AI Operating System</p>
          <div className="flex items-center gap-3">
            <h1 className="text-[30px] font-medium tracking-[-0.035em] text-[#171717] sm:text-[34px]">AI Operations</h1>
            <Badge value={systemStatus}/>
          </div>
          <p className="mt-2 max-w-2xl text-[13px] leading-5 text-black/45">One control center for agents, approvals, every AI action, spend protection, Chief alerts, and automated feature verification.</p>
        </div>
        <div className="flex flex-wrap gap-2"><Link href="/admin/ai/insights" className="inline-flex h-10 items-center rounded-lg border border-black/[0.10] bg-white px-4 text-[12px] font-medium text-black/65 shadow-sm hover:border-black/20">Private insights</Link><button onClick={()=>load(true)} disabled={refreshing} className="h-10 rounded-lg border border-black/[0.10] bg-white px-4 text-[12px] font-medium text-black/65 shadow-sm hover:border-black/20 disabled:opacity-50">{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
      </div>

      {error && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">{error}</div>}

      <div className="mb-7 flex gap-1 overflow-x-auto rounded-xl border border-black/[0.07] bg-white p-1.5">
        {tabs.map(([id,label]) => <button key={id} onClick={()=>setTab(id)} className={`min-w-max rounded-lg px-3.5 py-2 text-[11px] font-medium transition ${tab===id ? 'bg-[#111] text-white' : 'text-black/45 hover:bg-black/[0.04] hover:text-black'}`}>{label}{id==='approvals' && data?.overview.approvals ? ` (${data.overview.approvals})` : ''}</button>)}
      </div>

      {data && tab === 'overview' && <>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Card label="Agents" value={`${enabled} / ${agents.length}`} note={`${active} active • ${waiting} waiting`}/>
          <Card label="Needs you" value={data.overview.approvals} note="Pending approvals" danger={data.overview.approvals>0}/>
          <Card label="AI today" value={usd(data.overview.usage.today_cost)} note={`${data.overview.usage.today_calls} model calls`}/>
          <Card label="QA coverage" value={data.overview.qa.features} note={`${data.overview.qa.currently_failing} currently failing`} danger={data.overview.qa.currently_failing>0}/>
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-[1.25fr_.75fr]">
          <section className="rounded-xl border border-black/[0.07] bg-white p-5 sm:p-6">
            <div className="flex items-center justify-between"><div><p className="text-[9px] uppercase tracking-[0.16em] text-black/30">Chief Operator</p><h2 className="mt-1 text-[17px] font-medium">Latest daily brief</h2></div>{data.latestBrief && <Badge value={data.latestBrief.pushover_status}/>}</div>
            {data.latestBrief ? <><pre className="mt-5 whitespace-pre-wrap font-sans text-[13px] leading-6 text-black/65">{data.latestBrief.summary}</pre><p className="mt-4 text-[10px] text-black/30">{data.latestBrief.sent_at ? `Sent ${dateTime(data.latestBrief.sent_at)}` : `Generated ${dateTime(data.latestBrief.generated_at)}`}</p></> : <p className="mt-5 text-[12px] text-black/40">No daily brief has been generated yet.</p>}
          </section>
          <section className="rounded-xl border border-black/[0.07] bg-white p-5 sm:p-6">
            <div className="flex items-center justify-between"><div><p className="text-[9px] uppercase tracking-[0.16em] text-black/30">Monthly AI</p><h2 className="mt-1 text-[17px] font-medium">{usd(data.budget.monthSpendMicros)} <span className="text-black/25">/ {usd(data.budget.operationalCutoffMicros)}</span></h2></div><Badge value={data.budget.mode}/></div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-black/[0.06]"><div className="h-full bg-[#111] transition-all" style={{width:`${spendPct}%`}}/></div>
            <p className="mt-3 text-[11px] text-black/35">Target {usd(data.budget.targetMonthlyMicros)} • Absolute owner ceiling {usd(data.budget.absoluteCeilingMicros)}</p>
            <button onClick={toggleBudgetLock} disabled={busy==='budget'} className={`mt-5 w-full rounded-lg border px-3 py-2.5 text-[11px] font-medium ${data.budget.manuallyLocked ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{data.budget.manuallyLocked ? 'Unlock AI spending' : 'Emergency lock all paid AI'}</button>
          </section>
        </div>

        <section className="mt-6 rounded-xl border border-black/[0.07] bg-white">
          <div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">Recent AI activity</h2></div>
          <div className="divide-y divide-black/[0.05]">{data.actions.slice(0,8).map(a=><div key={a.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="min-w-0"><div className="flex items-center gap-2"><span className="text-[11px] font-medium">{a.agent_name}</span><Badge value={a.status}/></div><p className="mt-1 truncate text-[12px] text-black/50">{a.summary}</p></div><div className="text-right text-[10px] text-black/30">{dateTime(a.created_at)}<br/>{usd(a.estimated_cost_micros)}</div></div>)}</div>
          {data.actions.length===0 && <p className="px-6 py-8 text-[12px] text-black/35">No AI actions yet.</p>}
        </section>
      </>}

      {data && tab === 'approvals' && <section className="rounded-xl border border-black/[0.07] bg-white">
        <div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">Needs your decision</h2><p className="mt-1 text-[11px] text-black/35">Yellow/red actions remain blocked until allowed by policy and approved here.</p></div>
        <div className="divide-y divide-black/[0.05]">{data.approvals.map(a=><div key={a.id} className="p-5 sm:p-6"><div className="flex flex-wrap items-center gap-2"><span className="text-[12px] font-medium">{a.agent_name}</span><Badge value={a.risk_level}/><Badge value={a.permission_level}/></div><p className="mt-3 text-[13px] leading-5 text-black/65">{a.summary}</p><div className="mt-4 flex gap-2"><button disabled={busy===a.id} onClick={()=>decide(a.id,'approved')} className="rounded-lg bg-[#111] px-4 py-2 text-[11px] font-medium text-white disabled:opacity-40">Approve</button><button disabled={busy===a.id} onClick={()=>decide(a.id,'rejected')} className="rounded-lg border border-black/10 px-4 py-2 text-[11px] font-medium text-black/60 disabled:opacity-40">Reject</button></div></div>)}</div>
        {data.approvals.length===0 && <p className="px-6 py-10 text-[12px] text-black/35">Nothing needs your approval.</p>}
      </section>}

      {data && tab === 'agents' && <section className="grid gap-3 lg:grid-cols-2">{agents.map(a=><div key={a.id} className="rounded-xl border border-black/[0.07] bg-white p-5"><div className="flex items-start justify-between gap-4"><div><p className="text-[9px] uppercase tracking-[0.14em] text-black/30">{a.department}</p><h3 className="mt-1 text-[15px] font-medium">{a.name}</h3><div className="mt-2 flex gap-2"><Badge value={a.status}/><Badge value={a.autonomy_level}/><Badge value={a.model_role}/></div></div><button disabled={busy===a.id} onClick={()=>updateAgent(a,{enabled:!a.enabled})} className={`rounded-lg border px-3 py-2 text-[10px] font-medium ${a.enabled ? 'border-black/10 text-black/45' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>{a.enabled?'Disable':'Enable'}</button></div><div className="mt-5 flex flex-wrap gap-2">{['shadow','approval','limited','trusted'].map(level=><button key={level} disabled={busy===a.id || !a.enabled} onClick={()=>updateAgent(a,{autonomyLevel:level})} className={`rounded-md border px-2.5 py-1.5 text-[9px] uppercase tracking-[0.08em] ${a.autonomy_level===level ? 'border-black bg-black text-white' : 'border-black/[0.08] text-black/35'}`}>{level}</button>)}</div></div>)}</section>}

      {data && tab === 'activity' && <section className="rounded-xl border border-black/[0.07] bg-white"><div className="divide-y divide-black/[0.05]">{data.actions.map(a=><div key={a.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[150px_1fr_120px] sm:px-6"><div><p className="text-[11px] font-medium">{a.agent_name}</p><p className="mt-1 text-[9px] text-black/30">{dateTime(a.created_at)}</p></div><div><div className="flex flex-wrap gap-2"><Badge value={a.status}/><Badge value={a.risk_level}/>{a.model_name && <span className="text-[9px] text-black/30">{a.model_name}</span>}</div><p className="mt-2 text-[12px] leading-5 text-black/55">{a.summary}</p></div><div className="sm:text-right"><p className="text-[11px]">{usd(a.estimated_cost_micros)}</p><p className="mt-1 text-[9px] text-black/30">Confidence {a.confidence==null?'—':`${Math.round(Number(a.confidence)*100)}%`}</p></div></div>)}</div>{data.actions.length===0 && <p className="px-6 py-10 text-[12px] text-black/35">No AI activity yet.</p>}</section>}

      {data && tab === 'alerts' && <section className="rounded-xl border border-black/[0.07] bg-white"><div className="divide-y divide-black/[0.05]">{data.alerts.map(a=><div key={a.id} className={`px-5 py-4 sm:px-6 ${a.resolved_at ? 'opacity-50' : ''}`}><div className="flex flex-wrap items-center gap-2"><Badge value={a.severity}/><span className="text-[11px] font-medium">{a.title}</span><span className="text-[9px] text-black/25">{a.agent_name}</span>{a.resolved_at && <Badge value="resolved"/>}</div><p className="mt-2 text-[12px] leading-5 text-black/55">{a.summary}</p><div className="mt-2 flex flex-wrap items-center justify-between gap-3"><p className="text-[9px] text-black/30">Chief: {a.disposition.replaceAll('_',' ')} • Pushover: {a.pushover_status.replaceAll('_',' ')} • Seen {a.occurrence_count}× • {dateTime(a.last_seen_at)}</p>{!a.resolved_at && <button disabled={busy===`alert:${a.id}`} onClick={()=>resolveAlert(a.id)} className="rounded-md border border-black/[0.08] px-2.5 py-1.5 text-[9px] font-medium text-black/45 hover:bg-black/[0.03] disabled:opacity-40">Resolve</button>}</div></div>)}</div>{data.alerts.length===0 && <p className="px-6 py-10 text-[12px] text-black/35">No alerts.</p>}</section>}

      {data && tab === 'spend' && <div className="grid gap-4 lg:grid-cols-2"><section className="rounded-xl border border-black/[0.07] bg-white p-6"><p className="text-[9px] uppercase tracking-[0.16em] text-black/30">Monthly spend</p><p className="mt-3 text-[34px] font-medium tracking-[-0.04em]">{usd(data.budget.monthSpendMicros)}</p>{data.budget.activeReservationMicros>0&&<p className="mt-1 text-[10px] text-black/35">{usd(data.budget.activeReservationMicros)} currently reserved in-flight</p>}{data.budget.orphanedReservationMicros>0&&<p className="mt-1 text-[10px] text-amber-700">{usd(data.budget.orphanedReservationMicros)} conservatively held for interrupted/unsettled calls</p>}<div className="mt-5 h-2 overflow-hidden rounded-full bg-black/[0.06]"><div className="h-full bg-[#111]" style={{width:`${spendPct}%`}}/></div><div className="mt-5 space-y-2 text-[11px] text-black/45"><div className="flex justify-between"><span>Preferred target</span><span>{usd(data.budget.targetMonthlyMicros)}</span></div><div className="flex justify-between"><span>Warning 1</span><span>{usd(data.budget.warning1Micros)}</span></div><div className="flex justify-between"><span>Warning 2</span><span>{usd(data.budget.warning2Micros)}</span></div><div className="flex justify-between"><span>Essential only</span><span>{usd(data.budget.essentialOnlyMicros)}</span></div><div className="flex justify-between font-medium text-black/70"><span>Operational hard stop</span><span>{usd(data.budget.operationalCutoffMicros)}</span></div><div className="flex justify-between"><span>Owner absolute ceiling</span><span>{usd(data.budget.absoluteCeilingMicros)}</span></div></div></section><section className="rounded-xl border border-black/[0.07] bg-white p-6"><h2 className="text-[15px] font-medium">Cost policy</h2><p className="mt-3 text-[12px] leading-5 text-black/45">Normal code handles deterministic work for $0. Paid inference is reserved atomically before each call. Optional inference turns off before the hard stop; at {usd(data.budget.operationalCutoffMicros)} all paid model calls are blocked.</p><button onClick={toggleBudgetLock} disabled={busy==='budget'} className="mt-6 w-full rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[11px] font-medium text-red-700">{data.budget.manuallyLocked?'Unlock paid AI':'Emergency lock paid AI now'}</button></section></div>}

      {data && tab === 'performance' && <section className="rounded-xl border border-black/[0.07] bg-white"><div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">30-day agent performance</h2><p className="mt-1 text-[11px] text-black/35">Operational quality, owner overrides, escalations, and paid-model cost. Business-outcome scoring is added only when a result can be measured honestly.</p></div><div className="divide-y divide-black/[0.05]">{data.performance.map(p=><div key={p.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_repeat(5,minmax(70px,auto))] sm:items-center sm:px-6"><div><p className="text-[11px] font-medium">{p.name}</p><p className="mt-1 text-[9px] text-black/30">{p.department} • {p.autonomy_level}</p></div><div><p className="text-[9px] text-black/30">Executed</p><p className="text-[12px]">{p.executed_count}</p></div><div><p className="text-[9px] text-black/30">Success</p><p className="text-[12px]">{p.success_rate_pct == null ? '—' : `${Number(p.success_rate_pct).toFixed(1)}%`}</p></div><div><p className="text-[9px] text-black/30">Overrides</p><p className="text-[12px]">{p.owner_override_count}</p></div><div><p className="text-[9px] text-black/30">Escalations</p><p className="text-[12px]">{p.escalation_count}</p></div><div className="sm:text-right"><p className="text-[9px] text-black/30">AI cost</p><p className="text-[12px]">{usd(p.ai_cost_micros)}</p></div></div>)}</div></section>}

      {data && tab === 'qa' && <div className="space-y-4"><div className="grid grid-cols-2 gap-3 xl:grid-cols-4"><Card label="Registered features" value={data.overview.qa.features}/><Card label="Currently failing" value={data.overview.qa.currently_failing} danger={data.overview.qa.currently_failing>0}/><Card label="Never verified" value={data.overview.qa.never_passed} danger={data.overview.qa.never_passed>0}/><Card label="Target" value="0" note="Untested production features"/></div><section className="rounded-xl border border-black/[0.07] bg-white"><div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">Feature verification</h2></div><div className="divide-y divide-black/[0.05]">{data.qaDetail.features.map(f=>{const failing=Boolean(f.last_failed_at)&&(!f.last_passed_at||new Date(f.last_failed_at!).getTime()>new Date(f.last_passed_at!).getTime()); return <div key={f.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div><div className="flex flex-wrap items-center gap-2"><span className="text-[11px] font-medium">{f.name}</span><Badge value={failing?'failed':f.last_passed_at?'healthy':'waiting'}/><Badge value={f.criticality}/></div><p className="mt-1 text-[9px] text-black/30">{f.area} • {f.test_count} test contract{f.test_count===1?'':'s'} • {f.production_safe?'production-safe checks available':'test/preview only'}</p></div><p className="text-[9px] text-black/30">{f.last_passed_at?`Last pass ${dateTime(f.last_passed_at)}`:'Never passed'}</p></div>})}</div></section><section className="rounded-xl border border-black/[0.07] bg-white"><div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">Recent QA runs</h2></div><div className="divide-y divide-black/[0.05]">{data.qaDetail.runs.map(r=><div key={r.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div><div className="flex gap-2"><Badge value={r.status}/><span className="text-[10px] text-black/45">{r.environment} • {r.trigger_type.replaceAll('_',' ')}</span></div><p className="mt-1 text-[9px] text-black/30">{r.passed_count} passed • {r.failed_count} failed • {r.skipped_count} skipped{r.commit_sha?` • ${r.commit_sha.slice(0,8)}`:''}</p></div><p className="text-[9px] text-black/30">{dateTime(r.started_at)}</p></div>)}</div>{data.qaDetail.runs.length===0&&<p className="px-6 py-8 text-[12px] text-black/35">No QA run has been reported yet.</p>}</section></div>}

      {data && tab === 'evals' && <div className="grid gap-4 xl:grid-cols-[.72fr_1.28fr]">
        <section className="rounded-xl border border-black/[0.07] bg-white p-5 sm:p-6">
          <h2 className="text-[15px] font-medium">Cheap-model arena</h2>
          <p className="mt-2 text-[11px] leading-5 text-black/40">Runs the same synthetic, PII-free KVRN support cases through each cheap model. Every call still uses the global budget lock and AI Gateway.</p>
          <div className="mt-5 space-y-2">
            <button onClick={()=>runEvaluation('haiku_5_5')} disabled={busy.startsWith('eval:')} className="w-full rounded-lg bg-black px-4 py-2.5 text-left text-[11px] font-medium text-white disabled:opacity-40">Run Haiku 5.5 support eval</button>
            <button onClick={()=>runEvaluation('gpt_6_luna')} disabled={busy.startsWith('eval:')} className="w-full rounded-lg border border-black/10 bg-white px-4 py-2.5 text-left text-[11px] font-medium text-black/60 disabled:opacity-40">Run GPT-6 Luna support eval</button>
          </div>
          <div className="mt-5 rounded-lg bg-black/[0.025] p-3 text-[10px] leading-5 text-black/40">
            {data.evals.caseCounts.map(c=><div key={`${c.suite}:${c.target_agent_id}`} className="flex justify-between gap-3"><span>{c.suite.replaceAll('_',' ')}</span><span>{c.enabled_cases} cases</span></div>)}
          </div>
        </section>
        <section className="rounded-xl border border-black/[0.07] bg-white">
          <div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">Recent evaluation runs</h2><p className="mt-1 text-[11px] text-black/35">A model must prove itself on KVRN cases before we expand autonomy.</p></div>
          <div className="divide-y divide-black/[0.05]">{data.evals.runs.map(r=><div key={r.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_120px_110px] sm:px-6"><div><div className="flex flex-wrap gap-2"><Badge value={r.status}/><span className="text-[10px] font-medium text-black/55">{r.evaluation_model_id.replaceAll('_',' ')}</span></div><p className="mt-2 text-[10px] text-black/35">{r.suite.replaceAll('_',' ')} • {r.passed_count}/{r.case_count} passed{r.model?` • ${r.model}`:''}</p></div><div className="sm:text-right"><p className="text-[14px] font-medium">{r.score==null?'—':`${Math.round(Number(r.score)*100)}%`}</p><p className="text-[9px] text-black/30">score</p></div><div className="sm:text-right"><p className="text-[11px]">{usd(r.cost_micros)}</p><p className="mt-1 text-[9px] text-black/30">{dateTime(r.started_at)}</p></div></div>)}</div>
          {data.evals.runs.length===0&&<p className="px-6 py-10 text-[12px] text-black/35">No model evaluation has been run yet.</p>}
        </section>
      </div>}

      {data && tab === 'social' && <div className="grid gap-4 xl:grid-cols-[.7fr_1.3fr]">
        <section className="rounded-xl border border-black/[0.07] bg-white p-5 sm:p-6">
          <h2 className="text-[15px] font-medium">Analyze a short video</h2>
          <p className="mt-2 text-[11px] leading-5 text-black/40">Queues a budget-capped Gemini analysis. Public YouTube URLs work now; TikTok/Instagram media will plug in when their approved media connector is available. Nothing is posted or changed automatically.</p>
          <div className="mt-5 space-y-3">
            <select value={videoDraft.platform} onChange={e=>setVideoDraft({...videoDraft,platform:e.target.value})} className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-[12px]"><option value="youtube">YouTube</option><option value="tiktok">TikTok</option><option value="instagram">Instagram</option><option value="other">Other</option></select>
            <input placeholder="Public YouTube URL or trusted Gemini File URI" value={videoDraft.videoUri} onChange={e=>setVideoDraft({...videoDraft,videoUri:e.target.value})} className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-[12px]"/>
            <div className="grid grid-cols-2 gap-3"><input placeholder="Content ID (optional)" value={videoDraft.contentId} onChange={e=>setVideoDraft({...videoDraft,contentId:e.target.value})} className="rounded-lg border border-black/10 px-3 py-2.5 text-[12px]"/><label className="text-[9px] text-black/30">Duration seconds<input type="number" min={1} max={300} value={videoDraft.durationSeconds} onChange={e=>setVideoDraft({...videoDraft,durationSeconds:Number(e.target.value)})} className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-[12px] text-black/70"/></label></div>
            <button onClick={queueVideoAnalysis} disabled={busy==='video:queue'} className="w-full rounded-lg bg-black px-4 py-2.5 text-[11px] font-medium text-white disabled:opacity-40">Queue analysis</button>
          </div>
        </section>
        <section className="rounded-xl border border-black/[0.07] bg-white"><div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">Recent video intelligence</h2><p className="mt-1 text-[11px] text-black/35">Observed metrics and AI interpretation are stored separately from canonical sales/accounting data.</p></div><div className="divide-y divide-black/[0.05]">{data.socialAnalyses.map(v=>{const a=v.metrics?.analysis||{};const strengths=Array.isArray((a as any).strengths)?(a as any).strengths:[];const tests=Array.isArray((a as any).nextTests)?(a as any).nextTests:[];return <div key={v.id} className="px-5 py-4 sm:px-6"><div className="flex flex-wrap items-center gap-2"><Badge value={v.platform}/><span className="text-[10px] text-black/35">{v.content_id||'manual'} • {dateTime(v.captured_at)}</span>{v.metrics?.aiCostMicros!=null&&<span className="text-[9px] text-black/30">{usd(v.metrics.aiCostMicros)}</span>}</div><p className="mt-2 text-[11px] text-black/60">{strengths.slice(0,2).join(' • ')||'Analysis stored.'}</p>{tests.length>0&&<p className="mt-2 text-[10px] text-black/40"><b className="font-medium text-black/55">Next test:</b> {String(tests[0])}</p>}</div>})}</div>{data.socialAnalyses.length===0&&<p className="px-6 py-10 text-[12px] text-black/35">No video analyses yet.</p>}</section>
      </div>}

      {data && tab === 'research' && <div className="grid gap-4 xl:grid-cols-[.7fr_1.3fr]">
        <section className="rounded-xl border border-black/[0.07] bg-white p-5 sm:p-6">
          <h2 className="text-[15px] font-medium">Add approved research target</h2>
          <p className="mt-2 text-[11px] leading-5 text-black/40">Only public HTTPS URLs are accepted. The agent hashes pages first; unchanged pages use $0 AI.</p>
          <div className="mt-5 space-y-3">
            <input placeholder="Brand / product name" value={researchDraft.name} onChange={e=>setResearchDraft({...researchDraft,name:e.target.value})} className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-[12px]"/>
            <input placeholder="https://competitor.com/product" value={researchDraft.canonicalUrl} onChange={e=>setResearchDraft({...researchDraft,canonicalUrl:e.target.value})} className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-[12px]"/>
            <div className="grid grid-cols-2 gap-3"><select value={researchDraft.targetType} onChange={e=>setResearchDraft({...researchDraft,targetType:e.target.value})} className="rounded-lg border border-black/10 px-3 py-2.5 text-[12px]"><option value="competitor">Competitor</option><option value="product">Product</option><option value="marketplace">Marketplace</option><option value="category">Category</option><option value="creator">Creator</option></select><input type="number" min={1} max={5} value={researchDraft.priority} onChange={e=>setResearchDraft({...researchDraft,priority:Number(e.target.value)})} className="rounded-lg border border-black/10 px-3 py-2.5 text-[12px]" title="Priority 1 = highest"/></div>
            <input placeholder="Marketplace (optional: Amazon, TikTok Shop…)" value={researchDraft.marketplace} onChange={e=>setResearchDraft({...researchDraft,marketplace:e.target.value})} className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-[12px]"/>
            <button onClick={createMarketTarget} disabled={busy==='research:create'} className="w-full rounded-lg bg-black px-4 py-2.5 text-[11px] font-medium text-white disabled:opacity-40">Add research target</button>
          </div>
        </section>
        <section className="rounded-xl border border-black/[0.07] bg-white"><div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">Market intelligence targets</h2><p className="mt-1 text-[11px] text-black/35">Priority 1 is highest. Disable a target to stop unattended refreshes.</p></div><div className="divide-y divide-black/[0.05]">{data.marketTargets.map(t=><div key={t.id} className="px-5 py-4 sm:px-6"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-[12px] font-medium">{t.name}</span><Badge value={t.active?'active':'disabled'}/><span className="text-[9px] uppercase tracking-[0.08em] text-black/30">P{t.priority} • {t.target_type}</span></div><p className="mt-1 truncate text-[10px] text-black/35">{t.canonical_url}</p><p className="mt-2 text-[9px] text-black/30">Last observed {dateTime(t.last_observed_at)} • {t.observation_count} observations</p></div><button disabled={busy===`research:${t.id}`} onClick={()=>updateMarketTarget(t,{active:!t.active})} className="rounded-lg border border-black/10 px-3 py-2 text-[10px] font-medium text-black/50 disabled:opacity-40">{t.active?'Pause':'Enable'}</button></div></div>)}</div>{data.marketTargets.length===0&&<p className="px-6 py-10 text-[12px] text-black/35">No approved research targets yet.</p>}</section>
      </div>}

      {data && tab === 'supply' && <section className="rounded-xl border border-black/[0.07] bg-white"><div className="border-b border-black/[0.06] px-5 py-4 sm:px-6"><h2 className="text-[15px] font-medium">Supplier planning profiles</h2><p className="mt-1 text-[11px] text-black/35">Planning only. These values never change FIFO/COGS and the AI can never place a PO automatically.</p></div><div className="divide-y divide-black/[0.05]">{data.supplyProfiles.map(p=>{const d=supplyValues(p);const set=(patch:any)=>setSupplyDraft(prev=>({...prev,[p.variant_id]:{...d,...patch}}));return <div key={p.variant_id} className="px-5 py-5 sm:px-6"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-[12px] font-medium">{p.product_name} — {p.color_name} / {p.size}</p><p className="mt-1 font-mono text-[9px] text-black/30">{p.sku}</p></div><Badge value={d.active?'active':'disabled'}/></div><div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6"><input placeholder="Supplier" value={d.supplierName} onChange={e=>set({supplierName:e.target.value})} className="rounded-lg border border-black/10 px-2.5 py-2 text-[11px]"/><label className="text-[9px] text-black/30">Lead days<input type="number" min={1} max={365} value={d.leadTimeDays} onChange={e=>set({leadTimeDays:Number(e.target.value)})} className="mt-1 w-full rounded-lg border border-black/10 px-2.5 py-2 text-[11px] text-black/70"/></label><label className="text-[9px] text-black/30">Safety days<input type="number" min={0} max={180} value={d.safetyBufferDays} onChange={e=>set({safetyBufferDays:Number(e.target.value)})} className="mt-1 w-full rounded-lg border border-black/10 px-2.5 py-2 text-[11px] text-black/70"/></label><label className="text-[9px] text-black/30">Target cover<input type="number" min={7} max={365} value={d.targetCoverDays} onChange={e=>set({targetCoverDays:Number(e.target.value)})} className="mt-1 w-full rounded-lg border border-black/10 px-2.5 py-2 text-[11px] text-black/70"/></label><label className="text-[9px] text-black/30">MOQ<input type="number" min={1} value={d.moqUnits} onChange={e=>set({moqUnits:Number(e.target.value)})} className="mt-1 w-full rounded-lg border border-black/10 px-2.5 py-2 text-[11px] text-black/70"/></label><label className="text-[9px] text-black/30">Quote cents<input type="number" min={0} value={d.planningUnitQuoteCents} onChange={e=>set({planningUnitQuoteCents:e.target.value})} className="mt-1 w-full rounded-lg border border-black/10 px-2.5 py-2 text-[11px] text-black/70"/></label></div><div className="mt-3 flex gap-2"><button onClick={()=>saveSupplyProfile(p)} disabled={busy===`supply:${p.variant_id}`} className="rounded-lg bg-black px-3 py-2 text-[10px] font-medium text-white disabled:opacity-40">Save</button><button onClick={()=>{set({active:!d.active})}} className="rounded-lg border border-black/10 px-3 py-2 text-[10px] text-black/50">{d.active?'Disable plan':'Enable plan'}</button></div></div>})}</div>{data.supplyProfiles.length===0&&<p className="px-6 py-10 text-[12px] text-black/35">No active product variants.</p>}</section>}

      {data && tab === 'settings' && settingsDraft && <section className="rounded-xl border border-black/[0.07] bg-white p-6"><h2 className="text-[15px] font-medium">Chief notification settings</h2><p className="mt-2 max-w-2xl text-[11px] leading-5 text-black/40">The daily Chief summary is mandatory. Quiet hours suppress non-emergency pushes; checkout, payment, security, site-outage, data-exposure, financial-integrity and critical incidents may still interrupt you.</p><div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><label className="text-[10px] text-black/45"><span className="mb-2 block uppercase tracking-[0.10em] text-black/30">Timezone</span><input value={settingsDraft.businessTimezone} onChange={e=>setSettingsDraft({...settingsDraft,businessTimezone:e.target.value})} className="w-full rounded-lg border border-black/10 px-3 py-2 text-[12px]"/></label><label className="text-[10px] text-black/45"><span className="mb-2 block uppercase tracking-[0.10em] text-black/30">Daily brief hour (0-23)</span><input type="number" min={0} max={23} value={settingsDraft.dailyBriefHourLocal} onChange={e=>setSettingsDraft({...settingsDraft,dailyBriefHourLocal:Number(e.target.value)})} className="w-full rounded-lg border border-black/10 px-3 py-2 text-[12px]"/></label><label className="text-[10px] text-black/45"><span className="mb-2 block uppercase tracking-[0.10em] text-black/30">Noncritical push limit/day</span><input type="number" min={0} max={50} value={settingsDraft.noncriticalPushLimitDay} onChange={e=>setSettingsDraft({...settingsDraft,noncriticalPushLimitDay:Number(e.target.value)})} className="w-full rounded-lg border border-black/10 px-3 py-2 text-[12px]"/></label><label className="flex items-center gap-2 text-[11px] text-black/55"><input type="checkbox" checked={settingsDraft.quietHoursEnabled} onChange={e=>setSettingsDraft({...settingsDraft,quietHoursEnabled:e.target.checked})}/><span>Enable quiet hours</span></label><label className="text-[10px] text-black/45"><span className="mb-2 block uppercase tracking-[0.10em] text-black/30">Quiet starts</span><input type="number" min={0} max={23} value={settingsDraft.quietHoursStartLocal} onChange={e=>setSettingsDraft({...settingsDraft,quietHoursStartLocal:Number(e.target.value)})} className="w-full rounded-lg border border-black/10 px-3 py-2 text-[12px]"/></label><label className="text-[10px] text-black/45"><span className="mb-2 block uppercase tracking-[0.10em] text-black/30">Quiet ends</span><input type="number" min={0} max={23} value={settingsDraft.quietHoursEndLocal} onChange={e=>setSettingsDraft({...settingsDraft,quietHoursEndLocal:Number(e.target.value)})} className="w-full rounded-lg border border-black/10 px-3 py-2 text-[12px]"/></label></div><button onClick={saveSettings} disabled={busy==='settings'} className="mt-6 rounded-lg bg-black px-4 py-2.5 text-[11px] font-medium text-white disabled:opacity-40">Save Chief settings</button></section>}

      {data && tab === 'connections' && <section className="grid gap-3 lg:grid-cols-2">{data.capabilities.map(c=>{const sync=data.integrations.find(i=>i.id===c.id);return <div key={c.id} className="rounded-xl border border-black/[0.07] bg-white p-5"><div className="flex items-start justify-between gap-4"><div><p className="text-[9px] uppercase tracking-[0.14em] text-black/30">{c.department.replaceAll('_',' ')}</p><h3 className="mt-1 text-[14px] font-medium">{c.label}</h3></div><Badge value={sync?.connection_state || c.status}/></div><p className="mt-3 text-[11px] leading-5 text-black/45">{c.note}</p>{sync&&<div className="mt-4 grid grid-cols-2 gap-2 rounded-lg bg-black/[0.025] p-3 text-[9px] text-black/35"><span>Last success<br/><b className="font-medium text-black/55">{dateTime(sync.last_success_at)}</b></span><span>Last failure<br/><b className="font-medium text-black/55">{dateTime(sync.last_failure_at)}</b></span>{sync.last_error_code&&<span className="col-span-2">Last error<br/><b className="font-mono font-medium text-red-600">{sync.last_error_code}</b></span>}</div>}</div>})}</section>}
    </div>
  )
}
