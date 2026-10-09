import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {webcrypto} from 'node:crypto'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const uuid='11a11111-1111-4111-8111-111111111111'
const approval='22b22222-2222-4222-8222-222222222222'
const reservation='33c33333-3333-4333-8333-333333333333'
const env={NODE_ENV:'production',KVRN_RUNTIME_ENV:'staging',MARKETING_OWNER_EXECUTION_HTTP_ENABLED:'true',
 MARKETING_OWNER_SEND_RELEASE_ENABLED:'true',MARKETING_SEND_ENABLED:'true',MARKETING_PROVIDER_DELIVERY_ENABLED:'true',
 MARKETING_CLAIM_RESOLVER_ENABLED:'true',MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED:'true',MARKETING_PROVIDER_RECEIPTS_ENABLED:'true',
 MARKETING_OWNER_CAMPAIGN_EXECUTION_ENABLED:'true',MARKETING_OWNER_APPROVAL_EMAIL:'owner@example.com'}
let members=[],calls=0,active=0,maxActive=0,doFail=new Set(),readCalls=0
const canonical=n=>Array.from({length:n},(_,i)=>({
 memberId:i+1,approvalId:approval,budgetReservationId:reservation,evidenceId:uuid,
 messageSha256:'a'.repeat(64),evidenceExpiresAt:new Date(Date.now()+160_000).toISOString(),
 claimKey:`email:${uuid}:${i+1}`,readyForOwnerReview:true,hasCurrentEvidence:true,
 previousAttempt:false,eligibleLocally:true,canSend:false
}))
const deps={
 './marketing-email-recipient-evidence':{listReviewedEmailAudience:async()=>{readCalls++;return members}},
 './marketing-server-execution':{attemptTrustedMarketingDeliveryOnce:async input=>{
  calls++;active++;maxActive=Math.max(maxActive,active)
  assert.equal(input.channel,'email')
  await Promise.resolve();await Promise.resolve();active--
  if(doFail.has(input.memberId))throw Error('PII customer@example.com')
  return {state:'claimed_unknown',attemptId:uuid,canRetry:false,costSettled:false}
 }},
 './marketing-owner-approval':{isConfiguredMarketingOwner:(e,c)=>e===c},
 './marketing-owner-execution-gate':{ownerApprovedExecutionAllowed:e=>e.MARKETING_OWNER_CAMPAIGN_EXECUTION_ENABLED==='true'&&e.MARKETING_SEND_ENABLED==='true'},
}
const exports={}
const raw=readFileSync('lib/marketing-owner-campaign-execution.ts','utf8')
vm.runInNewContext(ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {exports,require:n=>{if(!deps[n])throw Error('Unexpected import '+n);return deps[n]},process:{env},Promise,Array,Number,String,Set,Math,Date,Object,Error,crypto:webcrypto,TextEncoder,Uint8Array})
const mod=exports
let n=0;async function test(label,cb){await cb();n++;console.log('PASS',label)}
await test('default-off gate prevents provider attempts even with owner confirmation',async()=>{
 members=canonical(2)
 env.MARKETING_OWNER_CAMPAIGN_EXECUTION_ENABLED='false'
 await assert.rejects(mod.executeOwnerApprovedEmailCampaign({planId:uuid,confirm:'I AUTHORIZE THE EXACT REVIEWED EMAIL CAMPAIGN',audienceSha256:'a'.repeat(64)},'owner@example.com'),/EXECUTION_DISABLED/)
 assert.equal(calls,0);env.MARKETING_OWNER_CAMPAIGN_EXECUTION_ENABLED='true'
})
await test('preview refuses unconfigured owner with no audience read',async()=>{
 const before=readCalls
 await assert.rejects(mod.previewApprovedEmailCampaign(uuid,'impostor@example.com'),/OWNER_OR_PLAN_INVALID/)
 assert.equal(readCalls,before)
})
await test('preview emits exact audience fingerprint, expiry and no send authority',async()=>{
 members=canonical(6)
 const p=await mod.previewApprovedEmailCampaign(uuid,'owner@example.com')
 assert.equal(p.ready,true);assert.equal(p.memberCount,6);assert.match(p.audienceSha256,/^[a-f0-9]{64}$/)
 assert.equal(p.canSend,false);assert.ok(p.expiresSoonestAt)
})
await test('stale or manipulated member changes require a new owner confirmation',async()=>{
 const p=await mod.previewApprovedEmailCampaign(uuid,'owner@example.com')
 members[0]={...members[0],messageSha256:'b'.repeat(64)}
 await assert.rejects(mod.executeOwnerApprovedEmailCampaign({planId:uuid,audienceSha256:p.audienceSha256,
 confirm:'I AUTHORIZE THE EXACT REVIEWED EMAIL CAMPAIGN'},'owner@example.com'),/REVIEW_STALE/)
 assert.equal(calls,0);members=canonical(6)
})
await test('any unreviewed, expired, previously claimed or missing evidence blocks entire batch',async()=>{
 for(const fault of [{hasCurrentEvidence:false},{previousAttempt:true},{eligibleLocally:false},
 {readyForOwnerReview:false},{evidenceExpiresAt:new Date(Date.now()+2000).toISOString()},
 {approvalId:null},{messageSha256:null}]){
  members=canonical(3);members[1]={...members[1],...fault}
  const p=await mod.previewApprovedEmailCampaign(uuid,'owner@example.com')
  assert.equal(p.ready,false);assert.equal(p.audienceSha256,null)
 }
 assert.equal(calls,0)
})
await test('owner-acknowledged exact audience runs at-most-once calls with bounded parallelism',async()=>{
 members=canonical(20)
 const p=await mod.previewApprovedEmailCampaign(uuid,'owner@example.com')
 const result=await mod.executeOwnerApprovedEmailCampaign({planId:uuid,audienceSha256:p.audienceSha256,
 confirm:'I AUTHORIZE THE EXACT REVIEWED EMAIL CAMPAIGN'},'owner@example.com')
 assert.equal(result.requested,20);assert.equal(result.claimedUnknown,20);assert.equal(result.blocked,0)
 assert.equal(result.canRetry,false);assert.equal(result.costSettled,false);assert.equal(calls,20)
 assert.equal(maxActive,3);assert.deepEqual(Array.from(result.attemptedRecipients.map(x=>x.memberId)),Array.from({length:20},(_,i)=>i+1))
})
await test('indeterminate individual errors remain claimed-unknown, never repeated or leaked to Admin',async()=>{
 members=canonical(4);doFail=new Set([2,4]);calls=0
 const p=await mod.previewApprovedEmailCampaign(uuid,'owner@example.com')
 const result=await mod.executeOwnerApprovedEmailCampaign({planId:uuid,audienceSha256:p.audienceSha256,
 confirm:'I AUTHORIZE THE EXACT REVIEWED EMAIL CAMPAIGN'},'owner@example.com')
 assert.equal(result.requested,4);assert.equal(result.blocked,0);assert.equal(result.claimedUnknown,4)
 assert.equal(result.attemptedRecipients[1].attemptId,null);assert.equal(result.attemptedRecipients[3].state,'claimed_unknown')
 assert.equal(calls,4);assert.doesNotMatch(JSON.stringify(result),/customer@example|PII|body|price/)
})
await test('invalid request and duplicate audience never reach transport',async()=>{
 const inRaw={planId:uuid,audienceSha256:'a'.repeat(64),confirm:'I AUTHORIZE THE EXACT REVIEWED EMAIL CAMPAIGN'}
 for(const bad of [{...inRaw,confirm:'send'},{...inRaw,email:'customer@example.com'},{...inRaw,audienceSha256:'x'.repeat(64)}])assert.equal(mod.validApprovedCampaignExecution(bad),false)
 members=canonical(2);members[1]={...members[0]}
 await assert.rejects(mod.previewApprovedEmailCampaign(uuid,'owner@example.com'),/AUDIENCE_INVALID/)
 assert.equal(calls,4)
})
await test('authenticated route has read-only preview and mutation requires extra disabled-by-default batch flag',async()=>{
 const route=readFileSync('app/api/admin/marketing/execute-approved-campaign/route.ts','utf8')
 for(const s of ['requireAdmin(req)','isConfiguredMarketingOwner','readAdminMutationJson(req,900)',
 'validApprovedCampaignExecution','previewApprovedEmailCampaign','executeOwnerApprovedEmailCampaign',
 "process.env.MARKETING_OWNER_CAMPAIGN_EXECUTION_ENABLED!=='true'"])assert.ok(route.includes(s),s)
 assert.doesNotMatch(route,/setInterval\(|setTimeout\(|sendBroadcast|\.send\(|recipientEmail|phone_e164/)
})
console.log(`${n}/${n} manual owner email campaign execution tests passed; provider, DB and sending MOCKED.`)
