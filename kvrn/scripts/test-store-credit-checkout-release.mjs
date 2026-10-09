import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const src=readFileSync('lib/store-credit-checkout-release.ts','utf8')
const sqlFile=readFileSync('db/migrations/056_store_credit_checkout_release.sql','utf8')
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const env={STORE_CREDIT_CHECKOUT_RELEASE_ENABLED:'false',STRIPE_MODE:'test'}
let status='expired',payment='unpaid',pi=null,stripeCount=0,sqlCount=0
const sql=async()=>{sqlCount++;return sqlCount===1?[{session_id:'cs_test_ABC000111222'}]:[{event_id:'90847'}]}
const exp={}
vm.runInNewContext(js,{exports:exp,process:{env},Object,Number,String,RegExp,Error,require(name){
 if(name==='@/lib/db')return {sql}
 if(name==='@/lib/stripe-client')return {getStripe:()=>({checkout:{sessions:{retrieve:async(id)=>{stripeCount++;return {id,status,payment_status:payment,payment_intent:pi}}}}})}
 throw Error(name)
}})
const input={reservationId:'ff9e6c5b-9a3a-4ad9-a660-d58c44db398c',requestKey:'release-000001'}
let n=0
async function test(name,fn){await fn();n++;console.log('PASS',name)}
await test('disabled-by-default never calls Stripe or DB',async()=>{await assert.rejects(exp.releaseExpiredCreditHold(input),/CREDIT_RELEASE_DISABLED/);assert.equal(sqlCount,0);assert.equal(stripeCount,0)})
await test('cannot execute against live Stripe even if flag is on',async()=>{env.STORE_CREDIT_CHECKOUT_RELEASE_ENABLED='true';env.STRIPE_MODE='live';await assert.rejects(exp.releaseExpiredCreditHold(input),/CREDIT_RELEASE_DISABLED/);assert.equal(sqlCount,0)})
await test('reject invalid UUID and idempotency key',async()=>{assert.equal(exp.validateReleaseCreditHold({...input,reservationId:'bad'}),false);assert.equal(exp.validateReleaseCreditHold({...input,requestKey:'short'}),false)})
await test('test-mode only, Stripe final expiry proof before ledger call',async()=>{env.STRIPE_MODE='test';sqlCount=0;status='open';await assert.rejects(exp.releaseExpiredCreditHold(input),/CREDIT_RELEASE_PROVIDER_NOT_FINAL/);assert.equal(sqlCount,1);status='expired'})
await test('paid and unexpired provider sessions always blocked',async()=>{for(const paymentState of ['paid','no_payment_required']){sqlCount=0;payment=paymentState;await assert.rejects(exp.releaseExpiredCreditHold(input),/CREDIT_RELEASE_PROVIDER_NOT_FINAL/);assert.equal(sqlCount,1)}payment='unpaid'})
await test('unresolved payment intent blocks credit release',async()=>{pi='pi_not_fetched';sqlCount=0;await assert.rejects(exp.releaseExpiredCreditHold(input),/CREDIT_RELEASE_PAYMENT_INTENT_UNRESOLVED/);assert.equal(sqlCount,1);pi={status:'processing'};sqlCount=0;await assert.rejects(exp.releaseExpiredCreditHold(input),/CREDIT_RELEASE_PAYMENT_INTENT_UNRESOLVED/);assert.equal(sqlCount,1);pi=null})
await test('final expired unpaid session with no intent can release in isolated test',async()=>{sqlCount=0;assert.equal(await exp.releaseExpiredCreditHold(input),'90847');assert.equal(sqlCount,2)})
await test('shared advisory lock serializes hold, issue, release',async()=>assert.match(sqlFile,/pg_advisory_xact_lock\(48112026051::bigint\)/))
await test('SQL checks linked orders of every payment state and reservation terminal state',async()=>{assert.match(sqlFile,/FROM orders o/);assert.match(sqlFile,/v_res\.status NOT IN \('released','failed'\)/);assert.match(sqlFile,/CREDIT_RELEASE_ORDER_PRESENT/)})
await test('unique terminal event protects against capture-after-release',async()=>assert.match(sqlFile,/event_type IN \('capture','release'\)/))
await test('idempotent only identical proof and key',async()=>{assert.match(sqlFile,/v_existing\.idempotency_key=p_request_key/);assert.match(sqlFile,/v_existing\.event_type='release'/);assert.match(sqlFile,/CREDIT_RELEASE_HOLD_ALREADY_TERMINAL/)})
await test('append-only Stripe-finality proof and no external sends',async()=>{assert.match(sqlFile,/CREDIT_RELEASE_PROOF_APPEND_ONLY/);assert.doesNotMatch(src,/\bPOST\b|sendSms|sendEmail|sendRefund/);assert.doesNotMatch(sqlFile,/http_post|stripe\.com/)})
console.log(`${n}/${n} checkout credit release checks passed`)
