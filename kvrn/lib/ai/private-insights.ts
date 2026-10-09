/** First-party read-only operations insights. No LLM, raw SQL, arbitrary tools,
 * customer records, payment data, or external API access in this module.
 * Unlike AI-generated recommendations these statements are deterministic.
 */
import {getMarketingOverview,type MarketingOverview} from '@/lib/marketing-overview'
import {storeCreditReadiness,type CreditReadiness} from '@/lib/store-credit-readiness'
import {getAiBudgetSnapshot} from './budget'
import {getInventoryIntegritySummary,type InventoryIntegritySummary} from './inventory-integrity-insight'
import {getPaymentExceptionSummary,type PaymentExceptionSummary} from './payment-exceptions-insight'
import {getAffiliateIntegritySummary,type AffiliateIntegritySummary} from './affiliate-integrity-insight'
import {getStoreCreditOperationsSummary,type StoreCreditOperationsSummary} from './store-credit-integrity-insight'
import {getMarketingDeliverySummary,type MarketingDeliverySummary} from './marketing-delivery-insight'
export const PRIVATE_INSIGHT_TOPICS=['marketing-consent','store-credit','ai-budget','inventory-integrity','payment-exceptions','affiliate-integrity','marketing-delivery','operations-brief'] as const
export type PrivateInsightTopic=typeof PRIVATE_INSIGHT_TOPICS[number]
export type PrivateInsightLine={label:string;value:string;state:'verified'|'warning'|'unknown'}
export type PrivateInsight={topic:PrivateInsightTopic;asOf:string;summary:string;lines:PrivateInsightLine[];modelUsed:false;externalTransmission:false;readOnly:true;warnings:string[]}
export function validateInsightTopic(input:unknown):input is PrivateInsightTopic{
 return typeof input==='string'&&(PRIVATE_INSIGHT_TOPICS as readonly string[]).includes(input)
}
const nonnegative=(n:unknown):string=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n.toLocaleString('en-US'):'Unknown'
const amount=(n:unknown):string=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?`$${(n/100).toFixed(2)}`:'Unknown'
const metric=(label:string,n:unknown):PrivateInsightLine=>({label,value:nonnegative(n),state:nonnegative(n)==='Unknown'?'unknown':'verified'})
export function makeMarketingInsight(value:MarketingOverview):Pick<PrivateInsight,'summary'|'lines'|'warnings'>{
 return {
  summary:'Local marketing enrollment counts. Consent evidence and provider permission are separate requirements; these counts cannot authorize messages.',
  lines:[
   metric('Email recorded subscribed',value.email.subscribed),
   metric('Email affirmative checkbox records',value.email.affirmativeCheckboxRecords),
   metric('Email recorded unsubscribed',value.email.unsubscribed),
   metric('SMS recorded subscribed',value.sms.subscribed),
   metric('SMS confirmed keyword proofs',value.sms.confirmedKeyword),
   metric('SMS recorded unsubscribed',value.sms.unsubscribed),
   {label:'SMS campaign sending',value:'Disabled',state:'warning'},
  ],
  warnings:['Counts do not validate imported Postscript opt-ins, mailbox ownership or reassigned telephone numbers.','Any future sending requires fresh suppression, consent, location, cost and owner checks.'],
 }
}
export function makeCreditInsight(value:CreditReadiness,ops:StoreCreditOperationsSummary|null=null):Pick<PrivateInsight,'summary'|'lines'|'warnings'>{
 const data=value.amounts
 return {
  summary:ops?.integrityVerified===false?'Store-credit hold, capture or payment-proof integrity is inconsistent. Do not trust available balances or mark liabilities reconciled.':value.status==='foundation-only'?'Credit liability amounts are available from the ledger but issuance/redemption is not enabled.':value.status==='schema-not-applied'?'Credit liability schema is unavailable. Unknown balances must not be reported as zero.':'Credit ledger totals are inconsistent or unverifiable. All customer transactions must remain blocked.',
  lines:[{label:'Credit financial integrity',value:value.status,state:value.status==='foundation-only'?'verified':'warning'},
   {label:'Outstanding liability',value:data?amount(data.outstandingCents):'Unknown',state:data?'verified':'unknown'},
   {label:'Issued to customers',value:data?amount(data.issuedCents):'Unknown',state:data?'verified':'unknown'},
   {label:'Redeemed liability',value:data?amount(data.redeemedCents):'Unknown',state:data?'verified':'unknown'},
   {label:'Checkout redemption',value:'Disabled',state:'warning'},
   {label:'Credit accounts',value:ops?nonnegative(ops.accountCount):'Unknown',state:ops?'verified':'unknown'},
   {label:'Active credit holds',value:ops?nonnegative(ops.openHoldCount):'Unknown',state:ops?'verified':'unknown'},
   {label:'Expired, unresolved credit holds',value:ops?nonnegative(ops.expiredOpenHoldCount):'Unknown',state:ops?.expiredOpenHoldCount?'warning':ops?'verified':'unknown'},
   {label:'Paid checkouts with uncaptured credit',value:ops?nonnegative(ops.paidOpenHoldCount):'Unknown',state:ops?.paidOpenHoldCount?'warning':ops?'verified':'unknown'},
   {label:'Holds missing or mismatching checkout links',value:ops?nonnegative(ops.invalidHoldLinkCount):'Unknown',state:ops?.invalidHoldLinkCount?'warning':ops?'verified':'unknown'},
   {label:'Unpaired or inconsistent hold terminations',value:ops?nonnegative(ops.unpairedTerminalCount+ops.inconsistentTerminalCount):'Unknown',state:ops?.unpairedTerminalCount||ops?.inconsistentTerminalCount?'warning':ops?'verified':'unknown'},
   {label:'Credit captures without payment proof',value:ops?nonnegative(ops.unprovedCaptureCount):'Unknown',state:ops?.unprovedCaptureCount?'warning':ops?'verified':'unknown'},
   {label:'Pending held liability',value:ops?.integrityVerified&&ops.pendingHoldCents!==null?amount(ops.pendingHoldCents):'Unknown',state:ops?.integrityVerified?'verified':'unknown'},
   {label:'Available unheld liability',value:ops?.availableLiabilityCents!==null&&ops?.availableLiabilityCents!==undefined?amount(ops.availableLiabilityCents):'Unknown',state:ops?.integrityVerified?'verified':'unknown'}],
  warnings:[...value.limitations,
   ...(ops===null?['Credit hold/capture reconciliation unavailable; totals alone are insufficient evidence of operational integrity.']:[]),
   ...(ops?.integrityVerified===false?['Credit ledger-to-checkout or capture proof inconsistency detected; monetary availability is unknown.']:[]),
   ...(ops?.expiredOpenHoldCount?['Expired credit holds may still have uncertain Stripe outcomes; do not automatically release them.']:[])],
 }
}
export function makeBudgetInsight(value:{monthSpendMicros:number;activeReservationMicros:number;orphanedReservationMicros:number;effectiveCommittedMicros:number;operationalCutoffMicros:number;manuallyLocked:boolean;mode:string}):Pick<PrivateInsight,'summary'|'lines'|'warnings'>{
 const valid=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0
 const format=(n:number)=>valid(n)?`$${(n/1_000_000).toFixed(2)}`:'Unknown'
 const integrity=[value.monthSpendMicros,value.activeReservationMicros,value.orphanedReservationMicros,value.effectiveCommittedMicros,value.operationalCutoffMicros].every(valid)
 return {
  summary:!integrity?'AI spending figures require integrity review; do not authorize model calls based on them.':value.manuallyLocked||value.mode==='locked'?'AI spending is currently locked.':'AI budget figures are advisory; other provider invoices and taxes may not be included.',
  lines:[{label:'AI actual monthly spend',value:format(value.monthSpendMicros),state:valid(value.monthSpendMicros)?'verified':'unknown'},
   {label:'Active AI cost reservations',value:format(value.activeReservationMicros),state:valid(value.activeReservationMicros)?'verified':'unknown'},
   {label:'Orphaned reservations (conservative)',value:format(value.orphanedReservationMicros),state:valid(value.orphanedReservationMicros)?'verified':'unknown'},
   {label:'Total committed AI budget',value:format(value.effectiveCommittedMicros),state:valid(value.effectiveCommittedMicros)?'verified':'unknown'},
   {label:'Operational cutoff',value:format(value.operationalCutoffMicros),state:valid(value.operationalCutoffMicros)?'verified':'unknown'},
   {label:'Owner lock',value:value.manuallyLocked?'Engaged':'Not engaged',state:value.manuallyLocked?'warning':'verified'}],
  warnings:['Budget figures are a control estimate, not an all-inclusive invoice guarantee.','This read-only endpoint cannot unlock spending, use models, or modify budgets.'],
 }
}
export function makeInventoryInsight(v:InventoryIntegritySummary):Pick<PrivateInsight,'summary'|'lines'|'warnings'> {
 const compromised=v.invalidStockRows>0||v.unreconciledVariants>0
 const complete=v.completeValuation===true&&!compromised
 return {
  summary:compromised?'Physical stock or FIFO layers do not reconcile. Do not treat availability or COGS as verified.':
   v.unknownCostUnits>0?'Physical stock reconciles, but some FIFO landed costs are unknown; full valuation is unavailable.':
   'Stock and FIFO cost layers reconcile at the current read, subject to pending fulfillment and future changes.',
  lines:[metric('Variants recorded',v.variantCount),metric('Active sellable variants',v.activeVariantCount),
   metric('Available units (on-hand minus reserved)',v.availableUnits),
   metric('FIFO layer mismatches',v.unreconciledVariants),
   metric('Invalid stock/reservation rows',v.invalidStockRows),
   metric('Units with unknown landed cost',v.unknownCostUnits),
   {label:'Complete inventory landed cost',value:complete?amount(v.knownLandedCostCents):'Unknown',state:complete?'verified':'unknown'}],
  warnings:['Unknown landed COGS is not zero. Totals are unavailable whenever layer mismatches or unknown-cost units exist.',
   'This is a read-only operational snapshot; it cannot reserve stock, change variant inventory, create orders or purchase stock.'],
 }
}
export function makePaymentExceptionInsight(v:PaymentExceptionSummary):Pick<PrivateInsight,'summary'|'lines'|'warnings'>{
 const open=v.openCount>0
 return {
  summary:open?'Unresolved paid-checkout exceptions require owner review. Do not treat these payments as normal completed orders.':'No open payment exceptions recorded at this read.',
  lines:[metric('Open paid-checkout exceptions',v.openCount),metric('Resolved exceptions',v.resolvedCount),
   {label:'Open exception USD amount',value:v.openUsdCents!==null?amount(v.openUsdCents):'Unknown',state:v.openUsdCents!==null&&v.openNonUsdCount===0?'verified':'unknown'},
   metric('Open exceptions in other currencies',v.openNonUsdCount),
   {label:'Oldest open exception, days',value:v.oldestOpenDays===null?'None':nonnegative(v.oldestOpenDays),state:open?'warning':'verified'},
   metric('No inventory reservation',v.missingReservationCount),
   metric('Insufficient stock',v.insufficientStockCount),
   metric('Reservation ineligible',v.ineligibleReservationCount),
   metric('Unknown reason',v.unknownReasonCount)],
  warnings:['Amounts from other currencies are excluded from the USD subtotal, never converted implicitly.',
   'The exception record may require a separate refund or fulfillment investigation. This tool cannot move money, allocate stock, or resolve exceptions.'],
 }
}
export function makeAffiliateInsight(v:AffiliateIntegritySummary):Pick<PrivateInsight,'summary'|'lines'|'warnings'>{
 const risk=v.incompleteCommissionCount>0||v.inconsistentPayoutCount>0
 return {
  summary:risk?'Affiliate records require reconciliation before trusting payout or commission reports.':
   'Affiliate commission and payout counts agree at this read; this does not establish campaign profit or verify external bank settlement.',
  lines:[metric('Affiliates',v.affiliateCount),metric('Currently active affiliates',v.activeAffiliateCount),
   metric('Recorded commissions',v.commissionCount),metric('Pending commissions',v.pendingCommissionCount),
   metric('Approved commissions',v.approvedCommissionCount),metric('Marked-paid commissions',v.paidCommissionCount),
   metric('Reversed commissions',v.reversedCommissionCount),
   {label:'Incomplete/unquantified commissions',value:nonnegative(v.incompleteCommissionCount),state:v.incompleteCommissionCount>0?'warning':'verified'},
   metric('Draft payouts',v.draftPayoutCount),metric('Marked-paid payouts',v.paidPayoutCount),
   {label:'Payouts not matching line allocations',value:nonnegative(v.inconsistentPayoutCount),state:v.inconsistentPayoutCount>0?'warning':'verified'},
   {label:'Marked-paid payout total (recorded cents)',value:v.recordedPaidPayoutCents===null?'Unknown':`${nonnegative(v.recordedPaidPayoutCents)} cents`,state:v.recordedPaidPayoutCents===null?'unknown':'verified'}],
  warnings:['An incomplete commission is unknown, not zero; a payout mismatch makes monetary totals unavailable.',
   'Marked paid is not bank-reconciled; the total is recorded minor units without an independently verified currency. Profit requires independently verified sales, fees, refunds and landed costs. This tool cannot approve, mark paid or send payouts.'],
 }
}
export function makeMarketingDeliveryInsight(v:MarketingDeliverySummary):Pick<PrivateInsight,'summary'|'lines'|'warnings'>{
 const pending=v.unresolvedAttempts>0
 return {
  summary:pending?'Unresolved provider attempt outcomes require owner investigation. Do not replay claimed marketing deliveries.':
    v.claimedAttempts>0?'All claimed attempts have an evidenced outcome, but delivery and billing still require separate reconciliation.':
    'No marketing delivery attempts recorded; staged recipients are preparation only, not permission to send.',
  lines:[metric('Active staged plans',v.activePlans),metric('Cancelled plans',v.cancelledPlans),
   metric('Total staged recipients (historical)',v.stagedRecipients),
   metric('Claimed, at-most-once attempts',v.claimedAttempts),
   {label:'Provider-accepted outcomes',value:nonnegative(v.providerAccepted),state:'verified'},
   metric('Verified not submitted',v.verifiedNotSubmitted),
   {label:'Unresolved outcomes',value:nonnegative(v.unresolvedAttempts),state:pending?'warning':'verified'},
   {label:'Initial provider acknowledgements (not delivered)',value:nonnegative(v.initialAcknowledged),state:'verified'},
   {label:'Initial provider rejections',value:nonnegative(v.initialRejected),state:v.initialRejected?'warning':'verified'},
   {label:'Uncertain initial provider responses',value:nonnegative(v.initialUncertain),state:v.initialUncertain?'warning':'verified'},
   {label:'Claimed attempts without initial receipts',value:nonnegative(v.missingInitialReceipt),state:v.missingInitialReceipt?'warning':'verified'},
   {label:'Unclaimed historical recipients',value:nonnegative(v.unclaimedRecipients),state:'verified'},
   {label:'Unclaimed active recipients with fresh evidence',value:nonnegative(v.evidenceReadyRecipients),state:'verified'},
   {label:'Oldest unresolved outcome (hours)',value:v.oldestUnresolvedHours===null?'None':nonnegative(v.oldestUnresolvedHours),state:pending?'warning':'verified'}],
  warnings:['No retry is authorized by this report. A timeout may have reached the provider.',
   'Initial provider acceptance is not final delivery, consent, cost settlement, or provider invoice reconciliation.',
   'Fresh evidence expires rapidly and never proves a full audience is ready; current suppression, region, pricing, approval and budgets must be rechecked before each claim.']
 }
}
/** One fixed, owner-only operational brief, no agent, egress, writes or ad-hoc SQL.
 * A missing table/provider never yields an invented zero or an all-clear.
 */
