/** CP80: offline tests of browser-only backend PR safety. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
let ts
try { ts = require('typescript') } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript') }
const source = readFileSync('lib/developer-studio.ts','utf8')
const compiled = ts.transpileModule(source, {compilerOptions:{module: ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const sha = 'a'.repeat(40)
let calls=[], previewSuccess = true
const mockedFetch=async (url,init)=>{
 const endpoint = new URL(url).pathname.split('/repos/omidhamidi1110/KVRN-/')[1]
 calls.push(`${init.method} ${endpoint}`)
 if(endpoint.startsWith('git/ref/heads/')) return {ok:true,status:200,json:async()=>({object:{sha}})}
 if(endpoint.startsWith('contents/.github/workflows')) return {ok:true,status:200,json:async()=>({sha:'b'.repeat(40)})}
 if(endpoint.startsWith('compare/')) return {ok:true,status:200,json:async()=>({files:[{filename:'kvrn/lib/ai/agents/finance.ts',status:'modified'}],total_commits:1})}
 if(endpoint.startsWith('actions/workflows/')) return {ok:true,status:200,json:async()=>({workflow_runs:previewSuccess?[{head_sha:sha,conclusion:'success',display_title:'Studio preview '+sha,id:1}]:[]})}
 if(endpoint === 'pulls') return {ok:true,status:201,json:async()=>({number:7,html_url:'https://github.com/omidhamidi1110/KVRN-/pull/7'})}
 throw Error('Unexpected endpoint '+endpoint)
}
const mod={exports:{}}
vm.runInNewContext(compiled,{module:mod,exports:mod.exports,process:{env:{DEV_STUDIO_GITHUB_TOKEN:'test-token'}},fetch:mockedFetch,URL,Buffer})
const x=mod.exports
for (const f of ['kvrn/lib/ai/agents/finance.ts','kvrn/app/api/admin/orders/route.ts','kvrn/lib/ai/chief-chat-policy.ts','kvrn/scripts/build-qa-report.mjs']) assert.equal(x.studioFileKind(f),'backend',f)
for (const f of ['.github/workflows/production.yml','kvrn/wrangler.toml','kvrn/lib/admin-auth.ts','kvrn/lib/developer-studio.ts','kvrn/lib/ai/router.ts','kvrn/app/api/admin/developer-studio/route.ts','kvrn/scripts/verify-studio-preview-isolation.mjs','kvrn/scripts/cp79-submit-qa-report.mjs','kvrn/app/../.env']) assert.equal(x.editableFile(f),false,f)
assert.equal(x.studioFileKind('kvrn/app/admin/inventory/page.tsx'),'ui')
const response=await x.createReviewPullRequest(sha,'owner@example.com')
assert.equal(response.number,7)
assert.ok(calls.includes('POST pulls'))
assert.ok(!calls.some(x=>x.includes('merges') || x.includes('git/refs/heads/kvrn-cp60-source-integration')))
previewSuccess=false; calls=[]
await assert.rejects(x.createReviewPullRequest(sha,'owner@example.com'),/preview build/i)
assert.ok(!calls.some(x=>x==='POST pulls'))
const api=readFileSync('app/api/admin/developer-studio/route.ts','utf8')
assert.match(api,/Backend changes require a reviewed GitHub pull request; direct publishing is disabled/)
const workflow=readFileSync('../.github/workflows/kvrn-studio-review.yml','utf8')
assert.match(workflow,/pull_request:/)
assert.doesNotMatch(workflow,/CLOUDFLARE_API_TOKEN|secrets\.|deploy --env|wrangler deploy/)
const ui=readFileSync('app/admin/developer-studio/DeveloperStudioClient.tsx','utf8')
assert.match(ui,/Create backend review PR/)
assert.match(ui,/Publish UI to live site/)
console.log('PASS CP80 backend PR creation, preview gate, no direct backend publish, protected source and credential-free CI')
