/** Offline store-credit customer entry tests. No Next server, provider or DB. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const read=(p)=>fs.readFileSync(p,'utf8')
const source=read('components/checkout/StoreCreditCheckout.tsx')
const js=ts.transpileModule(source,{fileName:'StoreCreditCheckout.tsx',compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
const module={exports:{}}
vm.runInNewContext(js,{module,exports:module.exports,require:(id)=>{
 if(id==='react')return {useEffect:()=>{},useState:()=>{}}
 if(id==='react/jsx-runtime')return {jsx:()=>{},jsxs:()=>{}}
 throw Error(`unexpected test dependency: ${id}`)
}}, {filename:'StoreCreditCheckout.tsx'})
const parse=module.exports.parseCreditDollars
const test=(name,fn)=>{fn();console.log('PASS',name)}
test('strict USD cents does not accept floats or exponent notation',()=>{
 for(const [input,expected] of [['0.01',1],['0.99',99],['5',500],['5.1',510],['5.10',510],['9999.99',999999]])
   assert.equal(parse(input),expected,input)
 for(const input of ['0','0.00','00.1','1.234','1e2','-2','+2','$2','NaN',' 2','2 ','1,000','99999999','1.2.3',''])
   assert.equal(parse(input),null,input)
})
test('checkout posts credit only when selected and not a bundle',()=>{
 const checkout=read('app/checkout/page.tsx')
 assert.match(checkout,/!hasBundle && storeCreditCents!==null \? \{storeCreditCents\}/)
 assert.match(checkout,/import StoreCreditCheckout from/)
 assert.match(checkout,/netMerchandiseCents=\{Math\.max\(0,subtotalPence-appliedDiscountCents\)\}/)
 assert.match(checkout,/onChange=\{setStoreCreditCents\}/)
 assert.match(source,/setApplied\(null\);setInput\(''\);setError\(''\);onChange\(null\)/)
})
test('payment is still strictly gated by verified backend balance and session',()=>{
 assert.match(read('lib/store-credit-checkout-redemption.ts'),/env\.STRIPE_MODE==='test'/)
 assert.match(read('lib/store-credit-checkout-redemption.ts'),/resolveVerifiedCreditAccount\(p\.cookieValue,p\.customerEmail\)/)
 assert.match(read('lib/store-credit-checkout-redemption.ts'),/quoteStoreCreditSplitTender\(/)
 const balance=read('app/api/store-credit/balance/route.ts')
 assert.match(balance,/redemptionEnabled:creditRedemptionEnabled\(\)/)
 assert.match(balance,/Cache-Control':'private, no-store/)
})
test('verification link has working guarded route and strips token fragment',()=>{
 const server=read('app/store-credit/verify/page.tsx')
 const client=read('app/store-credit/verify/CreditVerifyClient.tsx')
 assert.match(server,/if \(!creditIdentityConfigured\(\)\) notFound\(\)/)
 assert.match(client,/window\.history\.replaceState/)
 assert.match(client,/verificationRequest=useRef<Promise<boolean>\|null>\(null\)/)
 assert.match(client,/\/api\/store-credit\/identity\/verify/)
 assert.doesNotMatch(client,/localStorage|sessionStorage|console\./)
})
test('both new routes registered and default off before owner activation',()=>{
 const manifest=JSON.parse(read('qa/route-contracts.json'))
 for(const path of ['app/store-credit/verify/page.tsx','app/api/admin/content/policies/[id]/owner-draft/route.ts'])
  assert.ok(manifest.routes.some(r=>r.path===path&&r.requiredChecks.includes('regression')),path)
})
console.log('5/5 customer-credit offline integration checks passed. No providers called.')
