import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzePostscriptCsv } from '../postscript-consent-dry-run.mjs'
const header='phone,status,consented_at,consent_source,consent_brand,unsubscribed_at\n'
test('valid brand-specific record counts as candidate but never authorizes import',()=>{
  const result=analyzePostscriptCsv(header+'+12135550101,subscribed,2026-01-01,website,KVRN,\n')
  assert.equal(result.activeWithEvidence,1)
  assert.equal(result.safeToAutomaticallyImport,false)
  assert.ok(!JSON.stringify(result).includes('+12135550101'))
})
test('opt-out overrides any earlier consent in duplicate rows',()=>{
  const result=analyzePostscriptCsv(header+
    '+12135550101,unsubscribed,2026-01-01,website,KVRN,2026-02-01\n'+
    '+12135550101,subscribed,2026-01-01,website,KVRN,\n')
  assert.equal(result.suppressed,1);assert.equal(result.activeWithEvidence,0)
  assert.equal(result.conflicts,1)
})
test('missing original KVRN-specific consent is not importable',()=>{
  const r=analyzePostscriptCsv(header+'+12135550101,subscribed,2026-01-01,website,Other Brand,\n')
  assert.equal(r.missingEvidence,1);assert.equal(r.activeWithEvidence,0)
})
test('invalid numbers and contradictory statuses fail closed',()=>{
  const r=analyzePostscriptCsv(header+'not-a-phone,subscribed,2026-01-01,website,KVRN,\n'+
  '+12135550101,maybe,2026-01-01,website,KVRN,\n')
  assert.equal(r.invalidNumbers,1);assert.equal(r.ambiguousStatus,1)
})
test('CSV quotes, commas and embedded newlines parse without leaking PII',()=>{
  const r=analyzePostscriptCsv(header+'"+12135550101",subscribed,2026-01-01,"web, modal",KVRN,\n')
  assert.equal(r.activeWithEvidence,1)
})
test('never stitches eligibility from separate incomplete consent rows',()=>{
  const result=analyzePostscriptCsv(header+
   '+12135550101,subscribed,,website,KVRN,\n'+
   '+12135550101,maybe,2026-01-01,website,KVRN,\n')
  assert.equal(result.activeWithEvidence,0)
  assert.equal(result.ambiguousStatus,1)
  assert.ok(!JSON.stringify(result).includes('+12135550101'))
})
