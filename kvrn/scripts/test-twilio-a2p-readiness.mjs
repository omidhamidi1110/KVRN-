import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const accountSid='AC'+'a'.repeat(32),serviceSid='MG'+'b'.repeat(32),campaignSid='QE'+'c'.repeat(32)
const env={TWILIO_A2P_READINESS_ENABLED:'false',TWILIO_ACCOUNT_SID:accountSid,
 TWILIO_MESSAGING_SERVICE_SID:serviceSid,TWILIO_A2P_CAMPAIGN_SID:campaignSid,
 TWILIO_API_KEY:'SK'+'d'.repeat(32),TWILIO_API_SECRET:'secret-for-test-only-abc'}
const response={account_sid:accountSid,messaging_service_sid:serviceSid,sid:campaignSid,campaign_status:'VERIFIED'}
let calls=0,requested='',options=null,bounded=0,payload=response
const mocks={'./marketing-provider-permission':{readBoundedProviderJson:async(res,max)=>{bounded++;assert.equal(max,24576);return res.mock?payload:null}}}
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(readFileSync('lib/twilio-a2p-readiness.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {module,exports:module.exports,process:{env},require:n=>{if(!mocks[n])throw Error('Unexpected import '+n);return mocks[n]},fetch:async(url,o)=>{calls++;requested=url;options=o;return {mock:true}},Buffer,Promise,AbortSignal,Array,Object,Number,String,Date,Error,Set})
const f=module.exports
let n=0;async function test(label,check){await check();n++;console.log('PASS',label)}
await test('default off before any Twilio request',async()=>{
 await assert.rejects(f.readTwilioA2pReadiness(),/READINESS_DISABLED/);assert.equal(calls,0)
})
await test('missing Twilio config blocks external request',async()=>{
 env.TWILIO_A2P_READINESS_ENABLED='true';delete env.TWILIO_API_SECRET
 await assert.rejects(f.readTwilioA2pReadiness(),/CREDENTIALS_UNAVAILABLE/);assert.equal(calls,0)
 env.TWILIO_API_SECRET='secret-for-test-only-abc'
})
await test('read-only Twilio GET uses exact service/campaign and never sends messages',async()=>{
 const out=await f.readTwilioA2pReadiness()
 assert.equal(calls,1);assert.equal(options.method,'GET');assert.equal(options.redirect,'error')
 assert.equal(requested,`https://messaging.twilio.com/v1/Services/${serviceSid}/Compliance/Usa2p/${campaignSid}`)
 assert.match(options.headers.Authorization,/^Basic [A-Za-z0-9+/=]+$/)
 assert.equal(out.campaignStatus,'VERIFIED');assert.equal(out.campaignVerified,true)
 assert.equal(out.smsMarketingSendingAuthorized,false);assert.equal(out.serviceRegistrationMatched,true)
 assert.doesNotMatch(JSON.stringify(out),/secret-for-test-only/)
})
await test('pending, failed, and in-progress never authorize sending',async()=>{
 for(const status of ['PENDING','FAILED','IN_PROGRESS']){
  const out=f.interpretTwilioA2pResponse({...response,campaign_status:status},{accountSid,serviceSid,campaignSid})
  assert.equal(out.campaignStatus,status);assert.equal(out.campaignVerified,false)
  assert.equal(out.smsMarketingSendingAuthorized,false)
 }
})
await test('rejects mismatched service, account, campaign, unknown campaign status',async()=>{
 for(const altered of [{sid:'QE'+'f'.repeat(32)},{messaging_service_sid:'MG'+'f'.repeat(32)},
 {account_sid:'AC'+'f'.repeat(32)},{campaign_status:'SENT'},{}]){
  if(Object.keys(altered).length===0)continue
  assert.throws(()=>f.interpretTwilioA2pResponse({...response,...altered},{accountSid,serviceSid,campaignSid}),/UNVERIFIED_RESPONSE/)
 }
})
await test('malformed/unavailable Twilio response cannot become verified',async()=>{
 payload={...response,account_sid:'AC'+'f'.repeat(32)}
 await assert.rejects(f.readTwilioA2pReadiness(),/UNVERIFIED_RESPONSE/)
 payload=null;await assert.rejects(f.readTwilioA2pReadiness(),/PROVIDER_UNAVAILABLE/)
 payload=response
})
await test('Admin endpoint is private, authenticated, disabled-before-lookup, read-only',async()=>{
 const route=readFileSync('app/api/admin/marketing/twilio-a2p-readiness/route.ts','utf8')
 for(const x of ['requireAdmin(req)','isConfiguredMarketingOwner','TWILIO_A2P_READINESS_ENABLED','readTwilioA2pReadiness()','private, no-store'])assert.ok(route.includes(x),x)
 for(const x of ['export async function POST','sendSms(','writeConsent(','bulkConsents','message.create(','DELETE(','PATCH('])assert.equal(route.includes(x),false,x)
})
console.log(`${n}/${n} owner-only Twilio A2P read-only readiness tests passed; no provider calls.`)
