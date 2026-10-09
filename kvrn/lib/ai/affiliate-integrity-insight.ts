/** Aggregate affiliate payout integrity for authenticated first-party Admin insights.
 * Historical economics remain in the commission adjustment ledger; this snapshot
 * deliberately never calls a mutating promotion function or claims net profit.
 * No affiliate names, referral identifiers, customer data or payment details leave here.
 */
import {sql} from '@/lib/db'

export type AffiliateIntegritySummary={
 affiliateCount:number;activeAffiliateCount:number;commissionCount:number;
 pendingCommissionCount:number;approvedCommissionCount:number;paidCommissionCount:number;
 reversedCommissionCount:number;incompleteCommissionCount:number;
 draftPayoutCount:number;paidPayoutCount:number;inconsistentPayoutCount:number;
 recordedPaidPayoutCents:number|null;integrityVerified:boolean
}
function safe(raw:unknown,field:string):number{
 if(raw===null||raw===undefined||!/^\d+$/.test(String(raw)))throw Error('AFFILIATE_INSIGHT_INVALID_'+field)
 const n=Number(raw)
 if(!Number.isSafeInteger(n)||n<0)throw Error('AFFILIATE_INSIGHT_INVALID_'+field)
 return n
}
export function interpretAffiliateIntegrityRow(row:Record<string,unknown>):AffiliateIntegritySummary{
 const affiliateCount=safe(row.affiliate_count,'AFFILIATES')
 const activeAffiliateCount=safe(row.active_affiliate_count,'ACTIVE_AFFILIATES')
 const commissionCount=safe(row.commission_count,'COMMISSIONS')
 const pendingCommissionCount=safe(row.pending_commission_count,'PENDING')
 const approvedCommissionCount=safe(row.approved_commission_count,'APPROVED')
 const paidCommissionCount=safe(row.paid_commission_count,'PAID')
 const reversedCommissionCount=safe(row.reversed_commission_count,'REVERSED')
 const incompleteCommissionCount=safe(row.incomplete_commission_count,'INCOMPLETE')
 const draftPayoutCount=safe(row.draft_payout_count,'DRAFT_PAYOUTS')
 const paidPayoutCount=safe(row.paid_payout_count,'PAID_PAYOUTS')
 const inconsistentPayoutCount=safe(row.inconsistent_payout_count,'INCONSISTENT_PAYOUTS')
 const recordedPaid=safe(row.recorded_paid_payout_cents,'PAID_PAYOUT_AMOUNT')
 if(activeAffiliateCount>affiliateCount||
    pendingCommissionCount+approvedCommissionCount+paidCommissionCount+reversedCommissionCount!==commissionCount||
    incompleteCommissionCount>commissionCount||inconsistentPayoutCount>draftPayoutCount+paidPayoutCount||
    (paidPayoutCount===0&&recordedPaid!==0))throw Error('AFFILIATE_INSIGHT_INCONSISTENT_COUNTS')
 const integrityVerified=incompleteCommissionCount===0&&inconsistentPayoutCount===0
 return {affiliateCount,activeAffiliateCount,commissionCount,pendingCommissionCount,
  approvedCommissionCount,paidCommissionCount,reversedCommissionCount,incompleteCommissionCount,
  draftPayoutCount,paidPayoutCount,inconsistentPayoutCount,
  recordedPaidPayoutCents:inconsistentPayoutCount===0?recordedPaid:null,integrityVerified}
}
export async function getAffiliateIntegritySummary():Promise<AffiliateIntegritySummary>{
 // Independent aggregates prevent JOIN fan-out from inflating commissions or payouts.
 // An inconsistent payout is one whose recorded total differs from its own line items.
 // Avoid the portal balance helper: it could promote commissions.
 const rows=await sql`WITH
 a AS (SELECT COUNT(*)::text affiliate_count,
      COUNT(*) FILTER (WHERE status='active')::text active_affiliate_count FROM affiliates),
 c AS (SELECT COUNT(*)::text commission_count,
      COUNT(*) FILTER (WHERE status='pending')::text pending_commission_count,
      COUNT(*) FILTER (WHERE status='approved')::text approved_commission_count,
      COUNT(*) FILTER (WHERE status='paid')::text paid_commission_count,
      COUNT(*) FILTER (WHERE status='reversed')::text reversed_commission_count,
      COUNT(*) FILTER (WHERE incomplete)::text incomplete_commission_count
      FROM affiliate_commissions),
 p AS (SELECT COUNT(*) FILTER (WHERE status='draft')::text draft_payout_count,
      COUNT(*) FILTER (WHERE status='paid')::text paid_payout_count,
      COUNT(*) FILTER (WHERE status IN ('draft','paid') AND amount_cents::bigint <>
        (SELECT COALESCE(SUM(l.amount_cents::bigint),0) FROM affiliate_payout_lines l WHERE l.payout_id=pay.id))::text inconsistent_payout_count,
      COALESCE(SUM(amount_cents::bigint) FILTER (WHERE status='paid'),0)::text recorded_paid_payout_cents
      FROM affiliate_payouts pay)
 SELECT * FROM a CROSS JOIN c CROSS JOIN p`
 if(rows.length!==1)throw Error('AFFILIATE_INSIGHT_SCHEMA_UNAVAILABLE')
 return interpretAffiliateIntegrityRow(rows[0] as Record<string,unknown>)
}
