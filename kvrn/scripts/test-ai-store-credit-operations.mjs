import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const ts=createRequire(import.meta.url)('typescript')
const source=readFileSync('lib/ai/store-credit-integrity-insight.ts','utf8')
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const clean={account_count:'2',issue_events:'3',hold_events:'2',capture_events:'1',release_events:'0',
 open_holds:'1',expired_open_holds:'0',paid_open_holds:'0',invalid_hold_links:'0',
 unpaired_terminals:'0',inconsistent_terminals:'0',unproved_captures:'0',
 issued_cents:'8000',captured_cents:'2000',pending_cents:'3000'}
let response=[clean],requests=0
const exported={}
vm.runInNewContext(code,{exports:exported,Number,BigInt,String,Object,Error,Promise,require(name){
 if(name==='@/lib/db')return {sql:async(parts,...args)=>{
  requests++;assert.equal(args.length,0)
  assert.match(parts.join(''),/store_credit_checkout_capture_proofs/)
  return response
 }}
 throw Error('Unexpected dependency: '+name)
}})
let passed=0
const test=async(label,fn)=>{await fn();passed++;console.log('PASS '+label)}
await test('actual ledger and hold financial numbers from a single DB aggregate',async()=>{
 const v=await exported.getStoreCreditOperationsSummary()
 assert.equal(requests,1);assert.equal(v.availableLiabilityCents,3000)
 assert.equal(v.pendingHoldCents,3000);assert.equal(v.integrityVerified,true)
 assert.equal(v.captureEventCount,1)
})
await test('expired hold shows review requirement but does not authorize release',()=>{
 const v=exported.interpretStoreCreditOperationsRow({...clean,expired_open_holds:'1'})
 assert.equal(v.expiredOpenHoldCount,1);assert.equal(v.availableLiabilityCents,3000)
})
await test('paid checkout with uncaptured hold forces money availability unknown',()=>{
 const v=exported.interpretStoreCreditOperationsRow({...clean,paid_open_holds:'1'})
 assert.equal(v.integrityVerified,false);assert.equal(v.availableLiabilityCents,null)
})
await test('missing provider payment proof disables valid availability',()=>{
 const v=exported.interpretStoreCreditOperationsRow({...clean,unproved_captures:'1'})
 assert.equal(v.integrityVerified,false);assert.equal(v.availableLiabilityCents,null)
})
await test('orphan hold link disables verified liability availability',()=>{
 const v=exported.interpretStoreCreditOperationsRow({...clean,invalid_hold_links:'1'})
 assert.equal(v.integrityVerified,false)
})
await test('ledger negative liability never becomes a positive available balance',()=>{
 const v=exported.interpretStoreCreditOperationsRow({...clean,captured_cents:'9000'})
 assert.equal(v.availableLiabilityCents,null);assert.equal(v.integrityVerified,false)
})
await test('overcommitted holds never become spendable',()=>{
 const v=exported.interpretStoreCreditOperationsRow({...clean,pending_cents:'9000'})
 assert.equal(v.availableLiabilityCents,null);assert.equal(v.integrityVerified,false)
})
await test('unpaired terminals and price mismatches disable all-clear',()=>{
 for(const field of ['unpaired_terminals','inconsistent_terminals']){
  const v=exported.interpretStoreCreditOperationsRow({...clean,[field]:'1'})
  assert.equal(v.integrityVerified,false);assert.equal(v.availableLiabilityCents,null)
 }
})
await test('count contradictions fail closed',()=>{
 for(const diff of [{open_holds:'3'},{expired_open_holds:'2'},{capture_events:'3'},{unproved_captures:'2'},{paid_open_holds:'2'}])
  assert.throws(()=>exported.interpretStoreCreditOperationsRow({...clean,...diff}),/INCONSISTENT_COUNTS/)
})
await test('numeric coercion, decimals and unsafe input are refused',()=>{
 for(const val of [null,'-1','NaN','1.5','9007199254740992'])
  assert.throws(()=>exported.interpretStoreCreditOperationsRow({...clean,open_holds:val}))
})
await test('huge liability is unverified, never lossy currency',()=>{
 const v=exported.interpretStoreCreditOperationsRow({...clean,issued_cents:'90071992547409999'})
 assert.equal(v.availableLiabilityCents,null);assert.equal(v.issuedCents,null)
})
await test('empty or unavailable SQL result never masquerades as zero',async()=>{
 response=[]
 await assert.rejects(exported.getStoreCreditOperationsSummary(),/SCHEMA_UNAVAILABLE/)
 response=[clean]
})
await test('query is aggregate-only with no customer PII, writes or egress',()=>{
 assert.doesNotMatch(source,/\bcustomer_email\b|phone_e164|shipping_address|\bUPDATE\s|\bDELETE\s|\bINSERT\s|fetch\(/i)
 assert.match(source,/CROSS JOIN ledger CROSS JOIN holds_summary/)
 assert.match(source,/terminal_count=0/)
})
console.log(`${passed}/${passed} store-credit operational insight checks passed`)
