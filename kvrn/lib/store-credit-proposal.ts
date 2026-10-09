/**
 * Conservative PRE-ISSUANCE assessment for discretionary return store credit.
 * Pure function: no DB writes, no credit issuance, no payment action, no PII.
 * The calling server must obtain ALL evidence from trusted order/return/refund records
 * under a transaction before using this as one of several authorization checks.
 * This is not a consumer eligibility decision for statutory refund remedies.
 */
export interface CreditReturnEvidence {
  returnStatus: 'requested'|'in_transit'|'received'|'completed'|'cancelled'
  discretionaryReturnApproved: boolean | null
  paymentSucceeded: boolean | null
  orderCurrency: string | null
  deliveredAt: string | null
  requestedAt: string | null
  receivedAt: string | null
  completedAt: string | null
  cashRefundExistsForOrder: boolean | null
  returnRefundAllocationsExist: boolean | null
  disputeOrChargebackExists: boolean | null
  storeCreditAlreadyIssuedForReturn: boolean | null
  lines: ReadonlyArray<{quantity: number; netMerchandiseBasisCents: number | null}>
  proposedCreditCents: number
}
export type CreditProposalAssessment = {
  readyForFurtherReview: boolean
  maximumMerchandiseCents: number | null
  reasons: string[]
}
const DAY_MS = 24 * 60 * 60 * 1000
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER)
const safeNonnegative = (v:unknown):v is number => typeof v==='number' && Number.isSafeInteger(v) && v>=0
function timestamp(v:unknown):number|null {
  if(typeof v!=='string'|| !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v)) return null
  const value=Date.parse(v)
  return Number.isFinite(value)?value:null
}
export function assessDiscretionaryReturnCredit(f:CreditReturnEvidence):CreditProposalAssessment {
  const reasons:string[]=[]
  if(f.returnStatus!=='completed'||f.receivedAt===null||f.completedAt===null)reasons.push('return_not_completed_and_inspected')
  if(f.discretionaryReturnApproved!==true)reasons.push('explicit_discretionary_approval_missing')
  if(f.paymentSucceeded!==true)reasons.push('payment_not_verified')
  if(f.orderCurrency?.toLowerCase()!=='usd')reasons.push('currency_not_supported')
  const delivered=timestamp(f.deliveredAt),requested=timestamp(f.requestedAt)
  if(delivered===null||requested===null||requested<delivered||requested-delivered>14*DAY_MS) reasons.push('return_window_unverified_or_expired')
  const received=timestamp(f.receivedAt),completed=timestamp(f.completedAt)
  if(received===null||completed===null||requested===null||received<requested||completed<received)reasons.push('return_inspection_timeline_invalid')
  // Default-deny if a full or partial cash refund, credit, dispute or allocation
  // is unknown. Mixed settlements require a separate, fully reconciled design.
  if(f.cashRefundExistsForOrder!==false)reasons.push('cash_refund_or_uncertain_status')
  if(f.returnRefundAllocationsExist!==false)reasons.push('return_refund_allocation_or_unknown')
  if(f.disputeOrChargebackExists!==false)reasons.push('dispute_or_unknown')
  if(f.storeCreditAlreadyIssuedForReturn!==false)reasons.push('credit_already_issued_or_unknown')
  let basis=0n
  if(!Array.isArray(f.lines)||f.lines.length===0)reasons.push('missing_returned_merchandise')
  else for(const line of f.lines) {
    if(!Number.isSafeInteger(line.quantity)||line.quantity<=0||!safeNonnegative(line.netMerchandiseBasisCents)){
      reasons.push('missing_or_unsafe_net_merchandise_snapshot')
      break
    }
    basis+=BigInt(line.netMerchandiseBasisCents)
    if(basis>SAFE_MAX){reasons.push('merchandise_basis_overflow');break}
  }
  const maximumMerchandiseCents=reasons.some(r=>r==='missing_returned_merchandise'||r==='missing_or_unsafe_net_merchandise_snapshot'||r==='merchandise_basis_overflow')?null:Number(basis)
  if(!Number.isSafeInteger(f.proposedCreditCents)||f.proposedCreditCents<=0||maximumMerchandiseCents===null||f.proposedCreditCents>maximumMerchandiseCents)reasons.push('proposed_credit_exceeds_verified_merchandise')
  return {readyForFurtherReview:reasons.length===0, maximumMerchandiseCents,reasons}
}
