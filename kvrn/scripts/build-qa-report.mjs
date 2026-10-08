import fs from 'node:fs'

const smokeInput = process.env.KVRN_SMOKE_OUTPUT || '/tmp/kvrn-smoke.json'
const jestInput = process.env.KVRN_JEST_OUTPUT || '/tmp/kvrn-jest.json'
const browserInput = process.env.KVRN_BROWSER_OUTPUT || '/tmp/kvrn-browser.json'
const output = process.env.KVRN_QA_REPORT_OUTPUT || '/tmp/kvrn-qa-report.json'

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')) } catch { return fallback }
}

const smoke = readJson(smokeInput, { checks: [] })
const jest = readJson(jestInput, null)
const browser = readJson(browserInput, { checks: [] })

const results = []
const add = (r) => {
  if (!r?.testCaseId) return
  const i = results.findIndex(x => x.testCaseId === r.testCaseId)
  if (i < 0) { results.push(r); return }
  const prev = results[i]
  // A failure wins over a pass for the same durable feature contract.
  results[i] = {
    ...prev,
    status: prev.status === 'failed' || r.status === 'failed' ? 'failed' : prev.status === 'skipped' ? r.status : prev.status,
    durationMs: Number(prev.durationMs || 0) + Number(r.durationMs || 0),
    failureCode: prev.failureCode || r.failureCode || null,
    diagnosticSummary: [prev.diagnosticSummary, r.diagnosticSummary].filter(Boolean).join('; ').slice(0, 1000) || null,
    evidence: { ...(prev.evidence || {}), ...(r.evidence || {}) },
  }
}

for (const r of Array.isArray(smoke?.checks) ? smoke.checks : []) {
  add({
    testCaseId: r.testCaseId,
    status: r.status === 'passed' ? 'passed' : 'failed',
    durationMs: Number(r.durationMs || 0),
    failureCode: r.failureCode || null,
    diagnosticSummary: Array.isArray(r.checks)
      ? r.checks.filter(c => c.status !== 'passed').map(c => `${c.name}:${c.failureCode || 'failed'}`).join(', ').slice(0, 1000)
      : null,
    evidence: { smokeChecks: r.checks || [] },
  })
}


for (const r of Array.isArray(browser?.checks) ? browser.checks : []) {
  add({
    testCaseId: r.testCaseId,
    status: r.status === 'passed' ? 'passed' : r.status === 'skipped' ? 'skipped' : 'failed',
    durationMs: Number(r.durationMs || 0),
    failureCode: r.failureCode || null,
    diagnosticSummary: r?.evidence?.message ? String(r.evidence.message).slice(0,1000) : null,
    evidence: { browserCheck: r.name || null, ...(r.evidence || {}) },
  })
}

const suiteMap = [
  // One real suite may prove more than one durable feature contract. For example,
  // storefront-correctness exercises both storefront behavior and the cart reducer.
  [/storefront-correctness/i, ['storefront_jest', 'cart_jest']],
  [/ga4-client/i, ['product_detail_jest']],
  [/checkout-intl/i, ['checkout_jest']],
  [/reservations|launch-blockers-rev1-webhook/i, ['checkout_jest', 'stripe_finalization_jest']],
  [/financial-integrity/i, ['financial_integrity_jest', 'inventory_jest']],
  [/phase-b-financials|phase-b-batch3-018|phase-b-batch3-019|phase-b-batch3-020/i, ['inventory_jest']],
  [/support-inbox(?!-auth)|support-push/i, ['support_jest']],
  [/discounts|free-shipping/i, ['discounts_jest']],
  [/affiliate/i, ['affiliates_jest']],
  [/funnel-analytics/i, ['analytics_jest']],
  [/admin-auth|support-inbox-auth/i, ['admin_auth_jest']],
  [/content-cms/i, ['content_cms_jest']],
  [/fraud-review|audit-b-fraud/i, ['fraud_review_jest']],
  [/order-tags/i, ['order_tags_jest']],
  [/cms-foundation/i, ['cms_foundation_jest', 'media_library_jest']],
  [/content-(admin-ui|cms-|off-path|richtext)/i, ['content_cms_jest']],
  [/product-cms/i, ['product_cms_jest']],
  [/bundle-pure|bundles-/i, ['bundles_jest']],
  [/fraud-review|audit-b-fraud|audit-b-webhook/i, ['fraud_review_jest']],
  [/order-tags|orders-ui/i, ['order_tags_jest']],
  [/abandoned-checkout|audit-a-checkout/i, ['abandoned_checkout_jest']],
  [/affiliate-program/i, ['affiliate_program_jest']],
  [/affiliate-portal/i, ['affiliate_portal_jest']],
  [/audit-c-affiliate/i, ['affiliate_audit_jest']],
  [/i18n-/i, ['localization_jest']],
  [/admin-ui-|content-admin-ui/i, ['admin_ui_refresh_jest']],
  [/ai-os|ai_/i, ['ai_os_jest']],
]


