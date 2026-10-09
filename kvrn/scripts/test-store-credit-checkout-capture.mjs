import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const req=createRequire(import.meta.url)
let ts;try{ts=req('typescript')}catch{ts=req('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const src=readFileSync('lib/store-credit-checkout-capture.ts','utf8')
const schema=readFileSync('db/migrations/057_store_credit_verified_capture.sql','utf8')
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const uuid='abb9e3a1-5ec7-433b-93a4-a1e3a5934ff1'
const testId='cs_test_abc123456789',intentId='pi_ABCabc01234',orderId='a0739daa-5ef4-432f-bab4-1e70af58c975'
const env={STORE_CREDIT_CHECKOUT_CAPTURE_ENABLED:'false',STRIPE_MODE:'test'}
let db=0,stripeCalls=0,cash=5000,gross=7000,sessionStatus='complete',paymentStatus='paid',piStatus='succeeded',chargeStatus='succeeded',refunded=false,disputed=false,piIntent=intentId
const charge=()=>({payment_intent:intentId,paid:true,status:chargeStatus,disputed,refunded,amount_refunded:refunded?1:0,amount:cash})
const session=()=>({id:testId,status:sessionStatus,payment_status:paymentStatus,payment_intent:piIntent})
const pi=()=>({id:intentId,status:piStatus,currency:'usd',amount_received:cash,amount:cash,latest_charge:charge()})
const query=async()=>{db++;return db===1?[{order_id:orderId,session_id:testId,intent_id:intentId,cash_cents:cash,gross_cents:String(gross)}]:[{event_id:'4001'}]}
const exp={}
vm.runInNewContext(js,{exports:exp,process:{env},Error,Number,String,RegExp,Object,require(name){
 if(name==='@/lib/db')return {sql:query}
 if(name==='@/lib/stripe-client')return {getStripe:()=>({checkout:{sessions:{retrieve:async()=>{stripeCalls++;return session()}}},paymentIntents:{retrieve:async()=>{stripeCalls++;return pi()}}})}
 throw Error('unknown import '+name)
}})
const input={reservationId:uuid,requestKey:'capture-000001'}
let n=0
async function test(label,fn){await fn();n++;console.log('PASS',label)}
await test('default off: no DB or provider reads',async()=>{await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_DISABLED/);assert.equal(db,0);assert.equal(stripeCalls,0)})
await test('cannot use live Stripe even with switch on',async()=>{env.STORE_CREDIT_CHECKOUT_CAPTURE_ENABLED='true';env.STRIPE_MODE='live';await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_DISABLED/);assert.equal(db,0)})
await test('strict request schema rejects extras and malformed keys',async()=>{assert.equal(exp.validateCaptureVerifiedCredit({...input,x:'a'}),false);assert.equal(exp.validateCaptureVerifiedCredit({...input,reservationId:'bad'}),false);assert.equal(exp.validateCaptureVerifiedCredit({...input,requestKey:'x'}),false)})
await test('reject missing order evidence before provider call',async()=>{env.STRIPE_MODE='test';db=0;cash=7000;gross=7000;await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_CANONICAL_AMOUNTS_INVALID/);assert.equal(db,1);assert.equal(stripeCalls,0);cash=5000;gross=7000})
await test('reject noncomplete or unpaid session',async()=>{for(const v of ['open','expired']){db=0;sessionStatus=v;await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_SESSION_NOT_PAID/);assert.equal(db,1)}sessionStatus='complete';paymentStatus='unpaid';db=0;await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_SESSION_NOT_PAID/);paymentStatus='paid'})
await test('reject mismatched Checkout PaymentIntent',async()=>{db=0;piIntent='pi_different';await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_SESSION_NOT_PAID/);piIntent=intentId})
await test('reject unfinished PaymentIntent',async()=>{db=0;piStatus='processing';await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_STRIPE_AMOUNT_NOT_FINAL/);piStatus='succeeded'})
await test('reject disputed or refunded Charge',async()=>{disputed=true;db=0;await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_STRIPE_CHARGE_UNRESOLVED/);disputed=false;refunded=true;db=0;await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_STRIPE_CHARGE_UNRESOLVED/);refunded=false})
await test('reject unverified paid-charge state',async()=>{chargeStatus='pending';db=0;await assert.rejects(exp.captureVerifiedPaidCredit(input),/CREDIT_CAPTURE_STRIPE_CHARGE_UNRESOLVED/);chargeStatus='succeeded'})
await test('only verified paid test Checkout and PI can write ledger',async()=>{db=0;const result=await exp.captureVerifiedPaidCredit(input);assert.equal(result,'4001');assert.equal(db,2)})
await test('serialized ledger capture checks paid order, gross/cash composition, no refunds/disputes',async()=>{for(const x of ['pg_advisory_xact_lock(48112026051','v_order.payment_status<>\'paid\'','v_gross<>p_gross_order_cents','FROM order_refunds','FROM order_disputes','v_order.total_cents::bigint<>p_cash_received_cents'])assert.ok(schema.includes(x),x)})
await test('transactional unique hold capture proof and append-only audit',async()=>{for(const x of ['UNIQUE REFERENCES store_credit_ledger','order_id uuid NOT NULL UNIQUE','reservation_id uuid NOT NULL UNIQUE','capture_event_id','CREDIT_CAPTURE_ALREADY_TERMINAL','CREDIT_CAPTURE_PROOF_APPEND_ONLY'])assert.ok(schema.includes(x),x)})
await test('no endpoint, webhook mutation or marketing/provider outbound send',async()=>{assert.doesNotMatch(src,/\.create\(|\.refund\(|sendSms|sendEmail/);assert.doesNotMatch(schema,/http_post|http_get|stripe\.com/);assert.match(src,/STRIPE_MODE!=='test'/)})
console.log(`${n}/${n} isolated checkout capture tests passed`)
