/** CP78 Chief offline tests. Never accesses a database, provider or network. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const ts = require('typescript')
let cases = 0
function check(name, fn) { fn(); console.log('PASS', name); ++cases }
function load(modulePath) {
  const raw=readFileSync(modulePath,'utf8')
  const js=ts.transpileModule(raw,{fileName:modulePath,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true})
  assert.equal(js.diagnostics?.filter(x=>x.category===ts.DiagnosticCategory.Error).length,0)
  const module={exports:{}}
  vm.runInNewContext(js.outputText,{module,exports:module.exports}, {filename:modulePath})
  return module.exports
}
const {selectChiefChatTopics}=load('lib/ai/chief-chat-policy.ts')
const {compactChiefModelEvidence,compactChiefConversation,CHIEF_MAX_MODEL_EVIDENCE_CHARS}=load('lib/ai/integrations/chief-context.ts')
const route=readFileSync('app/api/admin/ai/chief/chat/route.ts','utf8')
check('Scoped priority request is only workforce and QA',()=>{
  const topics=Array.from(selectChiefChatTopics('Chief, review current AI workforce and QA status. Identify the two most important operational problems using verified records.'))
  assert.deepEqual(topics,['ai-workforce','qa'])
})
check('Prioritization without scope retains audit',()=>{
  const topics=Array.from(selectChiefChatTopics('Identify the three most urgent problems and recommend the order to fix them.'))
  assert(topics.includes('ai-workforce')&&topics.includes('qa'));assert(!topics.includes('payment-exceptions'))
})
check('Specific financial request remains Finance',()=>{
  const topics=Array.from(selectChiefChatTopics('Review financial monitoring and inventory readiness'))
  assert(topics.includes('payment-exceptions')&&topics.includes('inventory-integrity'))
})
check('Explicit workforce plus budget does not expand to six sources',()=>{
  const topics=Array.from(selectChiefChatTopics('Full audit of 11 agents and their AI budget'))
  assert(topics.includes('ai-workforce')&&topics.includes('ai-budget'));assert.equal(topics.length,2)
})
check('Generic audit bounded to six',()=>{
  const topics=Array.from(selectChiefChatTopics('Comprehensive health audit of KVRN entire business'))
  assert(topics.length<=6)
})
const records=Array.from({length:6},(_,i)=>({
 topic:i===0?'ai-workforce':'evidence-'+i,worker:'Chief Operator',asOf:new Date().toISOString(),source:'canonical records',
 summary:'a'.repeat(700),lines:Array.from({length:35},(_,j)=>({label:(i===0&&j<11?'Agent ':'Metric ')+j,value:'v'.repeat(800),state:j%3?'warning':'verified'})),warnings:['W'.repeat(500),'K'.repeat(500)]
}))
check('Six huge evidence reports never exceed global cap',()=>{
 const data=compactChiefModelEvidence(records)
 assert.equal(data.length,6)
 assert(JSON.stringify(data).length<=CHIEF_MAX_MODEL_EVIDENCE_CHARS+128,JSON.stringify(data).length)
 assert(data.every(x=>x.omittedLines>0))
})
check('Agent metadata kept over low-priority discarded events',()=>{
 const data=compactChiefModelEvidence([records[0]])[0]
 assert(data.lines.some(l=>l.label.startsWith('Agent ')))
})
check('Paid conversation history bounded',()=>{
 const data=compactChiefConversation(Array.from({length:6},(_,i)=>({who:i%2?'chief':'owner',text:'s'.repeat(1200)})))
 assert(data.length<=4 && JSON.stringify(data).length<=2200)
})
check('Chief paid route uses compact context and router safety budget',()=>{
 assert.match(route,/compactChiefModelEvidence\(evidence\)/)
 assert.match(route,/compactChiefConversation\(history\)/)
 assert.match(route,/runAiTask\(\{/)
 assert.match(route,/essential: false/)
 assert.match(route,/CHIEF_PAID_REASONING_FAILED/)
 assert.doesNotMatch(route,/console\.error\([^\n]*err\.message/)
})
check('Paid AI failure still returns deterministic canonical evidence',()=>{
 assert.match(route,/formatOfflineAnswer\(evidence, unavailable\)/)
 assert.match(route,/reason: category/)
 assert.match(route,/externalTransmission: 'unknown'/)
})
console.log(`${cases}/${cases} CP78 Chief offline tests passed`)
