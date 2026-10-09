import { preflightMarketingDispatch, type MarketingDispatchCandidate } from '../marketing-dispatch-policy'
const base: MarketingDispatchCandidate = {
 channel:'sms',recipientCount:5,smsSegmentsPerRecipient:1,priceMicrosPerRecipient:50_000,
 spentDayMicros:0,reservedDayMicros:0,spentMonthMicros:0,reservedMonthMicros:0,
 spentAiMonthMicros:0,reservedAiMonthMicros:0,isAiSelected:false,ownerApproved:true,consentVerified:true,
 suppressionRechecked:true,providerApproved:true,withinRecipientQuietHours:true,recipientFrequencyOk:true,
 pricingVerified:true,masterMarketingSwitchOn:true,immutableAudienceSnapshot:true,
 recipientWindows:Array.from({length:5},()=>({timezone:'America/Los_Angeles',timezoneVerified:true,jurisdictionRuleVerified:true})),
 evaluatedAtUtc:new Date('2026-10-08T18:30:00Z'),
}
test('marketing disabled by default until all explicit send gates pass',()=>{
 expect(preflightMarketingDispatch({...base,masterMarketingSwitchOn:false}).reasons).toContain('marketing_disabled')
})
test('unknown price or spend is a blocking error rather than free cost',()=>{
 expect(preflightMarketingDispatch({...base,priceMicrosPerRecipient:null}).permittedToAttemptAtomicReservation).toBe(false)
 expect(preflightMarketingDispatch({...base,reservedMonthMicros:null}).reasons).toContain('unknown_spend_or_reservations')
})
test('worst case cost is bounded by monthly and daily caps',()=>{
 expect(preflightMarketingDispatch({...base,spentDayMicros:2_900_000}).reasons).toContain('daily_cap')
 expect(preflightMarketingDispatch({...base,spentMonthMicros:14_900_000}).reasons).toContain('monthly_cap')
})
test('cannot exceed recipient/segment caps or missing consent evidence',()=>{
 const r=preflightMarketingDispatch({...base,recipientCount:51,smsSegmentsPerRecipient:2,consentVerified:false})
 expect(r.reasons).toEqual(expect.arrayContaining(['recipient_cap','segment_cap','consent_or_suppression_unverified']))
})
test('preflight can only authorize attempting a transaction reservation, never actual send',()=>{
 const r=preflightMarketingDispatch(base)
 expect(r.permittedToAttemptAtomicReservation).toBe(true)
 expect(r.worstCaseMicros).toBe(250_000)
})

test('email channel also has a hard daily budget (not only monthly)',()=>{
 const e={...base,channel:'email' as const,spentDayMicros:1_950_000,recipientCount:2,priceMicrosPerRecipient:50_000}
 expect(preflightMarketingDispatch(e).reasons).toContain('daily_cap')
})
test('a caller cannot raise owner ceilings or disable daily caps by supplying custom limits',()=>{
 const limits={smsMonthlyMicros:15_000_000,smsDailyMicros:3_000_000,emailDailyMicros:999_000_000,
   aiSmsMonthlyMicros:5_000_000,emailMonthlyMicros:10_000_000,recipientsPerCampaign:50,maxSmsSegmentsPerRecipient:1}
 expect(preflightMarketingDispatch({...base,limits}).reasons).toContain('limit_exceeds_owner_ceiling')
})
test('AI-initiated email remains blocked, even when other preflight inputs say yes',()=>{
 expect(preflightMarketingDispatch({...base,channel:'email',isAiSelected:true}).reasons).toContain('ai_email_dispatch_not_authorized')
})

test('fails closed when individual recipients have missing/invalid quiet hour evidence',()=>{
 expect(preflightMarketingDispatch({...base,recipientWindows:null}).reasons).toContain('recipient_time_window_evidence_missing')
 expect(preflightMarketingDispatch({...base,recipientWindows:[{timezone:'America/Los_Angeles',timezoneVerified:true,jurisdictionRuleVerified:true}]}).reasons).toContain('recipient_time_window_evidence_missing')
 expect(preflightMarketingDispatch({...base,recipientWindows:Array.from({length:5},()=>({timezone:'America/New_York',timezoneVerified:true,jurisdictionRuleVerified:true})),evaluatedAtUtc:new Date('2026-10-09T02:30:00Z')}).reasons).toContain('recipient_quiet_hours_or_region_unknown')
})
