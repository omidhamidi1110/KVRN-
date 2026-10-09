import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const code=readFileSync('lib/marketing-provider-one-shot-adapters.ts','utf8')
const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const ID='11111111-1111-4111-8111-111111111111'
let sms=0,email=0,records=0,mailPayload
const mod={exports:{}}
new Function('module','exports','require',js)(mod,mod.exports,name=>{
 if(name==='./twilio')return {sendSms:async()=>{sms++;return{ok:true,messageSid:'SM'+'a'.repeat(32)}}}
 if(name==='./resend-adapter')return {createResendAdapter:()=>({send:async m=>{email++;mailPayload=m;return{ok:true,providerMessageId:'a'.repeat(36)}}})}
 if(name==='./marketing-one-click-unsubscribe')return {oneClickMarketingUrl:u=>'https://kvrn.shop/api/marketing/one-click-unsubscribe?token='+new URL(u).searchParams.get('token')}
 if(name==='./marketing-provider-receipts')return {recordProvisionalProviderReceipt:async()=>{records++}}
 return {}
})
const {makeOneShotProviderBindings}=mod.exports
const env={...process.env}
let n=0
async function t(label,fn){await fn();n++;console.log('PASS',label)}
await t('a valid claimed UUID is required before building provider bindings',()=>assert.throws(()=>makeOneShotProviderBindings('user-supplied'),/INVALID/))
const a=makeOneShotProviderBindings(ID)
await t('default-off providers cannot send SMS or email',async()=>{delete process.env.MARKETING_SEND_ENABLED;await assert.rejects(()=>a.sendOneSms('+15555551234','x'),/BLOCKED/);await assert.rejects(()=>a.sendOneEmail('customer@example.com','subject','body','https://kvrn.shop/email-preferences?token=v1.foo'),/BLOCKED/);assert.equal(sms,0);assert.equal(email,0)})
const keys=['MARKETING_SEND_ENABLED','MARKETING_PROVIDER_DELIVERY_ENABLED','MARKETING_OWNER_SEND_RELEASE_ENABLED','MARKETING_PROVIDER_RECEIPTS_ENABLED','TWILIO_A2P_APPROVED','TWILIO_MARKETING_SEND_ENABLED','RESEND_MARKETING_SEND_ENABLED']
for(const k of keys)process.env[k]='true'
await t('SMS adapter does not send without A2P approved flag',async()=>{delete process.env.TWILIO_A2P_APPROVED;await assert.rejects(()=>a.sendOneSms('+15555551234','x'),/BLOCKED/);assert.equal(sms,0);process.env.TWILIO_A2P_APPROVED='true'})
await t('single SMS provider adapter invocation returns provisional reference',async()=>{const r=await a.sendOneSms('+15555551234','x');assert.equal(r.ok,true);assert.equal(sms,1);assert.match(r.providerMessageId,/^SM/)})
await t('no email send without dedicated marketing API key and verified from domain',async()=>{delete process.env.RESEND_MARKETING_API_KEY;await assert.rejects(()=>a.sendOneEmail('customer@example.com','subject','body','https://kvrn.shop/email-preferences?token=v1.foo'),/UNCONFIGURED/);assert.equal(email,0)})
process.env.RESEND_MARKETING_API_KEY='dummy-do-not-send'
process.env.RESEND_MARKETING_FROM='KVRN <offers@not-kvrn.shop>'
await t('rejects unapproved marketing sender address',async()=>{await assert.rejects(()=>a.sendOneEmail('customer@example.com','subject','body','https://kvrn.shop/email-preferences?token=v1.foo'),/UNCONFIGURED/);assert.equal(email,0)})
process.env.RESEND_MARKETING_FROM='KVRN <news@kvrn.shop>'
await t('one approved email send uses List-Unsubscribe and attempt-specific idempotency',async()=>{const url='https://kvrn.shop/email-preferences?token=v1.'+ID+'.'+'a'.repeat(43);const r=await a.sendOneEmail('customer@example.com','subject','body',url);assert.equal(r.ok,true);assert.equal(email,1);assert.equal(mailPayload.headers['List-Unsubscribe'],`<https://kvrn.shop/api/marketing/one-click-unsubscribe?token=${new URL(url).searchParams.get('token')}>`);assert.equal(mailPayload.headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');assert.equal(mailPayload.idempotencyKey,`kvrn-marketing-${ID}`);assert.equal(mailPayload.replyTo,'support@kvrn.shop')})
await t('cannot store a provisional receipt for a different claim',async()=>{await assert.rejects(()=>a.recordProvisional({attemptId:'22222222-2222-4222-8222-222222222222',provider:'twilio',result:'uncertain',referenceDigest:null}),/MISMATCH/);assert.equal(records,0);await a.recordProvisional({attemptId:ID,provider:'twilio',result:'uncertain',referenceDigest:null});assert.equal(records,1)})
for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k]
Object.assign(process.env,env)
console.log(`${n}/${n} one-shot provider adapter checks passed`)
