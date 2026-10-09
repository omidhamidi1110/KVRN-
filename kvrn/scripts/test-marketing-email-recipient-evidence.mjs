import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {webcrypto} from 'node:crypto'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const UUID='11a11111-1111-4111-8111-111111111111'
const env={MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED:'false',MARKETING_OWNER_APPROVAL_EMAIL:'owner@example.com',
 MARKETING_EMAIL_VERIFIED_WORST_MICROS:'4000',MARKETING_EMAIL_VERIFIED_PRICE_SOURCE:'resend-billing-verified-2026',
 MARKETING_EMAIL_PRICE_OWNER_VERIFIED:'true'}
let queries=0,permissionChecks=0,providerAllowed=true,sqlRows=[]
const now=new Date()
const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',hour:'numeric',hourCycle:'h23'}).format(now)
// Select a genuine IANA timezone currently inside 9:00–20:00 local.
const tz=['Pacific/Auckland','Asia/Tokyo','Europe/London','America/New_York','America/Los_Angeles',
 'Pacific/Honolulu','Asia/Dubai','America/Chicago'].find(t=>{
 const h=Number(new Intl.DateTimeFormat('en-US',{timeZone:t,hour:'numeric',hourCycle:'h23'}).format(now))
 return h>=9&&h<20
})
if(!tz)throw Error('Test clock has no allowed timezone')
const emailRow={subscriber_id:UUID,email:'user@example.com',resend_contact_id:'contact_123456789',
 channel:'email',campaign_state:'reviewed',campaign_version:2,subject:'New from KVRN',body:'Hello <friend> & family',
 snapshot_version:2,plan_state:'staged',approval_state:'approved',approval_expires:new Date(now.valueOf()+3600000).toISOString(),
 approval_campaign_id:UUID,approval_version:2,recent_attempts:0,affirmative_consent:true,consent_revoked:false,
 contact_status:'subscribed',unsubscribed_at:null}
const SQL=[]
const sql=async(strings,...args)=>{
 queries++;SQL.push({template:strings.join('?'),args})
 return strings.join('?').includes('kvrn_marketing_record_email_recipient_evidence')?
 [{evidence_id:UUID}]:sqlRows
}
const hash='a'.repeat(64)
const deps={
 '@/lib/db':{sql},
 './marketing-owner-approval':{isConfiguredMarketingOwner:(a,b)=>a===b},
 './marketing-provider-permission':{verifyMarketingProviderPermission:async(channel,email,contact)=>{
   permissionChecks++;assert.equal(channel,'email');assert.equal(email,emailRow.email)
   assert.equal(contact,emailRow.resend_contact_id);return providerAllowed}},
 './marketing-unsubscribe':{signMarketingUnsubscribe:async()=>`v1.${UUID}.${'b'.repeat(43)}`},
 './marketing-claimed-provider-transport':{hashFinalApprovedCopy:async(body,channel,subject)=>{
  assert.equal(channel,'email');assert.equal(subject,emailRow.subject)
  assert.match(body,/Hello &lt;friend&gt; &amp; family/)
  assert.match(body,/email-preferences\?token=v1\./);return hash}},
}
const raw=readFileSync('lib/marketing-email-recipient-evidence.ts','utf8')
const js=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
const mod={exports:{}}
vm.runInNewContext(js,{module:mod,exports:mod.exports,process:{env},require:n=>{
 if(!(n in deps))throw Error('Unexpected import '+n);return deps[n]
},crypto:webcrypto,TextEncoder,Uint8Array,Intl,Date,Number,String,RegExp,Object,Array,Error,Promise,console})
const f=mod.exports
const payload={planId:UUID,memberId:1,approvalId:UUID,recipientTimezone:tz,
 jurisdictionEvidenceRef:'owner-reviewed-region-2026',confirmLegalReview:true}
