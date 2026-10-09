/** Offline negative tests for internal audience snapshots. Does not connect DB/provider. */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
const require=createRequire(import.meta.url)
const ts=require('typescript')
const responses=[]
const queries=[]
async function sql(parts,...params){queries.push(parts.join('?'));if(responses.length===0)throw Error('DB_MOCK_MISSING');return responses.shift()}
function load(file,mocks){
 const out=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
 const exports={}
 vm.runInNewContext(out.outputText,{exports,Date,RegExp,Number,Array,console,require(name){if(!(name in mocks))throw Error('unmocked dependency '+name);return mocks[name]}},{filename:file})
 return exports
}
const preview={validateAudiencePreviewId:(v)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(v)}
const api=load('lib/marketing-audience-snapshot.ts',{'@/lib/db':{sql},'@/lib/marketing-audience-preview':preview})
const validId='c33494b6-2a0f-4265-b510-9a63e3f9eabc'
let count=0
function test(label,fn){const result=fn();return Promise.resolve(result).then(()=>{console.log('PASS',label);count++})}
await test('snapshot request key only accepts bounded safe characters',()=>{
 for(const key of ['','short',';SELECT * FROM orders','a'.repeat(121),'abc def'.repeat(3),null])assert.equal(api.validSnapshotRequestKey(key),false)
 assert.equal(api.validSnapshotRequestKey('snap-2d68f7fa-f976-4d27-b886-176592dc5830'),true)
})
await test('invalid IDs and versions never touch database',async()=>{
 for(const v of [0,-1,1.5,2**32])await assert.rejects(()=>api.createPrivateAudienceSnapshot(validId,v,'valid-idempotent-key-001'),/INVALID_SNAPSHOT_INPUT/)
 await assert.rejects(()=>api.createPrivateAudienceSnapshot('bad',1,'valid-idempotent-key-001'),/INVALID_SNAPSHOT_INPUT/)
})
await test('database function generates private snapshot id without returning PII',async()=>{
 responses.push([{id:validId}]);queries.length=0
 const id=await api.createPrivateAudienceSnapshot(validId,2,'valid-idempotent-key-001')
 assert.equal(id,validId)
 assert.match(queries[0],/kvrn_marketing_prepare_snapshot/)
})
await test('invalid database snapshot results fail closed',async()=>{
 responses.push([{id:'not-a-uuid'}]);await assert.rejects(()=>api.createPrivateAudienceSnapshot(validId,2,'valid-idempotent-key-001'),/SNAPSHOT_CREATE_FAILED/)
})
await test('listing returns only aggregate metadata, no contacts',async()=>{
 queries.length=0
 responses.push([{id:validId,campaign_id:validId,campaign_version:2,channel:'sms',audience:'recent-opt-ins',member_count:6,created_at:'2026-10-08T18:00:00Z'}])
 const entries=await api.listPrivateAudienceSnapshots()
 assert.equal(entries.length,1)
 assert.equal(entries[0].memberCount,6)
 assert.equal(entries[0].sendPermitted,false)
 assert.equal(JSON.stringify(entries).includes('phone'),false)
 assert.match(queries[0],/COUNT\(\*\)/)
 assert.doesNotMatch(queries[0],/\bSELECT\s+email\b|\bSELECT\s+phone_e164\b/i)
})
await test('missing/corrupt counts do not become zero',async()=>{
 for(const v of [-1,51,null,Number.MAX_SAFE_INTEGER+100]){
  responses.push([{id:validId,member_count:v}])
  await assert.rejects(()=>api.listPrivateAudienceSnapshots(),/SNAPSHOT_COUNT_CORRUPT/)
 }
})
await test('migration has private FKs and channel-exclusive members',()=>{
 const source=readFileSync('db/migrations/049_marketing_private_audience_snapshots.sql','utf8')
 for(const expected of [/sms_subscriber_id uuid REFERENCES sms_subscribers/,/email_subscriber_id uuid REFERENCES marketing_subscribers/,/audience_exactly_one_channel/,/CREATE UNIQUE INDEX.*idx_ma_s_unique/,/CREATE UNIQUE INDEX.*idx_ma_e_unique/,/marketing_audience_member_immutable/])assert.match(source,expected)
 assert.match(source,/v_count<1 OR v_count>50/)
 assert.match(source,/AUDIENCE_SNAPSHOT_COUNT_BLOCKED/)
 assert.doesNotMatch(source,/\b(?:send_sms|send_email|twilio_api|resend_api)\(/i)
})
await test('snapshot membership is forbidden for legacy unsubscribed or unconfirmed SMS',()=>{
 const source=readFileSync('db/migrations/049_marketing_private_audience_snapshots.sql','utf8')
 for(const expected of [/s.status='subscribed'/,/s.unsubscribed_at IS NULL/,/twilio_opt_out_state='opted_in'/,/sms_keyword_consent_proofs/,/e.event_type='unsubscribed'/,/e.event_type='affirmative_checkbox'/])assert.match(source,expected)
})
await test('migration does not update snapshot after immutability triggers installed',()=>{
 const source=readFileSync('db/migrations/049_marketing_private_audience_snapshots.sql','utf8')
 assert.doesNotMatch(source,/UPDATE\s+marketing_audience_snapshots/i)
 assert.doesNotMatch(source,/member_count integer/)
})
await test('admin endpoint requires authentication, bounded JSON and no sends',()=>{
 const source=readFileSync('app/api/admin/marketing/audience-snapshots/route.ts','utf8')
 for(const expected of [/requireAdmin/,/readAdminMutationJson\(req,2000\)/,/sendingEnabled:false/,/Cache-Control/])assert.match(source,expected)
 assert.doesNotMatch(source,/sendCampaign|sendSms|sendEmail|stripe\.com|api\.twilio\.com|api\.resend\.com/)
})
console.log(`${count}/${count} private-audience snapshot safeguards passed; no DB/provider access`)
