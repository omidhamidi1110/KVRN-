#!/usr/bin/env node
/**
 * CP58: all-local browser journey + responsive audit of the previously built OpenNext Worker.
 * No deploy, no provider calls, no checkout submission, no persistent database writes.
 * Each browser context blocks every request outside its exact localhost origin.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createTcpServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requiredRoot = '/workspaces/KVRN-/kvrn-merged-staging'
const browserReport = '/tmp/kvrn-cp58-browser.json'
const workerLog = '/tmp/kvrn-cp58-worker.log'
const browserLog = '/tmp/kvrn-cp58-browser.log'
const responsiveLog = '/tmp/kvrn-cp58-responsive.log'

function verifyInstallation() {
  assert.equal(realpathSync(root), requiredRoot, 'STOP: run from isolated merged staging, not the original website')
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.dev.vars', '.dev.vars.production', '.dev.vars.preview']) {
    assert.ok(!existsSync(path.join(root, name)), `STOP: unexpected ${name}; local runtime cannot be proven isolated`)
  }
  assert.ok(existsSync(path.join(root, '.open-next/worker.js')), 'Missing previously verified OpenNext worker; build is required')
  assert.ok(existsSync(path.join(root, '.open-next/assets/_next/static')), 'Missing previously verified OpenNext assets')
  assert.ok(existsSync(path.join(root, 'node_modules/.bin/wrangler')), 'Wrangler dependency missing')
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(packageJson.devDependencies?.wrangler, '4.92.0', 'Unexpected Wrangler version')
  const cfg = readFileSync(path.join(root, 'wrangler.toml'), 'utf8')
  assert.match(cfg, /main\s*=\s*"cloudflare-cron-wrapper\.js"/, 'Unexpected Worker entry')
  if (process.env.KVRN_QA_CHROMIUM_EXECUTABLE) {
    assert.ok(path.isAbsolute(process.env.KVRN_QA_CHROMIUM_EXECUTABLE), 'Chromium path must be absolute')
    assert.ok(existsSync(process.env.KVRN_QA_CHROMIUM_EXECUTABLE), 'Specified Chromium executable missing')
  }
}

const configLines = () => [
  'name = "kvrn-cp58-local-only"',
  `main = ${JSON.stringify(path.join(root, 'cloudflare-cron-wrapper.js'))}`,
  'compatibility_date = "2024-12-18"',
  'compatibility_flags = ["nodejs_compat"]',
  '[assets]',
  `directory = ${JSON.stringify(path.join(root, '.open-next/assets'))}`,
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

function selfTest() {
  const cfg = configLines()
  for (const forbidden of [/^routes?\s*=/m, /^\[\[r2_buckets\]\]/m, /triggers\s*=/m, /account_id\s*=/m, /NEON_/i, /STRIPE_SECRET/i, /TWILIO_AUTH/i, /resend_api/i]) {
    assert.ok(!forbidden.test(cfg), `Self-test: unsafe Wrangler config (${forbidden})`)
  }
  for (const filename of ['browser-smoke.mjs', 'browser-responsive-audit.mjs']) {
    const body = readFileSync(path.join(root, 'scripts', filename), 'utf8')
    assert.match(body, /route\('\*\*\/\*'/, `${filename}: network route interception missing`)
    assert.match(body, /\.origin !== new URL\(base\)\.origin/, `${filename}: external network restriction missing`)
    assert.match(body, /route\.abort\('blockedbyclient'\)/, `${filename}: abort missing`)
  }
  console.log('PASS CP58 self-test: no routes, providers, secrets, cross-origin browser requests or deployment')
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      server.close(err => err ? reject(err) : resolve(addr.port))
    })
  })
}

async function stopProcess(child) {
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3500)),
    ])
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
  }
}

async function runNode(file, logPath, env) {
  const fd = openSync(logPath, 'w', 0o600)
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'scripts', file)], {
        cwd: root, env, stdio: ['ignore', fd, fd],
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code === 0 ? 0 : (code ?? signal ?? 1)))
    })
  } finally { closeSync(fd) }
}

async function requireBrowser() {
  let chromium
  try { ({ chromium } = await import('playwright')) }
  catch { throw new Error('Optional Playwright is missing in staging. Install only that browser QA dependency; do not reinstall the website.') }
  let instance
  try {
    instance = await chromium.launch({ headless: true,
      ...(process.env.KVRN_QA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.KVRN_QA_CHROMIUM_EXECUTABLE } : {}),
    })
  } catch (err) {
    throw new Error(`Chromium browser unavailable: ${String(err.message || err).slice(0, 300)}`)
  } finally { await instance?.close() }
}

async function main(publicOnly = false) {
  verifyInstallation()
  await requireBrowser()
  const scratch = mkdtempSync(path.join(tmpdir(), 'kvrn-cp58-local-'))
  const emptyHome = path.join(scratch, 'empty-home')
  mkdirSync(emptyHome)
  const config = path.join(scratch, 'wrangler-local.toml')
  writeFileSync(config, configLines(), { mode: 0o600 })
  const fd = openSync(workerLog, 'w', 0o600)
  let wrangler
  try {
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const envWorker = {
      HOME: emptyHome, XDG_CONFIG_HOME: emptyHome,
      PATH: process.env.PATH || '/usr/bin:/bin', NODE_ENV: 'production', CI: '1',
      WRANGLER_SEND_METRICS: 'false', NEXT_TELEMETRY_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }
    wrangler = spawn(path.join(root, 'node_modules/.bin/wrangler'),
      ['dev', '--local', '--config', config, '--ip', '127.0.0.1', '--port', String(port)],
      { cwd: root, env: envWorker, detached: true, stdio: ['ignore', fd, fd] })
    let launchError
    wrangler.once('error', err => { launchError = err })
    console.log(`CP58: isolated Wrangler at ${base}; browser E2E only; no deploy`)
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError
      if (wrangler.exitCode !== null || wrangler.signalCode !== null) throw new Error('Local Worker exited unexpectedly')
      try {
        const res = await fetch(`${base}/robots.txt`, { redirect: 'manual', signal: AbortSignal.timeout(700) })
        if (res.ok) { ready = true; break }
      } catch { /* local startup not yet ready */ }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.ok(ready, 'Local Worker startup timed out')
    const envBrowser = {
      HOME: process.env.HOME || '/home/codespace', PATH: process.env.PATH || '/usr/bin:/bin',
      NODE_ENV: 'test', CI: '1',
      KVRN_BROWSER_BASE_URL: base, KVRN_QA_STAGING_URL: base,
      KVRN_QA_PUBLIC_ONLY: publicOnly ? 'true' : 'false',
      KVRN_BROWSER_OUTPUT: browserReport, KVRN_QA_WEBKIT: 'false', KVRN_QA_EXPECT_SMS_POLICIES_OFF: 'true',
      KVRN_QA_CHROMIUM_EXECUTABLE: process.env.KVRN_QA_CHROMIUM_EXECUTABLE || '',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }
    const smoke = await runNode('browser-smoke.mjs', browserLog, envBrowser)
    let smokeComplete = false
    if (smoke === 0 && existsSync(browserReport)) {
      try {
        const result = JSON.parse(readFileSync(browserReport, 'utf8'))
        const ids = publicOnly
          ? ['browser_storefront', 'browser_product_detail', 'browser_mobile']
          : ['browser_storefront', 'browser_product_detail', 'browser_cart', 'browser_checkout_entry', 'browser_mobile']
        const byId = new Map(result.checks?.map(c => [c.testCaseId, c]) || [])
        smokeComplete = result.skipped === false && ids.every(id => byId.get(id)?.status === 'passed')
          && (publicOnly
            ? byId.get('browser_cart')?.status === 'skipped' && byId.get('browser_checkout_entry')?.status === 'skipped'
            : byId.get('browser_cart')?.evidence?.cartOpened === true
              && byId.get('browser_checkout_entry')?.evidence?.checkoutLoaded === true)
        if (!smokeComplete) console.error(publicOnly
          ? 'Public browser QA is incomplete (three storefront/PDP/mobile checks and explicit cart/checkout skips required)'
          : 'Browser journey is incomplete: expected 5 real checks plus cart and checkout entry evidence')
      } catch { console.error('Missing or unreadable browser journey report') }
    }
    console.log(`${smoke === 0 && smokeComplete ? 'PASS' : 'FAIL'} browser customer journey (exit ${smoke}); log ${browserLog}; report ${browserReport}`)
    const responsive = await runNode('browser-responsive-audit.mjs', responsiveLog, envBrowser)
    console.log(`${responsive === 0 ? 'PASS' : 'FAIL'} browser responsive audit (exit ${responsive}); log ${responsiveLog}`)
    if (smoke !== 0 || !smokeComplete || responsive !== 0) throw new Error('Browser QA incomplete/failed; inspect the two local logs above')
    console.log(publicOnly
      ? 'CP58 PUBLIC-ONLY BROWSER PASS: storefront/PDP/mobile + viewport matrix; cart and checkout NOT VERIFIED'
      : 'CP58 LOCAL BROWSER PASS: live-inventory-backed local cart/checkout entry + public viewport matrix; no payment submitted')
  } finally {
    await stopProcess(wrangler)
    closeSync(fd)
    rmSync(scratch, { recursive: true, force: true })
    console.log('CLEANUP: local Wrangler and temporary config removed; no production changes')
  }
}

try {
  if (process.argv.length > 3 || (process.argv[2] && !['--self-test', '--public-only'].includes(process.argv[2]))) {
    throw new Error('Use cp58-local-browser-qa.mjs [--self-test|--public-only] only')
  }
  if (process.argv[2] === '--self-test') selfTest()
  else await main(process.argv[2] === '--public-only')
} catch (err) {
  console.error('CP58 FAIL:', err.message || err)
  process.exitCode = 1
}
