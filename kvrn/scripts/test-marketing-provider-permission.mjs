import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const content=readFileSync('lib/marketing-provider-permission.ts','utf8')
const js=ts.transpileModule(content,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const mod={exports:{}}
new Function('module','exports',js)(mod,mod.exports)
const check=mod.exports.verifyMarketingProviderPermission
const read=mod.exports.readBoundedProviderJson
const env={...process.env},oldFetch=globalThis.fetch
let count=0,network=0,contact={id:'contact_abc123',email:'person@example.com',unsubscribed:false},topics={data:[{id:'topic_abc123',subscription:'opt_in'}],has_more:false}
const response=(obj,opts={})=>new Response(JSON.stringify(obj),opts)
async function t(label,fn){await fn();count++;console.log('PASS',label)}
globalThis.fetch=async url=>{network++;return response(String(url).endsWith('/topics')?topics:contact)}
try{
 await t('default-off blocks before provider network',async()=>{delete process.env.MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED;assert.equal(await check('email','person@example.com','contact_abc123'),false);assert.equal(network,0)})
 process.env.MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED='true';process.env.RESEND_MARKETING_API_KEY='dummy';process.env.RESEND_MARKETING_TOPIC_ID='topic_abc123'
 await t('Twilio SMS authorization cannot be inferred from local record',async()=>{assert.equal(await check('sms','+15555551234','subscriber_id'),false);assert.equal(network,0)})
 await t('valid exact Resend contact and active program topic eligible as provider-side permission',async()=>{assert.equal(await check('email','person@example.com','contact_abc123'),true);assert.equal(network,2)})
 await t('contact mismatch and provider unsubscribe win',async()=>{contact={id:'contact_abc123',email:'elsewhere@example.com',unsubscribed:false};assert.equal(await check('email','person@example.com','contact_abc123'),false);contact={id:'contact_abc123',email:'person@example.com',unsubscribed:true};assert.equal(await check('email','person@example.com','contact_abc123'),false);contact.unsubscribed=false})
 await t('topic-level opt out, missing topic, unknown pagination and pagination true all block',async()=>{for(const q of [{data:[{id:'topic_abc123',subscription:'opt_out'}],has_more:false},{data:[],has_more:false},{data:[{id:'topic_abc123',subscription:'opt_in'}],has_more:true},{data:[{id:'topic_abc123',subscription:'opt_in'}]}]){topics=q;assert.equal(await check('email','person@example.com','contact_abc123'),false)};topics={data:[{id:'topic_abc123',subscription:'opt_in'}],has_more:false}})
 await t('invalid IDs and contact email rejected without requests',async()=>{const before=network;for(const id of ['bad/../path','',null])assert.equal(await check('email','person@example.com',id),false);assert.equal(await check('email','invalid','contact_abc123'),false);assert.equal(network,before)})
 await t('missing provider configuration blocks',async()=>{delete process.env.RESEND_MARKETING_TOPIC_ID;const before=network;assert.equal(await check('email','person@example.com','contact_abc123'),false);assert.equal(network,before)})
 await t('streaming response refuses no body and malformed JSON',async()=>{assert.equal(await read(new Response(null)),null);assert.equal(await read(new Response('not-json')),null);assert.equal(await read(new Response('[]')),null)})
 await t('response read bounded by declared content-length, including invalid declarations',async()=>{for(const hdr of ['70000','-1','1e6','999999999999999999999999999999999999'])assert.equal(await read(new Response('{}',{headers:{'content-length':hdr}})),null)})
 await t('chunked oversized responses are cut off before fully buffered',async()=>{
  let pulls=0,cancelled=false
  const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(35000));if(pulls===3)c.close()},cancel(){cancelled=true}})
  assert.equal(await read(new Response(stream)),null)
  assert.ok(cancelled);assert.ok(pulls<=3)
 })
 await t('truncated or invalid utf-8 provider response blocked',async()=>{
  assert.equal(await read(new Response(new Uint8Array([0xff,0xfe,0xfd]))),null)
 })
 await t('non-success provider responses cannot be trusted',async()=>assert.equal(await read(new Response(JSON.stringify(contact),{status:429})),null))
 await t('duplicate topic rows never establish permission',async()=>{topics={data:[{id:'topic_abc123',subscription:'opt_in'},{id:'topic_abc123',subscription:'opt_out'}],has_more:false};assert.equal(await check('email','person@example.com','contact_abc123'),false);topics={data:[{id:'topic_abc123',subscription:'opt_in'}],has_more:false}})
}finally{
 for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k]
 Object.assign(process.env,env)
 globalThis.fetch=oldFetch
}
console.log(`${count}/${count} current provider permission checks passed`)
