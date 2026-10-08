// Dependency-free regression guard for the first post-91f8655 adversarial audit.
// These are source-boundary checks; they do not replace Jest, Neon, or browser tests.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
const root = process.cwd()
const read = f => fs.readFileSync(path.join(root, f), 'utf8')

const compliance = read('app/api/admin/affiliates/compliance/route.ts')
assert.match(compliance, /Promise\.all\(\[svc\.currentDocuments\(\),\s*svc\.attention\(\)\]\)/, 'Compliance policy lookup must fail closed')
assert.doesNotMatch(compliance, /currentDocuments\(\)\.catch\(/, 'Failed compliance document read must not appear empty')

const chief = read('lib/ai/chief.ts')
const cycle = chief.slice(chief.indexOf('export async function runChiefCycle('))
assert.ok(cycle.indexOf('await enforceAgentAutonomySafety()') < cycle.indexOf('processApprovedAiActions(10)'), 'Governance must run before approved action execution')
assert.match(cycle, /governanceReady\s*\?\s*await processApprovedAiActions\(10\)\s*:\s*\{ claimed: 0 \}/, 'Failed governor must block approved execution')
assert.match(cycle, /if \(maintenanceErrors\.length\) throw new Error/, 'Maintenance faults must not report clean Chief success')
assert.ok(cycle.indexOf('const daily = await sendDailyChiefBriefIfDue()') < cycle.indexOf('if (maintenanceErrors.length) throw'), 'Do not skip daily brief when governance fails')

const governance = read('lib/ai/governance.ts')
assert.match(governance, /WITH changed AS \([\s\S]*?\), audited AS \([\s\S]*?\), alerted AS \(/, 'Autonomy downgrade, audit, alert must share one DB statement')
assert.match(governance, /WHERE id=\$\{row\.id\}[\s\S]*?AND autonomy_level=\$\{row\.autonomy_level\}/, 'Concurrent owner changes must be respected')
assert.doesNotMatch(governance, /await upsertAiAlert\(/, 'No post-commit governor alerts that can disappear on error')

const media = read('app/api/admin/media/[id]/route.ts')
assert.match(media, /WITH changed AS \([\s\S]*?RETURNING id[\s\S]*?\), audited AS \(/, 'Media update and audit must be atomic')
assert.match(media, /WITH deleted AS \([\s\S]*?NOT EXISTS \(SELECT 1 FROM media_usages[\s\S]*?NOT EXISTS \(SELECT 1 FROM collections[\s\S]*?\), audited AS \(/, 'Media delete must recheck usages and audit atomically')
assert.match(media, /storageCleanupPending: true/, 'R2 deletion errors must be exposed')
assert.doesNotMatch(media, /bucket\.delete\(keys\)\.catch\(\(\)\s*=>\s*\{\}\)/, 'R2 deletion errors must not be suppressed')

const integrations = read('lib/ai/integrations/repository.ts')
assert.match(integrations, /UPDATE ai_integrations SET[\s\S]*?WHERE id=\$\{input\.id\}[\s\S]*?RETURNING id/, 'Connector state writes must return proof of mutation')
assert.match(integrations, /if \(!changed\.length\) throw new Error\('AI_INTEGRATION_STATE_ROW_MISSING'\)/, 'Connector state updates must fail closed for missing records')

console.log('PASS: 15 adversarial continuation assertions (compliance, Chief, governor, media, integrations)')
