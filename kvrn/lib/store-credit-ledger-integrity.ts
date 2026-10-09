/** Offline-verifiable read model for financial liability summary.
 * Missing/corrupt/overflow accounting must never be silently displayed as $0.
 * This is only a consistency check on an aggregate, not a reconciliation audit. */
export type CreditLiabilityTotals={issuedCents:number,redeemedCents:number,outstandingCents:number}
function cents(x:unknown):bigint|null {
  if(typeof x==='bigint')return x>=0n?x:null
  if(typeof x==='number')return Number.isSafeInteger(x)&&x>=0?BigInt(x):null
  if(typeof x==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(x))return BigInt(x)
  return null
}
export function inspectCreditLiabilityTotals(row:unknown):CreditLiabilityTotals|null{
  if(!row||typeof row!=='object')return null
  const r=row as Record<string,unknown>
  const issued=cents(r.total_issued_cents),redeemed=cents(r.total_redeemed_cents),outstanding=cents(r.outstanding_liability_cents)
  if(issued===null||redeemed===null||outstanding===null)return null
  const MAX=BigInt(Number.MAX_SAFE_INTEGER)
  if(issued>MAX||redeemed>MAX||outstanding>MAX||redeemed>issued||issued-redeemed!==outstanding)return null
  return {issuedCents:Number(issued),redeemedCents:Number(redeemed),outstandingCents:Number(outstanding)}
}
