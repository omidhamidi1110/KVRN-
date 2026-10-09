/** Offline Svix-signature and Resend suppression extraction tests.
 * NO provider, DB, production API or credentials are used.
 */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const js=ts.transpileModule(readFileSync(resolve('lib/resend-webhook-suppression.ts'),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}
}).outputText
const {verifyResendWebhook,extractResendSuppression}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
let passes=0
const run=async(name,fn)=>{await fn();console.log('PASS',name);passes++}
const keyBytes=new Uint8Array(Array.from({length:32},(_,i)=>i+1))
const secret='whsec_'+Buffer.from(keyBytes).toString('base64')
const signed=async(payload,id='msg_local_test_1234',epoch=Math.floor(Date.now()/1000))=>{
  const sigKey=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const mac=await crypto.subtle.sign('HMAC',sigKey,new TextEncoder().encode(`${id}.${epoch}.${payload}`))
  const headers=new Headers({'svix-id':id,'svix-timestamp':String(epoch),'svix-signature':'v1,'+Buffer.from(mac).toString('base64')})
  return headers
}
const payload=JSON.stringify({type:'contact.updated',data:{email:'TEST@example.invalid',unsubscribed:true}})
await run('Valid signed raw-body webhook succeeds',async()=>{
  const h=await signed(payload)
  assert.equal(await verifyResendWebhook(payload,h,secret),'msg_local_test_1234')
})
await run('Raw-body changes fail signature validation',async()=>{
  const h=await signed(payload)
  assert.equal(await verifyResendWebhook(payload+' ',h,secret),null)
})
await run('Stale replay and unsigned requests are rejected',async()=>{
  const h=await signed(payload,'msg_local_test_1234',Math.floor(Date.now()/1000)-601)
  assert.equal(await verifyResendWebhook(payload,h,secret),null)
  assert.equal(await verifyResendWebhook(payload,new Headers(),secret),null)
})
await run('Wrong signature and unconfigured secret fail closed',async()=>{
  const h=await signed(payload)
  h.set('svix-signature','v1,'+Buffer.alloc(32,42).toString('base64'))
  assert.equal(await verifyResendWebhook(payload,h,secret),null)
  assert.equal(await verifyResendWebhook(payload,h,''),null)
})
await run('Signing-key rotation accepts only an explicitly configured previous key',async()=>{
  const oldHeaders=await signed(payload)
  const newSecret='whsec_'+Buffer.alloc(32,77).toString('base64')
  assert.equal(await verifyResendWebhook(payload,oldHeaders,newSecret),null)
  assert.equal(await verifyResendWebhook(payload,oldHeaders,[newSecret,secret]),'msg_local_test_1234')
  assert.equal(await verifyResendWebhook(payload,oldHeaders,[newSecret]),null)
  assert.equal(await verifyResendWebhook(payload,oldHeaders,['',newSecret]),null)
  assert.equal(await verifyResendWebhook(payload,oldHeaders,[newSecret,secret,secret]),null)
})
await run('Contact global opt-out captured; opt-in ignored',()=>{
  assert.deepEqual(extractResendSuppression(JSON.parse(payload)),{email:'test@example.invalid',reason:'contact_unsubscribed'})
  assert.equal(extractResendSuppression({type:'contact.updated',data:{email:'test@example.invalid',unsubscribed:false}}),null)
})
await run('Permanent bounces and complaints captured, transient bounces ignored',()=>{
  const evt=(type,bounce)=>({type,data:{to:['test@example.invalid'],bounce}})
  assert.deepEqual(extractResendSuppression(evt('email.bounced',{type:'Permanent'})),{email:'test@example.invalid',reason:'permanent_bounce'})
  assert.equal(extractResendSuppression(evt('email.bounced',{type:'Transient'})),null)
  assert.deepEqual(extractResendSuppression(evt('email.complained',{})),{email:'test@example.invalid',reason:'email_complaint'})
})
await run('Multi-address and malformed suppression requests never silently choose a recipient',()=>{
  assert.equal(extractResendSuppression({type:'email.complained',data:{to:['a@example.invalid','b@example.invalid']}}),null)
  assert.equal(extractResendSuppression({type:'email.complained',data:{to:['not email']}}),null)
})
console.log(`${passes}/${passes} offline Resend webhook tests passed. No provider was contacted.`)
