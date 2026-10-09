import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const sqlText=readFileSync('db/migrations/054_marketing_budget_cost_reconciliation.sql','utf8')
const src=readFileSync('lib/marketing-cost-reconciliation.ts','utf8')
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const a='fb9e6c5b-9a3a-4ad9-a660-d58c44db398c',b='ff9e6c5b-9a3a-4ad9-a660-d58c44db398c'
const env={MARKETING_COST_RECONCILIATION_ENABLED:'false'}
const calls=[];const exports={};const sql=async()=>{calls.push(true);return [{state:'settled'}]}
vm.runInNewContext(js,{exports,process:{env},Number,String,RegExp,Error,require(x){if(x==='@/lib/db')return {sql};throw Error(x)}})
let n=0;const t=async(name,fn)=>{await fn();console.log('PASS',name);n++}
await t('disabled means no SQL',async()=>{await assert.rejects(exports.finalizeVerifiedMarketingCost(a,b),/DISABLED/);assert.equal(calls.length,0)})
await t('invalid IDs rejected before SQL',async()=>{env.MARKETING_COST_RECONCILIATION_ENABLED='true';await assert.rejects(exports.finalizeVerifiedMarketingCost('bad',b),/INVALID_REFERENCE/);assert.equal(calls.length,0)})
await t('valid referenced proof invokes one DB function',async()=>{assert.equal(await exports.finalizeVerifiedMarketingCost(a,b),'settled');assert.equal(calls.length,1)})
await t('budget reservations share serialization lock',async()=>assert.match(sqlText,/pg_advisory_xact_lock\(48112026046::bigint\)/))
await t('unknown provider outcome cannot become free release',async()=>{assert.match(sqlText,/outcome text NOT NULL CHECK\(outcome IN \('charged','definitely_not_sent'\)\)/);assert.doesNotMatch(sqlText,/outcome='unknown'/)})
await t('provider proof must be immutable, unique and channel specific',async()=>{assert.match(sqlText,/MARKETING_COST_EVIDENCE_APPEND_ONLY/);assert.match(sqlText,/provider_reference_sha256 text NOT NULL UNIQUE/);assert.match(sqlText,/MARKETING_COST_PROVIDER_CHANNEL_MISMATCH/)})
await t('actual cannot exceed reserved and unknown cannot settle',async()=>{assert.match(sqlText,/v_evidence\.actual_micros>v_res\.reserved_micros/);assert.match(sqlText,/outcome='charged' AND actual_micros IS NOT NULL/)})
await t('retry idempotent only on matching terminal state',async()=>assert.match(sqlText,/MARKETING_BUDGET_FINALIZATION_CONFLICT/))
await t('no sending or provider APIs',async()=>{assert.doesNotMatch(sqlText,/api\.twilio\.com|api\.resend\.com|pg_cron|sendSms/);assert.doesNotMatch(src,/\bfetch\(|sendSms|sendEmail/)})
console.log(`${n}/${n} offline marketing cost reconciliation tests passed`)
