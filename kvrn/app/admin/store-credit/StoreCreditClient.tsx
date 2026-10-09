'use client'
import {useEffect,useState} from 'react'
import {AdminPage,AdminPageHeader,AdminCard,AdminNotice} from '@/components/admin/ui/AdminUI'
import type {CreditReadiness} from '@/lib/store-credit-readiness'
type CreditStatus=CreditReadiness&{issuanceAvailable?:boolean}
function dollarsToCents(v:string):number|null{
 if(!/^\d{1,8}(?:\.\d{1,2})?$/.test(v))return null
 const [whole,frac='']=v.split('.')
 const cents=Number(whole)*100+Number(frac.padEnd(2,'0'))
 return Number.isSafeInteger(cents)&&cents>0?cents:null
}
import type {CreditReconciliation} from '@/lib/store-credit-reconciliation'
export function StoreCreditClient(){
 const [data,setData]=useState<CreditStatus|null>(null),[error,setError]=useState(false)
 const [recon,setRecon]=useState<CreditReconciliation|null>(null),[reconLoading,setReconLoading]=useState(false),[reconError,setReconError]=useState(false)
 useEffect(()=>{void fetch('/api/admin/store-credit',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('HTTP');return r.json()}).then(setData).catch(()=>setError(true))},[])
 const [returnId,setReturnId]=useState(''),[requestedDollars,setRequestedDollars]=useState('')
 const [deliveredAt,setDeliveredAt]=useState(''),[deliveryEvidenceRef,setDeliveryEvidenceRef]=useState('')
 const [inspectionConfirmed,setInspectionConfirmed]=useState(false)
 const [issueKey,setIssueKey]=useState(()=>`kvrn-credit-${crypto.randomUUID()}`)
 const [issuing,setIssuing]=useState(false),[issueMessage,setIssueMessage]=useState('')
 async function issueInspectedCredit(){
  if(!data?.issuanceAvailable||issuing)return
  const cents=dollarsToCents(requestedDollars)
  if(cents===null||!deliveredAt||!inspectionConfirmed){setIssueMessage('Complete the reviewed amount, delivery date and inspection confirmation.');return}
  const date=new Date(deliveredAt)
  if(!Number.isFinite(date.getTime())){setIssueMessage('Delivery date is invalid.');return}
  setIssuing(true);setIssueMessage('')
  try{
   const response=await fetch('/api/admin/store-credit/issue',{method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({returnId,requestedCents:cents,deliveredAt:date.toISOString(),deliveryEvidenceRef,requestKey:issueKey,confirmInspectedReturn:true})})
   const result=await response.json().catch(()=>({}))
   if(!response.ok||typeof result.creditEventId!=='string')throw Error('Issuance blocked by owner or financial-integrity checks. Nothing has been confirmed.')
   setIssueMessage('Credit issued after server approval. Ledger event '+result.creditEventId+'. Reconcile before further action.')
   setIssueKey(`kvrn-credit-${crypto.randomUUID()}`)
   setReturnId('');setRequestedDollars('');setDeliveredAt('');setDeliveryEvidenceRef('');setInspectionConfirmed(false)
  }catch(e){setIssueMessage(e instanceof Error?e.message:'Issuance unavailable. Retain the same request key before retrying.')}
  finally{setIssuing(false)}
 }
 const runReconciliation=async()=>{
  setReconLoading(true);setReconError(false);setRecon(null)
  try{const result=await fetch('/api/admin/store-credit/reconciliation',{cache:'no-store'});if(!result.ok)throw Error('reconciliation_unavailable');setRecon(await result.json())}
  catch{setReconError(true)}finally{setReconLoading(false)}
 }
 const money=(c:number|null)=>c===null?'Unknown':`$${(c/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`
 return <AdminPage>
  <AdminPageHeader title="Store Credit" description="Financial liability foundation and release safeguards"/>
  <AdminNotice tone="warning" title="Not available for customer transactions">Customer checkout redemption remains disabled. Owner-reviewed issuance appears only after its separate staging flag, schema, owner identity and financial safeguards are configured. Existing sales and financial records are not rewritten.</AdminNotice>
  {error&&<AdminNotice tone="danger">Could not verify store-credit ledger readiness.</AdminNotice>}
  {data?.issuanceAvailable&&<AdminCard className="my-4">
   <h2 className="text-sm font-semibold">Owner-reviewed inspected return credit</h2>
   <p className="mt-1 text-xs text-neutral-600">Only an eligible, completed and inspected return can be credited. The server independently verifies its frozen merchandise value, delivery window, refund/dispute status and one-time issuance. This does not enable checkout redemption.</p>
   <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();void issueInspectedCredit()}}>
    <label className="text-xs">Completed return UUID<input required maxLength={36} value={returnId} onChange={e=>setReturnId(e.target.value.trim())} className="mt-1 w-full rounded border p-2"/></label>
    <label className="text-xs">Approved merchandise credit (USD)<input required inputMode="decimal" placeholder="50.00" value={requestedDollars} onChange={e=>setRequestedDollars(e.target.value.trim())} className="mt-1 w-full rounded border p-2"/></label>
    <label className="text-xs">Verified carrier delivery date/time<input type="datetime-local" required value={deliveredAt} onChange={e=>setDeliveredAt(e.target.value)} className="mt-1 w-full rounded border p-2"/></label>
    <label className="text-xs">Reviewed delivery evidence reference<input required minLength={8} maxLength={120} value={deliveryEvidenceRef} onChange={e=>setDeliveryEvidenceRef(e.target.value)} className="mt-1 w-full rounded border p-2"/></label>
    <label className="col-span-full flex items-start gap-2 text-xs"><input type="checkbox" checked={inspectionConfirmed} onChange={e=>setInspectionConfirmed(e.target.checked)}/> I personally reviewed carrier delivery evidence and confirmed receipt, inspection, approval and amount.</label>
    <button type="submit" disabled={issuing||!inspectionConfirmed} className="w-fit rounded-lg border px-4 py-2 text-xs disabled:opacity-50">{issuing?'Verifying…':'Issue approved credit'}</button>
   </form>
   {issueMessage&&<p role="status" className="mt-3 text-xs">{issueMessage}</p>}
  </AdminCard>}
  <AdminCard className="my-4"><h2 className="text-sm font-medium">Read-only ledger reconciliation</h2>
  <p className="my-2 text-xs text-neutral-600">Checks per-account credit events against the liability view; never issues or redeems credit.</p>
  <button type="button" disabled={reconLoading} onClick={()=>void runReconciliation()} className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50">{reconLoading?'Checking…':'Verify credit ledger'}</button>
  {reconError&&<p role="alert" className="mt-2 text-xs text-red-600">Reconciliation unavailable. Do not infer zero or assume that records are clean.</p>}
  {recon&&<div className="mt-3 space-y-2 text-xs"><p role="status"><strong>{recon.status==='reconciled'?'Read-only ledger checks matched':'Financial integrity warning'}</strong></p>
  <p>{recon.eventsReviewed} events, {recon.accountsReviewed} private accounts, {recon.outstandingHolds} outstanding holds examined.</p>
  {recon.warnings.map(w=><p key={w}>{w}</p>)}</div>}
 </AdminCard>
 {data&&<>
   <p className="my-4 text-xs">Ledger state: <strong>{data.status==='foundation-only'?'Schema accessible, read-only':data.status==='integrity-warning'?'FINANCIAL INTEGRITY WARNING — investigate before enabling credit':'No verified ledger schema — do not infer zero liability'}</strong></p>
   {data.status==='integrity-warning' && <AdminNotice tone="danger">Credit liability totals are inconsistent or outside safe integer bounds. Balances have been withheld; review the ledger in isolated staging before any credit enablement.</AdminNotice>}
   <div className="grid gap-3 sm:grid-cols-3">
    {([['Issued',data.amounts?.issuedCents??null],['Redeemed',data.amounts?.redeemedCents??null],['Outstanding liability',data.amounts?.outstandingCents??null]] as const).map(([title,cents])=><AdminCard key={title}><p className="text-xs text-neutral-500">{title}</p><p className="mt-1 text-2xl font-medium tabular-nums">{money(cents)}</p></AdminCard>)}
   </div><AdminCard className="mt-4"><h2 className="text-sm font-medium">Before enabling</h2><ul className="mt-2 list-inside list-disc space-y-2 text-xs text-neutral-600">{data.limitations.map(s=><li key={s}>{s}</li>)}</ul></AdminCard>
  </>}
 </AdminPage>
}
