/** Offline, dependency-free (aside from global TS compiler) behavior tests.
 * Never invokes providers, local DB, or a network. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
const ts=require('typescript')
function loadPureTs(path, bindings={}){
 const source=readFileSync(path,'utf8')
 const result=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true})
 assert.equal(result.diagnostics?.length||0,0)
 const exported={}
 vm.runInNewContext(result.outputText,{exports:exported,console,Date,Intl,require:(name)=>{
  if(!(name in bindings))throw Error('Unexpected runtime dependency: '+name)
  return bindings[name]
 }},{filename:path})
 return exported
}
const windowLib=loadPureTs('lib/marketing-delivery-window.ts')
const exported=loadPureTs('lib/marketing-dispatch-policy.ts',{'./marketing-delivery-window':windowLib})
const {preflightMarketingDispatch, PROPOSED_MARKETING_LIMITS}=exported
const base={channel:'sms',recipientCount:5,smsSegmentsPerRecipient:1,priceMicrosPerRecipient:100_000,
 spentDayMicros:0,reservedDayMicros:0,spentMonthMicros:0,reservedMonthMicros:0,
 spentAiMonthMicros:0,reservedAiMonthMicros:0,isAiSelected:false,ownerApproved:true,consentVerified:true,
 suppressionRechecked:true,providerApproved:true,withinRecipientQuietHours:true,recipientFrequencyOk:true,
 pricingVerified:true,masterMarketingSwitchOn:true,immutableAudienceSnapshot:true,
 recipientWindows:Array.from({length:5},()=>({timezone:'America/Los_Angeles',timezoneVerified:true,jurisdictionRuleVerified:true})),
 evaluatedAtUtc:new Date('2026-10-08T18:30:00Z')}
const cases=[
 ['unverified consent blocks reservations',{consentVerified:false},'consent_or_suppression_unverified'],
 ['unknown price blocks reservations',{priceMicrosPerRecipient:null},'unknown_or_invalid_price'],
 ['missing ledger totals block reservations',{reservedMonthMicros:null},'unknown_spend_or_reservations'],
 ['SMS daily cap enforced',{spentDayMicros:2_700_000},'daily_cap'],
 ['SMS monthly cap enforced',{spentMonthMicros:14_700_000},'monthly_cap'],
 ['email daily cap enforced',{channel:'email',spentDayMicros:1_700_000},'daily_cap'],
 ['email monthly cap enforced',{channel:'email',spentMonthMicros:9_700_000},'monthly_cap'],
 ['AI email cannot dispatch',{channel:'email',isAiSelected:true},'ai_email_dispatch_not_authorized'],
 ['AI SMS subset cap enforced',{isAiSelected:true,spentAiMonthMicros:4_700_000},'ai_sub_budget'],
 ['owner cap cannot be raised',{limits:{...PROPOSED_MARKETING_LIMITS,emailDailyMicros:50_000_000}},'limit_exceeds_owner_ceiling'],
 ['zero or negative caps rejected',{limits:{...PROPOSED_MARKETING_LIMITS,emailDailyMicros:0}},'invalid_limits'],
 ['recipient limit blocks oversends',{recipientCount:51},'recipient_cap'],
 ['recipient evidence must match frozen audience',{recipientWindows:[]},'recipient_time_window_evidence_missing'],
 ['unknown region cannot bypass quiet hours',{recipientWindows:Array.from({length:5},()=>({timezone:'America/Los_Angeles',timezoneVerified:true,jurisdictionRuleVerified:false}))},'recipient_quiet_hours_or_region_unknown'],
 ['invalid IANA zone cannot bypass quiet hours',{recipientWindows:Array.from({length:5},()=>({timezone:'America/NotReal',timezoneVerified:true,jurisdictionRuleVerified:true}))},'recipient_quiet_hours_or_region_unknown'],
 ['missing approval blocks reservations',{ownerApproved:false},'owner_approval_required'],
]
for (const [label,delta,reason] of cases){
 const x=preflightMarketingDispatch({...base,...delta})
 assert.ok(x.reasons.includes(reason),`${label}: expected ${reason}, got ${x.reasons}`)
 assert.equal(x.permittedToAttemptAtomicReservation,false,label)
 console.log('PASS',label)
}
assert.equal(preflightMarketingDispatch(base).worstCaseMicros,500_000)
const evaluate=windowLib.evaluateRecipientDeliveryWindow
const sample={timezone:'America/Los_Angeles',timezoneVerified:true,jurisdictionRuleVerified:true}
assert.equal(evaluate(sample,new Date('2026-03-08T16:30:00Z')).allowed,true, 'DST boundary uses local clock, not fixed PST')
assert.equal(evaluate(sample,new Date('2026-03-08T15:30:00Z')).allowed,false, 'earlier PST time blocked')
assert.equal(evaluate(sample,new Date('2026-10-09T05:00:00Z')).allowed,false, 'late night blocked')
assert.equal(evaluate({...sample,timezoneVerified:false},new Date()).allowed,false, 'unverified timezone blocked')
console.log('PASS real timezone/DST quiet-hour decisions')
const sitemap=readFileSync('app/sitemap.ts','utf8')
assert.doesNotMatch(sitemap,/lastModified\s*:\s*new Date\s*\(/,'No fake per-request lastmod')
assert.match(sitemap,/\.\.\.\(lastModified \? \{ lastModified \} : \{\}\)/,'Product lastmod source preserved')
console.log('PASS sitemap only uses known timestamps')
console.log(`${cases.length+3}/${cases.length+3} offline budget/SEO checks passed`)
