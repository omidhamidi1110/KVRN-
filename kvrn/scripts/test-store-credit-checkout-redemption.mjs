import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const settings={
  STORE_CREDIT_SPLIT_TENDER_ENABLED:'true',STRIPE_MODE:'test',
  STORE_CREDIT_CHECKOUT_HOLD_ENABLED:'true',STORE_CREDIT_CHECKOUT_RELEASE_ENABLED:'true',
  STORE_CREDIT_IDENTITY_EMAIL_ENABLED:'true',STRIPE_USD_MINIMUM_VERIFIED:'true',
  STRIPE_USD_MINIMUM_CENTS:'50',NODE_ENV:'test'
}
const id='a891c09a-71cf-4511-941c-132b4f7e8567'
const account='c60eff7e-ecc0-419f-b765-2e1684acc516'
const logged=[]
const deps={
 './db':{sql:async()=>{logged.push('read_account');return [{account_id:account,issued:'10000',captured:'1500',held:'2000'}]}},
 './store-credit-customer-identity':{
   resolveVerifiedCreditAccount:async(cookie,email)=>cookie==='valid-cookie'&&email==='verified@example.com'?'a'.repeat(64):null,
   creditIdentityCookieName:p=>p?'__Host-kvrn_credit_identity':'kvrn_credit_identity_dev',
 },
 './store-credit-checkout-hold':{
   prepareCheckoutCreditHold:async(p)=>{logged.push(['hold',p]);return '44'}
 },
 './store-credit-split-tender':{},
}
function load(file,imports){
 const js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
 const mod={exports:{}}
 const context={module:mod,exports:mod.exports,require:(name)=>{
  if(!(name in imports))throw Error('Unexpected dependency '+name)
  return imports[name]
 },process:{env:settings},console,BigInt,Number,Error,RegExp,Date,Set,Object,Promise,Map,JSON,String}
 vm.runInNewContext(js,context,{filename:path.basename(file)})
 return mod.exports
}
const tender=load('lib/store-credit-split-tender.ts',{})
deps['./store-credit-split-tender']=tender
const mod=load('lib/store-credit-checkout-redemption.ts',deps)
let n=0
async function t(name,fn){await fn();console.log('PASS',name);n++}
await t('all payment, account and provider activation switches required',async()=>{
 assert.equal(mod.creditRedemptionEnabled(),true)
 for(const key of ['STRIPE_MODE','STORE_CREDIT_SPLIT_TENDER_ENABLED','STORE_CREDIT_CHECKOUT_HOLD_ENABLED','STORE_CREDIT_CHECKOUT_RELEASE_ENABLED','STORE_CREDIT_IDENTITY_EMAIL_ENABLED','STRIPE_USD_MINIMUM_VERIFIED','STRIPE_USD_MINIMUM_CENTS']){
   const save=settings[key];delete settings[key]
   assert.equal(mod.creditRedemptionEnabled(),false,key)
   settings[key]=save
 }
 settings.STRIPE_MODE='live';assert.equal(mod.creditRedemptionEnabled(),false);settings.STRIPE_MODE='test'
})
await t('customer credit must be an exact positive integer',async()=>{
 for(const val of [0,-1,3.4,'300',null,NaN,Infinity,2147483648])assert.equal(mod.parseRequestedCredit(val),null)
 assert.equal(mod.parseRequestedCredit(500),500)
})
await t('verified account and authoritative quote are paired with a serialized DB hold',async()=>{
 const result=await mod.prepareCustomerStoreCreditRedemption({
  requestedCreditCents:5000,customerEmail:'verified@example.com',cookieValue:'valid-cookie',reservationId:id,
  subtotalCents:12000,discountCents:1000,shippingCents:1000,taxCents:0
 })
 assert.equal(result.holdEventId,'44')
 assert.equal(result.quote.grossOrderCents,12000)
 assert.equal(result.quote.cashDueCents,7000)
 assert.equal(result.quote.creditTenderCents,5000)
 assert.equal(result.quote.balanceAfterHoldCents,1500)
 assert.equal(logged[0],'read_account')
 assert.deepEqual(JSON.parse(JSON.stringify(logged[1][1])),{
  accountId:account,reservationId:id,holdKey:`credit:${id}`,requestKey:`checkout:${id}`,
  amountCents:5000,verifiedAccountOwnership:true,canonicalNetTenderVerified:true})
})
await t('unverified email never performs even an account lookup',async()=>{
 logged.length=0
 await assert.rejects(mod.prepareCustomerStoreCreditRedemption({requestedCreditCents:100,
  customerEmail:'other@example.com',cookieValue:'valid-cookie',reservationId:id,
  subtotalCents:12000,discountCents:0,shippingCents:0,taxCents:0}),/NOT_VERIFIED/)
 assert.equal(logged.length,0)
})
await t('overspending cannot create a credit hold',async()=>{
 logged.length=0
 await assert.rejects(mod.prepareCustomerStoreCreditRedemption({requestedCreditCents:6501,
  customerEmail:'verified@example.com',cookieValue:'valid-cookie',reservationId:id,
  subtotalCents:12000,discountCents:0,shippingCents:0,taxCents:0}),/INSUFFICIENT/)
 assert.deepEqual(logged,['read_account'])
})
await t('Stripe minimum cash charge is enforced before hold',async()=>{
 logged.length=0
 await assert.rejects(mod.prepareCustomerStoreCreditRedemption({requestedCreditCents:6500,
  customerEmail:'verified@example.com',cookieValue:'valid-cookie',reservationId:id,
  subtotalCents:6525,discountCents:0,shippingCents:0,taxCents:0}),/BELOW_VERIFIED_STRIPE_MINIMUM/)
 assert.deepEqual(logged,['read_account'])
})
await t('Stripe coupon combines promo with credit exactly and idempotently',async()=>{
 const calls=[]
 const stripe={coupons:{create:async(p,opts)=>{
  calls.push([p,opts]);return {id:'test-coupon',amount_off:p.amount_off,currency:'usd'}
 }}}
 const coupon=await mod.createCreditCheckoutCoupon(stripe,id,1000,5000)
 assert.equal(coupon,'test-coupon')
 assert.equal(calls[0][0].amount_off,6000)
 assert.equal(calls[0][1].idempotencyKey,`credit-coupon-${id}`)
 assert.equal(calls[0][0].metadata.kvrn_credit_cents,'5000')
 assert.equal(calls[0][0].metadata.kvrn_merchandise_discount_cents,'1000')
})
await t('Stripe coupon provider amount mismatch is rejected',async()=>{
 await assert.rejects(mod.createCreditCheckoutCoupon({coupons:{create:async()=>({id:'test',currency:'usd',amount_off:2})}},id,1000,5000),/PROVIDER_MISMATCH/)
})
await t('SQL copy retains 022 finalizer with added atomic hold, capture, and no reduction in merchandise discount',async()=>{
 const old=readFileSync('db/migrations/022_late_payment_recovery.sql','utf8')
 const draft=readFileSync('db/migrations/062_store_credit_checkout_split_tender.sql','utf8')
 assert.match(draft,/CREATE OR REPLACE FUNCTION finalize_paid_order\(/)
 assert.match(draft,/v_gross_cents-v_credit_cents/)
 assert.match(draft,/PERFORM kvrn_credit_capture_verified_checkout\(/)
 assert.match(draft,/KVRN_CREDIT\|ONLY_VERIFIED_TEST_PAYMENTS/)
 assert.match(draft,/WHERE reservation_id=v_res\.id/)
 assert.match(draft,/IF v_credit_cents>0 THEN/)
 assert.match(draft,/p_amount_total,v_gross_cents/)
 assert.match(draft,/CREATE OR REPLACE FUNCTION kvrn_credit_release_expired_checkout\(/)
 assert.match(draft,/CREATE OR REPLACE FUNCTION kvrn_credit_create_checkout_hold\(/)
 for(const contract of ['v_res.attribution','consume_inventory_fifo(','INSERT INTO discount_redemptions','INSERT INTO transactional_emails','record_payment_exception(']){
  assert.ok(old.includes(contract)&&draft.includes(contract),`preserve ${contract}`)
 }
 const handler=readFileSync('lib/checkout-session-handler.ts','utf8')
 assert.match(handler,/creditTender=await prepareCustomerStoreCreditRedemption\(/)
 assert.match(handler,/creditCouponId=await createCreditCheckoutCoupon\(/)
 assert.match(handler,/discounts: \[\{ coupon: creditCouponId \|\| appliedDiscount!\.stripeCouponId \}\]/)
 assert.match(handler,/\.\.\.\(creditTender \? \{kvrn_store_credit_cents/)
})
await t('webhook release uses provider-verified final expiration and never guesses from a timeout',async()=>{
 const webhook=readFileSync('app/api/stripe/webhook/route.ts','utf8')
 assert.match(webhook,/case 'checkout.session.expired':[^]*?await releaseCreditForExpiredSession\(session\)/)
 assert.match(webhook,/await releaseExpiredCreditHold\(/)
 assert.doesNotMatch(webhook.split("case 'checkout.session.async_payment_failed':")[1].split("case 'checkout.session.expired':")[0],/releaseCreditForExpiredSession/)
})
console.log(`${n}/${n} customer-credit split tender integration tests passed (provider and SQL mocked; no payments).`)
