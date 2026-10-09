import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const req=createRequire(import.meta.url)
let ts;try{ts=req('typescript')}catch{ts=req('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const src=readFileSync('lib/marketing-plan-audit.ts','utf8')
const route=readFileSync('app/api/admin/marketing/readiness/route.ts','utf8')
const ui=readFileSync('app/admin/marketing/MarketingClient.tsx','utf8')
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const id='b4a11c91-29a8-4a03-87d8-925cfe9bb5c8'
let db=0,count=2
const summary={plan_state:'staged',channel:'sms',snapshot_version:4,campaign_version:4,campaign_state:'reviewed',staged_members:2,
 approval_state:'approved',approval_version:4,approval_count:2,approval_expires:'2030-10-08T23:00:00.000Z',budget_dispatch_enabled:false}
const sql=async()=>{db++;return db%2?[summary]:[{n:count}]}
const exp={}
vm.runInNewContext(js,{exports:exp,Date,Error,Object,Number,Array,process:{env:{}},require(name){
 if(name==='@/lib/db')return {sql}
 if(name==='./marketing-audience-preview')return {validateAudiencePreviewId:(v)=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v)}
 throw Error('unexpected dependency '+name)
}})
const now=new Date('2026-10-08T21:00:00Z')
const valid={planState:'staged',channel:'sms',snapshotVersion:4,campaignVersion:4,campaignState:'reviewed',
 stagedMembers:2,approvalState:'approved',approvalVersion:4,approvalCount:2,
 approvalExpires:'2026-10-08T22:00:00.000Z',budgetDispatchEnabled:true,locallyVerifiedCount:2,providerReady:true}
const evaluate=(override={})=>exp.summarizeMarketingPlanEvidence(id,{...valid,...override},now)
const check=(r,label)=>r.checks.find(c=>c.id===label)
let n=0
async function test(name,fn){await fn();console.log('PASS',name);n++}
await test('returns count-only audit, never approval to send',async()=>{const v=evaluate();assert.equal(v.recipientCount,2);assert.equal(v.canSend,false);assert.equal(v.locallyVerifiedCount,2);assert.ok(v.checks.length>=10)})
await test('disallows cancelled plans',async()=>assert.equal(check(evaluate({planState:'cancelled'}),'staging').passed,false))
await test('disallows stale copy/version mismatch',async()=>assert.equal(check(evaluate({campaignVersion:5}),'reviewed_copy').passed,false))
await test('disallows revoked and expired owner approval',async()=>{for(const state of ['revoked',null])assert.equal(check(evaluate({approvalState:state}),'owner_approval').passed,false);assert.equal(check(evaluate({approvalExpires:'2020-01-01T00:00:00Z'}),'owner_approval').passed,false)})
await test('disallows recipient count exceeding approval',async()=>assert.equal(check(evaluate({approvalCount:1}),'owner_approval').passed,false))
await test('disallows revoked consent mismatch',async()=>assert.equal(check(evaluate({locallyVerifiedCount:1}),'local_consent').passed,false))
await test('disallows database marketing switch off',async()=>assert.equal(check(evaluate({budgetDispatchEnabled:false}),'database_dispatch_policy').passed,false))
await test('disallows provider flag unknown',async()=>assert.equal(check(evaluate({providerReady:false}),'provider_registration').passed,false))
await test('missing per-recipient legal windows, provider suppression and price always block',async()=>{const r=evaluate();for(const id of ['recipient_delivery_windows','provider_contact_suppression','verified_price_and_atomic_budget','recipient_frequency','network_idempotency'])assert.equal(check(r,id).passed,false)})
await test('corrupt count or timestamp fails closed',async()=>{assert.throws(()=>evaluate({stagedMembers:51}),/PLAN_AUDIT_INTEGRITY/);assert.throws(()=>evaluate({locallyVerifiedCount:NaN}),/PLAN_AUDIT_INTEGRITY/)})
await test('DB-backed audit queries local evidence without reading customer PII fields',async()=>{db=0;summary.approval_expires='2030-10-08T23:00:00Z';const r=await exp.auditStagedMarketingPlan(id);assert.equal(db,2);assert.equal(r.canSend,false);assert.equal(r.recipientCount,2);for(const q of [...src.matchAll(/sql`([^`]+)`/g)].map(x=>x[1]))assert.doesNotMatch(q,/\.email\b|\.phone_e164\b|shipping_address|customer_name/i)})
await test('API Admin auth, no cache and no POST, UI release audit only',async()=>{assert.match(route,/requireAdmin/);assert.match(route,/Cache-Control':'private, no-store/);assert.doesNotMatch(route,/export async function POST/);assert.match(ui,/Audit consent and release blockers/);assert.match(ui,/cannot authorize dispatch/)})
console.log(`${n}/${n} marketing staged-plan release audit checks passed`)