export async function makeOperationsBrief():Promise<Pick<PrivateInsight,'summary'|'lines'|'warnings'>>{
 const topics=['marketing-consent','store-credit','ai-budget','inventory-integrity','payment-exceptions','affiliate-integrity','marketing-delivery'] as const
 const results=await Promise.allSettled(topics.map(t=>getPrivateInsight(t)))
 const labels=['Marketing consent','Store-credit liability','AI spending','Inventory/FIFO','Payment exceptions','Affiliate integrity','Marketing delivery']
 const lines:PrivateInsightLine[]=[]
 const warnings:string[]=['This is a deterministic seven-topic status brief, not an AI prediction or authorization to move money or send messages.']
 let available=0
 for(let i=0;i<results.length;i++){
  const r=results[i]
  if(r.status==='rejected'){
   lines.push({label:labels[i],value:'Unavailable — review source integrity',state:'unknown'})
   warnings.push(`${labels[i]} source unavailable; absence of evidence is not proof of health.`)
   continue
  }
  available++
  const insights=r.value.lines
  const integrityUnknown=insights.some(x=>x.state==='unknown')
  const risk=insights.some(x=>x.state==='warning')
  lines.push({label:labels[i],value:integrityUnknown?'Partial / unknown':risk?'Needs review':'Data available',
   state:integrityUnknown?'unknown':risk?'warning':'verified'})
 }
 return {summary:`${available} of ${topics.length} fixed operational data sources available. Status does not replace financial reconciliation, consent verification or payment review.`,
  lines,warnings}
}
async function getCreditInsight(){
 const [readiness,operations]=await Promise.allSettled([storeCreditReadiness(),getStoreCreditOperationsSummary()])
 const safeReadiness:CreditReadiness=readiness.status==='fulfilled'?readiness.value:{
  status:'integrity-warning',issuanceEnabled:false,redemptionEnabled:false,amounts:null,
  limitations:['Liability totals could not be read. No credit amount is assumed.']}
 return makeCreditInsight(safeReadiness,operations.status==='fulfilled'?operations.value:null)
}
export async function getPrivateInsight(topic:PrivateInsightTopic):Promise<PrivateInsight>{
 if(!validateInsightTopic(topic))throw Error('INSIGHT_TOPIC_INVALID')
 const value=topic==='operations-brief'?await makeOperationsBrief()
  :topic==='marketing-consent'?makeMarketingInsight(await getMarketingOverview())
  :topic==='store-credit'?await getCreditInsight()
  :topic==='inventory-integrity'?makeInventoryInsight(await getInventoryIntegritySummary())
  :topic==='payment-exceptions'?makePaymentExceptionInsight(await getPaymentExceptionSummary())
  :topic==='affiliate-integrity'?makeAffiliateInsight(await getAffiliateIntegritySummary())
  :topic==='marketing-delivery'?makeMarketingDeliveryInsight(await getMarketingDeliverySummary())
  :makeBudgetInsight(await getAiBudgetSnapshot())
 return {topic,asOf:new Date().toISOString(),...value,modelUsed:false,externalTransmission:false,readOnly:true}
}
