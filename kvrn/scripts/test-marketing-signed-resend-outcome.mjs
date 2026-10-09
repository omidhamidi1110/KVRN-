import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const source=readFileSync('lib/marketing-signed-resend-outcome.ts','utf8'),route=readFileSync('app/api/resend/marketing-webhook/route.ts','utf8')
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const id='11111111-1111-4111-8111-111111111111'
let sqlCalls=0,verifiedCalls=0,results=[{attempt_id:id}]
const modules={
 '@/lib/db':{sql:()=>{sqlCalls++;return Promise.resolve(results)}},
 './marketing-provider-receipts':{validProviderReference:(_,ref)=>typeof ref==='string'&&/^[a-f0-9-]{36}$/.test(ref),digestProviderReference:async()=> 'd'.repeat(64)},
 './marketing-verified-outcome':{recordVerifiedMarketingAttemptOutcome:async()=>{verifiedCalls++}},
}
const mod={exports:{}}
new Function('module','exports','require',js)(mod,mod.exports,name=>modules[name]??{})
const {extractSignedResendDelivery,recordSignedResendMarketingDelivery}=mod.exports
const env={...process.env}
const event={type:'email.delivered',data:{email_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',to:['CUSTOMER@Example.com']}}
let n=0
async function t(label,fn){await fn();n++;console.log('PASS',label)}
await t('extracts only confirmed Resend delivery from exact recipient',()=>{assert.deepEqual(extractSignedResendDelivery(event),{providerMessageId:event.data.email_id,recipientEmail:'customer@example.com'});for(const type of ['email.sent','email.bounced','email.complained','contact.updated'])assert.equal(extractSignedResendDelivery({...event,type}),null)})
await t('ambiguous or missing recipient is not delivery evidence',()=>{for(const to of [[],['a@example.com','b@example.com'],['bad'],null])assert.equal(extractSignedResendDelivery({...event,data:{...event.data,to}}),null)})
await t('disabled default cannot query database',async()=>{delete process.env.MARKETING_SIGNED_RESEND_OUTCOME_ENABLED;assert.equal(await recordSignedResendMarketingDelivery(event,true),'ignored');assert.equal(sqlCalls,0)})
process.env.MARKETING_SIGNED_RESEND_OUTCOME_ENABLED='true';process.env.MARKETING_PROVIDER_OUTCOME_RECONCILIATION_ENABLED='true'
await t('unsigned callback is never accepted',async()=>{await assert.rejects(()=>recordSignedResendMarketingDelivery(event,false),/SIGNATURE/);assert.equal(sqlCalls,0)})
await t('signed correlated delivery can record verified terminal outcome',async()=>{assert.equal(await recordSignedResendMarketingDelivery(event,true),'recorded');assert.equal(sqlCalls,1);assert.equal(verifiedCalls,1)})
await t('unknown provider reference is ignored and never broad-matched',async()=>{results=[];assert.equal(await recordSignedResendMarketingDelivery(event,true),'ignored');assert.equal(verifiedCalls,1)})
await t('malformed linked claim remains a retryable webhook error',async()=>{results=[{attempt_id:'bad'}];await assert.rejects(()=>recordSignedResendMarketingDelivery(event,true),/CORRUPT/);assert.equal(verifiedCalls,1)})
await t('existing suppression route verifies signature first and preserves suppression branch',()=>{assert.ok(route.indexOf('verifyResendWebhook(')<route.indexOf('recordSignedResendMarketingDelivery('));assert.ok(route.indexOf('extractResendSuppression(')<route.indexOf('recordSignedResendMarketingDelivery('));assert.match(route,/kvrn_resend_suppress_marketing/);assert.match(route,/retry required/);assert.match(route,/status=503|},503/);})
for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k]
Object.assign(process.env,env)
console.log(`${n}/${n} signed Resend marketing delivery checks passed`)
