/**
 * Marketing Suite pre-dispatch policy, PURE and fail-closed.
 * NOT a dispatch authorizer on its own: calling code must first atomically reserve
 * worst-case provider cost in DB, verify current consent/suppression and enforce
 * recipient/local-time limits in the same controlled execution path. No sends yet.
 */
import {evaluateRecipientDeliveryWindow, type RecipientDeliveryWindow} from './marketing-delivery-window'

export interface MarketingLimits {
  smsMonthlyMicros: number
  smsDailyMicros: number
  emailDailyMicros: number
  aiSmsMonthlyMicros: number
  emailMonthlyMicros: number
  recipientsPerCampaign: number
  maxSmsSegmentsPerRecipient: number
}
export const PROPOSED_MARKETING_LIMITS: Readonly<MarketingLimits> = Object.freeze({
  smsMonthlyMicros: 15_000_000,
  smsDailyMicros: 3_000_000,
  emailDailyMicros: 2_000_000,
  aiSmsMonthlyMicros: 5_000_000,
  emailMonthlyMicros: 10_000_000,
  recipientsPerCampaign: 50,
  maxSmsSegmentsPerRecipient: 1,
})
export interface MarketingDispatchCandidate {
  channel: 'sms' | 'email'
  recipientCount: number
  smsSegmentsPerRecipient?: number
  /** Worst-case cost per recipient including provider charges, carrier fees and regional taxes (USD micros). */
  priceMicrosPerRecipient: number | null
  spentDayMicros: number | null
  reservedDayMicros: number | null
  spentMonthMicros: number | null
  reservedMonthMicros: number | null
  spentAiMonthMicros?: number | null
  reservedAiMonthMicros?: number | null
  limits?: MarketingLimits
  isAiSelected: boolean
  ownerApproved: boolean
  consentVerified: boolean
  suppressionRechecked: boolean
  providerApproved: boolean
  withinRecipientQuietHours: boolean
  recipientFrequencyOk: boolean
  pricingVerified: boolean
  masterMarketingSwitchOn: boolean
  immutableAudienceSnapshot: boolean
  /** Independent, freshly verified jurisdiction/timezone evidence for each
   * recipient. These facts alone never establish consent or send authorization. */
  recipientWindows: ReadonlyArray<RecipientDeliveryWindow> | null
  /** Send initiation UTC clock (not a scheduler's displayed local time). */
  evaluatedAtUtc: Date
}
export interface MarketingPreflightResult {
  permittedToAttemptAtomicReservation: boolean
  worstCaseMicros: number | null
  reasons: string[]
}
function safeNonnegativeInt(n: unknown): n is number {
  return Number.isSafeInteger(n) && typeof n==='number' && n>=0
}
/** This is a preflight estimate only; it NEVER grants permission to send. */
export function preflightMarketingDispatch(c: MarketingDispatchCandidate): MarketingPreflightResult {
  const reasons: string[] = []
  const limits=c.limits ?? PROPOSED_MARKETING_LIMITS
  if(!c.masterMarketingSwitchOn) reasons.push('marketing_disabled')
  if(!c.ownerApproved) reasons.push('owner_approval_required')
  if(!c.providerApproved) reasons.push('provider_approval_required')
  if(!c.consentVerified || !c.suppressionRechecked) reasons.push('consent_or_suppression_unverified')
  if(!c.withinRecipientQuietHours) reasons.push('quiet_hours')
  // The old aggregate boolean was insufficient for a multi-timezone audience.
  // Require a fresh per-recipient evaluation. Not a replacement for final
  // just-in-time checks in the future send worker.
  if(!(c.evaluatedAtUtc instanceof Date)||!Number.isFinite(c.evaluatedAtUtc.getTime())
     || !Array.isArray(c.recipientWindows) || c.recipientWindows.length!==c.recipientCount) {
    reasons.push('recipient_time_window_evidence_missing')
  }else if(c.recipientWindows.some(e=>!evaluateRecipientDeliveryWindow(e,c.evaluatedAtUtc).allowed)){
    reasons.push('recipient_quiet_hours_or_region_unknown')
  }
  if(!c.recipientFrequencyOk) reasons.push('recipient_frequency_limit')
  if(!c.immutableAudienceSnapshot) reasons.push('audience_not_frozen')
  if(!safeNonnegativeInt(c.recipientCount) || c.recipientCount===0 || c.recipientCount>limits.recipientsPerCampaign) reasons.push('recipient_cap')
  if(c.channel==='sms' && (!safeNonnegativeInt(c.smsSegmentsPerRecipient) || !c.smsSegmentsPerRecipient || c.smsSegmentsPerRecipient>limits.maxSmsSegmentsPerRecipient)) reasons.push('segment_cap')
  if(!c.pricingVerified || !safeNonnegativeInt(c.priceMicrosPerRecipient) || c.priceMicrosPerRecipient===0) reasons.push('unknown_or_invalid_price')
  const money=[c.spentDayMicros,c.reservedDayMicros,c.spentMonthMicros,c.reservedMonthMicros]
  if(money.some(n=>!safeNonnegativeInt(n))) reasons.push('unknown_spend_or_reservations')
  // A caller can LOWER hard-coded limits, never raise the owner-facing safety
  // ceilings. The database policy (migration 046) independently enforces them.
  if(!Object.values(limits).every(n=>safeNonnegativeInt(n) && n>0)) reasons.push('invalid_limits')
  for(const k of Object.keys(PROPOSED_MARKETING_LIMITS) as Array<keyof MarketingLimits>){
    if(!safeNonnegativeInt(limits[k]) || limits[k]>PROPOSED_MARKETING_LIMITS[k]){
      reasons.push('limit_exceeds_owner_ceiling')
      break
    }
  }
  // The autonomous marketing permission model is SMS-only, and even that is
  // still gated separately. AI-authored email may be drafted, not dispatched.
  if(c.isAiSelected && c.channel==='email') reasons.push('ai_email_dispatch_not_authorized')
  if(c.isAiSelected && (!safeNonnegativeInt(c.spentAiMonthMicros) || !safeNonnegativeInt(c.reservedAiMonthMicros))) reasons.push('unknown_ai_spend')
  const worstCaseMicros=safeNonnegativeInt(c.recipientCount) && safeNonnegativeInt(c.priceMicrosPerRecipient) &&
    Number.isSafeInteger(c.recipientCount*c.priceMicrosPerRecipient) ? c.recipientCount*c.priceMicrosPerRecipient : null
  if(worstCaseMicros===null || worstCaseMicros<=0) reasons.push('cost_overflow_or_unknown')
  if(worstCaseMicros!==null && money.every(safeNonnegativeInt) && Object.values(limits).every(n=>safeNonnegativeInt(n) && n>0)) {
    // BigInt prevents overflow or silent precision loss when values are individually safe
    // integers but the sum of committed + reserved + candidate costs is not.
    const cost = BigInt(worstCaseMicros)
    const monthly = c.channel==='sms' ? limits.smsMonthlyMicros : limits.emailMonthlyMicros
    if(BigInt(c.spentMonthMicros!)+BigInt(c.reservedMonthMicros!)+cost>BigInt(monthly)) reasons.push('monthly_cap')
    const daily = c.channel==='sms' ? limits.smsDailyMicros : limits.emailDailyMicros
    if(BigInt(c.spentDayMicros!)+BigInt(c.reservedDayMicros!)+cost>BigInt(daily)) reasons.push('daily_cap')
    if(c.isAiSelected && c.channel==='sms' && safeNonnegativeInt(c.spentAiMonthMicros) && safeNonnegativeInt(c.reservedAiMonthMicros)
      && BigInt(c.spentAiMonthMicros)+BigInt(c.reservedAiMonthMicros)+cost>BigInt(limits.aiSmsMonthlyMicros)) reasons.push('ai_sub_budget')
  }
  return { permittedToAttemptAtomicReservation: reasons.length===0, worstCaseMicros, reasons }
}
