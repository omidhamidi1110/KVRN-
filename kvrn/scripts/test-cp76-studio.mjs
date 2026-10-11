/** No network, provider, database or production calls. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const req = createRequire(import.meta.url)
let ts
try { ts = req('typescript') } catch { ts = req('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript') }
let passed = 0
function check(name, fn) { fn(); passed++; console.log('PASS', name) }
const files = [
  'lib/developer-studio.ts',
  'app/api/admin/developer-studio/route.ts',
  'app/admin/developer-studio/DeveloperStudioClient.tsx',
  'app/admin/developer-studio/page.tsx',
  'app/admin/ai/chief/ChiefChatClient.tsx',
  'lib/ai/chief-chat-policy.ts',
  'lib/ai/agents/finance.ts',
]
for (const file of files) {
  check('TypeScript syntax '+file, () => {
    const output=ts.transpileModule(readFileSync(file,'utf8'),{fileName:file,reportDiagnostics:true,compilerOptions:{jsx:ts.JsxEmit.Preserve,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
    assert.equal((output.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0)
  })
}
const raw = readFileSync('lib/ai/chief-chat-policy.ts','utf8')
const compiled = ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const mod={exports:{}}
vm.runInNewContext(compiled,{module:mod,exports:mod.exports})
const routes=mod.exports.selectChiefChatTopics
check('Prioritization not confused with ecommerce orders',()=>{
 const topics=Array.from(routes('Identify the three most urgent problems and recommend the order to fix them.'))
 assert.ok(topics.includes('ai-workforce')&&topics.includes('qa'))
 assert.ok(!topics.includes('payment-exceptions'))
})
check('Explicit paid order request still routes finance',()=>{
 const topics=Array.from(routes('Check paid orders and payment exceptions'))
 assert.ok(topics.includes('payment-exceptions'))
})
const backend=readFileSync('lib/developer-studio.ts','utf8')
check('Studio backend uses reviewed PR, protected runtime files are blocked',()=>{
 const js=ts.transpileModule(backend,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const mod={exports:{}}
 vm.runInNewContext(js,{module:mod,exports:mod.exports,process:{env:{}},Buffer})
 const accepts=mod.exports.editableFile
 assert.ok(accepts('kvrn/app/admin/ai/chief/ChiefChatClient.tsx'))
 assert.ok(accepts('kvrn/lib/ai/agents/market-intel.ts'))
 assert.ok(accepts('kvrn/lib/ai/integrations/research-tiktok.ts'))
 assert.ok(accepts('kvrn/lib/ai/agents/finance.ts'))
 assert.ok(accepts('kvrn/app/api/admin/orders/route.ts'))
 for(const bad of ['kvrn/db/migrations/066.sql','kvrn/.github/workflows/x.yml','kvrn/app/../../.env','kvrn/scripts/deploy.sh','kvrn/lib/ai/router.ts','kvrn/app/api/admin/developer-studio/route.ts','kvrn/app/admin/developer-studio/page.tsx','kvrn/scripts/verify-studio-preview-isolation.mjs']) assert.equal(accepts(bad),false,bad)
})
const api=readFileSync('app/api/admin/developer-studio/route.ts','utf8')
check('Admin auth and bounded JSON reads',()=>{assert.match(api,/requireAdmin\(req\)/);assert.match(api,/readAdminMutationJson\(req, 300_000\)/)})
check('Release requires verified same-commit preview',()=>{assert.match(api,/draftSha && r\.conclusion === 'success'/);assert.match(api,/compare\/\$\{encodeURIComponent\(RELEASE\)\}/)})
check('Rollback never applies migrations',()=>{assert.match(api,/Restore a bounded set of UI files|eligible UI|eligible.*UI/i);assert.doesNotMatch(api,/\b(DATABASE_URL|STRIPE_SECRET_KEY)\b/)})
check('Finance session column uses schema field',()=>{
 const s=readFileSync('lib/ai/agents/finance.ts','utf8')
 assert.match(s,/FROM analytics_sessions WHERE first_seen_at/)
 assert.doesNotMatch(s,/analytics_sessions WHERE started_at/)
})
console.log(`${passed}/${passed} CP76 offline checks passed`)
