#!/usr/bin/env node
/**
 * CP60: single non-production staging acceptance for previously unverified
 * checkout/shipping/webhook and owner API permission boundaries.
 * Intentionally DOES NOT verify provider payments, R2 writes, or authenticated CMS writes.
 * Does not apply migrations, alter Neon, send messages, buy labels, deploy, or merge.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createTcpServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_ROOT = '/workspaces/KVRN-/kvrn-merged-staging'
const TARGET = '/workspaces/KVRN-/kvrn'
const LOG_DIR = '/tmp'
const REPORT_FILE = '/tmp/kvrn-cp60-acceptance.json'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stages = []
const probes = []
const SHA = data => createHash('sha256').update(data).digest('hex')
const stamp = () => new Date().toISOString()
let dependencyAudit = { status: 'NOT RUN', productionVulnerabilities: null }
const externalGates = {
  'Staging Neon inventory HTTP': 'PASS in owner-provided prior CP59.2 output; not re-executed',
  'Real Stripe test-mode session and signed provider callback': 'NOT VERIFIED — dedicated test-provider authorization required',
  'Real Shippo staging quote and label': 'NOT VERIFIED — test-provider authorization required; no labels purchased',
  'R2 real staging upload/download': 'NOT VERIFIED — authorized isolated R2 binding required',
  'Authenticated admin CMS CRUD/publish with staging JWT': 'NOT VERIFIED — authenticated staging execution not performed',
  'Cloudflare deployed edge and Safari/WebKit': 'NOT VERIFIED — separate release gates',
}
function logStage(name, status, detail) {
  const row = { name, status, detail: String(detail ?? '').slice(0, 350) }
  stages.push(row)
  console.log(`${status}: ${name}${detail ? ` — ${row.detail}` : ''}`)
}
function assertRoot() {
  assert.equal(realpathSync(ROOT), REQUIRED_ROOT, 'STOP: run only from isolated merged staging')
  assert.ok(!existsSync(path.join(ROOT, '.git')), 'STOP: nested Git checkout unexpected')
  const blocked = ['.env','.env.local','.env.production','.env.production.local','.dev.vars','.dev.vars.preview','.dev.vars.production']
  for (const file of blocked) assert.ok(!existsSync(path.join(ROOT, file)), `STOP: local secret config ${file}`)
  assert.ok(existsSync(path.join(ROOT,'node_modules/.bin/wrangler')), 'Existing Wrangler missing')
  assert.ok(existsSync(path.join(ROOT,'node_modules/jest/bin/jest.js')), 'Existing Jest missing')
  assert.ok(existsSync(path.join(ROOT,'.open-next/worker.js')), 'Existing OpenNext worker missing')
  assert.ok(existsSync(path.join(ROOT,'.open-next/assets/_next/static')), 'Existing static assets missing')
}
function validateBaseline() {
  const m = JSON.parse(readFileSync(path.join(ROOT,'CP59_2_SOURCE_MANIFEST.json'),'utf8'))
  assert.equal(m.checkpoint, 'CP59.2')
  assert.equal(Object.keys(m.files).length,1267,'CP59.2 manifest unexpectedly short')
  const recoveryMetadataExceptions = new Set(['MANIFEST_SHA256.json','README_RECOVERY.txt'])
  let matching = 0
  const preserved = []
  const wrong = []
  for (const [rel, expected] of Object.entries(m.files)) {
    const abs = path.join(ROOT,rel)
    if (!abs.startsWith(`${ROOT}/`) || !existsSync(abs) || !lstatSync(abs).isFile() || lstatSync(abs).isSymbolicLink()) {
      wrong.push(rel); continue
    }
    const data=readFileSync(abs),actual=SHA(data)
    if (recoveryMetadataExceptions.has(rel)) {
      assert.ok(data.length < 1_000_000,'Recovery metadata size unexpectedly large')
      if(rel==='MANIFEST_SHA256.json') JSON.parse(data.toString('utf8'))
      else new TextDecoder('utf-8',{fatal:true}).decode(data)
      if(actual!==expected) preserved.push({path:rel,sha256:actual})
      else matching++
    } else if (actual !== expected) wrong.push(rel)
    else matching++
  }
  assert.equal(wrong.length,0,`CP59.2 protected source mismatch: ${wrong.slice(0,8).join(', ')}`)
  assert.equal(SHA(readFileSync(path.join(ROOT,'scripts/cp59-local-cart-fixture.mjs'))),
    '4e573477ad804689b3390f33d3f2730417d4b57a180390261a484113eb90901d',
    'CP59.2 verified cart runner must remain installed')
  assert.ok(matching >= 1265, 'Unexpected source mismatch count')
  logStage('CP59.2 executable/source integrity', 'PASS',
    `${matching}/1267 exact SHA-256; ${preserved.length} preserved recovery-document exceptions (not app code)`) 
  if(preserved.length)logStage('Locally differing recovery metadata','REVIEW',
    preserved.map(x=>`${x.path} ${x.sha256}`).join('; '))
}

function staticGuards() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT,'package.json'),'utf8'))
  assert.equal(pkg.devDependencies.wrangler, '4.92.0')
  assert.equal(pkg.devDependencies['@opennextjs/cloudflare'],'1.19.10')
  const mode = readFileSync(path.join(ROOT,'lib/stripe-mode.ts'),'utf8')
  assert.match(mode,/canonical === 'true'/)
  assert.match(mode,/mode === 'test' && \(env.ENABLE_STRIPE_TEST_CHECKOUT/)
  const inventory = readFileSync(path.join(ROOT,'app/api/inventory/route.ts'),'utf8')
  assert.match(inventory,/Cache-Control': 'no-store'/)
  const checkout = readFileSync(path.join(ROOT,'app/api/checkout/session/route.ts'),'utf8')
  assert.match(checkout,/allowPublicApiRequest\(sql/)
  assert.match(checkout,/Checkout is temporarily unavailable/)
  const shipping = readFileSync(path.join(ROOT,'app/api/shipping-rates/route.ts'),'utf8')
  assert.match(shipping,/allowPublicApiRequest\(sql/)
  assert.match(shipping,/unavailable: true/)
  const webhook = readFileSync(path.join(ROOT,'app/api/stripe/webhook/route.ts'),'utf8')
  assert.match(webhook,/verifyWebhookSignature/)
  assert.match(webhook,/Missing Stripe-Signature/)
  const auth = readFileSync(path.join(ROOT,'lib/admin-auth.ts'),'utf8')
  assert.match(auth,/!IS_PROD && DEV_BYPASS_EMAIL/)
  assert.match(auth,/if \(!token \|\|/)
  logStage('Checkout, shipping, webhook and owner fail-closed source guards','PASS','Critical non-production safety guards still present')
}
function runCommand(title, exe, args, logPath, durationMs = 180000) {
  const env = {
    HOME: process.env.HOME || '/home/codespace', PATH: process.env.PATH || '/usr/bin:/bin',
    NODE_ENV:'test', CI:'1', NEXT_TELEMETRY_DISABLED:'1', NO_PROXY:'127.0.0.1,localhost', no_proxy:'127.0.0.1,localhost',
  }
  const r = spawnSync(exe,args,{cwd:ROOT,env,encoding:'utf8',timeout:durationMs,maxBuffer:8*1024*1024})
  const data = (r.stdout || '')+'\n'+(r.stderr || '')
  writeFileSync(logPath,data,{mode:0o600})
  if (r.status !== 0 || r.error) {
    const tail = data.split('\n').slice(-22).join('\n').slice(-2400)
    throw Error(`${title} failed (exit ${r.status ?? String(r.error)}). ${logPath}: ${tail}`)
  }
  logStage(title,'PASS',`exit 0; ${logPath}`)
}
async function availablePort() {
  return new Promise((resolve,reject) => {
    const server = createTcpServer(); server.once('error',reject)
    server.listen(0,'127.0.0.1',()=> {const p=server.address().port;server.close(e=>e?reject(e):resolve(p))})
  })
}
async function shutdown(child) {
  if (!child?.pid) return
  try { process.kill(-child.pid,'SIGTERM') } catch {}
  if (child.exitCode === null && child.signalCode === null) await Promise.race([
    new Promise(resolve=>child.once('exit',resolve)),sleep(3500),
  ])
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid,'SIGKILL') } catch {} }
}
const RULES = [
  ['Retired checkout GET','GET','/api/checkout',[410]],
  ['Retired checkout POST','POST','/api/checkout',[410], '{}'],
  ['Checkout fails closed without payment or database','POST','/api/checkout/session',[503], '{"items":[]}'],
  ['Shipping fails closed without rate limiter/provider','POST','/api/shipping-rates',[503], '{"city":"Long Beach","zip":"90802","country":"US","items":[]}'],
  ['Unsigned Stripe webhook cannot process','POST','/api/stripe/webhook',[500], '{}'],
  ['Admin products GET denied','GET','/api/admin/products',[401,403]],
  ['Admin products POST denied','POST','/api/admin/products',[401,403], '{}'],
  ['Admin media GET denied','GET','/api/admin/media',[401,403]],
  ['Admin media POST denied','POST','/api/admin/media',[401,403], '{}'],
  ['Admin CMS GET denied','GET','/api/admin/content/pages',[401,403]],
  ['Admin CMS POST denied','POST','/api/admin/content/pages',[401,403], '{}'],
  ['Admin marketing GET denied','GET','/api/admin/marketing/campaigns',[401,403]],
  ['Admin marketing POST denied','POST','/api/admin/marketing/campaigns',[401,403], '{}'],
  ['Admin finances GET denied','GET','/api/admin/financials/summary',[401,403]],
  ['Admin store credit GET denied','GET','/api/admin/store-credit',[401,403]],
  ['No-database inventory rejects unverified stock','GET','/api/inventory?slug=kvrn-phantom-hoodie',[503]],
  ['Malformed inventory request refused','GET','/api/inventory',[400]],
  ['SMS policy remains unpublished','GET','/messaging-privacy',[404]],
]
async function probe(base, [name, method, resource, expected, body]) {
  const target = new URL(resource,base)
  assert.equal(target.hostname,'127.0.0.1')
  const options={method,redirect:'manual',signal:AbortSignal.timeout(14000),headers:{'user-agent':'KVRN-CP60-LocalAcceptance/1'}}
  if (body !== undefined) {options.body=body;options.headers['content-type']='application/json'}
  const response=await fetch(target,options)
  assert.ok(expected.includes(response.status),`${name}: HTTP ${response.status}, expected ${expected.join('/')}`)
  if (response.status >= 300 && response.status < 400) {
    const where=response.headers.get('location')
    if (where) assert.equal(new URL(where,target).origin,base,'Unsafe external redirect')
  }
  // No API endpoint in this test may accept a request that mutates state.
  if (method === 'POST') assert.ok(response.status >= 400,`${name}: unexpectedly accepted POST`)
  await response.arrayBuffer()
  probes.push({name,method,status:response.status})
  console.log(`PASS HTTP ${response.status}: ${name}`)
}
function makeConfig() {
  const config = [
    'name = "kvrn-cp60-local-only"',
    `main = ${JSON.stringify(path.join(ROOT,'cloudflare-cron-wrapper.js'))}`,
    'compatibility_date = "2024-12-18"',
    'compatibility_flags = ["nodejs_compat"]',
    '[assets]',
    `directory = ${JSON.stringify(path.join(ROOT,'.open-next/assets'))}`,
    'binding = "ASSETS"',
    '[vars]',
    'NODE_ENV = "production"',
    'SITE_URL = "https://staging.invalid"',
    'NEXT_PUBLIC_SITE_URL = "https://staging.invalid"',
    'STRIPE_MODE = "test"',
    'ENABLE_CHECKOUT = "false"',
    'ENABLE_STRIPE_TEST_CHECKOUT = "false"',
    'TWILIO_MARKETING_SEND_ENABLED = "false"',
    'AI_ENABLED = "false"',
    'KVRN_SMS_POLICY_PUBLIC_ENABLED = "false"',
    '',
  ].join('\n')
  for (const forbidden of [/^routes?\s*=/m,/^account_id\s*=/m,/^\[\[r2_buckets\]\]/m,/^\[triggers\]/m, /DATABASE_URL/,/STRIPE_SECRET_KEY/,/SHIPPO_API_TOKEN/,/RESEND_API_KEY/,/TWILIO_AUTH_TOKEN/]) {
    assert.ok(!forbidden.test(config),'Unsafe temporary Worker configuration')
  }
  return config
}
async function localAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(),'kvrn-cp60-'))
  const home=path.join(scratch,'empty-home');mkdirSync(home)
  const config=path.join(scratch,'wrangler.toml');writeFileSync(config,makeConfig(),{mode:0o600})
  const fd=openSync('/tmp/kvrn-cp60-worker.log','w',0o600)
  let worker
  try {
    const p=await availablePort(),base=`http://127.0.0.1:${p}`
    worker=spawn(path.join(ROOT,'node_modules/.bin/wrangler'),
      ['dev','--local','--config',config,'--ip','127.0.0.1','--port',String(p)],
      {cwd:ROOT,detached:true,stdio:['ignore',fd,fd],env:{HOME:home,XDG_CONFIG_HOME:home,
        PATH:process.env.PATH||'/usr/bin:/bin',NODE_ENV:'production',CI:'1',
        WRANGLER_SEND_METRICS:'false',NEXT_TELEMETRY_DISABLED:'1',NO_PROXY:'127.0.0.1,localhost',
        no_proxy:'127.0.0.1,localhost'}})
    let spawnErr; worker.once('error',e=>{spawnErr=e})
    let ready=false
    for(let i=0;i<100;i++){
      if(spawnErr)throw spawnErr
      if(worker.exitCode!==null || worker.signalCode!==null)throw Error('Local Worker exited early')
      try {const res=await fetch(`${base}/robots.txt`,{signal:AbortSignal.timeout(750)});if(res.ok){ready=true;break}}
      catch{}
      await sleep(500)
    }
    assert.ok(ready,'Worker readiness timed out')
    console.log('START: guarded localhost API matrix; provider credentials ABSENT')
    for(const rule of RULES) await probe(base,rule)
    logStage('Non-production Worker API safety matrix','PASS',`${probes.length}/${RULES.length} authenticated/anonymous route gates passed`)
  } finally {
    await shutdown(worker)
    closeSync(fd)
    rmSync(scratch,{recursive:true,force:true})
    console.log('CLEANUP: temporary Wrangler configuration and localhost Worker removed')
  }
}
function readOnlyIntegrationPlan() {
  const manifest=JSON.parse(readFileSync(path.join(ROOT,'CP59_2_SOURCE_MANIFEST.json'),'utf8'))
  assert.ok(existsSync(TARGET) && lstatSync(TARGET).isDirectory(),'Original /kvrn checkout directory not found')
  assert.equal(realpathSync(TARGET),TARGET,'Original website target resolves unexpectedly')
  assert.notEqual(realpathSync(TARGET),realpathSync(ROOT),'Staging and target resolve to same path')
  const paths=[...Object.keys(manifest.files),'scripts/cp60-final-acceptance.mjs','scripts/cp60-postmerge-verify.mjs','CP60_ACCEPTANCE_README.md','CP60_SOURCE_MANIFEST.json']
  const groups={identical:[],replace:[],add:[]}
  for(const rel of paths){
    const src=path.join(ROOT,rel),dst=path.join(TARGET,rel)
    assert.ok(existsSync(src) && lstatSync(src).isFile() && !lstatSync(src).isSymbolicLink(),`Unsafe source ${rel}`)
    if(!existsSync(dst)){groups.add.push(rel);continue}
    const stat=lstatSync(dst)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(),`Unsafe target entry ${rel}`)
    groups[SHA(readFileSync(src))===SHA(readFileSync(dst))?'identical':'replace'].push(rel)
  }
  const rootRepo='/workspaces/KVRN-'
  const git=spawnSync('git',['-C',rootRepo,'status','--porcelain','--','kvrn'],{encoding:'utf8',timeout:12000})
  const existingChanges=git.status===0 ? git.stdout.trim().split('\n').filter(Boolean).length : null
  const result={scope:'READ ONLY; no files copied, changed, deleted, staged or committed', generatedAt:stamp(),
    staging:ROOT,target:TARGET, fileCount:paths.length,
    identical:groups.identical.length,replace:groups.replace.length,add:groups.add.length,
    gitTargetWorkingTreeChanges:existingChanges,changesToReview:[...groups.replace,...groups.add],
    deletionPolicy:'NO DELETIONS; target-only files preserved',
    integrationAuthorized:false,productionDeploymentAuthorized:false}
  writeFileSync('/tmp/kvrn-cp60-merge-plan.json',JSON.stringify(result,null,2),{mode:0o600})
  logStage('Original website integration dry run','PASS',`${result.add} add, ${result.replace} replace, ${result.identical} identical; ${existingChanges===null?'Git status unavailable':existingChanges+' pre-existing Git changes'}; NO writes`)
}
function inspectDependencyRisk() {
  const r = spawnSync('npm',['audit','--omit=dev','--json'],{
    cwd:ROOT,env:{HOME:process.env.HOME||'/home/codespace',PATH:process.env.PATH||'/usr/bin:/bin',
      NODE_ENV:'production',CI:'1',NPM_CONFIG_FUND:'false'},
    encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,
  })
  try {
    const parsed=JSON.parse(r.stdout || '')
    const counts=parsed.metadata?.vulnerabilities
    if (!counts || typeof counts.high !== 'number') throw Error('Audit response lacks vulnerability totals')
    dependencyAudit={status:counts.high || counts.critical ? 'REVIEW' : 'PASS',
      productionVulnerabilities:{low:counts.low||0,moderate:counts.moderate||0,high:counts.high||0,critical:counts.critical||0},
      mode:'npm audit --omit=dev; no files changed'}
    logStage('Dependency vulnerability review', dependencyAudit.status === 'PASS'?'PASS':'REVIEW',
      `production dependencies: ${counts.high||0} high; ${counts.critical||0} critical; ${counts.moderate||0} moderate`)
  } catch {
    dependencyAudit={status:'UNVERIFIED',productionVulnerabilities:null,
      reason:'npm advisory report unavailable (offline/parse/timeout); manual audit required'}
    logStage('Dependency vulnerability review','REVIEW','No verified npm advisory result; review before production release')
  }
}
function report() {
  const failed=stages.filter(s=>s.status==='FAIL')
  const output={checkpoint:'CP60-local-acceptance',generatedAt:stamp(),
    localAcceptance: failed.length===0 && stages.length>=5 ? 'PASS' : 'FAIL',stages,probes,
    priorVerified:'Owner-supplied CP55–CP59.2 terminal results, including live staging inventory reads; not rerun',
    externalGates, dependencyAudit, productionAuthorized:false, deploymentPerformed:false, integrationPerformed:false,
    acceptanceScope:'Local safety acceptance only; not provider-connected end-to-end or production readiness'}
  writeFileSync(REPORT_FILE,JSON.stringify(output,null,2),{mode:0o600})
  console.log(`REPORT: ${REPORT_FILE}`)
  console.log(`RESULT: ${output.localAcceptance === 'PASS' ? 'CP60 LOCAL ACCEPTANCE PASS' : 'CP60 LOCAL ACCEPTANCE INCOMPLETE'}`)
  console.log('NOT VERIFIED: test-mode Stripe, Shippo, authenticated staging CMS/R2; do not claim complete production acceptance')
  console.log('NO DEPLOYMENT, NEON WRITES, PROVIDER REQUESTS, MESSAGES, OR REPOSITORY MERGE EXECUTED')
}
async function selfTest() {
  assert.ok(makeConfig().includes('ENABLE_CHECKOUT = "false"'))
  assert.equal(RULES.length,18)
  const server = createHttpServer((req,res)=>{
    const rule=RULES.find(r=>r[1]===req.method && r[2]===req.url)
    res.writeHead(rule ? rule[3][0] : 404)
    res.end('blocked')
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const base=`http://127.0.0.1:${server.address().port}`
  try {
    for(const rule of RULES) await probe(base,rule)
    const bad=RULES.find(r=>r[0]==='Admin products POST denied')
    const unsafe=createHttpServer((_req,res)=>{res.writeHead(200);res.end('ok')})
    await new Promise(r=>unsafe.listen(0,'127.0.0.1',r))
    try{
      await assert.rejects(probe(`http://127.0.0.1:${unsafe.address().port}`,bad),/HTTP 200/)
    }finally{unsafe.close()}
  }finally{server.close()}
  console.log('PASS CP60 self-test: 18 HTTP expectations + rejection of open admin mutation + fail-closed local configuration')
}
try {
  if(process.argv.length>3 || (process.argv[2] && process.argv[2]!=='--self-test'))throw Error('Usage: node scripts/cp60-final-acceptance.mjs [--self-test]')
  if(process.argv[2]==='--self-test') await selfTest()
  else {
    try {
      assertRoot();validateBaseline();staticGuards()
      runCommand('TypeScript after optional Playwright install',process.execPath,
        [path.join(ROOT,'node_modules/typescript/bin/tsc'),'--noEmit'], '/tmp/kvrn-cp60-typescript.log')
      const focus=[
        'launch-blockers-rev1-stripe-mode.test.ts','launch-blockers-rev1-webhook.test.ts',
        'shipping-quote-input.test.ts','shipping-failclosed.test.ts','shippo.test.ts',
        'admin-routes-guard.test.ts','admin-mutation-safety.test.ts','product-cms-guards.test.ts',
        'limited-json-request.test.ts','free-shipping.test.ts','public-api-rate-limit.test.ts',
      ]
      runCommand('Targeted backend/admin/checkout/shipping/webhook Jest',process.execPath,
        [path.join(ROOT,'node_modules/jest/bin/jest.js'),'--runInBand','--silent','--runTestsByPath',...focus.map(f=>path.join(ROOT,'lib/__tests__',f))],
        '/tmp/kvrn-cp60-targeted-jest.log',240000)
      await localAcceptance()
      readOnlyIntegrationPlan()
      inspectDependencyRisk()
    } catch(e) {logStage('Final acceptance','FAIL',e.message || String(e));process.exitCode=1}
    finally {report()}
  }
} catch(e) {console.error('CP60 ERROR:',e.message||e);process.exitCode=1}
