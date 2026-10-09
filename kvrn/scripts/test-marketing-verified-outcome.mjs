import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const code=readFileSync('lib/marketing-verified-outcome.ts','utf8')
const source=ts.transpileModule(code.replace(/^import .*\n/gm,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
const validator=new Function('exports','require',source+'\nreturn exports.validateVerifiedAttemptOutcome;')({},()=>{throw Error('No runtime imports allowed')})
const sql=readFileSync('db/migrations/059_marketing_outcome_reconciliation.sql','utf8')
const input={attemptId:'22222222-2222-4222-8222-222222222222',outcome:'provider_accepted',verificationSource:'provider_final_status',providerReferenceSha256:'a'.repeat(64),providerAuthenticationVerified:true,attemptMessageCorrelationVerified:true}
let n=0;function test(label,fn){fn();n++;console.log('PASS',label)}
test('only exact authenticated correlated evidence is accepted',()=>{assert.equal(validator(input),true);assert.equal(validator({...input,attemptMessageCorrelationVerified:false}),false);assert.equal(validator({...input,providerAuthenticationVerified:false}),false)})
test('wrong proof source cannot claim definitively unsent',()=>assert.equal(validator({...input,outcome:'verified_not_submitted'}),false))
test('verified rejection is distinct from received outcome',()=>assert.equal(validator({...input,outcome:'verified_not_submitted',verificationSource:'verified_provider_rejection'}),true))
test('unexpected keys and invalid digests rejected',()=>{assert.equal(validator({...input,recipient:'foo'}),false);assert.equal(validator({...input,providerReferenceSha256:'5'}),false)})
test('gate defaults off and route is not exposed',()=>{assert.match(code,/MARKETING_PROVIDER_OUTCOME_RECONCILIATION_ENABLED!=='true'/);assert.doesNotMatch(code,/fetch\(|sendSms\(|\.send\(/)})
test('SQL requires exact bound attempt and locks in budget then plan order',()=>{assert.match(sql,/WHERE id=p_attempt FOR SHARE/);assert.match(sql,/pg_advisory_xact_lock\(48112026046::bigint\)/);assert.match(sql,/pg_advisory_xact_lock\(48112026050::bigint\)/);assert.ok(sql.indexOf('48112026046')<sql.indexOf('48112026050'))})
test('SQL returns idempotently only matching evidence and rejects proof replay',()=>{assert.match(sql,/v_existing\.outcome=p_outcome/);assert.match(sql,/v_existing\.provider_reference_sha256=p_provider_reference_sha256/);assert.match(sql,/MARKETING_OUTCOME_PROVIDER_PROOF_REUSED/);assert.match(sql,/MARKETING_OUTCOME_CONFLICT_NO_RETRY/)})
test('outcome insertion does not settle cost or enable retry',()=>{assert.doesNotMatch(sql.replace(/^--.*$/gm,''),/(?:UPDATE|DELETE FROM)\s+marketing_budget_reservations/i);assert.doesNotMatch(sql,/https?:\/\/|http_post|sendSms\(|sendEmail\(/i)})
console.log(`${n}/${n} provider-outcome ledger checks passed`)
