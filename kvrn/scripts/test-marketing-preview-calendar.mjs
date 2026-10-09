/** Dependency-free tests of audience privacy + editorial calendar contracts.
 * No network, DB, messages, or real date scheduling. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
const ts=require('typescript')
let hits=0
function check(name,fn){return Promise.resolve().then(fn).then(()=>{console.log('PASS',name);hits++})}
function compile(file,dependencyMap){
 const out=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
 const exports={}
 vm.runInNewContext(out.outputText,{exports,Date,Number,console,require:(name)=>{
   if(!(name in dependencyMap))throw Error('Unmocked import '+name)
   return dependencyMap[name]
 }},{filename:file})
 return exports
}
const fakeResults=[]; const queryTexts=[]
async function sql(parts,...params){
 queryTexts.push(parts.join('?'))
 if(!fakeResults.length)throw Error('No mocked query')
 return fakeResults.shift()
}
const draftModule={}
const audience=compile('lib/marketing-audience-preview.ts',{'@/lib/db':{sql},'@/lib/marketing-campaign-drafts':draftModule})
const calendar=compile('lib/marketing-editorial-calendar.ts',{'@/lib/db':{sql},'@/lib/marketing-audience-preview':audience})
const validId='b2a72546-641d-43ae-979f-0ffab3d318f6'
await check('invalid campaign IDs cannot be queried',async()=>{
 for(const id of ['','abc','001; DROP TABLE marketing_subscribers',null]){
  assert.equal(audience.validateAudiencePreviewId(id),false)
  await assert.rejects(()=>audience.previewCampaignAudience(id),/INVALID_CAMPAIGN_ID/)
 }
})
await check('unsupported existing-customer segment is blocked rather than assumed consenting',async()=>{
 fakeResults.push([{channel:'email',audience:'existing-customers',state:'reviewed',version:1}])
 await assert.rejects(()=>audience.previewCampaignAudience(validId),/AUDIENCE_REQUIRES_VERIFIED/)
})
await check('only reviewed campaigns receive audience estimates',async()=>{
 fakeResults.push([{channel:'sms',audience:'all-consenting',state:'draft',version:2}])
 await assert.rejects(()=>audience.previewCampaignAudience(validId),/CAMPAIGN_NOT_REVIEWED/)
})
await check('SMS evidence count excludes raw recipient PII and requires two-step proof',async()=>{
 queryTexts.length=0
 fakeResults.push([{channel:'sms',audience:'recent-opt-ins',state:'reviewed',version:4}],[{total:3}])
 const result=await audience.previewCampaignAudience(validId)
 assert.equal(result.canDispatch,false)
 assert.equal(result.locallyEvidenceMatched,3)
 assert.equal(result.campaignVersion,4)
 assert.ok(!JSON.stringify(result).includes('phone_e164'))
 assert.match(queryTexts[1],/sms_keyword_consent_proofs/)
 assert.match(queryTexts[1],/twilio_opt_out_state='opted_in'/)
 assert.match(queryTexts[1],/unsubscribed_at IS NULL/)
 assert.doesNotMatch(queryTexts[1],/SELECT\s+(?:s\.)?phone_e164/)
})
await check('email evidence count excludes unsubscribes and never returns addresses',async()=>{
 queryTexts.length=0
 fakeResults.push([{channel:'email',audience:'all-consenting',state:'reviewed',version:1}],[{total:51}])
 const result=await audience.previewCampaignAudience(validId)
 assert.equal(result.overInitialCap,true)
 assert.equal(result.canDispatch,false)
 assert.match(queryTexts[1],/marketing_email_consent_events/)
 assert.match(queryTexts[1],/event_type='unsubscribed'/)
 assert.doesNotMatch(queryTexts[1],/SELECT\s+(?:s\.)?email/)
 assert.ok(!JSON.stringify(result).includes('@'))
})
await check('missing consent migrations fail closed',async()=>{
 fakeResults.push([{channel:'sms',audience:'all-consenting',state:'reviewed',version:1}])
 await assert.rejects(()=>audience.previewCampaignAudience(validId),/No mocked query/)
})
await check('nonnumeric audience counts reject rather than default to zero',async()=>{
 fakeResults.push([{channel:'email',audience:'all-consenting',state:'reviewed',version:1}],[{total:null}])
 // Number(null) would incorrectly become 0; this test requires explicit unknown rejection.
 await assert.rejects(()=>audience.previewCampaignAudience(validId),/AUDIENCE_COUNT_INVALID/)
})
await check('editorial schedule requires explicit future UTC time within one year',async()=>{
 const now=Date.parse('2026-10-08T22:00:00Z')
 assert.equal(calendar.validateEditorialTime('2026-10-08T22:05:00.000Z',now),null)
 assert.equal(calendar.validateEditorialTime('2026-10-08T22:20:00.000Z',now),'2026-10-08T22:20:00.000Z')
 assert.equal(calendar.validateEditorialTime('2029-01-01T00:00:00.000Z',now),null)
 assert.equal(calendar.validateEditorialTime('2026-10-08T15:00',now),null)
})
await check('invalid calendar record or version never gets a DB write',async()=>{
 for(const v of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
  await assert.rejects(()=>calendar.planEditorialCampaign(validId,v,new Date(Date.now()+3600000).toISOString()),/INVALID_EDITORIAL_PLAN/)
 }
 await assert.rejects(()=>calendar.cancelEditorialPlan('invalid'),/INVALID_EDITORIAL_PLAN/)
})
await check('calendar can only write through audited database functions',async()=>{
 const source=readFileSync('lib/marketing-editorial-calendar.ts','utf8')
 assert.match(source,/SELECT kvrn_marketing_editorial_plan/)
 assert.match(source,/SELECT kvrn_marketing_editorial_cancel/)
 assert.doesNotMatch(source,/\b(?:INSERT|DELETE|UPDATE)\s+(?:INTO\s+|FROM\s+)?marketing_editorial_calendar/i)
 const sql=readFileSync('db/migrations/048_marketing_editorial_calendar.sql','utf8')
 assert.match(sql,/campaign_version/)
 assert.match(sql,/state<>'reviewed'/)
 assert.match(sql,/idx_marketing_one_active_plan/)
 assert.match(sql,/marketing_editorial_calendar_audit/)
 assert.doesNotMatch(sql,/\b(?:http_post|fetch|send_message|twilio|resend_api)\s*\(/i)
})
await check('no send actions in new read-only API routes',async()=>{
 for(const path of ['app/api/admin/marketing/calendar/route.ts','app/api/admin/marketing/audience-preview/route.ts']){
  const text=readFileSync(path,'utf8')
  assert.match(text,/requireAdmin/)
  assert.match(text,/no-store/)
  assert.doesNotMatch(text,/api\.twilio\.com|api\.resend\.com|stripe\.com|sendCampaign|sendSms|sendEmail/)
 }
})
console.log(`${hits}/${hits} audience/calendar contract checks passed; no sends or DB operations performed`)
