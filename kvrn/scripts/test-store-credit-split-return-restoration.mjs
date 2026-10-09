import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {webcrypto} from 'node:crypto'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const env={STORE_CREDIT_RETURN_RESTORE_ENABLED:'false',STRIPE_MODE:'test',STORE_CREDIT_ISSUANCE_OWNER_EMAIL:'owner@example.com'}
const SQL=[]
let databaseRows=[{event_id:'612'}]
const sql=async(strings,...args)=>{SQL.push({strings,args});return databaseRows}
const owner={isCreditIssuanceOwner:email=>email.toLowerCase()===env.STORE_CREDIT_ISSUANCE_OWNER_EMAIL,
 validateCreditIssueRequest(v){return !!v && typeof v==='object'&&!Array.isArray(v)&&
   Object.keys(v).sort().join(',')===['confirmInspectedReturn','deliveredAt','deliveryEvidenceRef','requestKey','requestedCents','returnId'].sort().join(',')&&
   v.confirmInspectedReturn===true&&Number.isSafeInteger(v.requestedCents)&&v.requestedCents>0&&
   /^[0-9a-f-]{36}$/.test(v.returnId)&&/^[A-Za-z0-9:_-]{12,120}$/.test(v.requestKey)&&
   typeof v.deliveryEvidenceRef==='string'&&v.deliveryEvidenceRef.length>=8&&
   typeof v.deliveredAt==='string'&&!Number.isNaN(Date.parse(v.deliveredAt))}
}
function load(src,deps){
 const code=ts.transpileModule(readFileSync(src,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
 const mod={exports:{}}
 vm.runInNewContext(code,{module:mod,exports:mod.exports,process:{env},require:key=>{
  if(!(key in deps))throw Error('Unexpected import '+key)
  return deps[key]
 },crypto:webcrypto,TextEncoder,Uint8Array,Date,Number,String,BigInt,RegExp,Object,Array,Error,Promise,console})
 return mod.exports
}
const impl=load('lib/store-credit-split-return-restoration.ts',{
 '@/lib/db':{sql},'./store-credit-return-issuance':owner})
const req={returnId:'fb9e6c5b-9a3a-4ad9-a660-d58c44db398c',requestedCents:500,
 deliveredAt:'2026-10-01T17:00:00Z',deliveryEvidenceRef:'carrier-ref-12345',
 requestKey:'restore-credit-001',confirmInspectedReturn:true}
let passed=0
async function check(name,fn){await fn();console.log('PASS',name);passed++}
await check('restore disabled by default and makes no database call',async()=>{
 await assert.rejects(impl.restoreOriginalCreditTenderForReturn(req,'owner@example.com'),/CREDIT_RESTORE_DISABLED/)
 assert.equal(SQL.length,0)
})
await check('cannot restore through live Stripe even when enabled',async()=>{
 env.STORE_CREDIT_RETURN_RESTORE_ENABLED='true';env.STRIPE_MODE='live'
 await assert.rejects(impl.restoreOriginalCreditTenderForReturn(req,'owner@example.com'),/CREDIT_RESTORE_DISABLED/)
 assert.equal(SQL.length,0);env.STRIPE_MODE='test'
})
await check('valid input cannot choose credit account, cash refund, or original captured amount',async()=>{
 assert.equal(impl.validateRestoreOriginalCreditRequest(req),true)
 for(const field of ['accountKey','email','cashRefundCents','capturedCreditCents']){
  assert.equal(impl.validateRestoreOriginalCreditRequest({...req,[field]:'bad'}),false)
 }
})
await check('owner verified before database call',async()=>{
 await assert.rejects(impl.restoreOriginalCreditTenderForReturn(req,'other@example.com'),/OWNER_REQUIRED/)
 assert.equal(SQL.length,0)
})
await check('invalid, negative or unsafe amounts rejected',async()=>{
 for(const v of [-1,0,5.2,2147483648,Number.MAX_SAFE_INTEGER+1]){
  assert.equal(impl.validateRestoreOriginalCreditRequest({...req,requestedCents:v}),false)
 }
 await assert.rejects(impl.restoreOriginalCreditTenderForReturn({...req,requestedCents:2147483648},'owner@example.com'),/INVALID_REQUEST/)
 assert.equal(SQL.length,0)
})
await check('owner-approved restoration uses hashed evidence and one SQL transaction',async()=>{
 assert.equal(await impl.restoreOriginalCreditTenderForReturn(req,'owner@example.com'),'612')
 assert.equal(SQL.length,1)
 const call=SQL[0]
 assert.match(call.strings.join('?'),/kvrn_credit_restore_original_tender_on_return/)
 assert.equal(call.args[0],req.returnId)
 assert.equal(call.args[1],500)
 assert.equal(call.args[2],req.deliveredAt)
 assert.match(call.args[3],/^[0-9a-f]{64}$/)
 assert.match(call.args[4],/^[0-9a-f]{64}$/)
 assert.ok(!call.args.includes(req.deliveryEvidenceRef))
 assert.equal(call.args[5],req.requestKey)
})
await check('invalid database proof fails closed, without exposing customer information',async()=>{
 databaseRows=[{event_id:'0'}]
 await assert.rejects(impl.restoreOriginalCreditTenderForReturn(req,'owner@example.com'),/RESULT_INVALID/)
 databaseRows=[{event_id:'612'}]
})
const route=readFileSync('app/api/admin/store-credit/restore/route.ts','utf8')
const sqlDraft=readFileSync('db/migrations/063_store_credit_split_tender_return_restoration.sql','utf8')
await check('Admin endpoint authenticates owner and validates bounded request',async()=>{
 for(const contract of ['requireAdmin(req)','isCreditIssuanceOwner(identity.email)','readAdminMutationJson(req,1024)','validateRestoreOriginalCreditRequest(payload.value)'])
  assert.ok(route.includes(contract),contract)
 assert.doesNotMatch(route,/customer_email|accountKey|deliveryEvidenceRef|stripe\.refunds|sendEmail/)
})
await check('SQL prevents duplicate return/tender issuance and preserves history',async()=>{
 for(const p of ['CREDIT_RESTORE_ALREADY_SETTLED','CREDIT_RESTORE_REPLAY_CONFLICT',
 'CREDIT_RESTORE_DUPLICATE_RETURN_UNITS','v_credit_issued+p_amount>v_proof.credit_captured_cents',
 'v_net_basis<p_amount+v_cash_merch','v_proof.cash_received_cents<>v_order.total_cents',
 "v_ret.status<>'completed'",'store_credit_ledger(account_id,event_type,amount_cents,idempotency_key,return_id)',
 'CREDIT_RESTORE_PROOF_APPEND_ONLY','pg_advisory_xact_lock(48112026051::bigint)',
 'return_refund_allocations','order_disputes'])
  assert.ok(sqlDraft.includes(p),p)
 assert.doesNotMatch(sqlDraft,/UPDATE\s+orders|DELETE\s+FROM\s+orders|stripe\.refunds\.create/i)
})
await check('all money and proof writes remain inside one SQL transaction',async()=>{
 assert.match(sqlDraft,/^BEGIN;\s/m)
 assert.match(sqlDraft,/COMMIT;\s*$/)
 assert.match(sqlDraft,/INSERT INTO store_credit_ledger\([^]*?INSERT INTO store_credit_split_return_restorations\(/)
})
console.log(`${passed}/${passed} store-credit return restoration tests passed; no database/provider connections.`)
