import fs from 'node:fs'

const base = (process.env.KVRN_SMOKE_BASE_URL || '').replace(/\/$/, '')
const output = process.env.KVRN_SMOKE_OUTPUT || ''
if (!base) {
  console.log('Smoke tests skipped: KVRN_SMOKE_BASE_URL not set.')
  if (output) fs.writeFileSync(output, JSON.stringify({ skipped: true, checks: [] }))
  process.exit(0)
}

const checks = [
  { name: 'homepage', path: '/', expected: [200], testCaseId: 'storefront_smoke' },
  { name: 'shop', path: '/shop', expected: [200], testCaseId: 'storefront_smoke' },
  { name: 'contact', path: '/contact', expected: [200], testCaseId: 'support_smoke' },
  { name: 'faq', path: '/support/faq', expected: [200], testCaseId: 'support_smoke' },
  { name: 'shipping_returns', path: '/support/shipping-returns', expected: [200], testCaseId: 'support_smoke' },
  { name: 'size_guide', path: '/support/size-guide', expected: [200], testCaseId: 'support_smoke' },
  { name: 'track', path: '/support/track', expected: [200], testCaseId: 'support_smoke' },
  { name: 'analytics_config', path: '/api/analytics/config', expected: [200], testCaseId: 'analytics_config_smoke' },
]

const raw = []
let failed = 0
for (const check of checks) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  let status = 'failed'
  let failureCode = null
  try {
    const res = await fetch(base + check.path, {
      redirect: 'manual', signal: controller.signal,
      headers: { 'user-agent': 'KVRN-QA/1.0' },
    })
    if (!check.expected.includes(res.status)) {
      failed++
      failureCode = `HTTP_${res.status}`
      console.error(`FAIL ${check.name}: HTTP ${res.status}`)
    } else {
      status = 'passed'
      console.log(`PASS ${check.name}: HTTP ${res.status}`)
    }
  } catch (err) {
    failed++
    failureCode = err?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
    console.error(`FAIL ${check.name}: ${err?.name || 'network_error'}`)
  } finally {
    clearTimeout(timer)
    raw.push({ ...check, status, durationMs: Date.now() - started, failureCode })
  }
}

// Roll route-level checks into one result per durable feature test case.
const grouped = new Map()
for (const r of raw) {
  const g = grouped.get(r.testCaseId) || { testCaseId: r.testCaseId, status: 'passed', durationMs: 0, failureCode: null, checks: [] }
  g.durationMs += r.durationMs
  g.checks.push({ name: r.name, status: r.status, failureCode: r.failureCode })
  if (r.status === 'failed') {
    g.status = 'failed'
    g.failureCode ||= r.failureCode
  }
  grouped.set(r.testCaseId, g)
}
const payload = { skipped: false, checks: [...grouped.values()] }
if (output) fs.writeFileSync(output, JSON.stringify(payload, null, 2))
if (failed) process.exit(1)
