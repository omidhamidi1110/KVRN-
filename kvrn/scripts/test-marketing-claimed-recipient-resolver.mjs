import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const UUID='11111111-1111-4111-8111-111111111111',DATE='2026-10-08T17:00:00Z',NOW=new Date(DATE)
const copy='KVRN: Drop. Reply STOP to opt out.'
const digest='a'.repeat(64)
let rows=[],queries=0
function load(path,imports){const src=readFileSync(path,'utf8'),js=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,mod={exports:{}};new Function('module','exports','require',js)(mod,mod.exports,name=>imports[name]??{});return mod.exports}
const deps1={
 '@/lib/db':{sql:()=>{queries++;return Promise.resolve(rows)}},
 './marketing-message-composer':{composeMarketingSms:()=>({body:copy,validOneSegment:true})},
 './marketing-unsubscribe':{signMarketingUnsubscribe:async()=>`v1.${UUID}.${'b'.repeat(43)}`},
 './marketing-claimed-provider-transport':{hashFinalApprovedCopy:async()=>digest},
}
const src=load('lib/marketing-claimed-recipient-resolver.ts',deps1)
const {resolveClaimedMarketingRecipient}=src
let allowed=true,providerChecks=0
const checker={providerPermission:async()=>{providerChecks++;return allowed},signUnsubscribe:async()=>`v1.${UUID}.${'b'.repeat(43)}`,utcNow:()=>NOW}
const base={id:UUID,claim_plan_id:UUID,provider:'twilio',message_sha256:digest,approved_message_sha256:digest,reviewer_sha256:digest,owner_identity_sha256:digest,evidence_expires_at:'2026-10-08T17:04:00Z',recipient_timezone:'America/Los_Angeles',jurisdiction_proof_sha256:digest,provider_suppression_proof_sha256:digest,frequency_proof_sha256:digest,provider_price_proof_sha256:digest,recipient_price:'2000',channel:'sms',campaign_state:'reviewed',campaign_version:2,subject:null,body:'Drop.',snapshot_version:2,plan_state:'staged',snapshot_campaign_id:UUID,approval_state:'approved',approval_plan_id:UUID,approval_campaign_id:UUID,approval_campaign_version:2,approval_expires_at:'2026-10-08T17:30:00Z',approved_maximum:'3000',reservation_state:'reserved',budget_campaign_id:UUID,budget_channel:'sms',budget_utc_day:'2026-10-08',budget_utc_month:'2026-10-01',budget_reserved:'2500',phone_e164:'+15555551234',sms_contact_id:UUID,email_contact_id:null,email:null,local_consent:true}
function set(o={}){rows=[{...base,...o}]}
const env={...process.env}
let n=0
async function t(label,fn){await fn();n++;console.log('PASS',label)}
set()
await t('feature disabled before private SQL lookup',async()=>{delete process.env.MARKETING_CLAIM_RESOLVER_ENABLED;await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,checker),/DISABLED/);assert.equal(queries,0)})
process.env.MARKETING_CLAIM_RESOLVER_ENABLED='true'
await t('valid claimed DB state resolves exact SMS contact only on independent provider permission',async()=>{set();allowed=true;const e=await resolveClaimedMarketingRecipient(UUID,checker);assert.equal(e.recipient,base.phone_e164);assert.equal(e.provider,'twilio');assert.equal(e.approvedMessageSha256,digest);assert.equal(e.consentFresh,true);assert.equal(providerChecks,1)})
await t('known opt-out or provider lookup error blocks',async()=>{set();allowed=false;await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,checker),/SUPPRESSION/);allowed=true;await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,{...checker,providerPermission:async()=>{throw Error('provider timeout')}}),/SUPPRESSION/)})
await t('revoked local consent, owner approval, or budget blocks before provider contact',async()=>{for(const bad of [{local_consent:false},{approval_state:'revoked'},{reservation_state:'settled'},{plan_state:'cancelled'},{campaign_state:'draft'}]){set(bad);const was=providerChecks;await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,checker),/UNVERIFIED/);assert.equal(providerChecks,was)}})
await t('foreign approval/plan or stale campaign version is rejected',async()=>{for(const bad of [{approval_plan_id:'22222222-2222-4222-8222-222222222222'},{approval_campaign_version:1},{snapshot_version:1},{reviewer_sha256:'b'.repeat(64)}]){set(bad);await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,checker),/UNVERIFIED/)}})
await t('expired evidence or owner approval is rejected',async()=>{for(const bad of [{evidence_expires_at:'2026-10-08T16:59:59Z'},{approval_expires_at:'2026-10-08T16:59:59Z'}]){set(bad);await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,checker),/UNVERIFIED/)}})
await t('old UTC budget and insufficient quoted cap block',async()=>{for(const bad of [{budget_utc_day:'2026-10-07'},{budget_utc_month:'2026-09-01'},{recipient_price:'3001'},{budget_reserved:'1000'}]){set(bad);await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,checker),/UNVERIFIED/)}})
await t('unverified message digest and channel/provider mismatch block',async()=>{for(const bad of [{approved_message_sha256:'f'.repeat(64)},{provider:'resend'},{phone_e164:'15555551234'}]){set(bad);await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,checker))}})
await t('email uses canonical DB address, escaped HTML and contact-specific unsubscribe link',async()=>{
 set({provider:'resend',channel:'email',subject:'KVRN launch',body:'Hello <customer> & team',phone_e164:null,sms_contact_id:null,email:'person@example.com',email_contact_id:UUID,resend_contact_id:'contact_abc123',budget_channel:'email'});allowed=true
 let args=[]
 const res=await resolveClaimedMarketingRecipient(UUID,{...checker,providerPermission:async(...a)=>{args=a;return true}})
 assert.equal(res.channel,'email');assert.equal(res.recipient,'person@example.com')
 assert.match(res.finalBody,/Hello &lt;customer&gt; &amp; team/)
 assert.match(res.finalBody,/https:\/\/kvrn\.shop\/email-preferences\?token=v1\./)
 assert.equal(args[2],'contact_abc123');assert.equal(res.subject,'KVRN launch')
})
await t('missing or malformed provider contact ID fails before external check',async()=>{
 for(const contactId of [null,'','id','unsafe/id','a'.repeat(129)]){
  set({provider:'resend',channel:'email',subject:'KVRN launch',body:'Hello',phone_e164:null,sms_contact_id:null,email:'person@example.com',email_contact_id:UUID,resend_contact_id:contactId,budget_channel:'email'})
  let called=false
  await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,{...checker,providerPermission:async()=>{called=true;return true}}),/MARKETING_EMAIL_CONTACT_INVALID/)
  assert.equal(called,false)
 }
})
await t('missing claim does not reveal PII or call provider',async()=>{rows=[];const was=providerChecks;await assert.rejects(()=>resolveClaimedMarketingRecipient(UUID,checker),/NOT_FOUND/);assert.equal(providerChecks,was)})
await t('resolver query binds contacts to both claim and frozen audience and checks prior consent proofs',()=>{const text=readFileSync('lib/marketing-claimed-recipient-resolver.ts','utf8');assert.match(text,/a\.id=\$\{attemptId\}::uuid/);assert.match(text,/JOIN marketing_audience_members m ON m\.id=a\.audience_member_id/);assert.match(text,/sms_keyword_consent_proofs/);assert.match(text,/marketing_email_consent_events/);assert.match(text,/providerPermission\(channel,recipient,/);assert.doesNotMatch(text, /console\.(?:log|error)\(/)})
for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k]
Object.assign(process.env,env)
console.log(`${n}/${n} claimed recipient resolver checks passed`)
