import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const src=readFileSync('lib/marketing-budget-status.ts','utf8')
const fnBody=ts.transpileModule(src.replace(/^import .*\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const e={};const interpret=new Function('exports',fnBody+'\nreturn exports.interpretBudgetFacts;')(e)
const sample={dispatchEnabled:false,dailyCapSms:'3000000',monthlyCapSms:'15000000',dailyCapEmail:'2000000',monthlyCapEmail:'10000000',aiMonthlyCapSms:'5000000',smsToday:'0',smsMonth:'0',emailToday:'0',emailMonth:'0',aiSmsMonth:'0',smsPending:0,emailPending:0,smsOldestHours:null,emailOldestHours:null}
let n=0;function test(label,fn){fn();n++;console.log('PASS',label)}
test('empty legitimate ledger returns zero and never authorizes sending',()=>{const x=interpret(sample,new Date());assert.equal(x.lines[0].dailyCommittedMicros,0);assert.equal(x.sendAuthorized,false);assert.equal(x.dispatchEnabled,false)})
test('reserved costs reduce available budgets',()=>{const x=interpret({...sample,smsToday:'1500000',smsMonth:'4500000'},new Date());assert.equal(x.lines[0].remainingDailyMicros,1500000);assert.equal(x.lines[0].remainingMonthlyMicros,10500000)})
test('crossing cap reports exceeded, not free credit',()=>{const x=interpret({...sample,smsToday:'3000001',smsMonth:'3000001'},new Date());assert.equal(x.lines[0].status,'exceeded');assert.equal(x.lines[0].remainingDailyMicros,0)})
test('aged unresolved reservations require review',()=>{const x=interpret({...sample,emailPending:2,emailOldestHours:48},new Date());assert.equal(x.lines[1].status,'review_required');assert.equal(x.lines[1].unresolvedReservations,2)})
test('unknown reservation age is not a clean report',()=>{const x=interpret({...sample,smsPending:1,smsOldestHours:null},new Date());assert.equal(x.lines[0].status,'review_required')})
test('reject missing/non-numeric cost totals instead of zero',()=>{for(const p of [{smsMonth:null},{smsMonth:'NaN'},{smsToday:'-1'},{emailMonth:'9007199254740992'}])assert.throws(()=>interpret({...sample,...p},new Date()),/UNVERIFIED|UNSAFE/)})
test('reject attempts to exceed configured owner cap',()=>assert.throws(()=>interpret({...sample,dailyCapSms:'4000000'},new Date()),/INVALID_CAPS/))
test('AI budget is independent and bounded',()=>{const x=interpret({...sample,aiSmsMonth:'5500000'},new Date());assert.equal(x.aiSmsStatus,'exceeded');assert.equal(x.aiSmsRemainingMicros,0)})
test('SQL uses conservative settled actual vs fully reserved, no PII',()=>{assert.match(src,/WHEN state='reserved' THEN reserved_micros::numeric/);assert.match(src,/WHEN state='settled' THEN actual_micros::numeric/);assert.doesNotMatch(src,/customer_email|phone_number|JOIN\s+marketing_subscribers/i)})
test('route authenticated, read-only and no-cache',()=>{const s=readFileSync('app/api/admin/marketing/budget-status/route.ts','utf8');assert.match(s,/requireAdmin\(req\)/);assert.match(s,/private, no-store/);assert.doesNotMatch(s,/export async function (?:POST|PATCH|PUT|DELETE)/)})
console.log(`${n}/${n} marketing budget read-model checks passed`)
