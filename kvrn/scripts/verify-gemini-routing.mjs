#!/usr/bin/env node
// CP73 Gemini model/employee routing guard. No AI requests or live writes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(p, 'utf8')
const w = read('wrangler.toml')
const config = read('lib/ai/config.ts')
const provider = read('lib/ai/providers.ts')
const employee = read('lib/ai/agents/video-performance.ts')
const readiness = read('app/api/admin/ai/chief/readiness/route.ts')
const events = read('lib/ai/events.ts')
const cases = []
function check(name, fn) { fn(); cases.push(name); console.log('PASS:', name) }
function section(heading, next) {
  const start = w.indexOf(heading)
  assert(start >= 0, `Missing Wrangler ${heading}`)
  const end = next ? w.indexOf(next, start + heading.length) : -1
  return w.slice(start, end < 0 ? undefined : end)
}
const rootVars = section('[vars]', '[env.production]')
const productionVars = section('[env.production.vars]', '[env.preview]')
const previewVars = section('[env.preview.vars]', '')
const vars = [['root',rootVars],['production',productionVars],['preview',previewVars]]
const prop = (text,key) => {
  const line = text.split('\n').find(line => new RegExp(`^\\s*${key}\\s*=`).test(line))
  assert(line, `Missing ${key}`)
  const match = line.match(/=\s*"([^"]+)"/)
  assert(match, `Malformed ${key}`)
  return match[1]
}
for (const [name, v] of vars) {
  if (name === 'root') {
    check('root: approved Gemini code default without extra binding', () => {
      assert.doesNotMatch(v, /^AI_GOOGLE_VIDEO_MODEL\s*=/m)
      assert.match(config, /model: process\.env\.AI_GOOGLE_VIDEO_MODEL \|\| 'gemini-3\.8-flash'/)
    })
  } else {
    check(`${name}: pinned Gemini model`, () => assert.equal(prop(v,'AI_GOOGLE_VIDEO_MODEL'),'gemini-3.8-flash'))
  }
  check(`${name}: compatible Gemini API version`, () => assert.equal(prop(v,'AI_GOOGLE_API_VERSION'),'v1beta'))
  check(`${name}: Google AI Studio Gateway route`, () => assert.match(prop(v,'AI_GOOGLE_BASE_URL'),/\/kvrn-ai-prod\/google-ai-studio$/))
  check(`${name}: paid AI remains OFF`, () => assert.equal(prop(v,'AI_ENABLED'),'false'))
  check(`${name}: spending confirmation stays OFF`, () => assert.equal(prop(v,'AI_EXTERNAL_BUDGET_CAP_CONFIRMED'),'false'))
}
check('video role defaults to verified Google model', () => {
  assert.match(config,/case 'video':[\s\S]*?provider: 'google',[\s\S]*?model: process\.env\.AI_GOOGLE_VIDEO_MODEL \|\| 'gemini-3\.8-flash'/)
  assert.match(config,/'video:google:gemini-3\.8-flash'/)
})
check('production rejects unapproved models', () => assert.match(config,/AI_MODEL_NOT_VETTED_FOR_ROLE/))
check('Ads & Social video employee uses routed video role', () => assert.match(employee,/agentId: 'ads_social', role: 'video'/))
check('video analysis is reachable by event dispatcher', () => assert.match(events,/ads_social\.video_analyze/))
check('Gemini text uses generateContent with configured model', () => assert.match(provider,/encodeURIComponent\(config\.model\)\}:generateContent/))
check('Gemini video uses interactions with configured model', () => {
  assert.match(provider,/\/\$\{version\}\/interactions/)
  assert.match(provider,/model: config\.model/)
})
check('Gemini provider uses Gateway auth and fail-closed stored key policy', () => {
  assert.match(provider,/cf-aig-authorization/)
  assert.match(provider,/cf-aig-no-wholesale/)
})
check('Chief shows video agent routing without claiming video test passed', () => {
  assert.match(readiness,/videoRequestTested: false/)
  assert.match(readiness,/videoModel\.model === 'gemini-3\.8-flash'/)
})
check('No retired Gemini model ID in active AI source', () => {
  for (const p of ['lib/ai/config.ts','lib/ai/providers.ts','lib/ai/agents/video-performance.ts']) {
    assert.doesNotMatch(read(p),/gemini-2\.5-flash/)
  }
})
console.log(`PASS: ${cases.length}/${cases.length} Gemini routing guards (no paid requests made)`)
