import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const raw=readFileSync('lib/store-credit-split-tender.ts','utf8')
const js=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const exports={}
vm.runInNewContext(js,{exports,Number,BigInt,Error,Array,Object})
const base={currency:'usd',subtotalCents:8000,merchandiseDiscountCents:800,shippingCents:500,taxCents:650,availableCreditCents:3000,requestedCreditCents:1800,authoritativeCartVerified:true,authoritativeTaxVerified:true,verifiedCustomerIdentity:true,verifiedStripeMinimumCents:50,stripeMinimumVerified:true}
let n=0;const t=(name,fn)=>{fn();n++;console.log('PASS',name)}
t('split applies tender after real merchandise discount and fixed tax',()=>{
 const q=exports.quoteStoreCreditSplitTender(base)
 assert.equal(q.netMerchandiseCents,7200)
 assert.equal(q.grossOrderCents,8350)
 assert.equal(q.cashDueCents,6550)
 assert.equal(q.creditLiabilityToCaptureCents,1800)
 assert.equal(q.balanceAfterHoldCents,1200)
 assert.equal(q.taxCents,650)
})
t('no credit, still normal nonzero checkout',()=>assert.equal(exports.quoteStoreCreditSplitTender({...base,requestedCreditCents:0}).cashDueCents,8350))
t('cash + credit equal payable order total exactly',()=>{
 const q=exports.quoteStoreCreditSplitTender(base)
 assert.equal(q.cashDueCents+q.creditTenderCents,q.grossOrderCents)
})
t('reject customer identity not verified',()=>assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,verifiedCustomerIdentity:false}),/UNVERIFIED_CANONICAL_EVIDENCE/))
t('reject tax or cart not authoritative',()=>{
 for(const flag of ['authoritativeCartVerified','authoritativeTaxVerified'])assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,[flag]:false}),/UNVERIFIED_CANONICAL_EVIDENCE/)
})
t('reject negative fractional and overflowing amounts',()=>{
 for(const cents of [-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,shippingCents:cents}),/UNSAFE_CENTS/)
})
t('reject discounts exceeding merchandise amount',()=>assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,merchandiseDiscountCents:9000}),/DISCOUNT_EXCEEDS_MERCHANDISE/))
t('reject overspending credit and tax/shipping using credit',()=>{
 assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,requestedCreditCents:3001}),/INSUFFICIENT_CREDIT/)
 assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,availableCreditCents:9000,requestedCreditCents:7201}),/CREDIT_EXCEEDS_NET_MERCHANDISE/)
})
t('reject zero cash amount pending separate non-Stripe workflow',()=>{
 assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,shippingCents:0,taxCents:0,availableCreditCents:7200,requestedCreditCents:7200}),/ZERO_CASH_CHECKOUT_NOT_SUPPORTED/)
})
t('reject integers whose combined sum overflows precision',()=>{
 assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,subtotalCents:Number.MAX_SAFE_INTEGER,merchandiseDiscountCents:0}),/OVERFLOW/)
})
t('reject unsupported currency',()=>assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,currency:'eur'}),/UNSUPPORTED_CURRENCY/))
t('require independently verified Stripe charge minimum',()=>{
 for(const v of [{stripeMinimumVerified:false},{verifiedStripeMinimumCents:0},{verifiedStripeMinimumCents:-1}])
  assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,...v}),/UNVERIFIED_CANONICAL_EVIDENCE|UNSAFE_CENTS/)
})
t('block Stripe microcharge after application of credit',()=>{
 const v={...base,shippingCents:0,taxCents:0,availableCreditCents:7200,requestedCreditCents:7199}
 assert.throws(()=>exports.quoteStoreCreditSplitTender(v),/BELOW_VERIFIED_STRIPE_MINIMUM/)
 assert.equal(exports.quoteStoreCreditSplitTender({...v,requestedCreditCents:7150}).cashDueCents,50)
})
t('reject minimum unverified despite valid cart',()=>{
 assert.throws(()=>exports.quoteStoreCreditSplitTender({...base,stripeMinimumVerified:false}),/UNVERIFIED_CANONICAL_EVIDENCE/)
})
t('pure function cannot touch Stripe or DB' ,()=>{
 assert.doesNotMatch(raw,/from ['"]@\/lib\/db|import .*stripe|\bfetch\(|sql`|process\.env/)
})
console.log(`${n}/${n} offline split-tender tests passed`)
