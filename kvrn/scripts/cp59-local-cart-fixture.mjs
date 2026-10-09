#!/usr/bin/env node
/**
 * CP59: disposable local PostgreSQL inventory snapshot -> real Chromium PDP/cart/checkout UI.
 * DOES NOT test Neon's HTTP database adapter, server-side inventory route, or payment creation.
 * No deployed Worker, production service, browser cross-origin request or POST is permitted.
 */
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createTcpServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STAGING = '/workspaces/KVRN-/kvrn-merged-staging'
const DATA_DIR = path.join(homedir(), '.local/share/kvrn-audit2-pg16')
const DATABASE = `kvrn_cp59_cart_${randomBytes(5).toString('hex')}`
let databaseCreated = false
const LOCAL_CFG = name => ({ host: '/tmp', port: 5433, user: 'postgres', database: name, ssl: false,
  connectionTimeoutMillis: 5000, query_timeout: 20000, statement_timeout: 20000 })
const WORKER_LOG = '/tmp/kvrn-cp59-worker.log'
const REPORT = '/tmp/kvrn-cp59-cart-report.json'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function confirmStaging() {
  assert.equal(realpathSync(ROOT), STAGING, 'STOP: requires isolated merged staging, never the live repo')
  assert.ok(!existsSync(path.join(ROOT, '.git')), 'STOP: unexpected nested Git checkout')
  for (const f of ['.env','.env.local','.env.production','.env.production.local','.dev.vars','.dev.vars.preview','.dev.vars.production'])
    assert.ok(!existsSync(path.join(ROOT, f)), `STOP: sensitive configuration file ${f}`)
  assert.ok(existsSync(path.join(ROOT, '.open-next/worker.js')), 'Missing existing OpenNext build')
  assert.ok(existsSync(path.join(ROOT, '.open-next/assets')), 'Missing existing static assets')
  assert.ok(existsSync(path.join(ROOT, 'node_modules/.bin/wrangler')), 'Wrangler not installed')
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies.wrangler, '4.92.0')
  const sql065 = readFileSync(path.join(ROOT, 'db/migrations/065_cp56_checkout_lock_order_and_provider_marker.sql'), 'utf8')
  assert.match(sql065, /CREATE OR REPLACE FUNCTION finalize_paid_order\(/, 'Migration 065 is missing')
}

function workerConfig() {
  return [
    'name = "kvrn-cp59-local-only"',
    `main = ${JSON.stringify(path.join(ROOT, 'cloudflare-cron-wrapper.js'))}`,
    'compatibility_date = "2024-12-18"',
    'compatibility_flags = ["nodejs_compat"]',
    '[assets]',
    `directory = ${JSON.stringify(path.join(ROOT, '.open-next/assets'))}`,
    'binding = "ASSETS"',
    '[vars]',
    'NODE_ENV = "production"',
    'SITE_URL = "https://staging.invalid"',
    'NEXT_PUBLIC_SITE_URL = "https://staging.invalid"',
    'AI_ENABLED = "false"',
    'TWILIO_MARKETING_SEND_ENABLED = "false"',
    'ENABLE_STRIPE_TEST_CHECKOUT = "false"',
    'KVRN_SMS_POLICY_PUBLIC_ENABLED = "false"',
    '',
  ].join('\n')
}

