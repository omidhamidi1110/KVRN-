import {sql} from '@/lib/db'
import {inspectCreditLiabilityTotals} from './store-credit-ledger-integrity'
export type CreditReadiness={status:'schema-not-applied'|'foundation-only'|'integrity-warning',issuanceEnabled:false,redemptionEnabled:false,amounts:{issuedCents:number,redeemedCents:number,outstandingCents:number}|null,limitations:string[]}
const limitations=[
 'Store credit may not be issued without an inspected and approved eligible return.',
 'A customer must verify ownership of the checkout email before a credit balance is disclosed or spent.',
 'Stripe checkout, refunds, split tenders, tax, reversals and liability accounting must be reconciled first.',
 'No credit is transferable or convertible into cash unless legally required.',
] as const
export async function storeCreditReadiness():Promise<CreditReadiness>{
  // Do not silently interpret missing ledger as a $0 business liability.
  try{
    const rows=await sql`SELECT total_issued_cents,total_redeemed_cents,outstanding_liability_cents FROM store_credit_liability_totals`
    const amounts=inspectCreditLiabilityTotals(rows[0])
    if (!amounts) return {status:'integrity-warning',issuanceEnabled:false,redemptionEnabled:false,
      amounts:null,limitations:['Unexpected or inconsistent liability totals. Do not rely on these balances or enable credit operations.',...limitations]}
    return {status:'foundation-only',issuanceEnabled:false,redemptionEnabled:false,
      amounts,limitations:[...limitations]}
  }catch{return{status:'schema-not-applied',issuanceEnabled:false,redemptionEnabled:false,amounts:null,limitations:[...limitations]}}
}
