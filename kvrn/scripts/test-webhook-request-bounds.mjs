/** Real byte-cap tests for consent webhooks. Offline: no provider, DB or app server. */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const source=readFileSync('lib/limited-json-request.ts','utf8')
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
const {readLimitedText,readLimitedJson}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
let passed=0
async function run(name,fn){await fn();passed++;console.log('PASS',name)}
const url='https://kvrn.shop/api/twilio/incoming'
function make(body,options={}){return new Request(url,{method:'POST',body,duplex:'half',...options})}
await run('Valid small webhook returns exact raw bytes',async()=>{
 const raw='From=%2B15555550111&Body=STOP'
 const result=await readLimitedText(make(raw),4096)
 assert.deepEqual(result,{ok:true,value:raw})
})
await run('Declared Content-Length over limit is rejected before reading',async()=>{
 const r=make('a',{headers:{'content-length':'900000'}})
 assert.deepEqual(await readLimitedText(r,4096),{ok:false,status:413,reason:'too_large'})
})
await run('Chunked transfer without Content-Length stops at byte boundary',async()=>{
 const stream=new ReadableStream({start(ctrl){ctrl.enqueue(new TextEncoder().encode('a'.repeat(4000)));ctrl.enqueue(new TextEncoder().encode('b'.repeat(100)));ctrl.close()}})
 assert.deepEqual(await readLimitedText(make(stream),4096),{ok:false,status:413,reason:'too_large'})
})
await run('Exactly at the byte limit succeeds',async()=>{
 const r=await readLimitedText(make('a'.repeat(4096)),4096)
 assert.equal(r.ok,true);assert.equal(r.value.length,4096)
})
await run('Multi-byte characters count UTF-8 bytes, not JS code units',async()=>{
 assert.equal((await readLimitedText(make('🧵'.repeat(1024)),4096)).ok,true)
 assert.equal((await readLimitedText(make('🧵'.repeat(1025)),4096)).status,413)
})
await run('Invalid UTF-8 fails closed',async()=>{
 const result=await readLimitedText(make(new Uint8Array([0xff,0xfe])),4096)
 assert.deepEqual(result,{ok:false,status:400,reason:'invalid'})
})
await run('Bounded JSON reader rejects malformed payloads',async()=>{
 const result=await readLimitedJson(make('{bad'),2048)
 assert.deepEqual(result,{ok:false,status:400,reason:'invalid'})
})
console.log(`${passed}/${passed} offline webhook request-bound tests passed. No services contacted.`)
