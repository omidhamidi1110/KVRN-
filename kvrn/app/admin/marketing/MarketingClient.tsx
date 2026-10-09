'use client'
/** Marketing editorial workspace. There is intentionally NO send, dispatch, recipient export,
 * provider sync, or AI autopublish action in this component. */
import { useCallback, useEffect, useState } from 'react'
import { AdminPage, AdminPageHeader, AdminCard, AdminNotice, AdminButton, adminButtonClass } from '@/components/admin/ui/AdminUI'
import Link from 'next/link'
import type { CampaignDraft, DraftInput, CampaignChannel, CampaignAudience } from '@/lib/marketing-campaign-drafts'
import type { MarketingOverview } from '@/lib/marketing-overview'
import type { Gate } from '@/lib/marketing-suite-readiness'
import {composeMarketingSms} from '@/lib/marketing-message-composer'
import type {AudiencePreview} from '@/lib/marketing-audience-preview'
import type {CalendarItem} from '@/lib/marketing-editorial-calendar'
import type {MarketingSnapshotSummary} from '@/lib/marketing-audience-snapshot'
import type {StagedDeliverySummary} from '@/lib/marketing-staged-delivery'
import type {PlanReadinessResult} from '@/lib/marketing-plan-audit'
import type {DeliveryAttemptTotals} from '@/lib/marketing-attempt-audit'
import type {MarketingBudgetStatus} from '@/lib/marketing-budget-status'
import type {CopyTemplateSummary} from '@/lib/marketing-copy-templates'
import {renderStaticBrandCopy} from '@/lib/marketing-copy-template-tokens'

const freshDraft = (): DraftInput => ({ channel: 'email', title: '', subject: '', body: '', audience: 'all-consenting' })
const STATES: Record<string, string> = { draft: 'Draft', reviewed: 'Copy reviewed', archived: 'Archived' }

