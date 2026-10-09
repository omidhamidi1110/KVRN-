/** Offline tests only. No DB access or real credit issuance. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try {ts=require('typescript')} catch {ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const code=ts.transpileModule(readFileSync('lib/store-credit-proposal.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const exports={};vm.runInNewContext(code,{exports})
const assess=exports.assessDiscretionaryReturnCredit
const base={returnStatus:'completed',discretionaryReturnApproved:true,paymentSucceeded:true,orderCurrency:'usd',
 deliveredAt:'2026-09-30T14:00:00Z',requestedAt:'2026-10-08T15:00:00Z',receivedAt:'2026-10-09T15:00:00Z',completedAt:'2026-10-10T15:00:00Z',
 cashRefundExistsForOrder:false,returnRefundAllocationsExist:false,disputeOrChargebackExists:false,storeCreditAlreadyIssuedForReturn:false,
 lines:[{quantity:1,netMerchandiseBasisCents:7000}],proposedCreditCents:7000}
const tests=[
 ['valid completed discretionary return only advances to further review',()=>{const a=assess(base);assert.equal(a.readyForFurtherReview,true);assert.equal(a.maximumMerchandiseCents,7000)}],
 ['completed return alone is not authorization',()=>assert.equal(assess({...base,discretionaryReturnApproved:null}).readyForFurtherReview,false)],
 ['no previously issued or unknown credit',()=>{for(const v of [true,null])assert.equal(assess({...base,storeCreditAlreadyIssuedForReturn:v}).readyForFurtherReview,false)}],
 ['any prior cash refund or unknown refund blocks mixed settlement',()=>{for(const v of [true,null])assert.equal(assess({...base,cashRefundExistsForOrder:v}).readyForFurtherReview,false)}],
 ['return refund allocation, dispute, or unknown status blocks',()=>{for(const k of ['returnRefundAllocationsExist','disputeOrChargebackExists'])for(const v of [true,null])assert.equal(assess({...base,[k]:v}).readyForFurtherReview,false)}],
 ['unverified or failed Stripe payment cannot qualify',()=>{for(const v of [false,null])assert.equal(assess({...base,paymentSucceeded:v}).readyForFurtherReview,false)}],
 ['only USD until currency conversion/reconciliation implemented',()=>{for(const v of ['eur',null])assert.equal(assess({...base,orderCurrency:v}).readyForFurtherReview,false)}],
 ['out-of-window, pre-delivery and missing timestamps denied',()=>{for(const pair of [['2026-10-16T15:00:00Z',base.deliveredAt],[base.requestedAt,'2026-10-10T15:00:00Z'],[null,base.deliveredAt]])assert.equal(assess({...base,requestedAt:pair[0],deliveredAt:pair[1]}).readyForFurtherReview,false)}],
 ['zero, missing, invalid and overflow merchandise snapshots rejected',()=>{for(const lines of [[],[{quantity:1,netMerchandiseBasisCents:null}],[{quantity:0,netMerchandiseBasisCents:7000}],[{quantity:1,netMerchandiseBasisCents:-1}],[{quantity:1,netMerchandiseBasisCents:Number.MAX_SAFE_INTEGER},{quantity:1,netMerchandiseBasisCents:100}]])assert.equal(assess({...base,lines}).readyForFurtherReview,false)}],
 ['never propose more than net merchandise paid',()=>{for(const proposed of [0,7001,1.2,Number.MAX_SAFE_INTEGER])assert.equal(assess({...base,proposedCreditCents:proposed}).readyForFurtherReview,false)}],
 ['known net 6000 from discounted purchase cannot issue gross 8000',()=>assert.equal(assess({...base,lines:[{quantity:2,netMerchandiseBasisCents:6000}],proposedCreditCents:8000}).readyForFurtherReview,false)],
 ['invalid inspection timing and incomplete status blocked',()=>{for(const facts of [{receivedAt:null},{completedAt:'2026-10-08T10:00:00Z'},{returnStatus:'received'}])assert.equal(assess({...base,...facts}).readyForFurtherReview,false)}],
 ['SQL terminal hold constraint exists across capture AND release',()=>{const s=readFileSync('db/migrations/041_store_credit_liability_foundation.sql','utf8');assert.match(s,/UNIQUE INDEX[^\n]+idx_sc_terminal_hold[\s\S]*?event_type IN \('capture','release'\)/);assert.match(s,/amount_cents<=9007199254740991/);assert.match(s,/BEFORE UPDATE OR DELETE/)}],
 ['no provider calls, API routes, or issue-redemption functions in proposal',()=>assert.doesNotMatch(readFileSync('lib/store-credit-proposal.ts','utf8'),/\b(fetch\(|stripe|sql`|INSERT INTO|UPDATE\s+store_credit|await\s+)/)],
]
for(const [name,check] of tests){check();console.log('PASS',name)}
console.log(`${tests.length}/${tests.length} offline store-credit proposal checks passed; NOT an authorization to issue.`)
