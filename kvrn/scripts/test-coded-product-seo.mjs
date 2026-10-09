/** Offline coded-path SEO regression tests. No DB or Google traffic. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const file='lib/product-seo.ts';const raw=readFileSync(file,'utf8')
const compiled=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
const exports={}
vm.runInNewContext(compiled.outputText,{exports},{filename:file})
const product={name:'Test Product',slug:'visible-product',shortDescription:'Known textile',seo:{title:'Test Product',description:'Test description'},price:8000,productCode:'KVRN-TEST'}
const mk=(emitOffer)=>exports.buildProductJsonLd({product,origin:'https://kvrn.shop',imageUrls:['/images/test.webp'],availability:null,emitOffer})
const checks=[
 ['existing CMS product schema retains canonical-price offers',()=>{const v=mk(undefined);assert.equal(v.offers.price,'80.00');assert.equal(v.offers.priceCurrency,'USD')}],
 ['coded product schema cannot advertise unverified static price',()=>{const v=mk(false);assert.equal(v.offers,undefined);assert.equal(v.name,'Test Product');assert.equal(v.url,'https://kvrn.shop/products/visible-product')}],
 ['coded product schema does not fabricate in-stock status',()=>{const v=mk(false);assert.equal(v.offers,undefined);assert.ok(Array.isArray(v.image))}],
 ['JSON-LD script injection is escaped',()=>{const v=exports.jsonLdString({'@type':'Product',name:'</script><script>alert(1)</script>'});assert.equal(v.includes('</script>'),false);assert.ok(v.includes('u003c'))}],
 ['coded PDP emits stable canonical and noindex for hidden legacy products',()=>{const p=readFileSync('app/products/[slug]/page.tsx','utf8');assert.match(p,/alternates: \{ canonical: productPath\(product\.slug\) \}/);assert.match(p,/product\.hidden \? \{ robots: \{ index: false, follow: true \} \}/)}],
 ['coded PDP skips Product JSON-LD on hidden legacy products',()=>{const p=readFileSync('app/products/[slug]/page.tsx','utf8');assert.match(p,/!product\.hidden && <script type="application\/ld\+json"/);assert.match(p,/emitOffer: false/)}],
 ['CMS PDP continues to use same schema with canonical availability',()=>{const p=readFileSync('app/products/[slug]/page.tsx','utf8');assert.match(p,/availability: hit\.availability/);assert.match(p,/priceCents: r\.price_cents|buildProductJsonLd\(\{/)}],
]
for(const [name,fn] of checks){fn();console.log('PASS',name)}
console.log(`${checks.length}/${checks.length} coded-product SEO guards passed; no provider access.`)
