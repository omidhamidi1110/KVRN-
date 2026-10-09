/** Deterministic, read-only owner reminders for MANUAL affiliate payouts.
 * A draft payout is already reserved in the ledger, but has NOT been paid.
 * Candidates are approved (not pending), past hold, unreserved commission balances.
 * This is a REVIEW WORKLIST, never an authorization to send funds.
 */
import { sql } from '@/lib/db'

export type AffiliatePayoutReminder = {
  draftPayouts: number
  draftAffiliates: number
  draftAmountCents: number | null
  reviewCommissions: number
  reviewAffiliates: number
  reviewAmountCents: number | null
}

const nonnegativeInt = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (!/^(0|[1-9]\d*)$/.test(String(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export async function getAffiliatePayoutReminder(): Promise<AffiliatePayoutReminder> {
  // Stable SQL function affiliate_commission_payable() only reads the ledger.
  // Deliberately do NOT call affiliate_payable_commissions(): that function
  // promotes pending commissions and is VOLATILE (would mutate state).
  const rows = await sql`
    WITH drafts AS (
      SELECT COUNT(*)::text AS count, COUNT(DISTINCT affiliate_id)::text AS affiliates,
             COALESCE(SUM(amount_cents::bigint),0)::text AS amount
      FROM affiliate_payouts WHERE status='draft'
    ), candidates AS (
      SELECT COUNT(*)::text AS count, COUNT(DISTINCT c.affiliate_id)::text AS affiliates,
             COALESCE(SUM(affiliate_commission_payable(c.id)::bigint),0)::text AS amount
      FROM affiliate_commissions c
      WHERE c.status IN ('approved','paid') AND c.eligible_at <= NOW()
        AND c.incomplete = FALSE AND affiliate_commission_payable(c.id) > 0
    )
    SELECT d.count AS draft_count, d.affiliates AS draft_affiliates,
           d.amount AS draft_amount, c.count AS candidate_count,
           c.affiliates AS candidate_affiliates, c.amount AS candidate_amount
    FROM drafts d CROSS JOIN candidates c
  ` as any[]
  const row = rows[0]
  if (!row) throw new Error('AFFILIATE_PAYOUT_REMINDER_UNAVAILABLE')
  const draftPayouts = nonnegativeInt(row.draft_count)
  const draftAffiliates = nonnegativeInt(row.draft_affiliates)
  const reviewCommissions = nonnegativeInt(row.candidate_count)
  const reviewAffiliates = nonnegativeInt(row.candidate_affiliates)
  if ([draftPayouts,draftAffiliates,reviewCommissions,reviewAffiliates].some(x=>x===null)) {
    throw new Error('AFFILIATE_PAYOUT_REMINDER_INVALID_COUNTS')
  }
  return {
    draftPayouts: draftPayouts!, draftAffiliates: draftAffiliates!,
    draftAmountCents: nonnegativeInt(row.draft_amount),
    reviewCommissions: reviewCommissions!, reviewAffiliates: reviewAffiliates!,
    reviewAmountCents: nonnegativeInt(row.candidate_amount),
  }
}
