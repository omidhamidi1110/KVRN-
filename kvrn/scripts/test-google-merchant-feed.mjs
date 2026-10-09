/** Offline catalog feed invariants; no imports of the DB, Stripe or next runtime. */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
const ts=require('typescript')
const transpiled=ts.transpileModule(readFileSync('lib/google-merchant-feed.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true})
assert.equal(transpiled.diagnostics?.length||0,0)
const exports={}
vm.runInNewContext(transpiled.outputText,{exports,URL,Error,Set,Array,Number,RegExp},{filename:'google-merchant-feed.cjs'})
const {makeMerchantProductFeed,validatedMerchantOrigin}=exports
function sample(id='123e4567-e89b-42d3-a456-426614174000'){
 return {productId:id,slug:'project-kvrn-heavyweight-hoodie',availability:'InStock',
   ogImage:{url:'https://kvrn.shop/images/hoodie.webp'},imageUrls:[],
   product:{name:'Hoodie & Jacket <Offer>',description:'400 GSM & warm',price:8000,hidden:false}}
}
const cases=[
 ['reject bad protocol',()=>assert.equal(validatedMerchantOrigin('http://kvrn.shop'),null)],
 ['reject spoofed canonical origin',()=>assert.equal(validatedMerchantOrigin('https://kvrn.shop.evil.com'),null)],
 ['reject missing availability',()=>assert.equal(makeMerchantProductFeed([{...sample(),availability:null}],'https://kvrn.shop').included,0)],
 ['reject zero price',()=>assert.equal(makeMerchantProductFeed([{...sample(),product:{...sample().product,price:0}}],'https://kvrn.shop').included,0)],
 ['reject missing image',()=>assert.equal(makeMerchantProductFeed([{...sample(),ogImage:null}],'https://kvrn.shop').included,0)],
 ['reject hidden product',()=>assert.equal(makeMerchantProductFeed([{...sample(),product:{...sample().product,hidden:true}}],'https://kvrn.shop').included,0)],
 ['reject invalid path slug',()=>assert.equal(makeMerchantProductFeed([{...sample(),slug:'../../admin'}],'https://kvrn.shop').included,0)],
 ['reject duplicated canonical product identifier',()=>assert.equal(makeMerchantProductFeed([sample(),sample()],'https://kvrn.shop').included,1)],
 ['encode price from USD cents, escape text, preserve real availability',()=>{
   const r=makeMerchantProductFeed([sample()],'https://kvrn.shop')
   assert.equal(r.included,1)
   assert.match(r.xml,/<g:price>80\.00 USD<\/g:price>/)
   assert.match(r.xml,/<g:availability>in_stock<\/g:availability>/)
   assert.match(r.xml,/Hoodie &amp; Jacket &lt;Offer&gt;/)
   assert.doesNotMatch(r.xml,/<title>Hoodie & Jacket <Offer><\/title>/)
 }],
 ['out of stock stays out of stock',()=>assert.match(makeMerchantProductFeed([{...sample(),availability:'OutOfStock'}],'https://kvrn.shop').xml,/<g:availability>out_of_stock/)],
]
for(const [name,fn] of cases){fn();console.log('PASS',name)}
console.log(`${cases.length}/${cases.length} offline merchant feed assertions passed`)
