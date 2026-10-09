import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const src=readFileSync('lib/marketing-owner-local-send-gate.ts','utf8')
const js=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const mod={exports:{}}
const UUID='11111111-1111-4111-8111-111111111111'
const validInput={planId:UUID,memberId:2,approvalId:UUID,budgetReservationId:UUID,evidenceId:UUID,messageSha256:'b'.repeat(64),claimKey:'safe_test_claim_01',channel:'email'}
new Function('module','exports','require',js)(mod,mod.exports,()=>({isValidExecutionInput:x=>JSON.stringify(x)===JSON.stringify(validInput)}))
const {validLocalOwnerTestRequest,localMarketingTransportAllowed}=mod.exports
const env={NODE_ENV:'development',KVRN_RUNTIME_ENV:'local',MARKETING_LOCAL_ONE_RECIPIENT_TEST_ENABLED:'true',MARKETING_SEND_ENABLED:'true',MARKETING_PROVIDER_DELIVERY_ENABLED:'true',MARKETING_OWNER_SEND_RELEASE_ENABLED:'true',MARKETING_CLAIM_RESOLVER_ENABLED:'true',MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED:'true',MARKETING_PROVIDER_RECEIPTS_ENABLED:'true'}
let n=0
function test(label,fn){fn();n++;console.log('PASS',label)}
test('fail closed by default',()=>assert.equal(localMarketingTransportAllowed({}),false))
test('production and deployed staging builds both blocked',()=>{for(const nodeEnv of ['production','test',undefined])assert.equal(localMarketingTransportAllowed({...env,NODE_ENV:nodeEnv}),false)})
test('nonlocal runtime blocked',()=>{for(const runtime of [undefined,'staging','production'])assert.equal(localMarketingTransportAllowed({...env,KVRN_RUNTIME_ENV:runtime}),false)})
test('every separate execution switch required',()=>{for(const key of Object.keys(env).filter(k=>k!=='NODE_ENV'&&k!=='KVRN_RUNTIME_ENV'))assert.equal(localMarketingTransportAllowed({...env,[key]:'false'}),false)})
test('all local test switches allow only explicit dev environment',()=>assert.equal(localMarketingTransportAllowed(env),true))
test('exact body fields, confirmation, and private claim references',()=>{
 assert.equal(validLocalOwnerTestRequest({confirm:'I AUTHORIZE ONE LOCAL TEST MESSAGE',input:validInput}),true)
 for(const bad of [null,{},[],{confirm:'yes',input:validInput},{confirm:'I AUTHORIZE ONE LOCAL TEST MESSAGE',input:validInput,recipient:'example@example.com'},{confirm:'I AUTHORIZE ONE LOCAL TEST MESSAGE',input:{...validInput,recipient:'example@example.com'}}])assert.equal(validLocalOwnerTestRequest(bad),false)
})
test('route authenticates and reads bounded same-origin request',()=>{const route=readFileSync('app/api/admin/marketing/execute-local-once/route.ts','utf8');assert.match(route,/requireAdmin\(req\)/);assert.match(route,/readAdminMutationJson\(req,2200\)/);assert.match(route,/isConfiguredMarketingOwner/);assert.match(route,/localMarketingTransportAllowed\(process\.env\)/);assert.doesNotMatch(route,/sendSms\(|sendOneEmail\(|sendBroadcast\(/)})
test('route never returns contact or provider raw ID',()=>{const route=readFileSync('app/api/admin/marketing/execute-local-once/route.ts','utf8');assert.match(route,/canRetry:false/);assert.match(route,/costSettled:false/);assert.doesNotMatch(route,/recipient:|phone:|email:|providerMessageId:/)})
console.log(`${n}/${n} local owner test-sender checks passed`)
