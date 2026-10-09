import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const id='11111111-1111-4111-8111-111111111111'
const source=readFileSync('lib/marketing-signed-twilio-outcome.ts','utf8')
const migration=readFileSync('db/migrations/060_marketing_provisional_provider_receipts.sql','utf8')
const route=readFileSync('app/api/twilio/status/route.ts','utf8')
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
let sqlCalls=0,recordCalls=0,dbResults=[{attempt_id:id}]
const mods={
 '@/lib/db':{sql:()=>{sqlCalls++;return Promise.resolve(dbResults)}},
 './marketing-provider-receipts':{validProviderReference:(_,ref)=>/^SM[a-f0-9]{32}$/.test(ref),digestProviderReference:async()=> 'd'.repeat(64)},
 './marketing-verified-outcome':{recordVerifiedMarketingAttemptOutcome:async()=>{recordCalls++}},
 './phone':{normalizePhoneE164:(s)=>/^\+1[0-9]{10}$/.test(s)?s:null},
}
const mod={exports:{}}
new Function('module','exports','require',js)(mod,mod.exports,name=>mods[name]??{})
const {isFinalTwilioMarketingAcceptance,recordSignedTwilioMarketingAcceptance}=mod.exports
const env={...process.env}
let n=0
async function t(label,fn){await fn();n++;console.log('PASS',label)}
await t('only signed delivered status is final acceptance',()=>{for(const bad of ['queued','accepted','sending','sent','failed','undelivered','read',null])assert.equal(isFinalTwilioMarketingAcceptance(bad),false);assert.equal(isFinalTwilioMarketingAcceptance('delivered'),true)})
await t('feature disabled avoids querying marketing tables',async()=>{delete process.env.MARKETING_SIGNED_TWILIO_OUTCOME_ENABLED;assert.equal(await recordSignedTwilioMarketingAcceptance('SM'+'a'.repeat(32),'delivered','+15555551234',true),'ignored');assert.equal(sqlCalls,0)})
process.env.MARKETING_SIGNED_TWILIO_OUTCOME_ENABLED='true';process.env.MARKETING_PROVIDER_OUTCOME_RECONCILIATION_ENABLED='true'
await t('untrusted status cannot be recorded as verified',async()=>{await assert.rejects(()=>recordSignedTwilioMarketingAcceptance('SM'+'a'.repeat(32),'delivered','+15555551234',false),/SIGNATURE/);assert.equal(sqlCalls,0)})
await t('failed/undelivered statuses cannot clear attempts',async()=>{for(const st of ['failed','undelivered','sent'])assert.equal(await recordSignedTwilioMarketingAcceptance('SM'+'a'.repeat(32),st,'+15555551234',true),'ignored');assert.equal(sqlCalls,0)})
await t('invalid or missing customer number fails closed',async()=>{await assert.rejects(()=>recordSignedTwilioMarketingAcceptance('SM'+'a'.repeat(32),'delivered','someone@example.com',true),/RECIPIENT/);assert.equal(sqlCalls,0)})
await t('a valid correlated signed delivery records verified attempt',async()=>{assert.equal(await recordSignedTwilioMarketingAcceptance('SM'+'a'.repeat(32),'delivered','+15555551234',true),'recorded');assert.equal(sqlCalls,1);assert.equal(recordCalls,1)})
await t('unknown signed provider reference is not treated as attempted recipient',async()=>{dbResults=[];assert.equal(await recordSignedTwilioMarketingAcceptance('SM'+'a'.repeat(32),'delivered','+15555551234',true),'ignored');assert.equal(recordCalls,1)})
await t('corrupt linked attempt throws so webhook can retry',async()=>{dbResults=[{attempt_id:'bad'}];await assert.rejects(()=>recordSignedTwilioMarketingAcceptance('SM'+'a'.repeat(32),'delivered','+15555551234',true),/CORRUPT/);assert.equal(recordCalls,1)})
await t('signed webhook status follows existing authenticated and idempotent upsert path',()=>{assert.ok(route.indexOf("validity === 'invalid'")<route.indexOf('recordSignedTwilioMarketingAcceptance('));assert.ok(route.indexOf('upsertMessageStatus({')<route.indexOf('recordSignedTwilioMarketingAcceptance('));assert.match(route,/status: 503/);assert.match(migration,/marketing_provider_provisional_receipts/)})
for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k]
Object.assign(process.env,env)
console.log(`${n}/${n} signed Twilio marketing outcome checks passed`)
