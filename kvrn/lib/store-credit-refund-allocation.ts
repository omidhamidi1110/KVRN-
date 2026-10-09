/** Pure, staging-only split-tender refund allocation validator.
 * Store credit is a PAYMENT method, not a discount. The original tender split
 * and all previous refunds must be verified from canonical Stripe/Neon ledgers.
 * No financial state changes; a future DB writer must re-check with locks and
 * idempotency, and a refund to original payment method may require legal review.
 */
export type SplitTenderRefundProposal={
 currency:'usd'; originalGrossCents:number; originalCashTenderCents:number; originalCreditTenderCents:number
 cashAlreadyRefundedCents:number; creditAlreadyRestoredCents:number
 approvedRefundCents:number; proposedCashRefundCents:number; proposedCreditRestoreCents:number
 /** Source of approved remedy and refund basis must be independent of browser. */
 originalTenderVerified:boolean; previousSettlementsVerified:boolean; remedyApproved:boolean
 disputeClearanceVerified:boolean; refundStatusFinalVerified:boolean
}
export type ValidatedRefundAllocation={
 currency:'usd';originalGrossCents:number;approvedRefundCents:number
 cashRefundCents:number;creditRestoreCents:number
 remainingCashRefundableCents:number;remainingCreditRestorableCents:number
 cashRefundRequiresStripe:true;creditRestoreRequiresLedger:true
/** Never means this plan is approved to execute. */ executionAuthorized:false
}
const MAX=BigInt(Number.MAX_SAFE_INTEGER)
const money=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
const add=(a:bigint,b:bigint)=>{const s=a+b;if(s>MAX)throw Error('CREDIT_REFUND_OVERFLOW');return s}
export function validateSplitTenderRefund(p:SplitTenderRefundProposal):ValidatedRefundAllocation{
 if(!p||typeof p!=='object'||p.currency!=='usd')throw Error('CREDIT_REFUND_UNSUPPORTED_CURRENCY')
 const values=[p.originalGrossCents,p.originalCashTenderCents,p.originalCreditTenderCents,
  p.cashAlreadyRefundedCents,p.creditAlreadyRestoredCents,p.approvedRefundCents,
  p.proposedCashRefundCents,p.proposedCreditRestoreCents]
 if(!values.every(money))throw Error('CREDIT_REFUND_UNSAFE_CENTS')
 if(!p.originalTenderVerified||!p.previousSettlementsVerified||!p.remedyApproved||
    !p.disputeClearanceVerified||!p.refundStatusFinalVerified)
  throw Error('CREDIT_REFUND_EVIDENCE_MISSING')
 const [gross,cash,credit,priorCash,priorCredit,approved,newCash,newCredit]=values.map(v=>BigInt(v))
 if(gross<1n||cash<1n||credit<1n||approved<1n)throw Error('CREDIT_REFUND_UNSUPPORTED_TENDER')
 if(add(cash,credit)!==gross)throw Error('CREDIT_REFUND_ORIGINAL_TENDER_MISMATCH')
 if(priorCash>cash||priorCredit>credit)throw Error('CREDIT_REFUND_PRIOR_SETTLEMENT_INVALID')
 if(add(newCash,newCredit)!==approved)throw Error('CREDIT_REFUND_ALLOCATION_MISMATCH')
 if(newCash>cash-priorCash||newCredit>credit-priorCredit)
  throw Error('CREDIT_REFUND_EXCEEDS_REMAINING_TENDER')
 if(approved>gross-add(priorCash,priorCredit))throw Error('CREDIT_REFUND_OVER_REFUND')
 return {currency:'usd',originalGrossCents:p.originalGrossCents,approvedRefundCents:p.approvedRefundCents,
  cashRefundCents:p.proposedCashRefundCents,creditRestoreCents:p.proposedCreditRestoreCents,
  remainingCashRefundableCents:Number(cash-priorCash-newCash),
  remainingCreditRestorableCents:Number(credit-priorCredit-newCredit),
  cashRefundRequiresStripe:true,creditRestoreRequiresLedger:true,executionAuthorized:false}
}
