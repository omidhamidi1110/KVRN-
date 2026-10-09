/**
 * Store-credit accounting domain ONLY. Production issuance/redemption is disabled
 * until transactional database persistence, Stripe reconciliation and return
 * authorization are separately implemented, audited and approved.
 * All figures are integer US cents. No expiry or purchased gift cards.
 */
export type CreditLedgerEvent =
  | { idempotencyKey: string; type: 'issue'; amountCents: number; approvedReturnId: string }
  | { idempotencyKey: string; type: 'hold'; amountCents: number; holdId: string }
  | { idempotencyKey: string; type: 'capture'; amountCents: number; holdId: string; orderId: string }
  | { idempotencyKey: string; type: 'release'; amountCents: number; holdId: string }

export type StoreCreditSummary = {
  issuedCents: number
  redeemedCents: number
  availableCents: number
  heldCents: number
  outstandingCents: number
  eventCount: number
}
const positive = (v: number) => Number.isSafeInteger(v) && v>0
const MAX_CENTS=BigInt(Number.MAX_SAFE_INTEGER)
function safeCents(cents:bigint):number{
  if(cents<0n || cents>MAX_CENTS)throw new Error('CREDIT_OVERFLOW')
  return Number(cents)
}
/** Pure fold for a single account. Apply under a serializable DB transaction with a DB unique event key. */
export function calculateStoreCredit(events: ReadonlyArray<CreditLedgerEvent>): StoreCreditSummary {
  const keys=new Map<string,string>()
  const issues=new Set<string>()
  const holds=new Map<string,bigint>()
  // BigInt is essential: several individually safe cent amounts may overflow
  // JavaScript Number arithmetic when summed. Reject overflow explicitly.
  let issued=0n,redeemed=0n
  for(const e of events) {
    if(!e.idempotencyKey || !positive(e.amountCents)) throw new Error('INVALID_CREDIT_EVENT')
    const amount=BigInt(e.amountCents)
    const serialized=JSON.stringify(e)
    if(keys.has(e.idempotencyKey)) {
      if(keys.get(e.idempotencyKey)!==serialized) throw new Error('IDEMPOTENCY_CONFLICT')
      continue // exact webhook/callback retry must not double charge or issue
    }
    keys.set(e.idempotencyKey,serialized)
    if(e.type==='issue') {
      if(!e.approvedReturnId || issues.has(e.approvedReturnId)) throw new Error('DUPLICATE_RETURN_CREDIT')
      issues.add(e.approvedReturnId)
      issued+=amount
    } else if(e.type==='hold') {
      if(!e.holdId || holds.has(e.holdId)) throw new Error('DUPLICATE_CREDIT_HOLD')
      const held=[...holds.values()].reduce((a,b)=>a+b,0n)
      if(issued-redeemed-held<amount) throw new Error('INSUFFICIENT_CREDIT')
      holds.set(e.holdId,amount)
    } else {
      if(!e.holdId || !holds.has(e.holdId)) throw new Error('UNKNOWN_CREDIT_HOLD')
      if(holds.get(e.holdId)!==amount) throw new Error('CREDIT_HOLD_MISMATCH')
      holds.delete(e.holdId)
      if(e.type==='capture') {
        if(!e.orderId) throw new Error('MISSING_ORDER_FOR_CREDIT_CAPTURE')
        redeemed+=amount
      }
    }
    safeCents(issued);safeCents(redeemed)
  }
  const heldCents=[...holds.values()].reduce((a,b)=>a+b,0n)
  const availableCents=issued-redeemed-heldCents
  if(availableCents<0n) throw new Error('NEGATIVE_CREDIT_BALANCE')
  return {issuedCents:safeCents(issued),redeemedCents:safeCents(redeemed),availableCents:safeCents(availableCents),
    heldCents:safeCents(heldCents),outstandingCents:safeCents(issued-redeemed),eventCount:keys.size}
}
