import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const manifestPath = path.join(root, 'qa', 'route-contracts.json')
const featureContractPath = path.join(root, 'qa', 'feature-contracts.json')
const migrationPath = path.join(root, 'db', 'migrations', '036_ai_os_foundation.sql')

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const featureContracts = JSON.parse(fs.readFileSync(featureContractPath, 'utf8'))
// Never mutate 036: newly introduced features live in additive 042.
const migration = fs.readFileSync(migrationPath, 'utf8') + '\n' + fs.readFileSync(path.join(root,'db/migrations/042_qa_feature_contracts_marketing_credit.sql'),'utf8')
const registered = new Map((manifest.routes || []).map(r => [r.path, r]))
const contractedFeatures = new Map((featureContracts.features || []).map(f => [f.id, f]))

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.name === 'page.tsx' || ent.name === 'route.ts') out.push(path.relative(root, p).replaceAll('\\','/'))
  }
  return out
}

function sqlSeedContainsTestCase(id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\('${escaped}'\\s*,`).test(migration)
}

function sqlSeedContainsFeature(id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\('${escaped}'\\s*,\\s*'[^']+'\\s*,\\s*'[^']+'\\s*,`).test(migration)
}

const actual = walk(path.join(root, 'app')).sort()
const missing = actual.filter(p => !registered.has(p))
const stale = [...registered.keys()].filter(p => !actual.includes(p))
const invalid = [...registered.values()].filter(r => !r.feature || !Array.isArray(r.requiredChecks) || r.requiredChecks.length === 0)
const routeFeatures = new Set([...registered.values()].map(r => r.feature))
const missingFeatureContracts = [...routeFeatures].filter(id => !contractedFeatures.has(id))
const invalidFeatureContracts = []

for (const [id, contract] of contractedFeatures) {
  const problems = []
  if (!id || !sqlSeedContainsFeature(id)) problems.push('feature is not seeded in the registered additive migrations')
  if (!Array.isArray(contract.requiredTestCaseIds) || contract.requiredTestCaseIds.length === 0) problems.push('no requiredTestCaseIds')
  for (const testCaseId of contract.requiredTestCaseIds || []) {
    if (!sqlSeedContainsTestCase(testCaseId)) problems.push(`test case not seeded: ${testCaseId}`)
  }
  if (!Array.isArray(contract.evidenceFiles) || contract.evidenceFiles.length === 0) problems.push('no evidenceFiles')
  for (const file of contract.evidenceFiles || []) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing evidence file: ${file}`)
  }
  if (problems.length) invalidFeatureContracts.push({ id, problems })
}

if (missing.length || stale.length || invalid.length || missingFeatureContracts.length || invalidFeatureContracts.length) {
  console.error('KVRN QA feature-contract guard failed.')
  if (missing.length) console.error('\nUnregistered new routes/pages:\n' + missing.map(x => `  + ${x}`).join('\n'))
  if (stale.length) console.error('\nStale manifest entries:\n' + stale.map(x => `  - ${x}`).join('\n'))
  if (invalid.length) console.error('\nInvalid route contracts:\n' + invalid.map(x => `  ! ${x.path}`).join('\n'))
  if (missingFeatureContracts.length) console.error('\nRoute features without durable automated-test contracts:\n' + missingFeatureContracts.map(x => `  ! ${x}`).join('\n'))
  if (invalidFeatureContracts.length) console.error('\nInvalid feature-test contracts:\n' + invalidFeatureContracts.map(x => `  ! ${x.id}: ${x.problems.join('; ')}`).join('\n'))
  console.error('\nEvery production surface must map to a registered feature with concrete automated-test evidence before merge.')
  process.exit(1)
}

console.log(`QA feature-contract guard: ${actual.length} routes/pages registered across ${routeFeatures.size} routed features; ${contractedFeatures.size} durable feature contracts verified.`)
