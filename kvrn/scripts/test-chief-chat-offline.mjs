/** Bounded, offline regression guard. No DB, providers, browser or credentials. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const req = createRequire(import.meta.url)
let ts
try { ts = req('typescript') } catch { ts = req('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript') }
let count=0
const t=(label,fn)=>{fn();count++;console.log('PASS',label)}
const policy = readFileSync('lib/ai/chief-chat-policy.ts','utf8')
const source = ts.transpileModule(policy, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true})
assert.equal((source.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error).length,0)
const module = {exports:{}}
vm.runInNewContext(source.outputText,{exports:module.exports, module},{filename:'chief-chat-policy.js'})
const {classifyChiefChatRequest,validateChiefChatMessage,CHIEF_CHAT_READ_ONLY_NOTICE} = module.exports
t('QA requests routed to Engineering',()=>assert.equal(classifyChiefChatRequest('Test all features').topic,'qa'))
t('Payment requests routed to Finance',()=>assert.equal(classifyChiefChatRequest('refunds and payments').topic,'payment-exceptions'))
t('Stock requests routed to Inventory',()=>assert.equal(classifyChiefChatRequest('stock of hoodies').topic,'inventory-integrity'))
t('Unknown requests use safe operations brief',()=>assert.equal(classifyChiefChatRequest('hello there').topic,'operations-brief'))
t('Chat input bounded',()=>{for(const v of [null,1,'','a','x'.repeat(1001),'\0hello'])assert.equal(validateChiefChatMessage(v),null);assert.equal(validateChiefChatMessage('Hey chief'),'Hey chief')})
t('Read-only policy prohibits risky operations',()=>assert.match(CHIEF_CHAT_READ_ONLY_NOTICE,/cannot send messages, change orders/))
const api = readFileSync('app/api/admin/ai/chief/chat/route.ts','utf8')
t('Route requires Access identity and origin-bounded JSON',()=>{assert.match(api,/requireAdmin\(req\)/);assert.match(api,/readAdminMutationJson\(req, 12_288\)/);assert.doesNotMatch(api,/\breq\.json\(/)})
t('Paid AI gate and budget router preserved',()=>{assert.match(api,/AI_ENABLED !== 'true'/);assert.match(api,/runAiTask\(/);assert.match(api,/body\.reasoning/);assert.doesNotMatch(api,/process\.env\.AI_EXTERNAL_BUDGET_CAP_CONFIRMED\s*=/)})
t('No arbitrary agent execution or SQL tools',()=>{assert.doesNotMatch(api,/\beval\s*\(/);assert.doesNotMatch(api,/\bexec\s*\(/);assert.match(api,/eventType: 'engineering_qa.monitor'/)})
for(const p of ['app/admin/ai/chief/ChiefChatClient.tsx','app/admin/ai/chief/page.tsx','app/api/admin/ai/chief/chat/route.ts']){
 const out=ts.transpileModule(readFileSync(p,'utf8'),{fileName:p,compilerOptions:{jsx:ts.JsxEmit.Preserve,module:ts.ModuleKind.ESNext},reportDiagnostics:true})
 t('Syntax '+p,()=>assert.equal((out.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error).length,0))
}
const calc=readFileSync('app/admin/financials/FinancialsClient.tsx','utf8')
t('37% preset removed, calculator input retained',()=>{assert.match(calc,/\['15', '20', '22', '25', '30'\]/);assert.doesNotMatch(calc,/\['15', '20', '22', '25', '30', '37'\]/);assert.match(calc,/Number\(taxRate\)/)})
const repo=readFileSync('lib/ai/repository.ts','utf8')
t('PostgreSQL alert note is explicitly typed',()=>assert.match(repo,/jsonb_build_object\('note',\$\{note\}::text\)/))
console.log(`${count}/${count} Chief chat offline checks passed`)
