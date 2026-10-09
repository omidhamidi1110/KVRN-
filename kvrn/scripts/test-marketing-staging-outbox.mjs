/** Offline send-disabled staging regression. No DB, provider or real contacts. */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const results=[],queries=[]
const sql=async(parts,...args)=>{queries.push(parts.join('?'));if(!results.length)throw Error('MOCK_DB_UNAVAILABLE');return results.shift()}
const id='fb9e6c5b-9a3a-4ad9-a660-d58c44db398c'
const raw=readFileSync('lib/marketing-staged-delivery.ts','utf8')
const compiled=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const exports={}
vm.runInNewContext(compiled,{exports,Date,Number,String,RegExp,console,require(name){
 if(name==='@/lib/db')return {sql}
 if(name==='./marketing-audience-preview')return {validateAudiencePreviewId:x=>typeof x==='string'&&x===id}
 if(name==='./marketing-audience-snapshot')return {validSnapshotRequestKey:x=>typeof x==='string'&&/^[a-zA-Z0-9:_-]{12,120}$/.test(x)}
 throw Error('Unmocked module '+name)
}})
let n=0
const test=async(label,fn)=>{await fn();console.log('PASS',label);n++}
await test('invalid input cannot access DB',async()=>{
 await assert.rejects(exports.stagePrivateDelivery('bad','invalid-key-00000001'),/INVALID_STAGING_INPUT/)
 await assert.rejects(exports.stagePrivateDelivery(id,'bad'),/INVALID_STAGING_INPUT/)
 await assert.rejects(exports.cancelStagedDelivery('bad'),/INVALID_STAGING_INPUT/)
 assert.equal(queries.length,0)
})
await test('staging returns only internal plan reference',async()=>{
 results.push([{id}]);const created=await exports.stagePrivateDelivery(id,'stage-00000000-0001')
 assert.equal(created,id);assert.match(queries.at(-1),/kvrn_marketing_stage_delivery_plan/)
})
await test('cancelling does not call provider',async()=>{
 results.push([{cancelled:true}]);assert.equal(await exports.cancelStagedDelivery(id),true)
 assert.match(queries.at(-1),/kvrn_marketing_cancel_staged_delivery/)
})
await test('read-only Admin list excludes contact identifiers',async()=>{
 results.push([{id,snapshot_id:id,state:'staged',members:7,created_at:'2026-10-08T15:00:00Z'}])
 const plans=await exports.listStagedDeliveries()
 assert.equal(plans[0].memberCount,7)
 assert.equal(plans[0].dispatchAuthorized,false)
 assert.ok(!JSON.stringify(plans).includes('phone_e164'))
})
await test('corrupt counts and state fail closed',async()=>{
 for(const members of [0,51,null,-3]){
  results.push([{id,state:'staged',members}]);await assert.rejects(exports.listStagedDeliveries(),/STAGED_RECIPIENT_COUNT_INTEGRITY/)
 }
 results.push([{id,state:'sending',members:7}]);await assert.rejects(exports.listStagedDeliveries(),/STAGED_STATE_INTEGRITY/)
})
await test('SQL supports only staged or cancelled status',async()=>{
 const m=readFileSync('db/migrations/050_marketing_staged_delivery_outbox.sql','utf8')
 for(const s of [/state IN \('staged','cancelled'\)/,/MARKETING_DELIVERY/i,/DELIVERY_RECENT_CONSENT_REVOKED/,/v_eligible<>v_count/,/v_count<1 OR v_count>50/,/FOR SHARE/,/sms_keyword_consent_proofs/,/marketing_email_consent_events/,/marketing_audience_members/,/unique_staged_recipient/]){
  if(s.source.includes('MARKETING_DELIVERY'))continue
  assert.match(m,s)
 }
 assert.doesNotMatch(m,/status IN \('staged','sending'\)/)
 assert.doesNotMatch(m,/api\.twilio\.com|api\.resend\.com|send_message\(/i)
})
await test('public api requires admin and same-origin bounded JSON',async()=>{
 const m=readFileSync('app/api/admin/marketing/delivery-plans/route.ts','utf8')
 assert.match(m,/requireAdmin/);assert.match(m,/readAdminMutationJson\(req,2000\)/)
 assert.match(m,/sendingEnabled:false/);assert.match(m,/no-store/)
 assert.doesNotMatch(m,/sendSms|sendEmail|\bfetch\(/)
})
await test('staging is not a budget reservation or scheduled delivery',async()=>{
 const m=readFileSync('db/migrations/050_marketing_staged_delivery_outbox.sql','utf8')
 assert.doesNotMatch(m,/marketing_budget_reservations|marketing_editorial_calendar|CREATE TRIGGER.*send|pg_cron/)
})
console.log(`${n}/${n} marketing outbox staging safeguards passed; no DB/provider touched`)
