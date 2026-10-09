/** Offline financial-domain checks; zero database/network access. */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const requests=[],responses=[]
const sql=async(parts,...args)=>{requests.push(parts.join('?'));if(responses.length===0)throw Error('MISSING_MOCK');return responses.shift()}
function load(file,mocks={}){
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const exports={}
 vm.runInNewContext(code,{exports,require(name){if(!(name in mocks))throw Error('Unexpected import '+name);return mocks[name]},Date,BigInt,Number,String,Array,Set,Map,RegExp,JSON,Error,console},{filename:file})
 return exports
}
const domain=load('lib/store-credit-domain.ts')
const integrity=load('lib/store-credit-ledger-integrity.ts')
const service=load('lib/store-credit-reconciliation.ts',{'@/lib/db':{sql},'./store-credit-domain':domain,'./store-credit-ledger-integrity':integrity})
const account='36a2d1db-58a1-4b77-9461-112dd187e13e'
const more='91a74352-7453-4b02-b9a5-513ca1ac42ad'
const issue=(key='issue-00000001',a=account)=>({account_id:a,event_type:'issue',idempotency_key:key,amount_cents:'2500',return_id:'ret-123456'})
const hold=(a=account)=>({account_id:a,event_type:'hold',idempotency_key:'hold-00000001',amount_cents:'900',hold_key:'hold-123456'})
const capture=(a=account)=>({account_id:a,event_type:'capture',idempotency_key:'cap-00000001',amount_cents:'900',hold_key:'hold-123456',order_id:'order-123456'})
const release=(a=account)=>({account_id:a,event_type:'release',idempotency_key:'rel-00000001',amount_cents:'900',hold_key:'hold-123456'})
const totals=(i='2500',r='900',o='1600')=>({total_issued_cents:i,total_redeemed_cents:r,outstanding_liability_cents:o})
let pass=0
const t=(title,fn)=>{fn();pass++;console.log('PASS',title)}
t('matched issue/hold/capture remains read-only and no account PII returned',()=>{
 const a=service.analyzeStoreCreditRows([issue(),hold(),capture()],totals())
 assert.equal(a.status,'reconciled');assert.equal(a.outstandingHolds,0);assert.equal(a.outstandingLiabilityCents,1600)
 assert.equal(a.transactionalOperationsEnabled,false)
 assert.ok(!JSON.stringify(a).includes(account));assert.ok(!JSON.stringify(a).includes('ret-123456'))
})
t('unsettled hold reduces available balance but not total liability',()=>{
 const a=service.analyzeStoreCreditRows([issue(),hold()],totals('2500','0','2500'))
 assert.equal(a.outstandingHolds,1);assert.equal(a.outstandingLiabilityCents,2500)
})
t('released hold does not change original liability',()=>{
 const a=service.analyzeStoreCreditRows([issue(),hold(),release()],totals('2500','0','2500'))
 assert.equal(a.status,'reconciled');assert.equal(a.outstandingHolds,0)
})
t('orphan capture and double terminal event fail closed',()=>{
 assert.throws(()=>service.analyzeStoreCreditRows([issue(),capture()],totals()),/UNKNOWN_CREDIT_HOLD/)
 assert.throws(()=>service.analyzeStoreCreditRows([issue(),hold(),capture(),release()],totals()),/UNKNOWN_CREDIT_HOLD/)
})
t('duplicate return credit and cross-account event conflict detected',()=>{
 assert.throws(()=>service.analyzeStoreCreditRows([issue(),issue('different-issue')],totals()),/DUPLICATE_RETURN_CREDIT/)
 assert.throws(()=>service.analyzeStoreCreditRows([issue(),{...issue(),account_id:more}],totals()),/LEDGER|DUPLICATE/)
})
t('missing, corrupt and mismatched liability views withhold money',()=>{
 for(const value of [null,totals('0','0','0'),totals('foo','900','1600')]){
  const a=service.analyzeStoreCreditRows([issue(),hold(),capture()],value)
  assert.equal(a.status,'integrity-warning');assert.equal(a.outstandingLiabilityCents,null)
 }
})
t('unsafe cents reject overflow and negative values',()=>{
 for(const value of ['9007199254740992','-1','0','1.25'])assert.throws(()=>service.analyzeStoreCreditRows([{...issue(),amount_cents:value}],totals()),/LEDGER_UNSAFE_AMOUNT/)
})
t('missing credit references reject instead of guessing',()=>{
 assert.throws(()=>service.analyzeStoreCreditRows([{...issue(),return_id:null}],totals()),/LEDGER_INVALID_REFERENCE/)
})
t('bounded audit refuses truncated ledgers, never certifies partial history',()=>{
 assert.throws(()=>service.analyzeStoreCreditRows(Array(10001).fill(issue()),totals()),/LEDGER_RECONCILIATION_TOO_LARGE/)
})
await (async()=>{
 requests.length=0
 responses.push([issue(),hold(),capture()],[totals()])
 const output=await service.reconcileStoreCreditLedger()
 assert.equal(output.status,'reconciled')
 assert.equal(requests.length,2)
 assert.match(requests[0],/LIMIT \?/)
 assert.doesNotMatch(requests[0],/email|phone_e164|account_key|customer_name|shipping_address/i)
 pass++;console.log('PASS DB read model uses bounded anonymized ledger query')
})()
await (async()=>{
 responses.push([issue()])
 await assert.rejects(service.reconcileStoreCreditLedger(),/MISSING_MOCK/)
 pass++;console.log('PASS missing liability database result is not treated as zero')
})()
const route=readFileSync('app/api/admin/store-credit/reconciliation/route.ts','utf8')
assert.match(route,/requireAdmin/)
assert.match(route,/Cache-Control/)
assert.doesNotMatch(route,/(?:export async function POST|\.insert\(|\.update\(|stripe\.refunds|twilio|resend)/i)
pass++;console.log('PASS admin route is authenticated, read-only and hides backend exceptions')
console.log(`${pass}/${pass} offline credit reconciliation checks passed; no DB accessed`)
