import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
let count=0
function test(label,fn){fn();console.log('PASS',label);count++}
const baseEnv={...process.env,KVRN_BROWSER_OUTPUT:'/tmp/kvrn-offline-qa-guard-check.json'}
function run(script,key,url){return spawnSync(process.execPath,[script],{encoding:'utf8',env:{...baseEnv,[key]:url},timeout:10000})}
test('browser smoke rejects canonical production origin before loading optional Playwright',()=>{
 const r=run('scripts/browser-smoke.mjs','KVRN_BROWSER_BASE_URL','https://kvrn.shop')
 assert.equal(r.status,2);assert.match(r.stderr,/REFUSED:/)
})
test('browser smoke rejects www production alias',()=>{
 const r=run('scripts/browser-smoke.mjs','KVRN_BROWSER_BASE_URL','https://www.kvrn.shop')
 assert.equal(r.status,2);assert.match(r.stderr,/REFUSED:/)
})
test('browser smoke rejects unsafe HTTP remote origin',()=>{
 const r=run('scripts/browser-smoke.mjs','KVRN_BROWSER_BASE_URL','http://staging.example.com')
 assert.equal(r.status,2);assert.match(r.stderr,/REFUSED:/)
})
test('browser smoke rejects staging URL with path or query',()=>{
 for(const v of ['https://staging.example.com/admin','https://staging.example.com/?target=shop']){
  const r=run('scripts/browser-smoke.mjs','KVRN_BROWSER_BASE_URL',v)
  assert.equal(r.status,2);assert.match(r.stderr,/REFUSED:/)
 }
})
test('responsive audit rejects production before browser dependency',()=>{
 const r=run('scripts/browser-responsive-audit.mjs','KVRN_QA_STAGING_URL','https://kvrn.shop')
 assert.equal(r.status,2);assert.match(r.stderr,/REFUSED:/)
})
test('responsive audit rejects staging URLs with paths or credentials',()=>{
 for(const v of ['https://staging.example.com/admin','https://name:password@staging.example.com']){
  const r=run('scripts/browser-responsive-audit.mjs','KVRN_QA_STAGING_URL',v)
  assert.equal(r.status,2);assert.match(r.stderr,/Staging URL must be an origin/)
 }
})
test('both browser scripts block production redirect/network targets',()=>{
 for(const script of ['scripts/browser-smoke.mjs','scripts/browser-responsive-audit.mjs']){
  const s=readFileSync(script,'utf8')
  assert.match(s,/route\('\*\*\/\*'/)
  assert.match(s,/kvrn\\\.shop\$\/i\.test\(hostname\)/)
  assert.match(s,/route\.abort\('blockedbyclient'\)/)
 }
})
console.log(`${count}/${count} production-safe browser QA guard checks passed; browsers not launched.`)
