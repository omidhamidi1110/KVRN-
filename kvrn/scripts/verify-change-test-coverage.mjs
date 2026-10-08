import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const base = String(process.env.QA_BASE_SHA || '').trim()
const head = String(process.env.QA_HEAD_SHA || 'HEAD').trim() || 'HEAD'

function runGit(args) {
  return execFileSync('git', args, { encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim()
}

if (!base || /^0+$/.test(base)) {
  console.log('Change-test coverage guard: no comparable base SHA; skipped for this run.')
  process.exit(0)
}

let changed
try {
  changed = runGit(['diff','--name-only',`${base}...${head}`]).split('\n').map(s=>s.trim()).filter(Boolean)
} catch (error) {
  console.error('Change-test coverage guard could not compute the git diff. CI must checkout full history.')
  process.exit(1)
}

const appCode = changed.filter(f =>
  /^(app|components|lib)\//.test(f)
  && !/(^|\/)__tests__\//.test(f)
  && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
  && !f.endsWith('.d.ts')
)
const testEvidence = changed.filter(f =>
  /(^|\/)__tests__\//.test(f)
  || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
  || /^qa\//.test(f)
  || /^scripts\/(browser-smoke|smoke-test|verify-|build-qa-report)/.test(f)
)

if (!appCode.length) {
  console.log(`Change-test coverage guard: ${changed.length} changed files, no application-code change requiring test evidence.`)
  process.exit(0)
}

if (!testEvidence.length) {
  console.error('KVRN change-test coverage guard failed.')
  console.error('Application behavior changed but no automated test/QA contract changed in the same diff.')
  console.error('Changed application files:')
  for (const f of appCode.slice(0,40)) console.error(`  - ${f}`)
  console.error('Add/update a relevant automated test or QA contract. This prevents untested features from silently shipping.')
  process.exit(1)
}

// New route/page files are separately enforced by verify-route-contracts. This guard covers
// behavior added inside existing pages/components/services where no new route would appear.
console.log(`Change-test coverage guard: ${appCode.length} application files accompanied by ${testEvidence.length} test/QA evidence changes.`)
