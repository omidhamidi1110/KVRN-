import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const tsOpts={module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
const load=(src,exports,req)=>vm.runInNewContext(ts.transpileModule(readFileSync(src,'utf8'),{compilerOptions:tsOpts}).outputText,{exports,require:req,Set,Array,RegExp,Object,Number,String,Error})
const tokens={};load('lib/marketing-copy-template-tokens.ts',tokens,()=>{throw Error('No imports expected')})
const estimator={};load('lib/sms-segment-estimate.ts',estimator,()=>{throw Error('No imports expected')})
const e={};load('lib/marketing-message-composer.ts',e,n=>{
 if(n==='./sms-segment-estimate')return estimator
 if(n==='./marketing-copy-template-tokens')return tokens
 throw Error(n)
})
let n=0;function test(name,fn){fn();console.log('PASS',name);n++}
test('short SMS gets brand and explicit STOP footer',()=>{const v=e.composeMarketingSms('New drop');assert.equal(v.body,'KVRN: New drop Reply STOP to opt out.');assert.equal(v.validOneSegment,true);assert.equal(v.canSend,false)})
test('existing matching footer not duplicated',()=>{const v=e.composeMarketingSms('KVRN: Drop today. Reply STOP to opt out.');assert.equal(v.body.match(/Reply STOP/gi).length,1)})
test('unrelated STOP mention cannot evade required footer',()=>assert.match(e.composeMarketingSms('STOP by the store today').body,/Reply STOP to opt out\.$/))
test('final text, not raw draft, determines billed segments',()=>{const v=e.composeMarketingSms('x'.repeat(151));assert.equal(v.validOneSegment,false);assert.ok(v.estimate.segments>1);assert.ok(v.reasons.includes('sms_segment_limit'))})
test('unicode can lower per-segment capacity',()=>{const v=e.composeMarketingSms('🎃'.repeat(35));assert.equal(v.estimate.encoding,'UCS-2');assert.equal(v.validOneSegment,false)})
test('static brand tokens supported, unknown fields blocked',()=>{assert.match(e.composeMarketingSms('Visit {{site_url}}').body,/kvrn\.shop/);assert.ok(e.composeMarketingSms('Hello {{first_name}}').reasons.includes('unsupported_placeholder'))})
test('script and malformed data input cannot pass validation',()=>{for(const x of ['<img>','javascript:alert(1)','evil\ntext',null,''])assert.equal(e.composeMarketingSms(x).validOneSegment,false)})
test('does not send, create budget reservations, or use customer data',()=>{const src=readFileSync('lib/marketing-message-composer.ts','utf8');assert.doesNotMatch(src,/\bfetch\(|\bsql\b|sendSms|sendEmail|phone|email|customer_id|provider_status/);assert.match(src,/canSend:false/)})
console.log(`${n}/${n} SMS composition tests passed`)
