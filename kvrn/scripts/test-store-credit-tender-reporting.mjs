/** Offline payment-tender reporting integration, no DB/Stripe/Google/network. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try {ts=require('typescript')} catch {ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const source=p=>fs.readFileSync(p,'utf8')
const compile=(p)=>ts.transpileModule(source(p),{fileName:p,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
function load(p, dependencies={}) {
  const m={exports:{}}
  vm.runInNewContext(compile(p),{module:m,exports:m.exports,process:{env:{}},console,AbortController,Number,String,Date,
    require(id){if(Object.hasOwn(dependencies,id))return dependencies[id];throw Error(`unexpected dependency ${id}`)}},{filename:p})
  return m.exports
}
const common=load('lib/ga-common.ts')
const ga=load('lib/ga4-server.ts',{'./ga-common':common,'./funnel-analytics':{
  withAnalyticsTimeout:async p=>await p,ANALYTICS_TIMEOUT:Symbol('timeout'),
}})
const order={order_number:'KVRN-123456',currency:'usd',payment_status:'paid',subtotal_cents:10000,
  discount_cents:1000,shipping_cents:500,tax_cents:0,total_cents:7500,
  gross_order_cents:9500,credit_captured_cents:2000}
const item={slug:'heavy-hoodie',sku:'KVRN-HD-BLK-M',product_name:'KVRN Heavy Hoodie',quantity:1,unit_price_cents:10000}
const payload=o=>ga.buildGaPurchaseBody({orderId:'12345678-1234-1234-1234-123456789012',order:o,items:[item],clientId:'1234.5678'})
let n=0
const test=(name,fn)=>{n++;return Promise.resolve().then(fn).then(()=>console.log('PASS',name))}
await test('verified split tender values 90 dollars of discounted merchandise; credit is NOT a discount',()=>{
 const r=payload(order);assert.equal(r.ok,true)
 assert.equal(r.body.events[0].params.value,90)
 assert.equal(r.body.events[0].params.shipping,5)
 assert.equal(r.body.events[0].params.items[0].price,90)
 assert.equal(r.body.events[0].params.transaction_id,order.order_number)
})
await test('cash-only original canonical order reporting unchanged',()=>{
 const r=payload({...order,total_cents:9500,gross_order_cents:undefined,credit_captured_cents:undefined})
 assert.equal(r.ok,true)
 assert.equal(r.body.events[0].params.value,90)
})
await test('missing, mismatched, or corrupt credit proof NEVER reports the cash portion as gross',()=>{
 for(const bad of [
   {...order,gross_order_cents:null},
   {...order,gross_order_cents:9400},
   {...order,credit_captured_cents:null},
   {...order,credit_captured_cents:3000},
   {...order,total_cents:-1},
 ]){
   const r=payload(bad);assert.equal(r.ok,false);assert.equal(r.reason,'credit_tender_proof_missing_or_mismatched')
 }
})
await test('split-tender SQL joins one immutable capture proof and never passes unproved gross to GA',async()=>{
 const queries=[];const rows=[[order],[item]];const fetches=[]
 const sql=(template,...params)=>{queries.push(template.join('?'));return Promise.resolve(rows.shift())}
 const result=await ga.tryRecordGaPurchase(sql,{orderId:'12345678-1234-1234-1234-123456789012',gaClientId:'1234.5678',
  env:{STORE_CREDIT_SPLIT_TENDER_ENABLED:'true',NEXT_PUBLIC_GA_MEASUREMENT_ID:'G-123456AB',GA4_MEASUREMENT_PROTOCOL_SECRET:'abcdefghijk'},
  fetchImpl:async(url,request)=>{fetches.push({url,request});return{status:204}}})
 assert.equal(result,'sent');assert.equal(fetches.length,1)
 assert.match(queries[0],/store_credit_checkout_capture_proofs/)
 assert.match(queries[0],/p\.cash_received_cents\s*\+\s*p\.credit_captured_cents/)
 assert.equal(JSON.parse(fetches[0].request.body).events[0].params.value,90)
 assert.doesNotMatch(fetches[0].request.body,/@|customer_email|phone/i)
})
await test('query switches off proof tables for original cash-only storefront',async()=>{
 const queries=[];const rows=[[{...order,total_cents:9500,gross_order_cents:undefined,credit_captured_cents:undefined}],[item]]
 const sql=(template,...params)=>{queries.push(template.join('?'));return Promise.resolve(rows.shift())}
 const result=await ga.tryRecordGaPurchase(sql,{orderId:'12345678-1234-1234-1234-123456789012',gaClientId:'1234.5678',
  env:{NEXT_PUBLIC_GA_MEASUREMENT_ID:'G-123456AB',GA4_MEASUREMENT_PROTOCOL_SECRET:'abcdefghijk'},
  fetchImpl:async()=>({status:204})})
 assert.equal(result,'sent');assert.doesNotMatch(queries[0],/store_credit_checkout_capture_proofs/)
})
await test('Live View gross uses capture proof or returns unknown; inactive flag leaves old tables alone',()=>{
 const s=source('lib/live-analytics.ts')
 assert.match(s,/STORE_CREDIT_SPLIT_TENDER_ENABLED === 'true'/)
 assert.match(s,/p\.cash_received_cents\+p\.credit_captured_cents<>p\.gross_order_cents/)
 assert.match(s,/WHEN h\.reservation_id IS NULL THEN o\.total_cents::bigint\s+ELSE p\.gross_order_cents/)
 assert.match(s,/p\.id IS NULL/)
 assert.match(s,/THEN NULL\s+ELSE COALESCE\(SUM/)
 assert.match(s,/grossPaidTodayCents:safeGrossCents\(b\?\.gross\)/)
})
console.log(`${n}/${n} split-tender reporting checks passed. No external services accessed.`)