if (jest && Array.isArray(jest.testResults)) {
  for (const suite of jest.testResults) {
    const name = String(suite.name || '')
    const matches = suiteMap.filter(([re]) => re.test(name))
    if (!matches.length) continue
    const failedTests = Array.isArray(suite.assertionResults)
      ? suite.assertionResults.filter(a => a.status === 'failed').map(a => a.fullName || a.title).slice(0, 10)
      : []
    const status = suite.status === 'failed' || failedTests.length ? 'failed' : 'passed'
    const mappedIds = [...new Set(matches.flatMap(([, ids]) => ids))]
    for (const testCaseId of mappedIds) {
      add({
        testCaseId,
        status,
        durationMs: Number(suite.endTime && suite.startTime ? suite.endTime - suite.startTime : 0),
        failureCode: status === 'failed' ? 'JEST_FAILED' : null,
        diagnosticSummary: failedTests.length ? failedTests.join(' | ').slice(0, 1000) : null,
        evidence: { suite: name.split('/').slice(-3).join('/'), tests: Array.isArray(suite.assertionResults) ? suite.assertionResults.length : 0 },
      })
    }
  }
}

// CI gate outcomes are durable QA facts too. Failures must reach the dashboard even
// when deployment never occurs. A skipped gate is not reported as a pass.
function addGate(testCaseId, outcome, code) {
  if (outcome !== 'success' && outcome !== 'failure') return
  add({ testCaseId, status: outcome === 'success' ? 'passed' : 'failed', durationMs:0,
    failureCode: outcome === 'failure' ? code : null, diagnosticSummary:null, evidence:{ ciOutcome:outcome } })
}
addGate('route_contract_guard', process.env.QA_CONTRACTS_OUTCOME, 'ROUTE_CONTRACT_GUARD_FAILED')
addGate('change_coverage_guard', process.env.QA_CHANGE_COVERAGE_OUTCOME, 'CHANGE_TEST_COVERAGE_FAILED')
addGate('ai_boundary_guard', process.env.QA_AI_BOUNDARIES_OUTCOME, 'AI_BOUNDARY_GUARD_FAILED')
addGate('ai_import_guard', process.env.QA_AI_IMPORTS_OUTCOME, 'AI_IMPORT_GUARD_FAILED')
addGate('typecheck_guard', process.env.QA_TYPECHECK_OUTCOME, 'TYPECHECK_FAILED')
addGate('regression_gate', process.env.QA_REGRESSION_OUTCOME, 'REGRESSION_GATE_FAILED')
addGate('build_guard', process.env.QA_BUILD_OUTCOME, 'BUILD_FAILED')
addGate('product_build', process.env.QA_BUILD_OUTCOME, 'BUILD_FAILED')
addGate('browser_runner_guard', process.env.QA_BROWSER_OUTCOME, 'BROWSER_RUNNER_FAILED')

let failed = results.filter(r => r.status === 'failed').length
const passed = results.filter(r => r.status === 'passed').length
const skipped = results.filter(r => r.status === 'skipped').length
const smokeOutcome = process.env.QA_SMOKE_OUTCOME || 'unknown'
if (smokeOutcome !== 'success' && process.env.QA_EXPECT_SMOKE === 'true' && failed === 0) failed = 1

const body = {
  triggerType: process.env.QA_TRIGGER_TYPE || 'post_deploy',
  environment: process.env.QA_ENVIRONMENT || 'production',
  status: failed ? 'failed' : 'passed',
  totalCount: results.length,
  passedCount: passed,
  failedCount: failed,
  skippedCount: skipped,
  commitSha: process.env.QA_COMMIT_SHA || null,
  results,
}
fs.writeFileSync(output, JSON.stringify(body))
console.log(`QA report payload: ${passed} passed, ${failed} failed, ${skipped} skipped`)
