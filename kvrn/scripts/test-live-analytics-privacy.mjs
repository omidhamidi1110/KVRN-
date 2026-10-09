/** Offline Live View contracts, no DB, no user identifiers, no live network. */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const ts=require('typescript')
const answers=[];const queries=[]
async function sql(parts,...params){queries.push(parts.join('?'));if(!answers.length)throw Error('No mocked DB query');return answers.shift()}
const source=readFileSync('lib/live-analytics.ts','utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const exports={}
const testEnv={}
vm.runInNewContext(compiled,{exports,Date,Number,String,RegExp,console,process:{env:testEnv},require(name){if(name==='@/lib/db')return{sql};throw Error('unexpected import '+name)}})
const {coarseCampaignLabel,safeGrossCents,getLiveAnalyticsSummary}=exports
let n=0
function test(label,fn){n++;console.log('PASS',label);return fn()}
test('UTM with possible private data withheld',()=>{
 for(const value of ['x@y.com','https://example.com','5551234567','a/b','foo?email=someone','a\nheader','a'.repeat(70)])assert.equal(coarseCampaignLabel(value),'Other / withheld')
 assert.equal(coarseCampaignLabel('instagram'), 'instagram')
 assert.equal(coarseCampaignLabel('spring-launch_2026'),'spring-launch_2026')
 assert.equal(coarseCampaignLabel(null),'Direct / unknown')
})
test('unverified or overflowing gross sales unknown instead of zero',()=>{
 for(const value of [null,undefined,'NaN','9007199254740992','-1',-1,1.5])assert.equal(safeGrossCents(value),null)
 assert.equal(safeGrossCents('0'),0)
 assert.equal(safeGrossCents('10500'),10500)
})
await test('Live View aggregates without returning sessions, addresses or contacts',async()=>{
 answers.push(
  [{recent:6,products:4,carts:3,checkouts:2,purchases:1}],
  [{orders:2,gross:'14500'}],
  [{device:'mobile',sessions:4}],
  [{name:'KVRN Hoodie',views:5}],
  [{source:'x@y.com',sessions:2},{source:'instagram',sessions:4}],
  [{n:2}],
  [{session_events:6,product_views:4,add_to_cart:3,checkout_starts:2,purchases:1}],
  [{viewed:'4',carted:'3',checked_out:'2',purchased:'1'}],
 )
 const result=await getLiveAnalyticsSummary()
 assert.equal(result.grossPaidTodayCents,14500)
 assert.equal(result.observedFunnel30m.checkoutStartSessions,2)
 assert.equal(result.observedFunnel30m.authoritativePurchaseEvents,1)
 assert.equal(result.observedSequentialFunnel30m.thenPurchasedSessions,1)
 assert.equal(result.observedSequentialFunnel30m.thenStartedCheckoutSessions,2)
 assert.equal(result.sources[0].source,'Other / withheld')
 assert.ok(!JSON.stringify(result).includes('@'))
 assert.equal(result.activeConsentingSessions,2)
 assert.equal(result.recentlyObservedSessions,6)
 assert.equal(queries.length,8)
 for(const s of queries)assert.doesNotMatch(s,/shipping_address|customer_email|phone_e164|SELECT\s+\*\s+FROM\s+orders/i)
})
test('purchases only from authoritative order-linked events',()=>{
 assert.match(queries[6],/COUNT\(DISTINCT order_id\) FILTER \(WHERE event_name='purchase_completed' AND order_id IS NOT NULL\)/)
 assert.match(queries[7],/e\.event_name='purchase_completed' AND e\.order_id IS NOT NULL/)
 assert.match(queries[7],/e\.created_at>=c\.at/)
 assert.doesNotMatch(queries[7],/customer_email|shipping_address|ip_address/)
})
test('source omits potentially identifying location or IP data',()=>{
 assert.doesNotMatch(source,/\b(?:ip_address|shipping_address|customer_phone)\b/i)
 assert.match(source,/No IP addresses, exact locations, customer details/)
})
await test('credit-enabled Live View selects capture-proof gross, and uncertain proof remains unknown',async()=>{
 const before=queries.length
 testEnv.STORE_CREDIT_SPLIT_TENDER_ENABLED='true'
 answers.push(
  [{recent:1,products:1,carts:1,checkouts:1,purchases:1}],
  [{orders:1,gross:null}],
  [],[],[],[{n:1}],
  [{session_events:1,product_views:1,add_to_cart:1,checkout_starts:1,purchases:1}],
  [{viewed:'1',carted:'1',checked_out:'1',purchased:'1'}],
 )
 const result=await getLiveAnalyticsSummary()
 assert.equal(result.grossPaidTodayCents,null)
 assert.equal(result.ordersPaidToday,1)
 assert.match(queries[before+1],/LEFT JOIN store_credit_checkout_capture_proofs/)
 assert.match(queries[before+1],/THEN NULL/)
 assert.doesNotMatch(JSON.stringify(result),/email|account_key|stripe_payment_intent/i)
 testEnv.STORE_CREDIT_SPLIT_TENDER_ENABLED='false'
})
console.log(`${n}/${n} Live View privacy/accounting tests passed; no DB accessed`)
