import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const file=readFileSync('lib/marketing-attempt-audit.ts','utf8')
const tsSrc=ts.transpileModule(file.replace(/^import .*\n/gm,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
const exports={}
const fn=new Function('exports','require',tsSrc+'\nreturn exports.summarizeDeliveryAttempts;')
const summarize=fn(exports,()=>{throw Error('No runtime imports allowed')})
let count=0
function test(label,callback){callback();console.log('PASS',label);count++}
test('nothing claimed is not proof of consent to send',()=>{let r=summarize({staged:10,claimed:0,accepted:0,rejected:0});assert.equal(r.unclaimed,10);assert.equal(r.canRetry,false);assert.equal(r.billingReconciled,false)})
test('unknown attempt remains permanently non-retryable',()=>{const r=summarize({staged:3,claimed:2,accepted:1,rejected:0});assert.equal(r.unknown,1);assert.equal(r.canRetry,false);assert.equal(r.requiresOwnerReview,true)})
test('verified provider rejection is not budget release',()=>{const r=summarize({staged:1,claimed:1,accepted:0,rejected:1});assert.equal(r.verifiedNotSubmitted,1);assert.equal(r.billingReconciled,false)})
test('accepted is not delivered',()=>assert.match(summarize({staged:1,claimed:1,accepted:1,rejected:0}).warnings.join(' '),/not delivered/))
test('integer overcount fails closed',()=>{for(const x of [{staged:1,claimed:2,accepted:0,rejected:0},{staged:2,claimed:1,accepted:1,rejected:1},{staged:51,claimed:0,accepted:0,rejected:0},{staged:1,claimed:1,accepted:-1,rejected:0},{staged:'1',claimed:1,accepted:0,rejected:0}])assert.throws(()=>summarize(x),/INTEGRITY/)})
test('summary stays private and bounded',()=>{const r=summarize({staged:50,claimed:50,accepted:10,rejected:20});assert.equal(r.unknown,20);assert.equal(r.unclaimed,0);assert.deepEqual(Object.keys(r).sort(),['billingReconciled','canRetry','claimed','providerAccepted','requiresOwnerReview','staged','unknown','unclaimed','verifiedNotSubmitted','warnings'].sort())})
test('database query is counts-only, fixed, bound plan identifier',()=>{assert.match(file,/COUNT\(\*\)::int/);assert.match(file,/\$\{planId\}::uuid/);assert.doesNotMatch(file,/SELECT\s+\*|customer_email|phone_number|\bemail_address\b/i)})
test('Admin API uses authentication and GET only',()=>{const api=readFileSync('app/api/admin/marketing/delivery-attempts/route.ts','utf8');assert.match(api,/requireAdmin\(req\)/);assert.match(api,/private, no-store/);assert.doesNotMatch(api,/export async function (POST|PATCH|PUT|DELETE)/)})
console.log(`${count}/${count} marketing attempt recovery checks passed`)
