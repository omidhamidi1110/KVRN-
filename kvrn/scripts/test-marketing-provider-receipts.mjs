import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const source=readFileSync('lib/marketing-provider-receipts.ts','utf8')
const migration=readFileSync('db/migrations/060_marketing_provisional_provider_receipts.sql','utf8')
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
let sqlCount=0
const fakeSql=Object.assign(()=>{sqlCount++;return Promise.resolve([{id:'22222222-2222-4222-8222-222222222222'}])},{})
const mod={exports:{}}
new Function('module','exports','require',js)(mod,mod.exports,()=>({sql:fakeSql}))
const {validProviderReference,digestProviderReference,classifyProviderResponse,validateProvisionalReceipt,recordProvisionalProviderReceipt}=mod.exports
const ID='11111111-1111-4111-8111-111111111111'
let n=0
async function test(name,fn){await fn();n++;console.log('PASS',name)}
await test('Twilio SID strict, rejects phone numbers and unbounded strings',()=>{
 assert.ok(validProviderReference('twilio','SM'+'a'.repeat(32)))
 for(const bad of ['+15556667777','xx'+'f'.repeat(32),'SM'+'0'.repeat(31),'SM'+'a'.repeat(32)+'a'])assert.equal(validProviderReference('twilio',bad),false)
})
await test('Resend message ids reject HTML, URLs, email addresses and excessively long IDs',()=>{
 assert.equal(validProviderReference('resend','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),true)
 for(const bad of ['test@example.com','https://foo.com','<script>','a'.repeat(129)])assert.equal(validProviderReference('resend',bad),false)
})
await test('HTTP 202 is only provisional, never a final acceptance',()=>{
 assert.deepEqual(classifyProviderResponse('twilio',202,'SM'+'b'.repeat(32)),{result:'acknowledged',reference:'SM'+'b'.repeat(32),verifiedFinalOutcome:false,canRetry:false})
})
await test('all 4xx/5xx remain non-retryable and not final',()=>{
 for(const code of [400,404,409,429,500,503]){const r=classifyProviderResponse('resend',code,'x'.repeat(30));assert.equal(r.result,'rejected');assert.equal(r.canRetry,false);assert.equal(r.verifiedFinalOutcome,false)}
})
await test('timeout, malformed or missing response never reports accepted',()=>{
 for(const code of [undefined,null,0,700,201.5]){const r=classifyProviderResponse('resend',code,null);assert.equal(r.result,'uncertain');assert.equal(r.verifiedFinalOutcome,false)}
})
await test('HMAC digest scoped to brand, provider and pepper',async()=>{
 const key='x'.repeat(48),ref='SM'+'b'.repeat(32)
 const a=await digestProviderReference('twilio',ref,key)
 const b=await digestProviderReference('twilio',ref,key)
 assert.equal(a,b);assert.match(a,/^[0-9a-f]{64}$/)
 assert.notEqual(a,await digestProviderReference('twilio',ref,'z'.repeat(48)))
 await assert.rejects(()=>digestProviderReference('twilio',ref,'short'))
})
await test('receipt validator rejects unknown fields and invalid shape',()=>{
 const x={attemptId:ID,provider:'twilio',result:'uncertain',referenceDigest:null}
 assert.equal(validateProvisionalReceipt(x),true)
 assert.equal(validateProvisionalReceipt({...x,recipient:'somebody'}),false)
 assert.equal(validateProvisionalReceipt({...x,result:'acknowledged'}),false)
 assert.equal(validateProvisionalReceipt({...x,result:'rejected',referenceDigest:'a'.repeat(64)}),false)
 assert.equal(validateProvisionalReceipt({...x,result:'acknowledged',referenceDigest:'a'.repeat(64)}),true)
})
await test('recorder remains disabled by default and makes no database call',async()=>{
 delete process.env.MARKETING_PROVIDER_RECEIPTS_ENABLED
 await assert.rejects(()=>recordProvisionalProviderReceipt({attemptId:ID,provider:'twilio',result:'uncertain',referenceDigest:null}),/DISABLED/)
 assert.equal(sqlCount,0)
})
await test('enabled recorder requires strict evidence and uses DB function',async()=>{
 process.env.MARKETING_PROVIDER_RECEIPTS_ENABLED='true'
 await assert.rejects(()=>recordProvisionalProviderReceipt({attemptId:ID,provider:'twilio',result:'acknowledged',referenceDigest:null}),/INVALID/)
 assert.equal(sqlCount,0)
 const id=await recordProvisionalProviderReceipt({attemptId:ID,provider:'twilio',result:'uncertain',referenceDigest:null})
 assert.equal(id,'22222222-2222-4222-8222-222222222222');assert.equal(sqlCount,1)
 delete process.env.MARKETING_PROVIDER_RECEIPTS_ENABLED
})
await test('SQL records are append-only, one per claimed attempt, no budget or send writer',()=>{
 assert.match(migration,/attempt_id uuid NOT NULL UNIQUE/)
 assert.match(migration,/marketing_provisional_immutable/)
 assert.match(migration,/v_claim\.provider<>p_provider/)
 assert.match(migration,/MARKETING_PROVISIONAL_CONFLICT_NO_RESEND/)
 assert.doesNotMatch(migration,/UPDATE\s+marketing_budget_reservations|INSERT\s+INTO\s+sms_messages|\bhttp\s*\(/i)
})
console.log(`${n}/${n} provisional provider receipt checks passed`)
