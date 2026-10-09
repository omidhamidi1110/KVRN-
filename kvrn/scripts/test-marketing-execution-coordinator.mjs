import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const content=readFileSync('lib/marketing-execution-coordinator.ts','utf8')
const js=ts.transpileModule(content,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const mod={exports:{}}
new Function('module','exports',js)(mod,mod.exports)
const {isValidExecutionInput,executeMarketingAttemptOnce}=mod.exports
const ID='11111111-1111-4111-8111-111111111111'
const input={planId:ID,memberId:1,approvalId:ID,budgetReservationId:ID,evidenceId:ID,messageSha256:'f'.repeat(64),claimKey:'kvrn_test_claim_01',channel:'sms'}
let n=0;async function test(label,fn){await fn();n++;console.log('PASS',label)}
function deps(outcome){const c={pre:0,claim:0,send:0,record:0};return {c,deps:{recheck:async()=>{c.pre++;return true},claim:async()=>{c.claim++;return ID},submitOnce:async()=>{c.send++;return outcome??{kind:'outcome_unknown'}},recordVerifiedOutcome:async()=>{c.record++}}}}
const old={...process.env};
await test('rejects forged/reduced request evidence',()=>{assert.equal(isValidExecutionInput(input),true);assert.equal(isValidExecutionInput({...input,memberId:0}),false);assert.equal(isValidExecutionInput({...input,channel:'both'}),false);assert.equal(isValidExecutionInput({...input,phone:'+1'}),false)})
await test('feature switches default OFF before any action',async()=>{delete process.env.MARKETING_SEND_ENABLED;delete process.env.MARKETING_PROVIDER_DELIVERY_ENABLED;const d=deps();const r=await executeMarketingAttemptOnce(input,d.deps);assert.equal(r.state,'blocked');assert.equal(d.c.pre,0);assert.equal(d.c.send,0)})
process.env.MARKETING_SEND_ENABLED='true';process.env.MARKETING_PROVIDER_DELIVERY_ENABLED='true'
await test('failed independent precheck prevents claim and send',async()=>{const d=deps();d.deps.recheck=async()=>false;const r=await executeMarketingAttemptOnce(input,d.deps);assert.equal(r.state,'blocked');assert.equal(d.c.claim,0);assert.equal(d.c.send,0)})
await test('DB claim failures prevent network call',async()=>{const d=deps();d.deps.claim=async()=>{throw Error('already claimed')};const r=await executeMarketingAttemptOnce(input,d.deps);assert.equal(r.state,'blocked');assert.equal(d.c.send,0)})
await test('network exception leaves unknown no retry or free budget',async()=>{const d=deps();d.deps.submitOnce=async()=>{d.c.send++;throw Error('timeout')};const r=await executeMarketingAttemptOnce(input,d.deps);assert.equal(r.state,'claimed_unknown');assert.equal(r.canRetry,false);assert.equal(r.costSettled,false);assert.equal(d.c.send,1);assert.equal(d.c.record,0)})
await test('provider accepted requires immutable evidence before success',async()=>{const outcome={kind:'provider_accepted',providerReferenceSha256:'a'.repeat(64),verificationSource:'provider_final_status'};const d=deps(outcome);const r=await executeMarketingAttemptOnce(input,d.deps);assert.equal(r.state,'provider_accepted');assert.equal(r.costSettled,false);assert.equal(d.c.send,1);assert.equal(d.c.record,1)})
await test('evidence write failure leaves unknown even after transport accepted',async()=>{const d=deps({kind:'provider_accepted',providerReferenceSha256:'a'.repeat(64),verificationSource:'provider_invoice'});d.deps.recordVerifiedOutcome=async()=>{throw Error('db down')};const r=await executeMarketingAttemptOnce(input,d.deps);assert.equal(r.state,'claimed_unknown');assert.equal(r.canRetry,false)})
await test('ambiguous transport rejection is not verified not-submitted',async()=>{const d=deps({kind:'verified_not_submitted',providerReferenceSha256:'a'.repeat(64),verificationSource:'provider_invoice'});const r=await executeMarketingAttemptOnce(input,d.deps);assert.equal(r.state,'claimed_unknown');assert.equal(d.c.record,0)})
await test('verified not-submitted records only proven provider rejection',async()=>{const d=deps({kind:'verified_not_submitted',providerReferenceSha256:'a'.repeat(64),verificationSource:'verified_provider_rejection'});const r=await executeMarketingAttemptOnce(input,d.deps);assert.equal(r.state,'verified_not_submitted');assert.equal(r.canRetry,false);assert.equal(d.c.send,1)})
await test('no HTTP endpoint or provider adapter wired into coordinator',()=>{assert.doesNotMatch(content,/\bfetch\(|\bsendSms\(|\bStripe\b/);assert.match(content,/deps\.claim\(input\)/);assert.ok(content.indexOf('deps.claim(input)')<content.indexOf('deps.submitOnce(input,attemptId)'))})
Object.assign(process.env,old);delete process.env.MARKETING_SEND_ENABLED;delete process.env.MARKETING_PROVIDER_DELIVERY_ENABLED
console.log(`${n}/${n} marketing execution coordinator tests passed`)
