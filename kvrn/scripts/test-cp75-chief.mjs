/** Offline CP75 guard: no network/database/paid inference. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
let ts
try { ts = require('typescript') } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript') }
let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('PASS', name) }
const files = ['lib/ai/chief-chat-policy.ts','lib/ai/chief-evidence.ts','app/api/admin/ai/chief/chat/route.ts','app/admin/ai/chief/ChiefChatClient.tsx']
for (const file of files) {
  const out = ts.transpileModule(readFileSync(file,'utf8'), { fileName:file, reportDiagnostics:true, compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.ReactJSX } })
  test(`Typescript syntax ${file}`, () => assert.equal(out.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).length,0))
}
const code=ts.transpileModule(readFileSync(files[0],'utf8'),{ compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS } }).outputText
const module={exports:{}}
vm.runInNewContext(code,{exports:module.exports,module},{filename:'chief-chat-policy.js'})
const {selectChiefChatTopics,classifyChiefChatRequest,validateChiefChatMessage}=module.exports
test('No match => operations brief',()=>assert.equal(classifyChiefChatRequest('hello there').topic,'operations-brief'))
test('QA-only question => QA',()=>assert.deepEqual([...selectChiefChatTopics('test QA features')], ['qa']))
test('Cross-department question collects multiple real sources',()=>{const x=selectChiefChatTopics('How are all 11 agents and QA features?');assert.ok(x.includes('ai-workforce'));assert.ok(x.includes('qa'));assert.ok(x.includes('ai-routing'))})
test('Specific parallel departments collected',()=>{const x=selectChiefChatTopics('Check payments and inventory and marketing');assert.ok(x.includes('payment-exceptions'));assert.ok(x.includes('inventory-integrity'));assert.ok(x.includes('marketing-delivery'))})
test('A question cannot expand beyond the 6-source cap',()=>assert.ok(selectChiefChatTopics('AI providers, QA, budget, finance, inventory, marketing, credit, affiliates, consent').length<=6))
test('Longer audit question accepted, bounds still enforced',()=>{assert.ok(validateChiefChatMessage('x'.repeat(2500)));assert.equal(validateChiefChatMessage('x'.repeat(3501)),null);assert.equal(validateChiefChatMessage('a'),null);assert.equal(validateChiefChatMessage('bad\0prompt'),null)})
const route=readFileSync(files[2],'utf8')
test('Authenticated and explicitly bounded body',()=>{assert.match(route,/requireAdmin\(req\)/);assert.match(route,/readAdminMutationJson\(req, 16_384\)/)})
test('All evidence comes from fixed read-only collector',()=>{assert.match(route,/collectChiefEvidence\(message/);assert.match(route,/unavailableSources/);assert.doesNotMatch(route,/\breq\.json\(/)})
test('Paid gateway and budget boundaries preserved',()=>{assert.match(route,/runAiTask\(/);assert.match(route,/AI_ENABLED !== 'true'/);assert.match(route,/body\.reasoning/);assert.match(route,/maxOutputTokens: gathered\.multiSource \? 1150 : 650/)})
test('QA health monitor is not fake browser testing',()=>{assert.match(route,/eventType: 'engineering_qa.monitor'/);assert.match(route,/will NOT run browser tests/);assert.doesNotMatch(route,/exec\(/)})
const src=readFileSync('lib/ai/chief-evidence.ts','utf8')
test('Real event error-code surfaced, no event payloads',()=>{assert.match(src,/last_error_code/);assert.match(src,/WHERE status='discarded'/);assert.doesNotMatch(src,/SELECT \*/);assert.doesNotMatch(src,/SELECT[\s\S]{0,120}\bpayload\b/)})
test('Hover/focus/tap eye control and hidden safety content',()=>{const ui=readFileSync(files[3],'utf8');assert.match(ui,/function Reveal/);assert.match(ui,/group-hover:visible/);assert.match(ui,/group-open:visible/);assert.match(ui,/Read-only/);assert.match(ui,/maxLength=\{3500\}/)})
console.log(`${passed}/${passed} CP75 Chief offline checks passed`)
