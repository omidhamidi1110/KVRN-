#!/usr/bin/env node
// Dependency-free regression gates for the October 8 Phase 1 patch.
// Tests source contracts, not browser layout or production behavior.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const tests = [
  ['Cookie page shares consent context', () => {
    const src = read('app/cookies/CookieControls.tsx')
    assert.match(src, /useCookiePrefs/)
    assert.doesNotMatch(src, /kvrn_cookie_consent|location\.reload|localStorage\.setItem/)
  }],
  ['Clarity does not initialize outside consent gating', () => {
    const src = read('app/layout.tsx')
    assert.doesNotMatch(src, /clarity\.ms\/tag|clarityId\s*&&/)
    assert.match(src, /<GaTracker\s*\/>/)
  }],
  ['Legacy privacy + terms aliases redirect', () => {
    assert.match(read('app/legal/privacy/page.tsx'), /permanentRedirect\('\/privacy'\)/)
    assert.match(read('app/legal/terms/page.tsx'), /permanentRedirect\('\/terms'\)/)
    assert.doesNotMatch(read('app/legal/terms/page.tsx'), /Delaware/)
  }],
  ['Dedicated messaging pages require explicit owner policy-publication flag', () => {
    for (const route of ['messaging-terms','messaging-privacy']) {
      const src = read(`app/${route}/page.tsx`)
      assert.match(src, /if\(!active\(\)\)notFound\(\)/)
      assert.match(src, /KVRN_SMS_POLICY_PUBLIC_ENABLED/)
      assert.match(src, /if\(cmsContentEnabled\(\)\)/)
    }
  }],
  ['Privacy choices integrate with canonical preference state', () => {
    const src = read('app/privacy-choices/PrivacyChoicesClient.tsx')
    assert.match(src, /useCookiePrefs/)
    assert.match(src, /doNotSell: true/)
    assert.match(src, /effectiveAnalyticsConsent/)
  }],
  ['Admin table can scroll locally and shared frame respects available width', () => {
    assert.match(read('components/admin/ui/AdminUI.tsx'), /min-w-0 max-w-full overflow-x-auto/)
    assert.match(read('components/admin/AdminShell.tsx'), /w-full min-w-0 min-h-screen/)
  }],
  ['Single shared nav height', () => {
    const css = read('app/globals.css')
    assert.equal((css.match(/--nav-height\s*:/g) || []).length, 1)
  }],
]
let failed=0
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
}
console.log(`${tests.length-failed}/${tests.length} Phase 1 source guards passed`)
if (failed) process.exitCode=1
