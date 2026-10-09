/** Node-only offline domain checks; do NOT connect to KVRN production, providers, or DB.
 * This supplements, never replaces, Jest/Playwright/staging integration tests.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let ts
try { ts = require('typescript') } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript') }
function localModuleUrl(path, seen = new Set()) {
  const file = resolve(path)
  if (seen.has(file)) throw Error('CIRCULAR_OFFLINE_TEST_IMPORT')
  seen.add(file)
  const code = readFileSync(file, 'utf8')
  let js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  // The offline harness imports transpiled TS from data: URLs. Resolve any
  // local pure-domain dependencies explicitly; data: URLs have no relative
  // module base. This never executes the Next server or contacts providers.
  js = js.replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g, (_match, _quote, specifier) => {
    const dependency = resolve(dirname(file), `${specifier}.ts`)
    return `from '${localModuleUrl(dependency, new Set(seen))}'`
  })
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
async function load(path) {
  return import(localModuleUrl(path))
}
let count=0
async function check(label, action) { await action(); console.log('PASS',label); count++ }
const {validatePublicEmailConsent} = await load('lib/marketing-email-consent.ts')
await check('Only explicit true email consent is eligible',()=>{
  assert.equal(validatePublicEmailConsent({emailMarketingConsent:true},'homepage').ok,true)
  for(const bad of [false, 'true', undefined, 1])assert.equal(validatePublicEmailConsent({emailMarketingConsent:bad},'homepage').ok,false)
})
await check('SMS, checkout and forged sources never become email marketing consent',()=>{
  for(const bad of [{phone:'555',emailMarketingConsent:true},{smsConsent:true,emailMarketingConsent:true},{source:'checkout',emailMarketingConsent:true},{source:'manual_admin',emailMarketingConsent:true}])assert.equal(validatePublicEmailConsent(bad,'homepage').ok,false)
  assert.deepEqual(validatePublicEmailConsent({source:'homepage',emailMarketingConsent:true},'waitlist'),{ok:true,source:'waitlist'})
})
const {PROPOSED_MARKETING_LIMITS,preflightMarketingDispatch}=await load('lib/marketing-dispatch-policy.ts')
const candidate={channel:'sms',recipientCount:10,smsSegmentsPerRecipient:1,priceMicrosPerRecipient:110000,spentDayMicros:0,reservedDayMicros:0,spentMonthMicros:0,reservedMonthMicros:0,isAiSelected:false,ownerApproved:true,consentVerified:true,suppressionRechecked:true,providerApproved:true,withinRecipientQuietHours:true,recipientFrequencyOk:true,pricingVerified:true,masterMarketingSwitchOn:true,immutableAudienceSnapshot:true,
 evaluatedAtUtc:new Date('2026-10-08T17:00:00Z'),
 recipientWindows:Array.from({length:10},()=>({timezone:'America/Los_Angeles',timezoneVerified:true,jurisdictionRuleVerified:true}))}
await check('Marketing cost preflight never authorizes sending',()=>{
  assert.equal(preflightMarketingDispatch(candidate).permittedToAttemptAtomicReservation,true)
  assert.equal(preflightMarketingDispatch({...candidate,masterMarketingSwitchOn:false}).permittedToAttemptAtomicReservation,false)
  assert.ok(preflightMarketingDispatch({...candidate,masterMarketingSwitchOn:false}).reasons.includes('marketing_disabled'))
})
await check('Unknown pricing, large audiences, quiet hours and daily caps fail closed',()=>{
  for(const variant of [{priceMicrosPerRecipient:null},{recipientCount:51},{withinRecipientQuietHours:false},{reservedDayMicros:2_500_000}])assert.equal(preflightMarketingDispatch({...candidate,...variant}).permittedToAttemptAtomicReservation,false)
})
await check('Large individually-safe sums use exact BigInt accounting',()=>{
  const limit={...PROPOSED_MARKETING_LIMITS,smsMonthlyMicros:Number.MAX_SAFE_INTEGER,smsDailyMicros:Number.MAX_SAFE_INTEGER}
  const huge={...candidate,limits:limit,priceMicrosPerRecipient:1,recipientCount:1,spentMonthMicros:Number.MAX_SAFE_INTEGER-1,reservedMonthMicros:1,spentDayMicros:Number.MAX_SAFE_INTEGER-1,reservedDayMicros:1}
  const verdict=preflightMarketingDispatch(huge)
  assert.equal(verdict.permittedToAttemptAtomicReservation,false)
  assert.ok(verdict.reasons.includes('monthly_cap')&&verdict.reasons.includes('daily_cap'))
})
const {estimateSmsSegments}=await load('lib/sms-segment-estimate.ts')
await check('SMS preview estimates GSM extension characters and emoji segments only',()=>{
  assert.deepEqual(estimateSmsSegments('^'.repeat(81)),{encoding:'GSM-7',units:162,segments:2,estimatedOnly:true})
  assert.deepEqual(estimateSmsSegments('😀'.repeat(35)),{encoding:'UCS-2',units:70,segments:1,estimatedOnly:true})
  assert.equal(estimateSmsSegments('😀'.repeat(36)).segments,2)
})
const {signMarketingUnsubscribe,verifyMarketingUnsubscribe}=await load('lib/marketing-unsubscribe.ts')
await check('Signed unsubscribe links are opaque and tamper evident',async()=>{
  const id='123e4567-e89b-42d3-a456-426614174000'
  const old=process.env.MARKETING_UNSUBSCRIBE_SECRET
  process.env.MARKETING_UNSUBSCRIBE_SECRET='local-only-32-character-test-secret-do-not-reuse'
  try{
    const token=await signMarketingUnsubscribe(id)
    assert.equal(await verifyMarketingUnsubscribe(token),id)
    assert.equal(await verifyMarketingUnsubscribe(token.replace(id,'123e4567-e89b-42d3-a456-426614174001')),null)
    const pos=token.lastIndexOf('.')+12
    const forged=token.slice(0,pos)+(token[pos]==='A'?'B':'A')+token.slice(pos+1)
    assert.equal(await verifyMarketingUnsubscribe(forged),null)
    delete process.env.MARKETING_UNSUBSCRIBE_SECRET
    assert.equal(await verifyMarketingUnsubscribe(token),null)
  }finally{if(old===undefined)delete process.env.MARKETING_UNSUBSCRIBE_SECRET;else process.env.MARKETING_UNSUBSCRIBE_SECRET=old}
})
const {calculateStoreCredit}=await load('lib/store-credit-domain.ts')
await check('Credit fold preserves issued, available, held, redeemed and idempotent amounts',()=>{
 const events=[
   {idempotencyKey:'return-1',type:'issue',amountCents:5000,approvedReturnId:'return-1'},
   {idempotencyKey:'hold-1',type:'hold',amountCents:2000,holdId:'hold-1'},
   {idempotencyKey:'capture-1',type:'capture',amountCents:2000,holdId:'hold-1',orderId:'order-1'},
 ]
 assert.deepEqual(calculateStoreCredit([...events,events[2]]),{issuedCents:5000,redeemedCents:2000,availableCents:3000,heldCents:0,outstandingCents:3000,eventCount:3})
 assert.throws(()=>calculateStoreCredit([...events,{...events[2],amountCents:3000}]),/IDEMPOTENCY_CONFLICT/)
 assert.throws(()=>calculateStoreCredit([...events,{idempotencyKey:'hold-2',type:'hold',amountCents:4000,holdId:'hold-2'}]),/INSUFFICIENT_CREDIT/)
 assert.throws(()=>calculateStoreCredit([
  {idempotencyKey:'issue-big-1',type:'issue',amountCents:Number.MAX_SAFE_INTEGER,approvedReturnId:'return-big-1'},
  {idempotencyKey:'issue-big-2',type:'issue',amountCents:1,approvedReturnId:'return-big-2'},
 ]),/CREDIT_OVERFLOW/)
})
const { inspectPublishedContent } = await load('lib/content-policy-audit.ts')
await check('CMS policy audit detects legacy seed text but never modifies it',()=>{
  const snapshot={body:{blocks:[{text:'Contact returns@kvrn.shop. All orders include tracking. UK GDPR. Return window is shown in your order confirmation.'}]}}
  const raw=JSON.stringify(snapshot)
  const report=inspectPublishedContent([{entity_type:'faq',entity_id:'main',published_at:'2026-08-12T00:00:00Z',snapshot}])
  assert.equal(JSON.stringify(snapshot),raw)
  assert.ok(report.issues.some(i=>i.entityId==='main'&&i.code==='old_returns_email'))
  assert.ok(report.issues.some(i=>i.code==='tracking_guarantee'))
  assert.ok(report.issues.some(i=>i.code==='old_uk_legal'))
  assert.ok(report.issues.some(i=>i.code==='unbounded_return_window'))
  assert.ok(report.issues.some(i=>i.entityId==='privacy'&&i.code==='no_cms_published_version'))
})
console.log(`${count}/${count} offline domain safety checks passed. No integrations or production systems contacted.`)
