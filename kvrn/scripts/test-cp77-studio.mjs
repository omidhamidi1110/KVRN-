/** CP77: isolated, no-network contract tests for authenticated GitHub staging. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
let ts
try { ts = require('typescript') } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript') }
const code = readFileSync('lib/developer-studio.ts', 'utf8')
const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }}).outputText
let calls = [], drift = false
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40), e = 'e'.repeat(40)
function ok(value) { return {ok: true, status: 200, async json() { return value }}}
const mockFetch = async (url, init) => {
  const path = new URL(url).pathname.split('/repos/omidhamidi1110/KVRN-/')[1]
  calls.push(`${init.method} ${path}`)
  if (path.startsWith('git/ref/heads/')) return ok({object:{sha: drift && path.endsWith('kvrn-studio-draft') ? e : a}})
  if (path.startsWith('contents/.github/workflows')) return ok({sha:b})
  if (path === `git/commits/${a}`) return ok({tree:{sha:c}})
  if (path.startsWith(`git/trees/${c}`)) return ok({tree:[{path:'kvrn/lib/ai/agents/market-intel.ts',type:'blob',sha:d,size:100}]})
  if (path==='git/trees' && init.method==='POST') return ok({sha:e})
  if (path==='git/commits' && init.method==='POST') return ok({sha:b})
  if (path==='git/refs/heads/kvrn-studio-draft' && init.method==='PATCH') return ok({})
  throw Error('Unexpected mocked GitHub call: '+path)
}
const mod={exports:{}}
vm.runInNewContext(compiled,{module:mod,exports:mod.exports,process:{env:{DEV_STUDIO_GITHUB_TOKEN:'local-test-only'}},Buffer,fetch:mockFetch,URL})
const x=mod.exports
assert.equal(x.studioFileKind('kvrn/lib/ai/agents/market-intel.ts'),'backend')
assert.equal(x.studioFileKind('kvrn/app/admin/ai/chief/ChiefChatClient.tsx'),'ui')
for (const p of ['kvrn/wrangler.toml','kvrn/app/api/admin/developer-studio/route.ts','kvrn/scripts/verify-studio-preview-isolation.mjs','kvrn/lib/admin-auth.ts','kvrn/.github/workflows/deploy.yml','kvrn/db/migrations/066.sql','kvrn/app/../.env']) assert.equal(x.editableFile(p),false,p)
const changes = [{path:'kvrn/lib/ai/agents/market-intel.ts',content:'export const example = true',sha:d},{path:'kvrn/lib/ai/integrations/research-creators.ts',content:'export const safe = 1',sha:''}]
assert.equal(await x.commitChangeSet(changes,a,'test@example.com'),b)
assert.ok(calls.includes('POST git/trees'))
assert.ok(calls.includes('PATCH git/refs/heads/kvrn-studio-draft'))
await assert.rejects(x.commitChangeSet([{path:'kvrn/lib/admin-auth.ts',content:'',sha:''}],a,'x'),/invalid file/i)
calls=[];drift=true
await assert.rejects(x.commitChangeSet(changes,a,'test@example.com'),/draft changed/i)
assert.ok(!calls.some(z=>z.startsWith('POST ')),'Must not write during conflict')
const wf=readFileSync('../.github/workflows/kvrn-developer-studio.yml','utf8')
assert.doesNotMatch(wf,/gh api -X POST|auto.?merge|deploy --env preview/i)
assert.match(wf,/opennextjs-cloudflare build --config=wrangler.studio-preview.toml/)
const ui=readFileSync('app/admin/developer-studio/DeveloperStudioClient.tsx','utf8')
assert.match(ui,/save-batch/);assert.match(ui,/Create backend review PR/)
execFileSync('node',['scripts/verify-studio-preview-isolation.mjs'],{stdio:'inherit'})
console.log('PASS CP77 atomic multi-file save, stale-reference rejection, scope, explicit publish and staging isolation')
