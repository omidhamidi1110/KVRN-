/**
 * Read-only, strictly bounded store-credit ledger reconciliation.
 * No customer identity, HMAC key, account UUID, order ID or return ID is returned.
 * The verification is an independent accounting audit, NOT permission to transact.
 */
import {sql} from '@/lib/db'
import {calculateStoreCredit, type CreditLedgerEvent} from './store-credit-domain'
import {inspectCreditLiabilityTotals} from './store-credit-ledger-integrity'

export const CREDIT_RECONCILIATION_MAX_EVENTS=10_000
const MAX=BigInt(Number.MAX_SAFE_INTEGER)
export type CreditReconciliation={
  status:'reconciled'|'integrity-warning'
  accountsReviewed:number
  eventsReviewed:number
  outstandingHolds:number
  totalIssuedCents:number|null
  totalRedeemedCents:number|null
  outstandingLiabilityCents:number|null
  warnings:string[]
  transactionalOperationsEnabled:false
  asOf:string
}

type RawCreditRow=Record<string,unknown>
function numberCents(value:unknown):number {
  if((typeof value!=='string'||!/^[1-9][0-9]*$/.test(value)) &&
     (typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)) throw Error('LEDGER_UNSAFE_AMOUNT')
  const n=Number(value)
  if(!Number.isSafeInteger(n)||n<=0)throw Error('LEDGER_UNSAFE_AMOUNT')
  return n
}
function normalizedId(raw:unknown):string{
  if(typeof raw!=='string'||raw.length===0||raw.length>150)throw Error('LEDGER_INVALID_REFERENCE')
  return raw
}
function toEvent(r:RawCreditRow):CreditLedgerEvent{
  const idempotencyKey=normalizedId(r.idempotency_key)
  const amountCents=numberCents(r.amount_cents)
  switch(r.event_type){
    case 'issue':return {type:'issue',idempotencyKey,amountCents,approvedReturnId:normalizedId(r.return_id)}
    case 'hold':return {type:'hold',idempotencyKey,amountCents,holdId:normalizedId(r.hold_key)}
    case 'capture':return {type:'capture',idempotencyKey,amountCents,holdId:normalizedId(r.hold_key),orderId:normalizedId(r.order_id)}
    case 'release':return {type:'release',idempotencyKey,amountCents,holdId:normalizedId(r.hold_key)}
    default:throw Error('LEDGER_UNKNOWN_EVENT')
  }
}
const safeOutput=(n:bigint):number=>{
  if(n<0n||n>MAX)throw Error('LEDGER_AGGREGATE_OVERFLOW')
  return Number(n)
}
export function analyzeStoreCreditRows(rows:ReadonlyArray<RawCreditRow>,liability:unknown):CreditReconciliation {
  if(!Array.isArray(rows)||rows.length>CREDIT_RECONCILIATION_MAX_EVENTS)throw Error('LEDGER_RECONCILIATION_TOO_LARGE')
  const grouped=new Map<string,CreditLedgerEvent[]>()
  // DB unique indexes protect these invariants, but an independent audit must
  // detect cross-account duplication even if an index was absent/corrupted.
  const globalKeys=new Set<string>()
  const creditedReturns=new Set<string>()
  for(const r of rows){
    const account=normalizedId(r.account_id)
    const event=toEvent(r)
    if(globalKeys.has(event.idempotencyKey))throw Error('LEDGER_DUPLICATE_IDEMPOTENCY_KEY')
    globalKeys.add(event.idempotencyKey)
    if(event.type==='issue') {
      if(creditedReturns.has(event.approvedReturnId))throw Error('LEDGER_DUPLICATE_RETURN_CREDIT')
      creditedReturns.add(event.approvedReturnId)
    }
    const existing=grouped.get(account)??[]
    existing.push(event)
    grouped.set(account,existing)
  }
  let issued=0n,redeemed=0n,holds=0
  for(const events of grouped.values()){
    const summary=calculateStoreCredit(events)
    issued+=BigInt(summary.issuedCents)
    redeemed+=BigInt(summary.redeemedCents)
    holds+=events.filter(e=>e.type==='hold').length-events.filter(e=>e.type==='capture'||e.type==='release').length
    if(holds<0)throw Error('LEDGER_ORPHAN_TERMINAL_EVENT')
  }
  const totalIssuedCents=safeOutput(issued),totalRedeemedCents=safeOutput(redeemed)
  const outstandingLiabilityCents=safeOutput(issued-redeemed)
  const reported=inspectCreditLiabilityTotals(liability)
  const matches=!!reported&&reported.issuedCents===totalIssuedCents&&reported.redeemedCents===totalRedeemedCents&&reported.outstandingCents===outstandingLiabilityCents
  return {status:matches?'reconciled':'integrity-warning',accountsReviewed:grouped.size,
    eventsReviewed:rows.length,outstandingHolds:holds,
    totalIssuedCents:matches?totalIssuedCents:null,totalRedeemedCents:matches?totalRedeemedCents:null,
    outstandingLiabilityCents:matches?outstandingLiabilityCents:null,
    warnings:[
      'Read-only reconciliation does not establish credit issuance, return eligibility or checkout readiness.',
      'The ledger has no validated transactional writer yet; customer credit operations remain disabled.',
      ...(matches?[]:['Ledger event totals do not match authoritative liability totals. Withhold balances and investigate.']),
    ],transactionalOperationsEnabled:false,asOf:new Date().toISOString()}
}
export async function reconcileStoreCreditLedger():Promise<CreditReconciliation>{
  // Never fetch raw email, account HMAC, customer names, or phone numbers.
  // Extra 1 row detects truncation: an incomplete audit must never be labeled clean.
  const [entries,view]=await Promise.all([
    sql`SELECT account_id::text AS account_id,event_type,amount_cents::text AS amount_cents,
        idempotency_key,return_id::text AS return_id,order_id::text AS order_id,hold_key
        FROM store_credit_ledger ORDER BY account_id,id LIMIT ${CREDIT_RECONCILIATION_MAX_EVENTS+1}`,
    sql`SELECT total_issued_cents,total_redeemed_cents,outstanding_liability_cents FROM store_credit_liability_totals`,
  ])
  if(view.length!==1)throw Error('LEDGER_TOTALS_UNAVAILABLE')
  return analyzeStoreCreditRows(entries,view[0])
}
