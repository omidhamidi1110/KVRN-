import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const scanRoots = ['lib/ai', 'app/admin/ai', 'app/api/admin/ai', 'app/api/internal/ai-chief', 'app/api/internal/qa-report']
const allowedInferenceFiles = new Set(['lib/ai/providers.ts', 'lib/ai/config.ts', 'lib/ai/capabilities.ts'])
const allowedPushoverFiles = new Set(['lib/ai/chief.ts'])
const inferenceMarkers = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY',
  'AI_ANTHROPIC_BASE_URL', 'AI_OPENAI_BASE_URL', 'AI_GOOGLE_BASE_URL',
  'api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com',
]
const pushoverMarkers = ['sendPushoverNotification', 'api.pushover.net']

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes:true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(ent.name)) out.push(path.relative(root, full).replaceAll('\\','/'))
  }
  return out
}

const files = scanRoots.flatMap(r => walk(path.join(root, r)))
const violations = []
for (const file of files) {
  const src = fs.readFileSync(path.join(root, file), 'utf8')
  const inferenceHits = inferenceMarkers.filter(m => src.includes(m))
  if (inferenceHits.length && !allowedInferenceFiles.has(file)) {
    violations.push(`${file}: paid-inference boundary (${inferenceHits.join(', ')})`)
  }
  const pushHits = pushoverMarkers.filter(m => src.includes(m))
  if (pushHits.length && !allowedPushoverFiles.has(file)) {
    violations.push(`${file}: Chief-only Pushover boundary (${pushHits.join(', ')})`)
  }
}

if (violations.length) {
  console.error('KVRN AI boundary guard failed.')
  for (const v of violations) console.error(`  ! ${v}`)
  console.error('\nPaid inference must go through lib/ai/router.ts -> providers.ts, and AI Pushover must go through Chief.')
  process.exit(1)
}
console.log(`AI boundary guard: ${files.length} AI/control-plane source files obey router + Chief notification boundaries.`)
