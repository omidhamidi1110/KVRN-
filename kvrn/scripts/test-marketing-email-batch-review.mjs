import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const env={MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED:'false',MARKETING_OWNER_APPROVAL_EMAIL:'owner@example.com'}
const UUID='11a11111-1111-4111-8111-111111111111'
let calls=0,active=0,maximumActive=0,failed=new Set()
const external={
 './marketing-owner-approval':{isConfiguredMarketingOwner:(email,expected)=>email===expected},
 './marketing-email-recipient-evidence':{
  validRecipientEvidenceReview:input=>{
   if(Object.keys(input).length!==6||input.confirmLegalReview!==true||input.planId!==UUID||input.approvalId!==UUID)return false
   if(!Number.isSafeInteger(input.memberId)||input.memberId<1||!/^[a-zA-Z_/]+$/.test(input.recipientTimezone))return false
   if(!/^approved-[0-9]+$/.test(input.jurisdictionEvidenceRef))return false
   return true
  },
  recordReviewedEmailRecipientEvidence:async(input)=>{
   calls++;active++;maximumActive=Math.max(maximumActive,active)
   await Promise.resolve();await Promise.resolve()
   active--
   if(failed.has(input.memberId))throw Error('Secret provider response: subscriber@example.com')
   return {evidenceId:UUID,messageSha256:'a'.repeat(64),expiresInSeconds:240,canSend:false}
  }
 }
}
const raw=readFileSync('lib/marketing-email-batch-review.ts','utf8')
const mod={exports:{}}
vm.runInNewContext(ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {module:mod,exports:mod.exports,require:n=>{if(!external[n])throw Error('Unexpected import '+n);return external[n]},process:{env},Promise,Array,Object,Number,String,Set,Error,Math})
const f=mod.exports
const input=n=>({planId:UUID,approvalId:UUID,recipients:Array.from({length:n},(_,i)=>({memberId:i+1,recipientTimezone:'America/Los_Angeles',jurisdictionEvidenceRef:`approved-${i+1}`,confirmLegalReview:true}))})
let n=0
async function test(label,fn){await fn();console.log('PASS',label);n++}
await test('disabled by default before any recipient provider check',async()=>{
 await assert.rejects(f.prepareReviewedEmailAudienceBatch(input(1),'owner@example.com'),/BATCH_DISABLED/)
 assert.equal(calls,0)
})
await test('exact owner identity must match before batch preparation',async()=>{
 env.MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED='true'
 await assert.rejects(f.prepareReviewedEmailAudienceBatch(input(1),'other@example.com'),/OWNER_REQUIRED/)
 assert.equal(calls,0)
})
await test('rejects duplicates and invalid review without touching provider',async()=>{
 for(const x of [input(0),input(51), {...input(2),recipients:[input(1).recipients[0],input(1).recipients[0]]},
 {...input(1),recipients:[{...input(1).recipients[0],confirmLegalReview:false}]},
 {...input(1),recipient:'user@example.com'}]){
  assert.equal(f.validBatchEvidenceReview(x),false)
  await assert.rejects(f.prepareReviewedEmailAudienceBatch(x,'owner@example.com'),/INVALID_REVIEW/)
 }
 assert.equal(calls,0)
})
await test('full 50-recipient batch uses no more than 4 parallel reviews',async()=>{
 const output=await f.prepareReviewedEmailAudienceBatch(input(50),'owner@example.com')
 assert.equal(output.prepared,50);assert.equal(output.requested,50);assert.equal(output.rejected,0)
 assert.equal(output.recipientResults.length,50);assert.equal(output.readyForSend,false)
 assert.equal(maximumActive,4);assert.equal(calls,50)
})
await test('partial provider failures do not leak contact, cost, or provider exception',async()=>{
 failed=new Set([2,4]);const output=await f.prepareReviewedEmailAudienceBatch(input(5),'owner@example.com')
 assert.equal(output.prepared,3);assert.equal(output.rejected,2)
 assert.deepEqual(Array.from(output.recipientResults.filter(x=>!x.prepared).map(x=>x.memberId)),[2,4])
 const printed=JSON.stringify(output)
 assert.doesNotMatch(printed,/subscriber@example.com|Secret provider response|jurisdictionEvidenceRef|recipientTimezone/)
 assert.equal(output.readyForSend,false)
})
await test('individual member order is maintained independent of parallel completion',async()=>{
 failed=new Set();const output=await f.prepareReviewedEmailAudienceBatch(input(7),'owner@example.com')
 assert.deepEqual(Array.from(output.recipientResults.map(x=>x.memberId)),[1,2,3,4,5,6,7])
})
await test('Admin endpoint bound body, owner auth, no send and no contact details',async()=>{
 const route=readFileSync('app/api/admin/marketing/recipient-evidence-batch/route.ts','utf8')
 for(const s of ['requireAdmin(req)','isConfiguredMarketingOwner','readAdminMutationJson(req,16000)','validBatchEvidenceReview','prepareReviewedEmailAudienceBatch'])assert.ok(route.includes(s))
 assert.doesNotMatch(route,/twilio|resend\.emails|\.send\(|phone_e164|customer_email/)
})
console.log(`${n}/${n} reviewed email batch tests passed, no actual provider calls.`)
