/** Offline DB writer contracts. No real financial writes, Neon or checkout. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const text=readFileSync('lib/store-credit-checkout-hold.ts','utf8')
const migration=readFileSync('db/migrations/051_store_credit_checkout_holds.sql','utf8')
const transpiled=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const calls=[]
const sql=async()=>{calls.push(true);return [{event_id:'123456789'}]}
const exports={}
const env={STORE_CREDIT_CHECKOUT_HOLD_ENABLED:'false'}
vm.runInNewContext(transpiled,{exports,process:{env},Number,String,RegExp,Error,require(name){if(name==='@/lib/db')return {sql};throw Error(name)}})
const sample={accountId:'fb9e6c5b-9a3a-4ad9-a660-d58c44db398c',reservationId:'ff9e6c5b-9a3a-4ad9-a660-d58c44db398c',holdKey:'credit-hold-0001',requestKey:'credit-request-0001',amountCents:1500,verifiedAccountOwnership:true,canonicalNetTenderVerified:true}
let n=0
async function test(name,fn){await fn();n++;console.log('PASS',name)}
await test('disabled by default even for valid evidence',async()=>{
 await assert.rejects(exports.prepareCheckoutCreditHold(sample),/CREDIT_HOLDS_DISABLED/);assert.equal(calls.length,0)
})
await test('no browser proof is accepted implicitly',async()=>{
 assert.deepEqual([...exports.validateCheckoutCreditHold({...sample,verifiedAccountOwnership:false})],['unverified_account_ownership'])
})
await test('net tender needs independent validation',async()=>{
 assert.ok(exports.validateCheckoutCreditHold({...sample,canonicalNetTenderVerified:false}).includes('unverified_checkout_amount'))
})
await test('reject unsafe amounts and references',async()=>{
 for(const v of [0,-1,0.5,Number.MAX_SAFE_INTEGER+1,NaN])assert.ok(exports.validateCheckoutCreditHold({...sample,amountCents:v}).length)
 for(const holdKey of ['bad','foo\nbar','!'.repeat(20)])assert.ok(exports.validateCheckoutCreditHold({...sample,holdKey}).length)
})
await test('enabled path uses single SQL transaction function',async()=>{
 env.STORE_CREDIT_CHECKOUT_HOLD_ENABLED='true';assert.equal(await exports.prepareCheckoutCreditHold(sample),'123456789');assert.equal(calls.length,1)
})
await test('SQL globally serializes all account reservations',async()=>assert.match(migration,/pg_advisory_xact_lock\(48112026051::bigint\)/))
await test('SQL prevents reservation reuse and request key conflict',async()=>{
 assert.match(migration,/CREDIT_RESERVATION_ALREADY_HELD/);assert.match(migration,/CREDIT_HOLD_IDEMPOTENCY_CONFLICT/)
 assert.match(migration,/reservation_id uuid NOT NULL UNIQUE/)
})
await test('SQL only accepts active bound Stripe checkout reservations',async()=>{
 assert.match(migration,/v_res\.expires_at <= NOW\(\)/);assert.match(migration,/v_res\.stripe_checkout_session_id IS NULL/)
})
await test('SQL sums actual available credit not pending holds',async()=>{
 assert.match(migration,/v_available := v_issued-v_captured-v_pending/);assert.match(migration,/NOT EXISTS \(/)
})
await test('SQL does not enable issuing, capture, release or provider calls',async()=>{
 assert.doesNotMatch(migration,/kvrn_credit_(issue|capture|release)\(/i)
 assert.doesNotMatch(migration,/http_post|stripe\.com|send_sms|send_email/i)
})
console.log(`${n}/${n} offline credit checkout hold tests passed`)
