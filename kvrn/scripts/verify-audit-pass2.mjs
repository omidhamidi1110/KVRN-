// Dependency-free regression contract for the second merged AI/Admin audit.
// These guards do not replace the full Jest, Postgres or live-service suites.
import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
const src = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const checks = [
  ['shipping-rate input + safe subtotal', 'app/api/shipping-rates/route.ts', ['parseShippingQuoteInput(raw)', 'getSubtotalCentsForItems(items)', 'readLimitedJson(req, 8192)', "bucket: 'shipping_quote'"]],
  ['checkout abuse + true size cap', 'app/api/checkout/session/route.ts', ["bucket: 'checkout_session'", 'readLimitedJson(req.clone(), 32 * 1024)', 'checkoutPost(req)']],
  ['discount preview authority', 'app/api/discounts/validate/route.ts', ['getSubtotalCentsForItems(cartItems)', "bucket: 'discount_preview'", 'readLimitedJson(req, 8 * 1024)']],
  ['SMS create throttle', 'app/api/sms/claim/start/route.ts', ["bucket: 'sms_claim_start'"]],
  ['SMS resolve throttle + bounds', 'app/api/sms/claim/resolve/route.ts', ["bucket: 'sms_claim_resolve'", 'readLimitedJson(req, 1024)']],
  ['subscribe throttle + bounds', 'app/api/marketing/subscribe/route.ts', ["bucket: 'marketing_subscribe'", 'readLimitedJson(req, 2048)']],
  ['order tracking throttle + bounds', 'app/api/order-tracking/route.ts', ["bucket: 'order_tracking'", 'readLimitedJson(req, 2048)']],
  ['bundle quote bounded', 'app/api/bundles/quote/route.ts', ['readLimitedJson(req, MAX_BODY_BYTES)', "bucket: 'bundle_quote'"]],
  ['affiliate applications bounded', 'app/api/affiliates/apply/route.ts', ['readLimitedJson(req, MAX_BODY)']],
  ['recovery links bounded', 'app/api/checkout/recover/route.ts', ['readLimitedJson(req, MAX_BODY_BYTES)']],
  ['Stripe webhook bounded', 'app/api/stripe/webhook/route.ts', ['readLimitedText(req, 1024 * 1024)', 'verifyWebhookSignature(rawBody, sigHeader, secret)']],
  ['signed admin JWT issuer', 'lib/admin-auth.ts', ['payload.iss !== `https://${TEAM_DOMAIN}`', 'crypto.subtle.verify', "header.alg !== 'RS256'"]],
  ['fail closed on restock signup', 'app/api/notify-me/route.ts', ['success: false', 'status: 503']],
  ['fail closed on shipping database outage', 'lib/checkout-session-handler.ts', ['await getProductShippingData()']],
  ['abandoned sweep exposes failures', 'lib/abandoned-checkout.ts', ['ABANDONED_SWEEP_FAILED']],
  ['Shippo provider size/time limits', 'lib/shippo.ts', ['AbortSignal.timeout(12_000)']],
]
let assertions = 0
for (const [name, file, needles] of checks) {
  const body = src(file)
  for (const needle of needles) {
    assert.ok(body.includes(needle), `FAIL ${name}: missing ${needle} in ${file}`)
    assertions++
  }
}
const pure = String.raw`
import { strict as a } from 'node:assert'
import { readLimitedJson, readLimitedText } from './lib/limited-json-request.ts'
import { parseShippingQuoteInput } from './lib/shipping-quote-input.ts'
const req=(s, h={})=>new Request('https://example.test/',{method:'POST', body:s, headers:h})
a.deepEqual(await readLimitedJson(req('{"x":1}'),100),{ok:true,value:{x:1}})
a.equal((await readLimitedJson(req('{'),100)).status,400)
a.equal((await readLimitedJson(req(' '.repeat(200)),100)).status,413)
a.equal((await readLimitedText(req(' '.repeat(200),{'content-length':'1'}),100)).status,413)
a.equal((await readLimitedText(req('{"event":1}'),100)).value,'{"event":1}')
a.equal((await readLimitedText(new Request('https://x.test/',{method:'POST',body:new Uint8Array([255])}),100)).status,400)
a.equal(parseShippingQuoteInput({items:[{sku:'A', quantity:2}]}).ok,true)
a.equal(parseShippingQuoteInput({items:[{sku:'A', quantity:2},{sku:'A',quantity:1}]}).ok,false)
a.equal(parseShippingQuoteInput({items:[{sku:'A',quantity:11}]}).ok,false)
a.equal(parseShippingQuoteInput({items:Array.from({length:21},(_,i)=>({sku:'S'+i,quantity:1}))}).ok,false)
a.equal(parseShippingQuoteInput({items:[{sku:'A',quantity:10},{sku:'B',quantity:10},{sku:'C',quantity:10},{sku:'D',quantity:1}]}).ok,false)
`
execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--input-type=module', '-e', pure], { cwd: new URL('../', import.meta.url), stdio: ['ignore','pipe','pipe'] })
console.log(`PASS: Audit Pass 2 ${assertions} source guards + 11 executable input/size cases`)
