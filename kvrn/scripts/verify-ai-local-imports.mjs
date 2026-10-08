#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const scanRoots = [
  'lib/ai',
  'app/admin/ai',
  'app/api/admin/ai',
  'app/api/internal/ai-chief',
  'app/api/internal/qa-report',
]
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const files = []
function walk(rel) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) return
  const stat = fs.statSync(abs)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(path.join(rel, name))
  } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) files.push(rel)
}
for (const r of scanRoots) walk(r)

function resolveLocal(fromRel, spec) {
  let base
  if (spec.startsWith('@/')) base = path.join(root, spec.slice(2))
  else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(path.join(root, fromRel)), spec)
  else return true

  if (fs.existsSync(base) && fs.statSync(base).isFile()) return true
  for (const ext of extensions) if (fs.existsSync(base + ext)) return true
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const ext of extensions) if (fs.existsSync(path.join(base, 'index' + ext))) return true
  }
  return false
}

const missing = []
const importRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+|import\s*\()(['"])([^'"\n]+)\1/g
for (const rel of files) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8')
  let m
  while ((m = importRe.exec(src))) {
    const spec = m[2]
    if ((spec.startsWith('@/') || spec.startsWith('./') || spec.startsWith('../')) && !resolveLocal(rel, spec)) {
      missing.push(`${rel} -> ${spec}`)
    }
  }
}

if (missing.length) {
  console.error('AI local-import guard failed:')
  for (const x of missing) console.error(`  ${x}`)
  process.exit(1)
}
console.log(`AI local-import guard: ${files.length} control-plane source files have resolvable local imports.`)
