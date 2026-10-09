#!/usr/bin/env node
/** CP57: offline, localhost-only Wrangler edge runtime smoke. Never deploys. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createTcpServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expected = '/workspaces/KVRN-/kvrn-merged-staging'
const checks = []
const record = (name, success, detail = '') => {
  checks.push({ name, success, detail: String(detail).slice(0, 220) })
  console.log(`${success ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${String(detail).slice(0, 130)}` : ''}`)
}

function ensureNoLocalSecrets() {
  assert.equal(realpathSync(root), expected, 'STOP: use installed merged staging, never production source')
  for (const f of ['.env', '.env.local', '.env.production', '.env.production.local', '.dev.vars', '.dev.vars.production', '.dev.vars.preview']) {
    assert.ok(!existsSync(path.join(root, f)), `STOP: detected ${f}; cannot guarantee isolated runtime`)
  }
  assert.ok(existsSync(path.join(root, 'node_modules/.bin/wrangler')), 'STOP: use existing installed Wrangler; do not download dependencies')
  assert.ok(existsSync(path.join(root, '.open-next/worker.js')), 'STOP: CP56 Cloudflare output missing')
  assert.ok(existsSync(path.join(root, '.open-next/assets/_next/static')), 'STOP: Cloudflare static assets missing')
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.devDependencies?.wrangler ?? pkg.dependencies?.wrangler, '4.92.0', 'STOP: unverified Wrangler version')
  const wrangler = readFileSync(path.join(root, 'wrangler.toml'), 'utf8')
  assert.match(wrangler, /main\s*=\s*"cloudflare-cron-wrapper\.js"/, 'STOP: unexpected Worker entry')
}

function getFreeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(err => err ? reject(err) : resolve(address.port))
    })
  })
}

async function request(base, name, pathname, expectedStatuses, verify = async () => {}, report = true) {
  let result
  try {
    const req = new URL(pathname, base)
    assert.equal(req.hostname, '127.0.0.1')
    const response = await fetch(req, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'KVRN-CP57-LocalEdge/1.0' } })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? ''
      // The smoke never follows a redirect, but also flags any unexpected origin.
      if (location) assert.equal(new URL(location, req).origin, base, 'redirect exits local isolated origin')
    }
    assert.ok(expectedStatuses.includes(response.status), `HTTP ${response.status}; expected ${expectedStatuses.join('/')}`)
    await verify(response)
    result = { ok: true, status: response.status }
  } catch (err) {
    result = { ok: false, status: 'ERROR', message: String(err.message || err) }
  }
  if (report) record(name, result.ok, result.ok ? `HTTP ${result.status}` : result.message)
  return result
}

async function probes(base) {
  const local = new URL(base)
  assert.equal(local.hostname, '127.0.0.1')
  assert.equal(local.protocol, 'http:')
  assert.equal(local.pathname, '/')
  await request(base, 'Worker homepage HTML', '/', [200], async res => {
    assert.match(res.headers.get('content-type') || '', /text\/html/)
    assert.match((await res.text()).slice(0, 200000), /KVRN/i)
  })
  await request(base, 'Shop dynamic route', '/shop', [200], async res => {
    assert.match(res.headers.get('content-type') || '', /text\/html/)
    assert.match((await res.text()).slice(0, 200000), /KVRN/i)
  })
  await request(base, 'Product detail SSR route', '/products/kvrn-phantom-hoodie', [200], async res => {
    assert.match(res.headers.get('content-type') || '', /text\/html/)
    assert.match((await res.text()).slice(0, 200000), /KVRN/i)
  })
  await request(base, 'FAQ public page', '/support/faq', [200])
  await request(base, 'Privacy public page', '/privacy', [200])
  await request(base, 'Robots response', '/robots.txt', [200], async res => {
    assert.match(await res.text(), /Disallow:\s*\/admin/i)
  })
  await request(base, 'GA runtime config is disabled', '/api/analytics/config', [200], async res => {
    assert.match(res.headers.get('cache-control') || '', /no-store/i)
    const body = await res.json()
    assert.deepEqual(body, { measurementId: null })
  })
  await request(base, 'Admin products unauthorized', '/api/admin/products', [401, 403])
  await request(base, 'Admin media unauthorized', '/api/admin/media', [401, 403])
  await request(base, 'Public R2 media rejects invalid key', '/media/not-a-content-hash.webp', [404])
  await request(base, 'Public R2 missing binding fails closed', `/media/ab/${'a'.repeat(64)}/original.webp`, [503])
  await request(base, 'Product WebP asset', '/images/products/project-kvrn-heavyweight-hoodie/1.webp', [200], async res => {
    assert.match(res.headers.get('content-type') || '', /image\/webp/i)
    const bytes = Buffer.from(await res.arrayBuffer())
    assert.ok(bytes.length > 500, 'image too small')
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP')
  })
  const n = checks.filter(c => c.success).length
  console.log(`CP57 LOCAL EDGE RESULT: ${n}/${checks.length} checks passed; no deployment and no external requests from test client`)
  return n === checks.length
}

async function selfTest() {
  const server = createHttpServer((req, res) => {
    if (req.url?.startsWith('/api/admin/')) { res.writeHead(401); return res.end('Unauthorized') }
    if (req.url === '/api/analytics/config') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"measurementId":null}') }
    if (req.url === '/media/not-a-content-hash.webp') { res.writeHead(404); return res.end('Not found') }
    if (req.url?.startsWith('/media/ab/')) { res.writeHead(503); return res.end('Unavailable') }
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end('User-agent: *\nDisallow: /admin\n') }
    if (req.url?.endsWith('.webp')) { res.writeHead(200, { 'content-type': 'image/webp' }); return res.end(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(650)])) }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>KVRN</title>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    if (!await probes(`http://127.0.0.1:${port}/`)) process.exitCode = 1
    // Fail-closed regression: an inadvertently unprotected admin endpoint MUST cause failure.
    const unsafe = createHttpServer((req, res) => { res.writeHead(200); res.end('unexpected') })
    await new Promise(resolve => unsafe.listen(0, '127.0.0.1', resolve))
    try {
      const res = await request(`http://127.0.0.1:${unsafe.address().port}/`, 'unsafe admin mock', '/api/admin/products', [401, 403], async () => {}, false)
      if (res.ok) throw new Error('Unsafe admin mock was accepted')
      console.log('PASS: harness correctly rejects unauthorized endpoint returning 200')
    } finally { unsafe.close() }
    console.log('PASS: CP57 isolated mock self-test; real Wrangler runtime remains untested here')
  } finally { server.close() }
}

async function launchLocalEdge() {
  ensureNoLocalSecrets()
  const port = await getFreeLocalPort()
  const folder = mkdtempSync(path.join(tmpdir(), 'kvrn-cp57-local-edge-'))
  const home = path.join(folder, 'empty-home')
  mkdirSync(home)
  // Config is outside the repository. It intentionally contains NO routes, secrets, triggers,
  // R2 buckets, D1, KV, queues, service bindings, cloud account ID or production origin.
  const config = [
    'name = "kvrn-cp57-local-only"',
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
  const safeConfigPath = path.join(folder, 'wrangler-local-only.toml')
  writeFileSync(safeConfigPath, config, { mode: 0o600 })
  const logPath = '/tmp/kvrn-cp57-local-edge.log'
  const logFd = openSync(logPath, 'w', 0o600)
  const binary = path.join(root, 'node_modules/.bin/wrangler')
  const env = {
    HOME: home, XDG_CONFIG_HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', NODE_ENV: 'production',
    CI: '1', WRANGLER_SEND_METRICS: 'false', NEXT_TELEMETRY_DISABLED: '1',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  }
  let child
  try {
    console.log(`START CP57: local Wrangler --local on 127.0.0.1:${port}; no deployment, no account binding`)
    console.log(`Local runtime log: ${logPath}`)
    child = spawn(binary, ['dev', '--local', '--config', safeConfigPath, '--ip', '127.0.0.1', '--port', String(port)], {
      cwd: root, env, stdio: ['ignore', logFd, logFd], detached: true,
    })
    let launchError
    child.on('error', err => { launchError = err })
    const base = `http://127.0.0.1:${port}/`
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Wrangler exited early (${child.exitCode ?? child.signalCode})`)
      try {
        const res = await fetch(`${base}robots.txt`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(700) })
        if (res) { ready = true; break }
      } catch { /* Worker not yet listening */ }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.ok(ready, 'Wrangler did not become available within 50 seconds')
    const success = await probes(base)
    if (!success) process.exitCode = 1
    else console.log('PASS: CP57 local Worker smoke and cleanup pending')
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* exited already */ }
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3500))])
      }
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* cleanly exited */ }
      }
    }
    closeSync(logFd)
    rmSync(folder, { recursive: true, force: true })
    console.log('CLEANUP: local-only Wrangler process stopped; temporary config deleted; production untouched')
  }
}

try {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== '--self-test')) throw new Error('Unsupported arguments; use no args or --self-test')
  if (process.argv[2] === '--self-test') await selfTest()
  else await launchLocalEdge()
} catch (err) {
  console.error(`FAIL CP57: ${err.message || err}`)
  if (process.argv[2] !== '--self-test') console.error('Diagnostic log: /tmp/kvrn-cp57-local-edge.log')
  process.exitCode = 1
}
