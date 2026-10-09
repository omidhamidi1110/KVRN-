import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const source=readFileSync('lib/ai/marketing-delivery-insight.ts','utf8')
let results=[],calls=0,lastSql=''
const sql=async(template,...bindings)=>{calls++;assert.equal(bindings.length,0);lastSql=template.join('');return results}
const module={exports:{}}
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
vm.runInNewContext(code,{exports:module.exports,module,require:name=>{
 if(name==='@/lib/db')return {sql}
 throw Error('Unapproved import '+name)
},Object,Number,String,RegExp,Error,Date})
const mod=module.exports
const sample={active_plans:'2',cancelled_plans:'1',staged_recipients:'30',claimed_attempts:'5',provider_accepted:'1',verified_not_submitted:'1',initial_acknowledged:'2',initial_rejected:'1',initial_uncertain:'1',evidence_ready_recipients:'4',oldest_unresolved_hours:'8'}
let n=0
async function test(name,fn){await fn();console.log('PASS',name);n++}
await test('aggregate report returns truthful unresolved and provisional counts',async()=>{
 const ret=mod.interpretMarketingDeliveryRow(sample)
 assert.equal(ret.unresolvedAttempts,3);assert.equal(ret.missingInitialReceipt,1);assert.equal(ret.unclaimedRecipients,25)
 assert.equal(ret.evidenceReadyRecipients,4);assert.equal(ret.oldestUnresolvedHours,8)
})
await test('does not use provider acknowledgement as verified outcome',async()=>{
 const ret=mod.interpretMarketingDeliveryRow({...sample,initial_acknowledged:'4',initial_rejected:'0',initial_uncertain:'0'})
 assert.equal(ret.providerAccepted,1);assert.equal(ret.unresolvedAttempts,3)
})
await test('rejects attempt/outcome counts that cannot reconcile',async()=>{
 for(const value of [{claimed_attempts:'1'}, {staged_recipients:'2'}, {initial_acknowledged:'6'}, {evidence_ready_recipients:'31'}]){
 assert.throws(()=>mod.interpretMarketingDeliveryRow({...sample,...value}),/RECONCILIATION/)
 }
})
await test('rejects missing, fractional, negative, overflow, coercion and null metrics',async()=>{
 for(const bad of [null,undefined,'1.1','-1',-1,Infinity,'9007199254740994','x',{},'01']){
 assert.throws(()=>mod.interpretMarketingDeliveryRow({...sample,claimed_attempts:bad}),/INVALID_/)
 }
})
await test('unresolved attempt requires an oldest unresolved age',async()=>{
 assert.throws(()=>mod.interpretMarketingDeliveryRow({...sample,oldest_unresolved_hours:null}),/RECONCILIATION/)
 const zero={...sample,claimed_attempts:'2',provider_accepted:'1',verified_not_submitted:'1',initial_acknowledged:'1',initial_rejected:'1',initial_uncertain:'0',oldest_unresolved_hours:null}
 assert.equal(mod.interpretMarketingDeliveryRow(zero).unresolvedAttempts,0)
})
await test('database query only returns aggregates, never PII or contact rows',async()=>{
 results=[sample];const r=await mod.getMarketingDeliverySummary();assert.equal(r.unresolvedAttempts,3)
 assert.equal(calls,1)
 for(const part of ['marketing_delivery_attempts','marketing_delivery_attempt_outcomes','marketing_provider_provisional_receipts','marketing_recipient_delivery_evidence','LATERAL','oldest_unresolved_hours'])assert.ok(lastSql.includes(part))
 for(const forbidden of ['.email','.phone_e164','.shipping_address','SELECT *','INSERT ','UPDATE ','DELETE '])assert.equal(lastSql.includes(forbidden),false,forbidden)
 assert.deepEqual(Object.keys(r).filter(x=>x.includes('email')||x.includes('phone')),[])
})
await test('missing schema, missing row, or inconsistent results never become zero',async()=>{
 results=[];await assert.rejects(mod.getMarketingDeliverySummary(),/SCHEMA_UNAVAILABLE/)
 results=[{...sample,provider_accepted:'100'}];await assert.rejects(mod.getMarketingDeliverySummary(),/RECONCILIATION/)
})
console.log(`${n}/${n} marketing-delivery private AI insight tests passed.`)
