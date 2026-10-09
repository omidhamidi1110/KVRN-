import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
function load(path, imports={}){
 const s=readFileSync(path,'utf8')
 const js=ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
 const mod={exports:{}}
 new Function('module','exports','require',js)(mod,mod.exports,(name)=>imports[name]??{})
 return mod.exports
}
const receipt=load('lib/marketing-provider-receipts.ts',{'@/lib/db':{}})
const window=load('lib/marketing-delivery-window.ts')
const lib=load('lib/marketing-claimed-provider-transport.ts',{'./marketing-provider-receipts':receipt,'./marketing-delivery-window':window})
const ID='11111111-1111-4111-8111-111111111111'
const now=new Date('2026-10-08T17:00:00Z') // 10 AM PDT
const consent={timezone:'America/Los_Angeles',timezoneVerified:true,jurisdictionRuleVerified:true}
const originalEnv={...process.env}
let count=0
async function t(label,fn){await fn();count++;console.log('PASS',label)}
let body='KVRN: New drop. Reply STOP to opt out.'
let envelope={attemptId:ID,provider:'twilio',channel:'sms',recipient:'+15555551234',finalBody:body,approvedMessageSha256:await lib.hashFinalApprovedCopy(body),recipientWindow:consent,suppressionFresh:true,consentFresh:true,ownerApprovalFresh:true,budgetReservationFresh:true}
function deps(override={}){
 const calls={resolved:0,sms:0,email:0,receipt:[]}
 const d={resolveClaimedEnvelope:async()=>{calls.resolved++;return envelope},sendOneSms:async()=>{calls.sms++;return {ok:true,providerMessageId:'SM'+'a'.repeat(32)}},sendOneEmail:async()=>{calls.email++;return {ok:true,providerMessageId:'b'.repeat(36)}},recordProvisional:async(r)=>{calls.receipt.push(r)},utcNow:()=>now,...override}
 return {d,calls}
}
function enable(){for(const k of ['MARKETING_SEND_ENABLED','MARKETING_PROVIDER_DELIVERY_ENABLED','MARKETING_PROVIDER_RECEIPTS_ENABLED','MARKETING_OWNER_SEND_RELEASE_ENABLED','TWILIO_A2P_APPROVED','TWILIO_MARKETING_SEND_ENABLED','RESEND_MARKETING_SEND_ENABLED'])process.env[k]='true';process.env.MARKETING_PROVIDER_REFERENCE_PEPPER='test-secure-pepper-'.repeat(4)}
await t('all provider paths fail closed by default, no resolver or network',async()=>{delete process.env.MARKETING_SEND_ENABLED;const {d,calls}=deps();const r=await lib.submitClaimedProviderOnce(ID,d);assert.equal(r.networkAttempted,false);assert.equal(calls.resolved,0)})
enable()
await t('matching freshly-approved SMS makes exactly one network attempt; ack only provisional',async()=>{const {d,calls}=deps();const r=await lib.submitClaimedProviderOnce(ID,d);assert.equal(calls.sms,1);assert.equal(calls.receipt.length,1);assert.equal(calls.receipt[0].result,'acknowledged');assert.match(calls.receipt[0].referenceDigest,/^[0-9a-f]{64}$/);assert.equal(r.kind,'outcome_unknown');assert.equal(r.canRetry,false);assert.equal(r.receiptRecorded,true)})
await t('SMS without A2P blocks before any network',async()=>{delete process.env.TWILIO_A2P_APPROVED;const {d,calls}=deps();assert.equal((await lib.submitClaimedProviderOnce(ID,d)).networkAttempted,false);assert.equal(calls.sms,0);enable()})
await t('hash mismatch blocks even with all flags',async()=>{const {d,calls}=deps({resolveClaimedEnvelope:async()=>({...envelope,finalBody:'tampered'})});assert.equal((await lib.submitClaimedProviderOnce(ID,d)).networkAttempted,false);assert.equal(calls.sms,0)})
await t('revoked consent or missing owner approval blocks',async()=>{for(const key of ['consentFresh','suppressionFresh','ownerApprovalFresh','budgetReservationFresh']){const {d,calls}=deps({resolveClaimedEnvelope:async()=>({...envelope,[key]:false})});assert.equal((await lib.submitClaimedProviderOnce(ID,d)).networkAttempted,false);assert.equal(calls.sms,0)}})
await t('quiet hours block in recipient IANA timezone',async()=>{const {d,calls}=deps({utcNow:()=>new Date('2026-10-09T06:00:00Z')});assert.equal((await lib.submitClaimedProviderOnce(ID,d)).networkAttempted,false);assert.equal(calls.sms,0)})
await t('provider throw is permanently unknown, record attempted only once',async()=>{const {d,calls}=deps({sendOneSms:async()=>{calls.sms++;throw Error('timeout')}});const r=await lib.submitClaimedProviderOnce(ID,d);assert.equal(calls.sms,1);assert.equal(calls.receipt[0].result,'uncertain');assert.equal(r.canRetry,false);assert.equal(r.kind,'outcome_unknown')})
await t('lost receipt DB write never authorizes second attempt',async()=>{const {d,calls}=deps({recordProvisional:async()=>{throw Error('db')}});const r=await lib.submitClaimedProviderOnce(ID,d);assert.equal(calls.sms,1);assert.equal(r.receiptRecorded,false);assert.equal(r.canRetry,false)})
await t('SMS wrong recipient or missing STOP footer blocks',async()=>{for(const x of [{recipient:'15555551234'},{finalBody:'KVRN: Product launch',approvedMessageSha256:await lib.hashFinalApprovedCopy('KVRN: Product launch')}]){const {d,calls}=deps({resolveClaimedEnvelope:async()=>({...envelope,...x})});assert.equal((await lib.submitClaimedProviderOnce(ID,d)).networkAttempted,false);assert.equal(calls.sms,0)}})
await t('empty or malformed email payload cannot use email transport',async()=>{const email={...envelope,provider:'resend',channel:'email',recipient:'reader@example.com',emailSubscriberId:ID,subject:'Launch'};const {d,calls}=deps({resolveClaimedEnvelope:async()=>email});assert.equal((await lib.submitClaimedProviderOnce(ID,d)).networkAttempted,false);assert.equal(calls.email,0)})
await t('email subject changes invalidate copy approval hash',async()=>{const link='https://kvrn.shop/email-preferences?token=v1.'+ID+'.'+'a'.repeat(43);const content='<a href=\"'+link+'\">Unsubscribe</a>';const email={...envelope,provider:'resend',channel:'email',recipient:'reader@example.com',emailSubscriberId:ID,subject:'Changed subject',unsubscribeUrl:link,finalBody:content,approvedMessageSha256:await lib.hashFinalApprovedCopy(content,'email','Original subject')};const {d,calls}=deps({resolveClaimedEnvelope:async()=>email});assert.equal((await lib.submitClaimedProviderOnce(ID,d)).networkAttempted,false);assert.equal(calls.email,0)})
await t('unsub link + exact email approval allow single send but not confirmed delivery',async()=>{const link='https://kvrn.shop/email-preferences?token=v1.'+ID+'.'+'a'.repeat(43);const content='<p>KVRN update</p><p><a href="'+link+'">Unsubscribe</a></p>';const email={...envelope,provider:'resend',channel:'email',recipient:'reader@example.com',emailSubscriberId:ID,subject:'KVRN update',unsubscribeUrl:link,finalBody:content,approvedMessageSha256:await lib.hashFinalApprovedCopy(content,'email','KVRN update')};const {d,calls}=deps({resolveClaimedEnvelope:async()=>email});const r=await lib.submitClaimedProviderOnce(ID,d);assert.equal(calls.email,1);assert.equal(calls.sms,0);assert.equal(r.kind,'outcome_unknown');assert.equal(r.receiptRecorded,true)})
for(const k of Object.keys(process.env))if(!(k in originalEnv))delete process.env[k]
Object.assign(process.env,originalEnv)
console.log(`${count}/${count} claimed transport checks passed`)
