import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const source=readFileSync('lib/ai/affiliate-integrity-insight.ts','utf8')
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const row={affiliate_count:'3',active_affiliate_count:'2',commission_count:'7',pending_commission_count:'2',approved_commission_count:'3',paid_commission_count:'1',reversed_commission_count:'1',incomplete_commission_count:'0',draft_payout_count:'1',paid_payout_count:'1',inconsistent_payout_count:'0',recorded_paid_payout_cents:'12000'}
let result=[row],queryCount=0
const out={}
vm.runInNewContext(js,{exports:out,Number,String,Object,Error,Promise,require(n){if(n==='@/lib/db')return{sql:async(parts,...args)=>{queryCount++;assert.equal(args.length,0);assert.match(parts.join(''),/CROSS JOIN/);return result}};throw Error('unknown import '+n)}})
let passed=0
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
await test('count and monetary snapshots can be verified when complete',()=>{const v=out.interpretAffiliateIntegrityRow(row);assert.equal(v.commissionCount,7);assert.equal(v.recordedPaidPayoutCents,12000);assert.equal(v.integrityVerified,true)})
await test('status bucket inconsistencies fail closed',()=>assert.throws(()=>out.interpretAffiliateIntegrityRow({...row,pending_commission_count:'3'}),/INCONSISTENT/))
await test('incomplete commissions are not a green all-clear',()=>{const v=out.interpretAffiliateIntegrityRow({...row,incomplete_commission_count:'1'});assert.equal(v.integrityVerified,false)})
await test('mismatched payout lines make monetary totals unknown',()=>{const v=out.interpretAffiliateIntegrityRow({...row,inconsistent_payout_count:'1'});assert.equal(v.recordedPaidPayoutCents,null);assert.equal(v.integrityVerified,false)})
await test('cannot claim payout amount if no paid payouts',()=>assert.throws(()=>out.interpretAffiliateIntegrityRow({...row,paid_payout_count:'0',recorded_paid_payout_cents:'12000'}),/INCONSISTENT/))
await test('invalid and overflowing amounts are rejected',()=>{for(const n of ['-1','2.1','oops',null,'90071992547409930'])assert.throws(()=>out.interpretAffiliateIntegrityRow({...row,recorded_paid_payout_cents:n}))})
await test('active affiliate count cannot exceed total',()=>assert.throws(()=>out.interpretAffiliateIntegrityRow({...row,active_affiliate_count:'4'}),/INCONSISTENT/))
await test('incomplete count cannot exceed all commissions',()=>assert.throws(()=>out.interpretAffiliateIntegrityRow({...row,incomplete_commission_count:'8'}),/INCONSISTENT/))
await test('one PII-free and read-only SQL aggregate',async()=>{const before=queryCount;const v=await out.getAffiliateIntegritySummary();assert.equal(v.affiliateCount,3);assert.equal(queryCount,before+1);assert.doesNotMatch(source,/\bUPDATE\b|\bDELETE\b|\bINSERT\b|fetch\(|affiliate_portal_balances\s*\(/i);assert.match(source,/FROM affiliate_payouts pay/);assert.match(source,/FROM affiliate_payout_lines l/);assert.doesNotMatch(source,/SELECT\s+\*\s+FROM\s+affiliates/i)})
await test('lost schema cannot masquerade as empty',async()=>{result=[];await assert.rejects(out.getAffiliateIntegritySummary(),/SCHEMA_UNAVAILABLE/);result=[row]})
console.log(`${passed}/${passed} private affiliate integrity checks passed`)