const SLUGS = Object.freeze({
  'kvrn-phantom-hoodie': 'project-kvrn-heavyweight-hoodie',
  'project-kvrn-heavyweight-hoodie': 'project-kvrn-heavyweight-hoodie',
  'kvrn-phantom-sweatpants': 'project-kvrn-heavyweight-sweatpants',
  'project-kvrn-heavyweight-sweatpants': 'project-kvrn-heavyweight-sweatpants',
})
function assertSnapshot(snapshot) {
  assert.ok(snapshot && typeof snapshot === 'object')
  for (const [slug, dbSlug] of Object.entries(SLUGS)) {
    const variants = snapshot[slug]?.variants
    assert.ok(Array.isArray(variants) && variants.length === 6, `Missing six real DB variants for ${slug}`)
    const seen = new Set()
    for (const v of variants) {
      assert.ok(typeof v.sku === 'string' && /^KVRN-D001-(PKHH|PKHSP)-BLK-(XS|S|M|L|XL|XXL)$/.test(v.sku))
      assert.ok(['XS','S','M','L','XL','XXL'].includes(v.size) && !seen.has(v.size))
      seen.add(v.size)
      assert.ok(Number.isSafeInteger(v.available_qty) && v.available_qty >= 0 && v.available_qty <= 2)
      assert.equal(v.in_stock, v.active && v.available_qty > 0)
      assert.equal(v.color_code, 'BLK')
    }
    if (dbSlug === 'project-kvrn-heavyweight-hoodie') {
      assert.equal(variants.find(v => v.size === 'M').available_qty, 2)
      assert.equal(variants.find(v => v.size === 'S').available_qty, 0)
    }
  }
}
function checkConfig() {
  const cfg = workerConfig()
  for (const forbidden of [/^routes?\s*=/m, /^account_id\s*=/m, /^\[\[r2_buckets\]\]/m,
    /^\[triggers\]/m, /DATABASE_URL/i, /STRIPE_SECRET/i, /TWILIO_AUTH/i, /RESEND_API/i])
    assert.ok(!forbidden.test(cfg), `Unsafe local config: ${forbidden}`)
  assert.match(cfg, /ENABLE_STRIPE_TEST_CHECKOUT = "false"/)
}
function selfTest() {
  checkConfig()
  const variants = ['XS','S','M','L','XL','XXL'].map((size, i) => ({
    sku:`KVRN-D001-PKHH-BLK-${size}`, size, size_sort:i+1, color_code:'BLK',
    active:true, available_qty:size==='M'?2:0, in_stock:size==='M',
  }))
  const other = variants.map(v => ({...v, sku:v.sku.replace('PKHH','PKHSP')}))
  const example = Object.fromEntries(Object.entries(SLUGS).map(([k,v]) => [k,{
    variants:v.endsWith('hoodie') ? variants : other,
  }]))
  assertSnapshot(example)
  assert.throws(() => assertSnapshot({ ...example, 'kvrn-phantom-hoodie': { variants: [] } }), /Missing six/)
  assert.throws(() => assertSnapshot({ ...example, 'kvrn-phantom-hoodie': {variants: variants.map(v=>({ ...v, available_qty: 900 }))} }), /available_qty/)
  console.log('PASS CP59 self-test: locked fixture schema, sold-out & in-stock checks, forbidden provider/deploy bindings')
}
function psqlArgs(db, file) {
  return ['-X','-w','-v','ON_ERROR_STOP=1','-h','/tmp','-p','5433','-U','postgres','-d',db,'-f',file]
}
function psql(db, file) {
  const run = spawnSync('psql', psqlArgs(db, file), { encoding:'utf8', timeout: 60000,
    env: {HOME:homedir(), PATH:process.env.PATH || '/usr/bin:/bin', PGPASSWORD:''} })
  if (run.status !== 0 || run.error) throw Error(`Local psql failed: ${String(run.stderr || run.error).slice(-850)}`)
  assert.match(run.stdout, /COMMIT/, 'Local SQL file transaction did not commit')
}
async function initDatabase(pg) {
  const admin = new pg.Client(LOCAL_CFG('postgres'))
  await admin.connect()
  try {
    const result = (await admin.query('SELECT current_user AS u, inet_server_addr() AS a')).rows[0]
    assert.equal(result.u,'postgres')
    assert.equal(result.a,null,'STOP: database is not on a Unix socket')
    assert.equal(realpathSync((await admin.query('SHOW data_directory')).rows[0].data_directory), realpathSync(DATA_DIR), 'STOP: PostgreSQL data directory mismatch')
    const template = await admin.query("SELECT 1 FROM pg_database WHERE datname='kvrn_cp55_migrationtest'")
    assert.equal(template.rowCount, 1, 'STOP: CP55 evidence DB missing')
    const check = new pg.Client(LOCAL_CFG('kvrn_cp55_migrationtest'))
    await check.connect()
    try {
      const tables = (await check.query("SELECT to_regclass('products') p, to_regclass('product_variants') v")).rows[0]
      assert.ok(tables.p && tables.v, 'CP55 schema missing product tables')
    } finally { await check.end() }
    await admin.query(`CREATE DATABASE "${DATABASE}" TEMPLATE "kvrn_cp55_migrationtest"`)
    databaseCreated = true
  } finally { await admin.end() }
  console.log(`LOCAL DATABASE: ${DATABASE}; original CP55 evidence preserved`)
  psql(DATABASE, path.join(ROOT, 'db/migrations/065_cp56_checkout_lock_order_and_provider_marker.sql'))
  psql(DATABASE, path.join(ROOT, 'db/seed.sql'))
  const db = new pg.Client(LOCAL_CFG(DATABASE))
  await db.connect()
  try {
    await db.query('BEGIN')
    // Synthetic test stock ONLY. Do not confuse this with real KVRN inventory.
    await db.query(`UPDATE product_variants pv SET stock_on_hand=CASE WHEN pv.size='M' THEN 2 ELSE 0 END,
      reserved_quantity=0, active=true
      FROM products p WHERE pv.product_id=p.id AND p.slug IN ($1,$2)`,
      ['project-kvrn-heavyweight-hoodie','project-kvrn-heavyweight-sweatpants'])
    const rows = (await db.query(`SELECT p.slug,pv.sku,pv.size,pv.size_sort,pv.color_code,pv.active,
      GREATEST(0,pv.stock_on_hand-pv.reserved_quantity) AS available_qty,
      (pv.stock_on_hand>pv.reserved_quantity AND pv.active) AS in_stock
      FROM products p JOIN product_variants pv ON pv.product_id=p.id
      WHERE p.slug IN ($1,$2) ORDER BY p.slug,pv.size_sort`,
      ['project-kvrn-heavyweight-hoodie','project-kvrn-heavyweight-sweatpants'])).rows
    const snap = Object.fromEntries(Object.entries(SLUGS).map(([publicSlug, dbSlug]) => [publicSlug, {
      variants: rows.filter(r => r.slug === dbSlug).map(({slug, ...v}) => ({...v, available_qty:Number(v.available_qty)})),
    }]))
    assertSnapshot(snap)
    await db.query('COMMIT')
    console.log('PASS: actual PostgreSQL stock fixture read; M=2 and S=0; 12 variants checked')
    return snap
  } catch (err) { await db.query('ROLLBACK').catch(()=>{}); throw err }
  finally { await db.end() }
}
async function deleteFixture(pg) {
  const admin = new pg.Client(LOCAL_CFG('postgres'))
  await admin.connect()
  try {
    assert.equal(realpathSync((await admin.query('SHOW data_directory')).rows[0].data_directory), realpathSync(DATA_DIR))
    const inUse = Number((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [DATABASE])).rows[0].n)
    assert.equal(inUse,0,'Fixture database still has connections; preserved for investigation')
    await admin.query(`DROP DATABASE "${DATABASE}"`)
    console.log(`CLEANUP PASS: disposable ${DATABASE} dropped safely; CP55 database unchanged`)
  } finally {await admin.end()}
}
async function port() {
  return await new Promise((resolve,reject) => {
    const s=createTcpServer(); s.once('error',reject)
    s.listen(0,'127.0.0.1', () => {const p=s.address().port; s.close(err=>err?reject(err):resolve(p))})
  })
}
async function shutdown(child) {
  if (!child?.pid) return
  try {process.kill(-child.pid,'SIGTERM')} catch {}
  if (child.exitCode===null && child.signalCode===null) await Promise.race([
    new Promise(resolve=>child.once('exit',resolve)), sleep(3500),
  ])
  if (child.exitCode===null && child.signalCode===null) {
    try {process.kill(-child.pid,'SIGKILL')} catch {}
  }
}
async function browserJourney(chromium, base, snapshot) {
  const browser=await chromium.launch({headless:true})
  let interceptions=0
  let forbiddenWrites=0
  try {
    const context=await browser.newContext({ viewport: {width:1440,height:900}, locale:'en-US' })
    await context.route('**/*',async route => {
      const request=route.request()
      let u
      try { u=new URL(request.url()) } catch {return route.abort('blockedbyclient')}
      if (u.origin !== base || /(^|\.)kvrn\.shop$/i.test(u.hostname)) return route.abort('blockedbyclient')
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        forbiddenWrites++
        return route.abort('blockedbyclient')
      }
      if (u.pathname === '/api/inventory') {
        const slug=u.searchParams.get('slug')
        const result=slug && Object.hasOwn(snapshot,slug) ? snapshot[slug] : null
        if (!result) return route.fulfill({status:404,contentType:'application/json',body:'{"error":"Unknown fixture slug"}'})
        interceptions++
        return route.fulfill({status:200,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(result)})
      }
      return route.continue()
    })
    const page=await context.newPage()
    let response=await page.goto(`${base}/products/kvrn-phantom-hoodie`, {waitUntil:'domcontentloaded', timeout:25000})
    assert.equal(response?.status(),200, 'PDP must return HTTP 200')
    // First-time buyer: resolve the actual cookie banner with a real click, choosing
    // strictly necessary cookies. Do not hide it with CSS, inject storage, or force-click.
    const consent=page.getByRole('region',{name:'Cookie consent'})
    await consent.waitFor({state:'visible',timeout:9000})
    await consent.getByRole('button',{name:'Deny non-essential',exact:true}).click({timeout:10000})
    await page.waitForFunction(() => {
      const el=document.querySelector('[role="region"][aria-label="Cookie consent"]')
      return el && el.classList.contains('translate-y-full')
    },null,{timeout:5000})

    // The initial desktop hero is a genuine purchase interface. Scope all actions to
    // that visible hero, rather than guessing at the gallery's inline style or clicking
    // the separate DetailsStage buttons hidden behind the fixed snap overlay.
    // Preserve Playwright's pointer hit-testing (no force clicks or DOM event injection).
    const hero=page.locator('section[aria-label]').filter({has:page.locator('h1')}).first()
    await hero.waitFor({state:'visible',timeout:15000})
    const sizeM=hero.getByRole('button',{name:'M',exact:true})
    const sizeS=hero.getByRole('button',{name:'S',exact:true})
    await sizeM.waitFor({state:'visible',timeout:15000})
    assert.equal(await sizeS.isDisabled(),true,'Zero-stock S should remain disabled in visible hero')
    assert.equal(await sizeM.isEnabled(),true,'Database-backed M size must be selectable in visible hero')
    await sizeM.click({timeout:12000})
    const add=hero.getByRole('button',{name:/add to bag/i})
    await add.waitFor({state:'visible',timeout:10000})
    await add.click()
    const bag=page.getByRole('dialog',{name:/bag/i})
    await bag.waitFor({state:'visible',timeout:10000})
    await bag.getByText(/Black\s*\/\s*M/).first().waitFor({state:'visible',timeout:10000})
    const checkout=bag.getByRole('link',{name:/checkout/i})
    await checkout.waitFor({state:'visible',timeout:10000})
    await checkout.click()
    await page.waitForURL(/\/checkout(?:\?|$)/,{timeout:10000})
    await page.getByText('Checkout',{exact:true}).first().waitFor({state:'visible',timeout:10000})
    assert.ok(interceptions>=1,'No inventory response delivered from read-only local database snapshot')
    assert.equal(forbiddenWrites,0,'A browser POST/PUT/PATCH/DELETE was attempted during this test')
    await context.close()
    return {ok:true,inventorySource:'isolated PostgreSQL fixture, intercepted in browser ONLY',
      browserInventoryInterceptions:interceptions, cartOpened:true, checkoutLoaded:true,
      checkoutPaymentSubmitted:false, liveServerInventoryAPI:false, stripeVerified:false,
      cookieConsentAction:'denied non-essential', purchaseControls:'visible initial desktop hero'}
  } finally {await browser.close()}
}
async function main() {
  confirmStaging();checkConfig()
  const [{default:pg},{chromium}] = await Promise.all([import('pg'),import('playwright')])
  let completed=false, worker, workerFd, scratch
  try {
    const snapshot=await initDatabase(pg)
    scratch=mkdtempSync(path.join(tmpdir(),'kvrn-cp59-local-'))
    const emptyHome=path.join(scratch,'home');mkdirSync(emptyHome)
    const config=path.join(scratch,'wrangler.toml');writeFileSync(config,workerConfig(),{mode:0o600})
    const p=await port(),base=`http://127.0.0.1:${p}`
    workerFd=openSync(WORKER_LOG,'w',0o600)
    worker=spawn(path.join(ROOT,'node_modules/.bin/wrangler'),
      ['dev','--local','--config',config,'--ip','127.0.0.1','--port',String(p)],{
        cwd:ROOT,detached:true,stdio:['ignore',workerFd,workerFd],
        env:{HOME:emptyHome,XDG_CONFIG_HOME:emptyHome,PATH:process.env.PATH||'/usr/bin:/bin',
          NODE_ENV:'production',CI:'1',WRANGLER_SEND_METRICS:'false',NEXT_TELEMETRY_DISABLED:'1',
          NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},
      })
    let spawnError;worker.once('error',err=>{spawnError=err})
    let ready=false
    for (let i=0;i<100;i++) {
      if(spawnError)throw spawnError
      if(worker.exitCode!==null || worker.signalCode!==null)throw Error('Local Worker terminated')
      try {const r=await fetch(base+'/robots.txt',{signal:AbortSignal.timeout(700)});if(r.ok){ready=true;break}}catch{}
      await sleep(500)
    }
    assert.ok(ready,'Local Worker startup timed out')
    console.log('START: local Wrangler + real Chromium with synthetic, read-only PG inventory snapshot (NO NeON HTTP / NO Stripe)')
    const report=await browserJourney(chromium,base,snapshot)
    writeFileSync(REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600})
    completed=true
    console.log('CP59 CART UI PASS: real PDP -> available size -> bag -> checkout entry; synthetic PostgreSQL inventory served via browser interception')
    console.log('NOT VERIFIED: actual /api/inventory against Neon HTTP; backend checkout, Stripe, shipping, payment, R2')
    console.log('Report:',REPORT)
  } finally {
    await shutdown(worker)
    if (workerFd !== undefined) closeSync(workerFd)
    if (scratch) rmSync(scratch,{recursive:true,force:true})
    console.log('CLEANUP: local-only Wrangler stopped; temporary config removed')
    if (databaseCreated) {
      try {await deleteFixture(pg)} catch (err) {
        console.error('CLEANUP FAIL: local test DB preserved for forensic inspection:',DATABASE, String(err.message||err))
        throw err
      }
    }
    if (!completed) console.error('CP59 browser fixture verification incomplete: no PASS recorded')
  }
}
try {
  if (process.argv.length>3 || (process.argv[2] && process.argv[2]!=='--self-test')) throw Error('Use cp59-local-cart-fixture.mjs [--self-test]')
  if (process.argv[2]==='--self-test') selfTest()
  else await main()
} catch (err) {
  console.error('CP59 FAIL:',err?.stack||err)
  process.exitCode=1
}
