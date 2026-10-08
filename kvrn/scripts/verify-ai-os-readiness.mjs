#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const required = [
  'db/migrations/036_ai_os_foundation.sql',
  'db/migrations/037_security_hardening.sql',
  'lib/ai/router.ts',
  'lib/ai/chief.ts',
  'lib/ai/events.ts',
  'lib/ai/executors.ts',
  'app/admin/ai/page.tsx',
  'app/api/internal/ai-chief/route.ts',
  'app/api/internal/qa-report/route.ts',
  'qa/feature-contracts.json',
  'qa/route-contracts.json',
  'scripts/verify-route-contracts.mjs',
  'scripts/verify-change-test-coverage.mjs',
  'scripts/verify-ai-boundaries.mjs',
  'scripts/verify-ai-local-imports.mjs',
  'docs/AI-OS-RUNBOOK.md',
]

let failed = false
for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error(`MISSING: ${rel}`)
    failed = true
  }
}

const commands = [
  ['node', ['scripts/verify-route-contracts.mjs']],
  ['node', ['scripts/verify-ai-boundaries.mjs']],
  ['node', ['scripts/verify-ai-local-imports.mjs']],
]
for (const [cmd, args] of commands) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) failed = true
}

const migration = fs.readFileSync(path.join(root, 'db/migrations/036_ai_os_foundation.sql'), 'utf8')
for (const needle of [
  'operational_cutoff_micros <= 4000000',
  'absolute_ceiling_micros <= 5000000',
  'ai_reserve_budget',
  'ai_daily_briefs',
  "FROM ai_runtime_settings",
  "WHERE id=1",
  "date_trunc('month', NOW() AT TIME ZONE v_timezone)",
  "pg_timezone_names z WHERE z.name=ai_runtime_settings.business_timezone",
]) {
  if (!migration.includes(needle)) {
    console.error(`MIGRATION CONTROL MISSING: ${needle}`)
    failed = true
  }
}


const securityMigration = fs.readFileSync(path.join(root, 'db/migrations/037_security_hardening.sql'), 'utf8')
for (const needle of [
  'public_api_rate_events',
  'public_api_rate_allow',
  'content_redirects_safe_paths_chk',
]) {
  if (!securityMigration.includes(needle)) {
    console.error(`SECURITY HARDENING MISSING: ${needle}`)
    failed = true
  }
}

const affiliateAuthSource = fs.readFileSync(path.join(root, 'lib/affiliate-auth.ts'), 'utf8')
if (!affiliateAuthSource.includes('AFFILIATE_AUTH_PEPPER is not configured securely')) {
  console.error('AFFILIATE AUTH FAIL-CLOSED SECRET CHECK MISSING')
  failed = true
}
const affiliateApplySource = fs.readFileSync(path.join(root, 'lib/affiliate-application.ts'), 'utf8')
if (!affiliateApplySource.includes('AFFILIATE_HASH_PEPPER is not configured securely')) {
  console.error('AFFILIATE APPLICATION FAIL-CLOSED SECRET CHECK MISSING')
  failed = true
}
const publicRateSource = fs.readFileSync(path.join(root, 'lib/public-api-rate-limit.ts'), 'utf8')
if (!publicRateSource.includes('PUBLIC_API_RATE_PEPPER') || !publicRateSource.includes("env.NODE_ENV === 'production'")) {
  console.error('PUBLIC API RATE-LIMIT FAIL-CLOSED CONFIG CHECK MISSING')
  failed = true
}


const configSource = fs.readFileSync(path.join(root, 'lib/ai/config.ts'), 'utf8')
if (!configSource.includes("process.env.NODE_ENV === 'production' || process.env.AI_GATEWAY_USE_STORED_KEYS === 'true'")
  || !configSource.includes('CLOUDFLARE_AI_GATEWAY_TOKEN_NOT_CONFIGURED')) {
  console.error('GATEWAY AUTH CONTROL MISSING: production/stored-key requests must require the authenticated Gateway token')
  failed = true
}

const providersSource = fs.readFileSync(path.join(root, 'lib/ai/providers.ts'), 'utf8')
if (!providersSource.includes("'cf-aig-no-wholesale': 'true'")) {
  console.error('GATEWAY FAIL-CLOSED HEADER MISSING: cf-aig-no-wholesale=true')
  failed = true
}

const budgetSource = fs.readFileSync(path.join(root, 'lib/ai/budget.ts'), 'utf8')
if (!budgetSource.includes('FROM ai_runtime_settings WHERE id=1') || budgetSource.includes("ai_runtime_settings WHERE id='global'")) {
  console.error('BUDGET TIMEZONE SETTINGS KEY MISMATCH: expected ai_runtime_settings id=1')
  failed = true
}

const wrangler = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8')
const safeDefaults = [
  [/^AI_ENABLED\s*=\s*"false"$/m, 'AI_ENABLED=false'],
  [/^AI_CHIEF_NOTIFICATION_GATE\s*=\s*"false"$/m, 'AI_CHIEF_NOTIFICATION_GATE=false'],
  [/^AI_EXTERNAL_BUDGET_CAP_CONFIRMED\s*=\s*"false"$/m, 'AI_EXTERNAL_BUDGET_CAP_CONFIRMED=false'],
  [/^AI_EXTERNAL_BUDGET_CAP_USD\s*=\s*"5"$/m, 'AI_EXTERNAL_BUDGET_CAP_USD=5'],
  [/^AI_GATEWAY_USE_STORED_KEYS\s*=\s*"true"$/m, 'AI_GATEWAY_USE_STORED_KEYS=true'],
  [/^AI_GOOGLE_API_VERSION\s*=\s*"v1beta"$/m, 'AI_GOOGLE_API_VERSION=v1beta'],
]
for (const [pattern, label] of safeDefaults) {
  if (!pattern.test(wrangler)) {
    console.error(`SAFE DEFAULT MISSING: ${label}`)
    failed = true
  }
}

if (failed) process.exit(1)
console.log('AI OS readiness guard: required foundation, safety controls, route contracts and AI boundaries are present.')
