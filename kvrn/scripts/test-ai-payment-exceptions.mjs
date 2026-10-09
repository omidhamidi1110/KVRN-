import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const requireModule=createRequire(import.meta.url)
const ts=requireModule('typescript')
const source=readFileSync('lib/ai/payment-exceptions-insight.ts','utf8')
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const row={open_count:'2',resolved_count:'4',open_non_usd_count:'0',missing_reservation_count:'1',insufficient_stock_count:'1',ineligible_reservation_count:'0',unknown_reason_count:'0',open_usd_cents:'12600',oldest_open_days:'3'}
let result=[row],calls=0
const exports={}
vm.runInNewContext(js,{exports,Number,Object,String,Error,Promise,require(n){if(n==='@/lib/db')return{sql:async()=>{calls++;return result}};throw Error('unknown import '+n)}})
let passed=0
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
await test('valid aggregate uses canonical numeric money in minor units',()=>{const r=exports.interpretPaymentExceptionSummary(row);assert.equal(r.openCount,2);assert.equal(r.openUsdCents,12600);assert.equal(r.oldestOpenDays,3);assert.equal(r.dataVerified,true)})
await test('non-USD exceptions cannot be treated as a USD total',()=>{const r=exports.interpretPaymentExceptionSummary({...row,open_non_usd_count:'1'});assert.equal(r.dataVerified,false)})
await test('zero open exceptions has no age',()=>{const r=exports.interpretPaymentExceptionSummary({...row,open_count:'0',missing_reservation_count:'0',insufficient_stock_count:'0',open_usd_cents:'0',oldest_open_days:null});assert.equal(r.openCount,0);assert.equal(r.oldestOpenDays,null)})
await test('rejects negative and fractional counts',()=>{for(const count of ['-1','1.1',null,'oops'])assert.throws(()=>exports.interpretPaymentExceptionSummary({...row,open_count:count}))})
await test('rejects amounts outside safe integer',()=>assert.throws(()=>exports.interpretPaymentExceptionSummary({...row,open_usd_cents:'90071992547409920000'})))
await test('inconsistent reason categories fail closed',()=>assert.throws(()=>exports.interpretPaymentExceptionSummary({...row,insufficient_stock_count:'0'}),/INCONSISTENT_COUNTS/))
await test('invalid mixed age rejects',()=>assert.throws(()=>exports.interpretPaymentExceptionSummary({...row,oldest_open_days:null}),/AGE_MISMATCH/))
await test('one DB aggregate read contains no PII fields or mutations',async()=>{const before=calls;const r=await exports.getPaymentExceptionSummary();assert.equal(r.openCount,2);assert.equal(calls,before+1);assert.doesNotMatch(source,/customer_email|customer_name|customer_phone|shipping_address|stripe_checkout_session_id|stripe_payment_intent_id|\bUPDATE\b|\bDELETE\b|\bINSERT\b|fetch\(/);assert.match(source,/FROM payment_exceptions/)})
await test('schema loss cannot appear as zero',async()=>{result=[];await assert.rejects(exports.getPaymentExceptionSummary(),/SCHEMA_UNAVAILABLE/);result=[row]})
console.log(`${passed}/${passed} payment exception insight checks passed`)