let n=0;const t=async(label,fn)=>{await fn();n++;console.log('PASS',label)}
await t('feature disabled with zero database or provider calls',async()=>{
 assert.equal(f.validRecipientEvidenceReview(payload),true)
 await assert.rejects(f.recordReviewedEmailRecipientEvidence(payload,'owner@example.com'),/EVIDENCE_DISABLED/)
 assert.equal(queries,0);assert.equal(permissionChecks,0)
})
await t('owner and explicit legal evidence required before reading subscriber',async()=>{
 env.MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED='true'
 await assert.rejects(f.recordReviewedEmailRecipientEvidence(payload,'bad@example.com'),/OWNER_REQUIRED/)
 assert.equal(f.validRecipientEvidenceReview({...payload,confirmLegalReview:false}),false)
 assert.equal(f.validRecipientEvidenceReview({...payload,email:'override@example.com'}),false)
 assert.equal(f.validRecipientEvidenceReview({...payload,recipientTimezone:'invalid/place'}),false)
 assert.equal(f.validRecipientEvidenceReview({...payload,memberId:0}),false)
 assert.equal(queries,0)
})
await t('worst case pricing source is verified server-side, never from browser JSON',async()=>{
 delete env.MARKETING_EMAIL_PRICE_OWNER_VERIFIED
 await assert.rejects(f.recordReviewedEmailRecipientEvidence(payload,'owner@example.com'),/PRICE_UNVERIFIED/)
 env.MARKETING_EMAIL_PRICE_OWNER_VERIFIED='true'
 assert.equal(queries,0)
})
await t('fresh Resend permission is mandatory even with local affirmative consent',async()=>{
 sqlRows=[emailRow];providerAllowed=false
 await assert.rejects(f.recordReviewedEmailRecipientEvidence(payload,'owner@example.com'),/PROVIDER_UNVERIFIED/)
 assert.equal(queries,1);assert.equal(permissionChecks,1)
})
await t('revoked consent and recent attempts fail before provider API',async()=>{
 for(const field of [{consent_revoked:true},{recent_attempts:1},{contact_status:'unsubscribed'},{approval_state:'revoked'},{body:''}]){
  sqlRows=[{...emailRow,...field}];const prior=permissionChecks
  await assert.rejects(f.recordReviewedEmailRecipientEvidence(payload,'owner@example.com'),/INTEGRITY_OR_CONSENT/)
  assert.equal(permissionChecks,prior)
 }
})
await t('reviewed final email HTML and source proofs persisted with no raw email',async()=>{
 sqlRows=[emailRow];providerAllowed=true;SQL.length=0
 const ret=await f.recordReviewedEmailRecipientEvidence(payload,'owner@example.com')
 assert.equal(ret.evidenceId,UUID);assert.equal(ret.messageSha256,hash);assert.equal(ret.canSend,false)
 assert.equal(SQL.length,2);assert.match(SQL[1].template,/kvrn_marketing_record_email_recipient_evidence/)
 assert.equal(SQL[1].args[1],1)
 assert.equal(SQL[1].args[8],hash)
 assert.equal(SQL[1].args[9],tz)
 assert.equal(SQL[1].args[10],4000)
 for(const v of SQL[1].args)assert.notEqual(v,emailRow.email)
 for(const idx of [3,4,5,6,7])assert.match(SQL[1].args[idx],/^[0-9a-f]{64}$/)
})
await t('Admin can list plan members with no contact PII and with evidence status',async()=>{
 const planRow={member_id:'1',approval_id:UUID,approval_state:'approved',
  approval_expires:new Date(Date.now()+3600000).toISOString(),budget_id:UUID,budget_state:'reserved',
  evidence_id:UUID,approved_message:hash,evidence_expires:new Date(Date.now()+120000).toISOString(),
  attempted:false,local_consent:true,campaign_state:'reviewed',plan_state:'staged',
  current_version:2,frozen_version:2,dispatch_enabled:true}
 sqlRows=[planRow]
 const before=queries
 const items=await f.listReviewedEmailAudience(UUID,'owner@example.com')
 assert.equal(queries,before+1);assert.equal(items.length,1)
 assert.equal(items[0].memberId,1);assert.equal(items[0].hasCurrentEvidence,true)
 assert.equal(items[0].readyForOwnerReview,true);assert.equal(items[0].canSend,false)
 assert.equal(items[0].claimKey,`email:${UUID}:1`)
 assert.equal(items[0].messageSha256,hash)
 assert.doesNotMatch(JSON.stringify(items),/user@example|contact_123456789|subscriber_id/)
 sqlRows=[{...planRow,attempted:true}]
 assert.equal((await f.listReviewedEmailAudience(UUID,'owner@example.com'))[0].readyForOwnerReview,false)
 const was=queries
 await assert.rejects(f.listReviewedEmailAudience(UUID,'not-owner@example.com'),/OWNER_OR_PLAN/)
 assert.equal(queries,was)
})
const migration=readFileSync('db/migrations/064_marketing_email_recipient_evidence.sql','utf8')
const claim=readFileSync('db/migrations/058_marketing_at_most_once_claim.sql','utf8')
const route=readFileSync('app/api/admin/marketing/recipient-evidence/route.ts','utf8')
await t('DB evidence writer rechecks exact campaign approval, budget, consent and frequency',async()=>{
 for(const c of ['v_campaign.version<>v_snapshot.campaign_version','v_approval.owner_identity_sha256<>p_owner_sha256',
 'marketing_email_consent_events','MARKETING_EVIDENCE_FREQUENCY_BLOCK',
 'marketing_budget_reservations','dispatch_enabled=true','MARKETING_EVIDENCE_QUIET_HOURS',
 'marketing_recipient_delivery_evidence(','INTERVAL \'4 minutes\''])assert.ok(migration.includes(c),c)
})
await t('recipient-specific approved hashes do not block multi-contact campaigns',async()=>{
 assert.match(claim,/v_evidence\.approved_message_sha256<>p_message_sha256/)
 const block=claim.split('SELECT COUNT(ev.id)::integer')[1].split('IF v_evidenced_members')[0]
 assert.doesNotMatch(block,/ev\.approved_message_sha256=p_message_sha256/)
})
await t('owner-only API does not expose subscriber contact, send, or mutate subscription',async()=>{
 for(const c of ['requireAdmin(req)','readAdminMutationJson(req,1200)','isConfiguredMarketingOwner(identity.email','recordReviewedEmailRecipientEvidence(','listReviewedEmailAudience('])
  assert.ok(route.includes(c),c)
 assert.doesNotMatch(route,/\.send\(|twilio|customer_email|resend_contact_id|unsubscribeUrl/)
})
console.log(`${n}/${n} email recipient evidence tests passed. No real provider connections or messages.`)