type EditorialAction = 'review' | 'reopen' | 'archive'
type ReleaseReadiness = { sendsEnabled: boolean; autonomousAiEnabled: boolean; releaseGates: Gate[] }
export function MarketingClient() {
  const [overview, setOverview] = useState<MarketingOverview | null>(null)
  const [readiness, setReadiness] = useState<ReleaseReadiness | null>(null)
  const [drafts, setDrafts] = useState<CampaignDraft[]>([])
  const [form, setForm] = useState<DraftInput>(freshDraft)
  const [selected, setSelected] = useState<CampaignDraft | null>(null)
  const [copyTemplates,setCopyTemplates]=useState<CopyTemplateSummary[]>([])
  const [templatesLoading,setTemplatesLoading]=useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [staleDraftId, setStaleDraftId] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<MarketingSnapshotSummary[]>([])
  const [deliveryPlans,setDeliveryPlans]=useState<StagedDeliverySummary[]>([])
  const [deliveryPlansLoaded,setDeliveryPlansLoaded]=useState(false)
  const [planAudit,setPlanAudit]=useState<PlanReadinessResult|null>(null)
  const [planAuditBusy,setPlanAuditBusy]=useState(false)
  const [attemptReport,setAttemptReport]=useState<(DeliveryAttemptTotals & {planId:string;asOf:string})|null>(null)
  const [attemptReportBusy,setAttemptReportBusy]=useState(false)
  const [budgetStatus,setBudgetStatus]=useState<MarketingBudgetStatus|null>(null)
  const [budgetBusy,setBudgetBusy]=useState(false)
  const [deliveryPlansBusy,setDeliveryPlansBusy]=useState(false)
  const [snapshotsLoaded, setSnapshotsLoaded] = useState(false)
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [calendar, setCalendar] = useState<CalendarItem[]>([])
  const [calendarLoaded, setCalendarLoaded] = useState(false)
  const [planFor, setPlanFor] = useState('')
  const [calendarBusy, setCalendarBusy] = useState(false)
  const [preview, setPreview] = useState<AudiencePreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [suppressionEmail, setSuppressionEmail] = useState('')
  const [suppressionConfirmed, setSuppressionConfirmed] = useState(false)
  const [suppressionBusy, setSuppressionBusy] = useState(false)
  const [suppressionMessage, setSuppressionMessage] = useState('')
  const composedSms = form.channel === 'sms' ? composeMarketingSms(form.body) : null
  const smsEstimate = composedSms?.estimate ?? null

  const reload = useCallback(async () => {
    const response = await fetch('/api/admin/marketing/campaigns', { cache: 'no-store' })
    const payload = await response.json()
    if (!response.ok || !Array.isArray(payload.drafts)) throw Error('Campaign drafts are unavailable. Check migration 038 in staging.')
    setDrafts(payload.drafts)
    return payload.drafts as CampaignDraft[]
  }, [])
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [r, o, gates] = await Promise.all([
          fetch('/api/admin/marketing/campaigns', { cache: 'no-store' }),
          fetch('/api/admin/marketing/overview', { cache: 'no-store' }),
          fetch('/api/admin/marketing/readiness', { cache: 'no-store' }),
        ])
        const draftsJson = await r.json()
        if (!r.ok || !Array.isArray(draftsJson.drafts)) throw Error('Campaign drafts unavailable. Verify staging migration 038.')
        if (!cancelled) setDrafts(draftsJson.drafts)
        if (o.ok) { const summary = await o.json(); if (!cancelled) setOverview(summary) }
        if (gates.ok) {
          const state:ReleaseReadiness = await gates.json()
          if (!cancelled && Array.isArray(state.releaseGates)) setReadiness(state)
        }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load campaigns.') }
      finally { if (!cancelled) setRefreshing(false) }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  async function fetchTemplates(){
    if(templatesLoading)return
    setTemplatesLoading(true);setError('')
    try{
      const r=await fetch('/api/admin/marketing/templates',{cache:'no-store'})
      const payload=await r.json().catch(()=>({}))
      if(!r.ok||!Array.isArray(payload.templates)||payload.sendEnabled!==false)
        throw Error('Reusable templates unavailable. Verify migration 055 in staging.')
      // Ready means copy reusable, never that messaging is authorized.
      setCopyTemplates((payload.templates as CopyTemplateSummary[]).filter(t=>t.state==='ready'))
    }catch(e){setError(e instanceof Error?e.message:'Template list unavailable.')}
    finally{setTemplatesLoading(false)}
  }
  function copyTemplateIntoNewDraft(t:CopyTemplateSummary){
    if(selected||t.state!=='ready'){setError('Use a ready template only when creating a NEW campaign draft.');return}
    try{
      const body=renderStaticBrandCopy(t.body)
      const subject=t.channel==='email'?renderStaticBrandCopy(t.subject||''):null
      if(t.channel==='email'&&!subject)throw Error('Email template lacks a subject.')
      setForm({channel:t.channel,title:t.label.slice(0,120),body,subject,audience:'all-consenting'})
      setPreview(null);setError('');setNotice('Template copied into an unsaved draft. Review message, audience and required marketing disclosures; nothing is scheduled or sent.')
    }catch{setError('Template includes unsupported placeholders. No draft was changed.')}
  }
  function clearSelection() { setPreview(null); setSelected(null); setStaleDraftId(null); setForm(freshDraft()) }
  function beginEdit(d: CampaignDraft) {
    setSelected(d)
    setPreview(null)
    setStaleDraftId(null)
    setForm({ channel: d.channel, title: d.title, subject: d.subject, body: d.body, audience: d.audience })
    setError(''); setNotice('')
  }
  async function mutate(method: 'POST' | 'PATCH', body: Record<string, unknown>, success: string) {
    if (loading) return
    setLoading(true); setError(''); setNotice('')
    try {
      const res = await fetch('/api/admin/marketing/campaigns', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 409) {
          // A different Admin may have edited/reviewed this version. Keep the
          // editor's text intact, but never quietly rebase it over new copy.
          await reload().catch(() => undefined)
          if (typeof body.id === 'string') setStaleDraftId(body.id)
          throw Error('This draft changed or cannot make that transition. Your unsaved copy is preserved; choose Edit on its latest version before saving again.')
        }
        throw Error(typeof data.error === 'string' ? data.error : 'Draft request failed.')
      }
      await reload()
      // Do not discard text being edited when reviewing some other draft.
      if (typeof body.id !== 'string' || selected?.id === body.id) clearSelection()
      setNotice(success)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save campaign.')
    } finally { setLoading(false) }
  }
  async function inspectStagedPlan(planId:string) {
    if(planAuditBusy)return
    setPlanAuditBusy(true);setPlanAudit(null);setError('')
    try{
      const res=await fetch(`/api/admin/marketing/readiness?planId=${encodeURIComponent(planId)}`,{cache:'no-store'})
      const payload=await res.json().catch(()=>({}))
      if(!res.ok||!payload.audit||payload.audit.canSend!==false)
        throw Error('Cannot verify plan integrity. Check staging migrations and evidence.')
      setPlanAudit(payload.audit as PlanReadinessResult)
    }catch(e){setError(e instanceof Error?e.message:'Plan audit unavailable.')}
    finally{setPlanAuditBusy(false)}
  }

  async function loadBudgetStatus(){
    if(budgetBusy)return
    setBudgetBusy(true);setError('');setBudgetStatus(null)
    try{
      const r=await fetch('/api/admin/marketing/budget-status',{cache:'no-store'})
      const data=await r.json().catch(()=>({}))
      if(!r.ok||!data.budget||data.budget.sendAuthorized!==false)throw Error('Marketing budget unavailable. Do not assume unused funds.')
      setBudgetStatus(data.budget)
    }catch(e){setError(e instanceof Error?e.message:'Could not verify marketing budget.')}
    finally{setBudgetBusy(false)}
  }

  async function checkDeliveryAttempts(planId:string){
    if(attemptReportBusy)return
    setAttemptReport(null);setAttemptReportBusy(true);setError('')
    try{
      const r=await fetch(`/api/admin/marketing/delivery-attempts?planId=${encodeURIComponent(planId)}`,{cache:'no-store'})
      const value=await r.json().catch(()=>({}))
      if(!r.ok||!value.audit||value.audit.canRetry!==false||value.audit.billingReconciled!==false)
        throw Error('Delivery attempt evidence unavailable. Unknown is NOT unsent.')
      setAttemptReport(value.audit)
    }catch(e){setError(e instanceof Error?e.message:'Delivery outcome cannot be verified.')}
    finally{setAttemptReportBusy(false)}
  }

  async function suppressEmail() {
    if (suppressionBusy || !suppressionConfirmed) return
    setSuppressionBusy(true); setSuppressionMessage('')
    try {
      const response = await fetch('/api/admin/marketing/suppress-email', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({email:suppressionEmail,confirmed:true}), cache:'no-store',
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw Error(typeof result.error==='string' ? result.error : 'Unable to save suppression.')
      setSuppressionEmail(''); setSuppressionConfirmed(false)
      setSuppressionMessage('Local email marketing suppression saved; external contact reconciliation may still be pending.')
      const summary = await fetch('/api/admin/marketing/overview',{cache:'no-store'})
      if (summary.ok) setOverview(await summary.json())
    } catch(e) { setSuppressionMessage(e instanceof Error ? e.message : 'Suppression could not be saved.') }
    finally {setSuppressionBusy(false)}
  }

  async function reloadSnapshots(){
    const response=await fetch('/api/admin/marketing/audience-snapshots',{cache:'no-store'})
    const payload=await response.json().catch(()=>({}))
    if(!response.ok||!Array.isArray(payload.snapshots))throw Error('Audience snapshots unavailable; verify migration 049 in staging.')
    setSnapshots(payload.snapshots);setSnapshotsLoaded(true)
  }
  async function freezeSnapshot(d:CampaignDraft){
    if(snapshotBusy)return
    if(d.state!=='reviewed'){setError('Review the campaign copy before preparing its audience.');return}
    setSnapshotBusy(true);setNotice('');setError('')
    try{
      // Idempotency key unique per explicit click. This is a PRIVATE list of
      // DB reference IDs, never a marketing send authorization.
      const key='snap-'+crypto.randomUUID()
      const response=await fetch('/api/admin/marketing/audience-snapshots',{
        method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
        body:JSON.stringify({campaignId:d.id,version:d.version,requestKey:key}),
      })
      const payload=await response.json().catch(()=>({}))
      if(!response.ok)throw Error(typeof payload.error==='string'?payload.error:'Unable to prepare private snapshot.')
      await reloadSnapshots()
      setNotice('Private snapshot prepared for compliance review; no marketing messages were sent or queued.')
    }catch(e){setError(e instanceof Error?e.message:'Unable to freeze campaign audience.')}
    finally{setSnapshotBusy(false)}
  }
  async function reloadDeliveryPlans(){
    const r=await fetch('/api/admin/marketing/delivery-plans',{cache:'no-store'})
    const result=await r.json().catch(()=>({}))
    if(!r.ok||!Array.isArray(result.plans))throw Error('Staging records unavailable; migration 050 is required in isolated staging.')
    setDeliveryPlans(result.plans);setDeliveryPlansLoaded(true)
  }
  async function mutateDeliveryPlans(method:'POST'|'DELETE',data:Record<string,unknown>){
    if(deliveryPlansBusy)return
    setDeliveryPlansBusy(true);setError('');setNotice('')
    try{
      const r=await fetch('/api/admin/marketing/delivery-plans',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data),cache:'no-store'})
      const value=await r.json().catch(()=>({}))
      if(!r.ok)throw Error(typeof value.error==='string'?value.error:'Could not update internal delivery plan.')
      await reloadDeliveryPlans()
      setNotice('Internal recipient preparation updated. No messages queued for provider delivery or sent.')
    }catch(e){setError(e instanceof Error?e.message:'Unable to update internal delivery plan.')}
    finally{setDeliveryPlansBusy(false)}
  }
  async function reloadCalendar(){
    const r=await fetch('/api/admin/marketing/calendar',{cache:'no-store'})
    const data=await r.json().catch(()=>({}))
    if(!r.ok||!Array.isArray(data.plans))throw Error('Editorial calendar unavailable; verify migration 048 in staging.')
    setCalendar(data.plans);setCalendarLoaded(true)
  }
  async function calendarAction(method:'POST'|'DELETE',body:Record<string,unknown>){
    if(calendarBusy)return
    setCalendarBusy(true);setError('');setNotice('')
    try{
      const r=await fetch('/api/admin/marketing/calendar',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'})
      const data=await r.json().catch(()=>({}))
      if(!r.ok)throw Error(typeof data.error==='string'?data.error:'Calendar action failed.')
      await reloadCalendar()
      setNotice('Editorial calendar updated. No message is scheduled for delivery or sent.')
    }catch(e){setError(e instanceof Error?e.message:'Unable to update calendar.')}
    finally{setCalendarBusy(false)}
  }
  async function previewAudience(d: CampaignDraft) {
    if(previewBusy)return
    setPreviewBusy(true);setPreview(null);setError('')
    try{
      const r=await fetch(`/api/admin/marketing/audience-preview?campaignId=${encodeURIComponent(d.id)}`,{cache:'no-store'})
      const value=await r.json().catch(()=>({}))
      if(!r.ok)throw Error(typeof value.error==='string'?value.error:'Audience preview failed.')
      setPreview(value as AudiencePreview)
    }catch(e){setError(e instanceof Error?e.message:'Audience preview unavailable.')}
    finally{setPreviewBusy(false)}
  }
  function save() {
    if (selected) {
      if (selected.state !== 'draft' || staleDraftId === selected.id) return
      void mutate('PATCH', { id: selected.id, version: selected.version, action: 'edit', draft: form }, 'Changes saved. No messages were sent.')
    } else {
      void mutate('POST', { ...form }, 'Campaign draft created. No messages were sent.')
    }
  }
  function changeState(d: CampaignDraft, action: EditorialAction) {
    const message = action === 'review'
      ? 'Copy reviewed. This is NOT approval to send, nor proof of recipient consent.'
      : action === 'reopen' ? 'Draft reopened for editing.' : 'Campaign draft archived.'
    void mutate('PATCH', { id: d.id, version: d.version, action }, message)
  }
  return <AdminPage>
    <AdminPageHeader title="Marketing Suite" description="Draft and review KVRN campaigns. All broadcasts and autonomous AI sends are disabled." actions={<Link href="/admin/marketing/templates" className={adminButtonClass('secondary')}>Copy templates</Link>} />
    <AdminNotice tone="warning" title="No marketing sends enabled">
      Review only checks copy. It does not authorize SMS/email delivery, verify opt-in, reserve budget, or enable AI autonomy. Migrations 038–047 require independent staging verification and owner approval before production.
    </AdminNotice>
    {readiness && <AdminCard>
      <h2 className="text-sm font-semibold">Marketing release checklist</h2>
      <p className="mt-1 text-xs text-neutral-600" role="status">
        Campaign delivery: <strong>{readiness.sendsEnabled ? 'Requires owner verification' : 'Disabled'}</strong>.
        AI-autonomous delivery: <strong>{readiness.autonomousAiEnabled ? 'Requires owner verification' : 'Disabled'}</strong>.
        Copy review never changes either status.
      </p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2" aria-label="Marketing launch gates">
        {readiness.releaseGates.map(g => <li key={g.id} className="rounded border border-neutral-200 p-3">
          <p className="text-xs font-semibold">{g.label} — {g.codeStatus === 'blocked' ? 'Blocked' : 'Code present, verification required'}</p>
          <p className="mt-1 text-xs text-neutral-600">{g.reason}</p>
        </li>)}
      </ul>
    </AdminCard>}
    {overview && <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {([
        ['Email locally subscribed', overview.email.subscribed],
        ['Email checkbox assertions', overview.email.affirmativeCheckboxRecords],
        ['Email suppressed', overview.email.unsubscribed],
        ['SMS locally subscribed', overview.sms.subscribed],
        ['SMS confirmed keyword', overview.sms.confirmedKeyword],
      ] as const).map(([label, count]) => <AdminCard key={label}>
        <p className="text-xs text-neutral-500">{label}</p>
        <p className="mt-1 text-2xl font-medium tabular-nums">{count == null ? 'Unknown' : count.toLocaleString()}</p>
      </AdminCard>)}
    </div>}
    <p className="mt-3 text-xs text-neutral-500">
      Subscriber counts are local records, NOT proof of mailbox ownership, deliverability, or valid migrated consent. An email checkbox assertion does not prove inbox control or permission for a broadcast. Draft budget assumptions: SMS $15/month, $3/day; email $10/month, $2/day. Actual dispatch remains disabled until price and atomic reservation gates pass.
    </p>
    {overview && <p className="mt-2 text-xs text-neutral-500" role="status">
      Resend: {overview.provider.emailConfigured ? 'provider configuration detected' : 'configuration incomplete'};
      contact sync {overview.provider.contactSyncEnabled ? 'enabled' : 'disabled'};
      subscription sync {overview.provider.optInSyncEnabled ? 'requires evidence and is enabled' : 'disabled'}.
      Provider setup is not authorization to send.
    </p>}
    {error && <div role="alert" className="mt-4"><AdminNotice tone="danger">{error}</AdminNotice></div>}
    {staleDraftId && <p className="mt-3 text-xs">The list below has been refreshed. Select <strong>Edit</strong> on the current draft to load the latest copy. You may copy any unsaved text from this editor before doing so.</p>}
    {notice && <p className="mt-4 text-sm" role="status">{notice}</p>}
    <AdminCard>
      <h2 className="text-sm font-semibold">Record an email marketing opt-out received by Support</h2>
      <p className="mt-1 text-xs text-neutral-600">Suppression only. This does not add or reactivate subscriptions or change transactional order emails. Record requests only when the customer has actually revoked consent.</p>
      <div className="mt-3 flex min-w-0 flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-xs">Customer email
          <input type="email" className="mt-1 block w-full rounded border p-2" autoComplete="off" maxLength={254} value={suppressionEmail} disabled={suppressionBusy}
            onChange={e=>{setSuppressionEmail(e.target.value);setSuppressionConfirmed(false);setSuppressionMessage('')}}/>
        </label>
        <AdminButton disabled={suppressionBusy || !suppressionConfirmed || !suppressionEmail.trim()} onClick={()=>void suppressEmail()}>
          {suppressionBusy ? 'Saving…' : 'Record opt-out'}
        </AdminButton>
      </div>
      <label className="mt-3 flex items-start gap-2 text-xs">
        <input type="checkbox" checked={suppressionConfirmed} disabled={suppressionBusy} onChange={e=>setSuppressionConfirmed(e.target.checked)}/>
        I have received a genuine revocation request for this address.
      </label>
      {suppressionMessage && <p className="mt-2 text-xs" role="status">{suppressionMessage}</p>}
    </AdminCard>
    <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-2">
      <AdminCard>
        <h2 className="mb-3 text-sm font-semibold">{selected ? `Edit draft — version ${selected.version}` : 'New campaign draft'}</h2>
        {!selected&&<div className="mb-4 rounded border border-neutral-200 bg-neutral-50 p-3 text-xs">
          <p className="font-medium">Start from reusable copy (optional)</p>
          <p className="mt-1 text-neutral-600">Only ready editorial templates appear. Copying does not save a draft or authorize sending.</p>
          <div className="mt-2"><AdminButton size="sm" variant="secondary" disabled={templatesLoading||loading} onClick={()=>void fetchTemplates()}>{templatesLoading?'Loading…':'Load ready templates'}</AdminButton></div>
          {copyTemplates.length>0&&<ul className="mt-2 space-y-2">{copyTemplates.map(t=><li key={t.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-words">{t.label} · {t.channel.toUpperCase()} · v{t.version}</span><AdminButton size="sm" disabled={loading} onClick={()=>copyTemplateIntoNewDraft(t)}>Use in new draft</AdminButton></li>)}</ul>}
        </div>}

        <div className="space-y-3 text-xs">
          <label className="block">Channel
            <select className="mt-1 block w-full rounded border p-2" value={form.channel} disabled={!!selected || loading}
              onChange={e => setForm(f => ({ ...f, channel: e.target.value as CampaignChannel, subject: e.target.value === 'sms' ? null : '' }))}>
              <option value="email">Email</option><option value="sms">SMS / MMS</option>
            </select>
          </label>
          <label className="block">Internal campaign title
            <input className="mt-1 block w-full rounded border p-2" maxLength={120} value={form.title} disabled={loading}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          </label>
          {form.channel === 'email' && <label className="block">Email subject
            <input className="mt-1 block w-full rounded border p-2" maxLength={140} value={form.subject || ''} disabled={loading}
              onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} />
          </label>}
          <label className="block">Audience concept (not a recipient list)
            <select className="mt-1 block w-full rounded border p-2" value={form.audience} disabled={loading}
              onChange={e => setForm(f => ({ ...f, audience: e.target.value as CampaignAudience }))}>
              <option value="all-consenting">All consenting</option>
              <option value="recent-opt-ins">Recent opt-ins</option>
              <option value="existing-customers">Existing customers with separate marketing consent</option>
            </select>
          </label>
          <label className="block">Message content
            <textarea className="mt-1 block min-h-[150px] w-full rounded border p-2" maxLength={10000} value={form.body} disabled={loading}
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
          </label>
          <div className="flex flex-wrap gap-2">
            <AdminButton disabled={loading || refreshing || (!!selected && (selected.state !== 'draft' || staleDraftId === selected.id))} onClick={save}>
              {loading ? 'Saving…' : selected ? 'Save draft edits' : 'Create draft'}
            </AdminButton>
            {selected && <AdminButton variant="secondary" disabled={loading} onClick={clearSelection}>Cancel edit</AdminButton>}
          </div>
        </div>
      </AdminCard>
      <AdminCard>
        <h2 className="mb-3 text-sm font-semibold">Saved drafts ({drafts.length})</h2>
        {refreshing ? <p className="text-xs text-neutral-500">Loading…</p>
          : drafts.length === 0 ? <p className="text-xs text-neutral-500">No drafts available.</p>
          : <ul className="space-y-3">{drafts.map(d => <li key={d.id} className="min-w-0 rounded border border-neutral-200 p-3 text-xs">
            <div className="flex flex-wrap justify-between gap-2"><strong className="min-w-0 break-words">{d.title}</strong>
              <span>{d.channel.toUpperCase()} · {STATES[d.state] ?? d.state} · v{d.version}</span>
            </div>
            <p className="my-2 line-clamp-3 whitespace-pre-wrap break-words text-neutral-600">{d.body || '(Empty draft)'}</p>
            <div className="flex flex-wrap gap-2">
              {d.state === 'draft' && <>
                <AdminButton variant="secondary" disabled={loading} onClick={() => beginEdit(d)}>Edit</AdminButton>
                <AdminButton variant="secondary" disabled={loading} onClick={() => changeState(d, 'review')}>Review copy</AdminButton>
              </>}
              {d.state === 'reviewed' && <>
                <AdminButton variant="secondary" disabled={loading} onClick={() => changeState(d, 'reopen')}>Reopen</AdminButton>
                <AdminButton variant="secondary" disabled={loading || previewBusy} onClick={() => void previewAudience(d)}>
                  {previewBusy?'Checking…':'Preview audience evidence'}
                </AdminButton>
                <AdminButton variant="secondary" disabled={calendarBusy||!planFor} onClick={()=>{
                  const ms=Date.parse(planFor)
                  if(!Number.isFinite(ms)){setError('Choose a valid local date and time.');return}
                  void calendarAction('POST',{campaignId:d.id,version:d.version,plannedFor:new Date(ms).toISOString()})
                }}>Add editorial plan</AdminButton>
                <AdminButton variant="secondary" disabled={snapshotBusy} onClick={()=>void freezeSnapshot(d)}>
                  {snapshotBusy?'Preparing…':'Freeze recipient references (no send)'}
                </AdminButton>
              </>}
              {d.state !== 'archived' && <AdminButton variant="secondary" disabled={loading} onClick={() => changeState(d, 'archive')}>Archive</AdminButton>}
            </div>
          </li>)}</ul>}
      </AdminCard>
    </div>
    <AdminCard>
      <h2 className="text-sm font-semibold">Frozen audience references (no dispatch)</h2>
      <p className="mt-2 text-xs text-neutral-600">Preparing a snapshot stores only eligible subscriber IDs in the private database. Revoked consent, provider suppression, geography and costs must be rechecked before any actual delivery. Nothing here sends or queues messages.</p>
      <div className="mt-2"><AdminButton variant="secondary" disabled={snapshotBusy} onClick={()=>void reloadSnapshots().catch(e=>setError(e.message))}>Load saved snapshots</AdminButton></div>
      {snapshotsLoaded&&<ul className="mt-3 space-y-2 text-xs">{snapshots.length?snapshots.map(snapshot=><li key={snapshot.id} className="rounded border p-2">
        {snapshot.channel.toUpperCase()} · {snapshot.memberCount} private references · campaign v{snapshot.campaignVersion} · {new Date(snapshot.createdAt).toLocaleString()} · <strong>No sending authorized</strong>
        <div className="mt-2"><AdminButton variant="secondary" disabled={deliveryPlansBusy} onClick={()=>void mutateDeliveryPlans('POST',{snapshotId:snapshot.id,requestKey:'stage-'+crypto.randomUUID()})}>Stage internal delivery plan (no provider send)</AdminButton></div>
      </li>):<li>No snapshots recorded.</li>}</ul>}
    </AdminCard>
    <AdminCard>
      <h2 className="text-sm font-semibold">Marketing budget and unresolved reservations</h2>
      <p className="mt-2 text-xs text-neutral-600">Read-only USD commitments. Reserved amounts count at their full worst-case cost until verified provider billing/rejection evidence is reconciled. This is not an authorization to send.</p>
      <div className="mt-2"><AdminButton variant="secondary" disabled={budgetBusy} onClick={()=>void loadBudgetStatus()}>{budgetBusy?'Checking…':'Check budgets and unresolved charges'}</AdminButton></div>
      {budgetStatus&&<div className="mt-3 space-y-3 text-xs" aria-live="polite">
        <p>Database dispatch switch: <strong>{budgetStatus.dispatchEnabled?'Enabled — verify all other release gates':'Disabled'}</strong> · checked {new Date(budgetStatus.asOf).toLocaleString()}</p>
        {budgetStatus.lines.map(line=><div key={line.channel} className="rounded-lg border p-3">
          <p className="font-semibold">{line.channel.toUpperCase()} · {line.status==='within_cap'?'Within configured cap':line.status==='exceeded'?'OVER CAP — review':'Unresolved charges — review required'}</p>
          <p className="mt-1">Today committed ${(line.dailyCommittedMicros/1_000_000).toFixed(2)} / ${(line.dailyLimitMicros/1_000_000).toFixed(2)} · Month committed ${(line.monthlyCommittedMicros/1_000_000).toFixed(2)} / ${(line.monthlyLimitMicros/1_000_000).toFixed(2)}.</p>
          <p>Unsettled reservations {line.unresolvedReservations} · oldest {line.oldestUnresolvedHours===null?'Unknown or none':`${line.oldestUnresolvedHours} hours`}.</p>
        </div>)}
        <p className="font-medium">AI-assisted SMS sub-budget: ${(budgetStatus.aiSmsMonthlyCommittedMicros/1_000_000).toFixed(2)} / ${(budgetStatus.aiSmsMonthlyLimitMicros/1_000_000).toFixed(2)} ({budgetStatus.aiSmsStatus}).</p>
        <ul className="list-disc pl-5 text-neutral-600">{budgetStatus.warnings.map(w=><li key={w}>{w}</li>)}</ul>
      </div>}
    </AdminCard>
    <AdminCard>
      <h2 className="text-sm font-semibold">Internal delivery staging (not a send queue)</h2>
      <p className="mt-2 text-xs text-neutral-600">Stage approved-copy recipient references for a future compliance review. This does NOT authorize, schedule, price, reserve budget for, or deliver any campaign. Consent is rechecked before staging and must be checked again later.</p>
      <div className="mt-2"><AdminButton variant="secondary" disabled={deliveryPlansBusy} onClick={()=>void reloadDeliveryPlans().catch(e=>setError(e.message))}>Load staged plans</AdminButton></div>
      {deliveryPlansLoaded&&<ul className="mt-3 space-y-2 text-xs">{deliveryPlans.length?deliveryPlans.map(p=><li key={p.id} className="flex flex-wrap items-center gap-2 rounded border p-2">
        <span>{p.memberCount} internal references · {p.state} · {new Date(p.createdAt).toLocaleString()} · <strong>No sending authorized</strong></span>
        <AdminButton variant="secondary" disabled={planAuditBusy} onClick={()=>void inspectStagedPlan(p.id)}>
          {planAuditBusy?'Auditing…':'Audit consent and release blockers'}
        </AdminButton>
        <AdminButton variant="secondary" disabled={attemptReportBusy} onClick={()=>void checkDeliveryAttempts(p.id)}>
          {attemptReportBusy?'Checking…':'View attempt recovery audit'}
        </AdminButton>
        {p.state==='staged'&&<AdminButton variant="secondary" disabled={deliveryPlansBusy} onClick={()=>void mutateDeliveryPlans('DELETE',{id:p.id})}>Cancel staged plan</AdminButton>}
      </li>):<li>No internal delivery plans recorded.</li>}</ul>}
      {attemptReport&&<section className="mt-4 min-w-0 rounded-lg border border-neutral-300 p-3" aria-live="polite">
        <h3 className="text-sm font-semibold">Provider attempt recovery — no retries authorized</h3>
        <p className="mt-2 break-words text-xs">Plan {attemptReport.planId} · checked {new Date(attemptReport.asOf).toLocaleString()}</p>
        <p className="mt-2 text-xs">Staged {attemptReport.staged} · claimed {attemptReport.claimed} · provider accepted {attemptReport.providerAccepted} · confirmed not submitted {attemptReport.verifiedNotSubmitted} · <strong>unknown {attemptReport.unknown}</strong>.</p>
        <p className="mt-2 text-xs">Unclaimed references: {attemptReport.unclaimed}. No provider sends or budget release can be inferred from this report.</p>
        <ul className="mt-2 list-disc pl-5 text-xs text-neutral-600">{attemptReport.warnings.map(w=><li key={w}>{w}</li>)}</ul>
      </section>}
      {planAudit&&<section className="mt-4 min-w-0 rounded-lg border border-neutral-300 p-3" aria-live="polite">
        <h3 className="font-semibold text-sm">Release audit — sending blocked</h3>
        <p className="mt-1 text-xs">{planAudit.channel.toUpperCase()} · {planAudit.locallyVerifiedCount} of {planAudit.recipientCount} locally evidenced references · {new Date(planAudit.asOf).toLocaleString()}</p>
        <ul className="mt-2 space-y-1 text-xs">{planAudit.checks.map(c=><li key={c.id} className="break-words">
          <strong>{c.passed?'✓':'Blocked:'} {c.id.replaceAll('_',' ')}</strong> — {c.note}
        </li>)}</ul>
        <p className="mt-2 text-xs font-semibold">This audit cannot authorize dispatch or reserve marketing budget.</p>
      </section>}
    </AdminCard>
    <AdminCard>
      <h2 className="text-sm font-semibold">Editorial calendar (does not send messages)</h2>
      <p className="mt-1 text-xs text-neutral-600">Save a planned campaign time for internal review. Nothing here creates a send job, approves recipients, or reserves budget.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <AdminButton variant="secondary" disabled={calendarBusy} onClick={()=>void reloadCalendar().catch(e=>setError(e.message))}>Load editorial calendar</AdminButton>
      </div>
      {calendarLoaded && <ul className="mt-3 space-y-2 text-xs">{calendar.length?calendar.map(c=><li key={c.id} className="flex flex-wrap items-center gap-2 rounded border p-2">
        <span className="break-words">{c.title} · {new Date(c.plannedFor).toLocaleString()} · {c.state}{!c.copyCurrent?' · copy review is stale':''}</span>
        {c.state==='planned'&&<AdminButton variant="secondary" disabled={calendarBusy} onClick={()=>void calendarAction('DELETE',{id:c.id})}>Cancel plan</AdminButton>}
      </li>):<li>No editorial plans recorded.</li>}</ul>}
      <label className="mt-3 block text-xs">Planned local time (reviewed campaign required)
        <input type="datetime-local" className="mt-1 block w-full max-w-xs rounded border p-2" value={planFor} onChange={e=>setPlanFor(e.target.value)}/>
      </label>
      <p className="mt-2 text-xs text-neutral-500">Select a reviewed campaign below to add its copy to this editorial calendar. The time must be at least 15 minutes ahead and within one year.</p>
    </AdminCard>
    {preview && <AdminCard>
      <h2 className="text-sm font-semibold">Audience evidence — advisory only</h2>
      <p className="mt-2 text-sm">Locally evidenced records: <strong>{preview.locallyEvidenceMatched.toLocaleString()}</strong>
        {preview.overInitialCap?' (exceeds the initial 50-recipient cap)':''}</p>
      <p className="mt-1 text-xs">Campaign version {preview.campaignVersion}; {preview.audience}; checked {new Date(preview.asOf).toLocaleString()}.</p>
      <ul className="mt-2 list-disc pl-5 text-xs text-neutral-600">{preview.warnings.map(w=><li key={w}>{w}</li>)}</ul>
    </AdminCard>}
    <AdminCard>
      <h2 className="text-sm font-semibold">Campaign copy preview — no sending</h2>
      <div className="mt-3 flex min-w-0 flex-wrap gap-4">
        <section className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 p-4" aria-label="Desktop copy preview">
          <p className="mb-3 text-[11px] uppercase tracking-widest text-neutral-500">{form.channel === 'email' ? 'Email text preview' : 'SMS text preview'}</p>
          {form.channel === 'email' && <p className="mb-2 font-semibold break-words">{form.subject || '(No subject)'}</p>}
          <p className="whitespace-pre-wrap break-words text-sm">{form.channel==='sms'?composedSms?.body||'(No message text)':form.body||'(No message text)'}</p>
        </section>
        <section className="w-full max-w-[300px] shrink-0 rounded-2xl border-4 border-neutral-300 p-4" aria-label="Narrow-screen copy preview">
          <p className="mb-3 text-[11px] uppercase tracking-widest text-neutral-500">Mobile-width preview</p>
          <p className="whitespace-pre-wrap break-words text-xs">{form.channel==='sms'?composedSms?.body||'(No message text)':form.body||'(No message text)'}</p>
        </section>
      </div>
      {smsEstimate && <p className="mt-3 text-xs" role="status">
        Composed SMS length (brand + STOP): {smsEstimate.units} {smsEstimate.encoding} units ≈ {smsEstimate.segments} segment(s).
        {composedSms&&!composedSms.validOneSegment && <strong className="ml-1">Blocked for dispatch: {composedSms.reasons.join(', ')}.</strong>}
        {' '}This is not a carrier billing quote; provider-confirmed pricing is required before budget reservation.
      </p>}
      <p className="mt-2 text-xs text-neutral-500">This preview renders plain text only; HTML, images, links, deliverability and recipient personalization are not verified.</p>
    </AdminCard>
  </AdminPage>
}
