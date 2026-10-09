import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const ts=require('typescript')
const raw=readFileSync('lib/marketing-one-click-unsubscribe.ts','utf8')
const js=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const x={exports:{}}
new Function('module','exports',js)(x,x.exports)
const {validMarketingOneClickBody:valid,oneClickMarketingUrl:make}=x.exports
const token='v1.11111111-1111-4111-8111-111111111111.'+'a'.repeat(43)
let n=0;const test=(label,fn)=>{fn();n++;console.log('PASS',label)}
test('RFC 8058 exact one-click POST body recognized',()=>assert.equal(valid('application/x-www-form-urlencoded','List-Unsubscribe=One-Click'),true))
test('UTF-8 parameter supported, irrelevant casing not accepted',()=>{assert.equal(valid('application/x-www-form-urlencoded; charset=UTF-8','List-Unsubscribe=One-Click'),true);assert.equal(valid('application/x-www-form-urlencoded','list-unsubscribe=One-Click'),false)})
test('other consent-changing request payloads rejected',()=>{for(const body of ['','List-Unsubscribe=one-click','List-Unsubscribe=One-Click&subscribe=true','List-Unsubscribe=One-Click&List-Unsubscribe=One-Click','token=abc'])assert.equal(valid('application/x-www-form-urlencoded',body),false)})
test('JSON/text and unexpectedly long bodies rejected',()=>{assert.equal(valid('application/json','List-Unsubscribe=One-Click'),false);assert.equal(valid('text/plain','List-Unsubscribe=One-Click'),false);assert.equal(valid('application/x-www-form-urlencoded','x'.repeat(129)),false)})
test('one-click URL binds exact contact signed token',()=>assert.equal(make(`https://kvrn.shop/email-preferences?token=${token}`),`https://kvrn.shop/api/marketing/one-click-unsubscribe?token=${token}`))
test('offsite or malformed tokens cannot be placed into unsubscribe headers',()=>{for(const url of ['https://evil.tld/email-preferences?token='+token,'https://kvrn.shop/other?token='+token, 'https://kvrn.shop/email-preferences?token='+token+'&redirect=evil','https://kvrn.shop/email-preferences?token=bad'])assert.throws(()=>make(url),/INVALID/)})
test('route only handles POST and verifies signed token then persists suppression',()=>{
 const route=readFileSync('app/api/marketing/one-click-unsubscribe/route.ts','utf8')
 assert.match(route,/export async function POST/);assert.match(route,/export async function GET\(\).*405/)
 assert.match(route,/export async function HEAD\(\).*405/)
 assert.match(route,/verifyMarketingUnsubscribe\(token\)/)
 assert.match(route,/revokeMarketingSubscriberById\(subscriberId\)/)
 assert.match(route,/readLimitedText\(req,128\)/)
 assert.match(route,/return reply\(503\)/)
 assert.doesNotMatch(route,/subscribeMarketingSubscriber|sendSms|sendEmail/)
})
console.log(`${n}/${n} one-click unsubscribe checks passed`)

// Execute the actual route with isolated module mocks; no DB/provider/network.
const routeSrc=readFileSync('app/api/marketing/one-click-unsubscribe/route.ts','utf8')
const routeJs=ts.transpileModule(routeSrc,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
let revoked=[],badWrite=false,validSignature=true,limited={ok:true,value:'List-Unsubscribe=One-Click'}
class FakeNextResponse {constructor(body,opts={}){this.body=body;this.status=opts.status;this.headers=opts.headers}}
const routes={exports:{}}
new Function('module','exports','require',routeJs)(routes,routes.exports,name=>{
 if(name==='next/server')return {NextResponse:FakeNextResponse}
 if(name==='@/lib/limited-json-request')return {readLimitedText:async()=>limited}
 if(name==='@/lib/marketing-unsubscribe')return {verifyMarketingUnsubscribe:async()=>validSignature?'11111111-1111-4111-8111-111111111111':null}
 if(name==='@/lib/marketing-one-click-unsubscribe')return {validMarketingOneClickBody:valid}
 if(name==='@/lib/marketing-subscribers')return {revokeMarketingSubscriberById:async id=>{if(badWrite)throw Error('db down');revoked.push(id)}}
 throw Error('unexpected module '+name)
})
const post=routes.exports.POST
const mockRequest=(opts={})=>({nextUrl:{searchParams:new URLSearchParams(opts.query??('token='+token))},headers:{get:(k)=>k==='content-type'?(opts.type??'application/x-www-form-urlencoded'):null}})
async function run(name,fn){await fn();n++;console.log('PASS',name)}
await run('valid signed one-click POST writes one canonical unsubscribe',async()=>{const r=await post(mockRequest());assert.equal(r.status,204);assert.equal(revoked.length,1);assert.equal(r.headers['Cache-Control'],'no-store')})
await run('valid repeat POST remains idempotent by subscriber identity',async()=>{const r=await post(mockRequest());assert.equal(r.status,204);assert.equal(revoked[1],revoked[0])})
await run('invalid signature has no unsubscribe side effect',async()=>{validSignature=false;const before=revoked.length;assert.equal((await post(mockRequest())).status,400);assert.equal(revoked.length,before);validSignature=true})
await run('request with extra query parameters is rejected',async()=>{const before=revoked.length;assert.equal((await post(mockRequest({query:'token='+token+'&redirect=bad'}))).status,400);assert.equal(revoked.length,before)})
await run('incorrect body content and unreadable oversized request rejected',async()=>{limited={ok:true,value:'List-Unsubscribe=One-Click&other=x'};assert.equal((await post(mockRequest())).status,400);limited={ok:false,status:413,reason:'too_large'};assert.equal((await post(mockRequest())).status,400);limited={ok:true,value:'List-Unsubscribe=One-Click'}})
await run('DB suppression failure returns retryable 503 never success',async()=>{badWrite=true;const before=revoked.length;assert.equal((await post(mockRequest())).status,503);assert.equal(revoked.length,before);badWrite=false})
await run('GET and HEAD can never unsubscribe',async()=>{const before=revoked.length;assert.equal((await routes.exports.GET()).status,405);assert.equal((await routes.exports.HEAD()).status,405);assert.equal(revoked.length,before)})
console.log(`${n}/${n} total unsubscribe contract and route tests passed`)
