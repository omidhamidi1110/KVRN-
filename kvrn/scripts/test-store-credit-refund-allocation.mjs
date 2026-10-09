import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const source=readFileSync('lib/store-credit-refund-allocation.ts','utf8')
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const exports={}
vm.runInNewContext(js,{exports,Number,BigInt,Error,Array,Object})
const run=exports.validateSplitTenderRefund
const base={currency:'usd',originalGrossCents:11000,originalCashTenderCents:8000,originalCreditTenderCents:3000,
 cashAlreadyRefundedCents:1000,creditAlreadyRestoredCents:500,
 approvedRefundCents:2500,proposedCashRefundCents:2000,proposedCreditRestoreCents:500,
 originalTenderVerified:true,previousSettlementsVerified:true,remedyApproved:true,
 disputeClearanceVerified:true,refundStatusFinalVerified:true}
let n=0;const t=(label,fn)=>{fn();n++;console.log('PASS',label)}
t('exact split tender refund preserves cash and credit separately',()=>{const q=run(base);assert.equal(q.cashRefundCents,2000);assert.equal(q.creditRestoreCents,500);assert.equal(q.remainingCashRefundableCents,5000);assert.equal(q.remainingCreditRestorableCents,2000);assert.equal(q.executionAuthorized,false)})
t('approved 100% cash refund allowed within remaining Stripe tender',()=>assert.equal(run({...base,proposedCashRefundCents:2500,proposedCreditRestoreCents:0}).creditRestoreCents,0))
t('approved 100% credit return allowed within remaining credit tender',()=>assert.equal(run({...base,proposedCashRefundCents:0,proposedCreditRestoreCents:2500}).cashRefundCents,0))
t('no browser-supplied approval or missing financial proof accepted',()=>{for(const k of ['originalTenderVerified','previousSettlementsVerified','remedyApproved','disputeClearanceVerified','refundStatusFinalVerified'])assert.throws(()=>run({...base,[k]:false}),/EVIDENCE_MISSING/)})
t('old refunded cash cannot be refunded again',()=>assert.throws(()=>run({...base,cashAlreadyRefundedCents:7800}),/EXCEEDS_REMAINING_TENDER/))
t('restored store credit cannot be restored again',()=>assert.throws(()=>run({...base,creditAlreadyRestoredCents:2700}),/EXCEEDS_REMAINING_TENDER/))
t('reject credits greater than original tender',()=>assert.throws(()=>run({...base,creditAlreadyRestoredCents:3001}),/PRIOR_SETTLEMENT_INVALID/))
t('reject prior cash refunds greater than original tender',()=>assert.throws(()=>run({...base,cashAlreadyRefundedCents:8001}),/PRIOR_SETTLEMENT_INVALID/))
t('refund portions must exactly match approved remedy',()=>assert.throws(()=>run({...base,proposedCreditRestoreCents:501}),/ALLOCATION_MISMATCH/))
t('reject original tender that disagrees with verified gross',()=>assert.throws(()=>run({...base,originalGrossCents:10999}),/ORIGINAL_TENDER_MISMATCH/))
t('reject zero amount and non-split tender proposals',()=>{assert.throws(()=>run({...base,approvedRefundCents:0}),/UNSUPPORTED_TENDER/);assert.throws(()=>run({...base,originalCreditTenderCents:0,originalGrossCents:8000}),/UNSUPPORTED_TENDER/)})
t('reject negative, fractional, infinite, and unsafe amounts',()=>{for(const v of [-1,2.4,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>run({...base,proposedCashRefundCents:v}),/UNSAFE_CENTS/)})
t('protect sums that overflow safe integer range',()=>assert.throws(()=>run({...base,originalGrossCents:Number.MAX_SAFE_INTEGER,originalCashTenderCents:Number.MAX_SAFE_INTEGER,originalCreditTenderCents:3000}),/OVERFLOW/))
t('do not invent non-USD currency support',()=>assert.throws(()=>run({...base,currency:'eur'}),/UNSUPPORTED_CURRENCY/))
t('validator is pure: no Stripe, DB, fetch, or mutation',()=>assert.doesNotMatch(source,/\bsql`|\bfetch\(|from ['"]@\/lib\/db|stripe\.refunds|INSERT INTO|UPDATE\s+store_credit/))
console.log(`${n}/${n} split-tender refund-allocation tests passed`)
