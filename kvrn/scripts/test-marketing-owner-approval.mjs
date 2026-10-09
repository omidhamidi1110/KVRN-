import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const raw=readFileSync('lib/marketing-owner-approval.ts','utf8')
const sqlRaw=readFileSync('db/migrations/052_marketing_owner_approval.sql','utf8')
const route=readFileSync('app/api/admin/marketing/owner-approvals/route.ts','utf8')
const compiled=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const env={MARKETING_OWNER_APPROVAL_WRITES_ENABLED:'false',MARKETING_OWNER_APPROVAL_EMAIL:'owner@example.com'}
const calls=[]
const sql=async()=>{calls.push(1);return [{id:'fb9e6c5b-9a3a-4ad9-a660-d58c44db398c'}]}
const exports={}
vm.runInNewContext(compiled,{exports,process:{env},crypto:globalThis.crypto,TextEncoder,Uint8Array,Number,String,RegExp,Date,Array,Object,Error,require(name){if(name==='@/lib/db')return {sql};throw Error(name)}})
const item={planId:'fb9e6c5b-9a3a-4ad9-a660-d58c44db398c',requestKey:'owner-approval-0001',maximumCostMicros:10000}
let total=0
const test=async(name,cb)=>{await cb();total++;console.log('PASS',name)}
await test('default-off approval cannot touch DB',async()=>{await assert.rejects(exports.recordOwnerApproval(item,'owner@example.com'),/OWNER_APPROVAL_DISABLED/);assert.equal(calls.length,0)})
await test('only exact configured owner allowed',async()=>{
 assert.equal(exports.isConfiguredMarketingOwner('OWNER@example.com','owner@example.com'),true)
 assert.equal(exports.isConfiguredMarketingOwner('other@example.com','owner@example.com'),false)
 assert.equal(exports.isConfiguredMarketingOwner('owner@example.com',''),false)
})
await test('strict budget and input validation',async()=>{
 for(const amount of [0,2000001,-1,1.25,NaN])assert.equal(exports.validateOwnerApprovalInput({...item,maximumCostMicros:amount}),false)
 assert.equal(exports.validateOwnerApprovalInput({...item,unused:'x'}),false)
})
await test('enabled owner-only records a bounded approval',async()=>{
 env.MARKETING_OWNER_APPROVAL_WRITES_ENABLED='true';await assert.rejects(exports.recordOwnerApproval(item,'other@example.com'),/OWNER_IDENTITY_UNVERIFIED/)
 assert.equal(await exports.recordOwnerApproval(item,'owner@example.com'),item.planId);assert.equal(calls.length,1)
})
await test('owner revocation is authenticated and fails closed',async()=>{
 await assert.rejects(exports.revokeOwnerApproval(item.planId,'other@example.com'),/OWNER_IDENTITY_UNVERIFIED/)
 await assert.rejects(exports.revokeOwnerApproval('bad','owner@example.com'),/OWNER_APPROVAL_BAD_REQUEST/)
})
await test('DB approval binds immutable campaign version and 50-person limit',async()=>{
 assert.match(sqlRaw,/v_campaign\.version<>v_snap\.campaign_version/)
 assert.match(sqlRaw,/v_count<1 OR v_count>50/)
 assert.match(sqlRaw,/maximum_cost_micros BETWEEN 1 AND 2000000/)
})
await test('DB approval expires in one hour, revocation audited',async()=>{
 assert.match(sqlRaw,/NOW\(\)\+INTERVAL '1 hour'/);assert.match(sqlRaw,/marketing_owner_approval_audit/)
 assert.match(sqlRaw,/OWNER_APPROVAL_AUDIT_APPEND_ONLY/)
})
await test('no send worker, provider calls or auto dispatch',async()=>{
 assert.doesNotMatch(sqlRaw,/api\.twilio\.com|api\.resend\.com|pg_cron|send_message\(/i)
 assert.doesNotMatch(route,/\bfetch\(|sendSms|sendEmail|setTimeout/)
 assert.match(route,/canSend:false/)
})
await test('route requires verified Admin, distinct owner and bounded same-origin JSON',async()=>{
 assert.match(route,/requireAdmin\(req\)/);assert.match(route,/isConfiguredMarketingOwner/)
 assert.match(route,/readAdminMutationJson\(req,1024\)/)
})
await test('SQL prevents replay after revocation or expiry',async()=>{
 assert.match(sqlRaw,/v_existing\.state='approved'/);assert.match(sqlRaw,/v_existing\.expires_at>NOW\(\)/)
})
console.log(`${total}/${total} offline owner approval tests passed`)
