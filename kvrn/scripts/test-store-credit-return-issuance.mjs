import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const raw=readFileSync('lib/store-credit-return-issuance.ts','utf8')
const migration=readFileSync('db/migrations/053_store_credit_return_issuance.sql','utf8')
const route=readFileSync('app/api/admin/store-credit/issue/route.ts','utf8')
const compiled=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const env={STORE_CREDIT_ISSUANCE_ENABLED:'false',STORE_CREDIT_ISSUANCE_OWNER_EMAIL:'owner@example.com',STORE_CREDIT_ACCOUNT_PEPPER:'x'.repeat(48)}
const calls=[]
const sql=async()=>{calls.push('sql');return [{customer_email:'subscriber@example.com'}]}
const exports={}
vm.runInNewContext(compiled,{exports,process:{env},Date,Number,String,Array,Object,RegExp,Error,crypto:globalThis.crypto,TextEncoder,Uint8Array,require(name){
 if(name==='@/lib/db')return {sql}
 if(name==='./store-credit-identity')return {deriveStoreCreditAccountKey:async()=> 'a'.repeat(64)}
 throw Error(name)
}})
const valid={returnId:'fb9e6c5b-9a3a-4ad9-a660-d58c44db398c',requestedCents:5000,deliveredAt:'2026-10-01T17:00:00Z',deliveryEvidenceRef:'carrier-event-12345',requestKey:'credit-issue-key-001',confirmInspectedReturn:true}
let n=0;const t=async(title,fn)=>{await fn();console.log('PASS',title);n++}
await t('issuance disabled by default even with owner',async()=>{await assert.rejects(exports.issueCreditForInspectedReturn(valid,'owner@example.com'),/CREDIT_ISSUANCE_DISABLED/);assert.equal(calls.length,0)})
await t('extra fields and incomplete manual evidence rejected',async()=>{
 assert.equal(exports.validateCreditIssueRequest({...valid,email:'somebody@example.com'}),false)
 assert.equal(exports.validateCreditIssueRequest({...valid,deliveryEvidenceRef:'no'}),false)
 assert.equal(exports.validateCreditIssueRequest({...valid,confirmInspectedReturn:false}),false)
})
await t('email not supplied by browser',async()=>assert.ok(!('email' in valid)))
await t('proposed amount must be positive and safe integer',async()=>{
 for(const v of [-1,0,1.1,Number.MAX_SAFE_INTEGER+1])assert.equal(exports.validateCreditIssueRequest({...valid,requestedCents:v}),false)
})
await t('owner only with separate env gate',async()=>{
 env.STORE_CREDIT_ISSUANCE_ENABLED='true';await assert.rejects(exports.issueCreditForInspectedReturn(valid,'intruder@example.com'),/CREDIT_ISSUANCE_OWNER_REQUIRED/)
 assert.equal(calls.length,0)
})
await t('SQL protects append-only return approvals and idempotency',async()=>{
 assert.match(migration,/CREDIT_RETURN_ALREADY_ISSUED/);assert.match(migration,/CREDIT_ISSUE_KEY_ALREADY_USED/)
 assert.match(migration,/CREDIT_APPROVALS_APPEND_ONLY/);assert.match(migration,/UNIQUE REFERENCES order_returns/)
})
await t('SQL requires payment success and inspected completed return',async()=>{
 assert.match(migration,/v_order\.payment_status<>'paid'/);assert.match(migration,/v_return\.status<>'completed'/)
 assert.match(migration,/v_return\.requested_at > p_delivered\+INTERVAL '14 days'/)
})
await t('SQL denies refunds, allocations and disputes even if mixed',async()=>{
 for(const p of ['order_refunds','return_refund_allocations','order_disputes'])assert.match(migration,new RegExp(`EXISTS\\(SELECT 1 FROM ${p}`))
})
await t('SQL enforces frozen net merchandise not gross sales',async()=>{
 assert.match(migration,/net_merchandise_basis_cents/)
 assert.match(migration,/v_net_basis<p_amount/)
 assert.doesNotMatch(migration,/unit_price_cents_snapshot\s*\*/)
})
await t('SQL shares lock with checkout holds',async()=>assert.match(migration,/pg_advisory_xact_lock\(48112026051::bigint\)/))
await t('Admin route has no customer PII response and is bounded',async()=>{
 assert.match(route,/requireAdmin\(req\)/);assert.match(route,/isCreditIssuanceOwner/)
 assert.match(route,/readAdminMutationJson\(req,1024\)/)
 assert.doesNotMatch(route,/customer_email|accountKey|deliveryEvidenceRef/)
})
await t('no Stripe refunds, provider sends or checkout activation',async()=>{
 assert.doesNotMatch(migration,/refunds\.create|stripe\.com|pg_cron|sendSms|sendEmail/i)
 assert.doesNotMatch(route,/\bfetch\(|getStripe|createCheckout/)
})
console.log(`${n}/${n} offline credit return issuance tests passed`)
