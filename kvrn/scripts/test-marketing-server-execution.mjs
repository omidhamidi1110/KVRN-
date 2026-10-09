import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const code=readFileSync('lib/marketing-server-execution.ts','utf8')
const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const ID='11111111-1111-4111-8111-111111111111'
const input={planId:ID,memberId:1,approvalId:ID,budgetReservationId:ID,evidenceId:ID,messageSha256:'a'.repeat(64),claimKey:'test_claim_key_0001',channel:'email'}
let sqlCalls=0,precheckGood=true,transportCalls=0,claimCalls=0,signatureCalls=0
const modules={
 '@/lib/db':{sql:()=>{sqlCalls++;return Promise.resolve(sqlCalls%2===1?[{ok:precheckGood}]:[{attempt_id:ID}])}},
 './marketing-execution-coordinator':{
  isValidExecutionInput:i=>i?.memberId===1,
  executeMarketingAttemptOnce:async(i,deps)=>{
    if(!await deps.recheck(i))return {state:'blocked'}
    const id=await deps.claim(i);claimCalls++
    const outcome=await deps.submitOnce(i,id);assert.equal(outcome.kind,'outcome_unknown')
    return {state:'claimed_unknown',canRetry:false,costSettled:false}
  },
 },
 './marketing-claimed-recipient-resolver':{resolveClaimedMarketingRecipient:async()=>({}),defaultResolverDependencies:f=>({providerPermission:f})},
 './marketing-provider-permission':{verifyMarketingProviderPermission:async()=>false},
 './marketing-claimed-provider-transport':{submitClaimedProviderOnce:async()=>{transportCalls++;return{kind:'outcome_unknown'}}},
 './marketing-provider-one-shot-adapters':{makeOneShotProviderBindings:()=>({sendOneSms:async()=>{},sendOneEmail:async()=>{},recordProvisional:async()=>{}})},
}
const mod={exports:{}}
new Function('module','exports','require',js)(mod,mod.exports,name=>modules[name]??{})
const {attemptTrustedMarketingDeliveryOnce}=mod.exports
let n=0
async function t(label,fn){await fn();n++;console.log('PASS',label)}
await t('malformed inputs do not enter DB or claim',async()=>{const r=await attemptTrustedMarketingDeliveryOnce({...input,memberId:-1});assert.equal(r.state,'blocked');assert.equal(sqlCalls,0)})
await t('valid envelope runs read-only precheck, atomic DB claim, then one-shot provisional path',async()=>{const r=await attemptTrustedMarketingDeliveryOnce(input);assert.equal(r.state,'claimed_unknown');assert.equal(claimCalls,1);assert.equal(transportCalls,1);assert.equal(sqlCalls,2)})
await t('failed precheck never invokes claim or transport',async()=>{precheckGood=false;const r=await attemptTrustedMarketingDeliveryOnce(input);assert.equal(r.state,'blocked');assert.equal(claimCalls,1);assert.equal(transportCalls,1)})
await t('no HTTP, cron, raw-provider address, or direct final-outcome proof in this module',()=>{assert.doesNotMatch(code,/\bfetch\(|\bsendSms\(|\bgetEmailProvider\(|\bsetInterval\(/);assert.match(code,/kvrn_marketing_claim_at_most_once/);assert.match(code,/MARKETING_OUTCOME_REQUIRES_SIGNED_PROVIDER_EVIDENCE/);assert.match(code,/resolveClaimedMarketingRecipient/);assert.match(code,/verifyMarketingProviderPermission/)})
console.log(`${n}/${n} trusted server execution composition checks passed`)
