/** Offline Resend adapter safety tests. No secrets, network or database connections. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
let ts
try { ts=require('typescript') } catch { ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript') }
const js=ts.transpileModule(readFileSync(resolve('lib/resend-marketing.ts'),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}
}).outputText
const {syncSubscribeToResend,syncUnsubscribeFromResend}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const priorFetch=globalThis.fetch
const keys=['RESEND_MARKETING_API_KEY','RESEND_MARKETING_SEGMENT_ID','RESEND_MARKETING_TOPIC_ID']
const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
let passed=0
const run=async(name,fn)=>{await fn();console.log('PASS',name);passed++}
function mock(...responses){
  const calls=[]
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options})
    const response=responses[Math.min(calls.length-1,responses.length-1)]
    return{ok:response.ok,status:response.status??(response.ok?200:400),json:async()=>response.data??{}}
  }
  return calls
}
try{
  process.env.RESEND_MARKETING_API_KEY='test-only-fake-key'
  process.env.RESEND_MARKETING_SEGMENT_ID='seg-test'
  process.env.RESEND_MARKETING_TOPIC_ID='topic-test'
  const valid={email:'test@example.invalid',firstName:null,lastName:null}
  const goodContact={ok:true,data:{id:'c1',email:valid.email,unsubscribed:false}}
  const clearTopics={ok:true,data:{data:[],has_more:false}}
  const optedInTopics={ok:true,data:{data:[{id:'topic-test',subscription:'opt_in'}],has_more:false}}
  const optedOutTopics={ok:true,data:{data:[{id:'topic-test',subscription:'opt_out'}],has_more:false}}
  await run('No provider unsubscribe reset on contact upsert',async()=>{
    const calls=mock({ok:true,data:{id:'c1'}},goodContact,clearTopics,{ok:true},{ok:true},optedInTopics,goodContact)
    const result=await syncSubscribeToResend(valid)
    assert.equal(result.ok,true)
    assert.equal(calls.length,7)
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(calls[0].options.body),'unsubscribed'),false)
    assert.equal(calls[1].options.method,'GET')
    assert.ok(calls[1].url.endsWith('/contacts/c1'))
    assert.equal(calls[2].options.method,'GET')
    assert.ok(calls[2].url.endsWith('/contacts/c1/topics'))
    assert.deepEqual(JSON.parse(calls[4].options.body),{topics:[{id:'topic-test',subscription:'opt_in'}]})
  })
  await run('Provider topic-level opt-out cannot be overwritten by signup sync',async()=>{
    const calls=mock({ok:true,data:{id:'c1'}},goodContact,{ok:true,data:{data:[{id:'topic-test',subscription:'opt_out'}]}})
    const result=await syncSubscribeToResend(valid)
    assert.equal(result.ok,false)
    assert.equal(result.providerTopicOptOut,true)
    assert.match(result.error,/topic opted out/)
    assert.equal(calls.length,3)
  })
  await run('Unknown/paginated topic subscriptions block marketing opt-in',async()=>{
    for(const third of [{ok:false,status:503},{ok:true,data:{data:[],has_more:true}},{ok:true,data:{unexpected:[]}}]){
      const calls=mock({ok:true,data:{id:'c1'}},goodContact,third)
      assert.equal((await syncSubscribeToResend(valid)).ok,false)
      assert.equal(calls.length,3)
    }
  })
  await run('Post-sync topic recheck must confirm opted-in state',async()=>{
    const calls=mock({ok:true,data:{id:'c1'}},goodContact,clearTopics,{ok:true},{ok:true},{ok:true,data:{data:[{id:'topic-test',subscription:'opt_out'}]}},goodContact)
    const result=await syncSubscribeToResend(valid)
    assert.equal(result.ok,false)
    assert.match(result.error,/post-sync/)
    assert.equal(calls.length,7)
  })
  await run('Provider-suppressed contacts never enter topic or segment',async()=>{
    const calls=mock({ok:true,data:{id:'c1',unsubscribed:true}})
    const result=await syncSubscribeToResend(valid)
    assert.equal(result.ok,false)
    assert.match(result.error,/Provider-suppressed/)
    assert.equal(calls.length,1)
  })
  await run('Suppressed nested contact metadata is honored',async()=>{
    const calls=mock({ok:true,data:{contact:{id:'c1',unsubscribed:true}}})
    assert.equal((await syncSubscribeToResend(valid)).ok,false)
    assert.equal(calls.length,1)
  })
  await run('Contact creation with absent opt-out flag requires provider GET confirmation',async()=>{
    const calls=mock({ok:true,data:{id:'c1'}},{ok:true,data:{id:'c1',unsubscribed:true}})
    const result=await syncSubscribeToResend(valid)
    assert.equal(result.ok,false)
    assert.match(result.error,/Provider consent status unknown or suppressed/)
    assert.equal(calls.length,2)
    assert.equal(calls[1].options.method,'GET')
  })
  await run('Missing provider unsubscribe status fails closed even after successful GET',async()=>{
    const calls=mock({ok:true,data:{id:'c1'}},{ok:true,data:{id:'c1'}})
    const result=await syncSubscribeToResend(valid)
    assert.equal(result.ok,false)
    assert.equal(calls.length,2)
  })
  await run('Provider contact identity must match the approved local address',async()=>{
    const calls=mock({ok:true,data:{id:'c1'}},{ok:true,data:{id:'c1',email:'wrong@example.invalid',unsubscribed:false}})
    const result=await syncSubscribeToResend(valid)
    assert.equal(result.ok,false)
    assert.equal(calls.length,2)
  })
  await run('Unsubscribe missing provider ID remains unverified',async()=>{
    const calls=mock({ok:true})
    const result=await syncUnsubscribeFromResend({contactId:null})
    assert.equal(result.ok,false)
    assert.match(result.error,/reconcile/)
    assert.equal(calls.length,0)
  })
  await run('Unsubscribe without configured topic never claims reconciled',async()=>{
    delete process.env.RESEND_MARKETING_TOPIC_ID
    const calls=mock({ok:true})
    try {
      const result=await syncUnsubscribeFromResend({contactId:'c1'})
      assert.equal(result.ok,false)
      assert.match(result.error,/TOPIC_ID/)
      assert.equal(calls.length,0)
    } finally { process.env.RESEND_MARKETING_TOPIC_ID='topic-test' }
  })
  await run('Unsubscribe opts out topic before segment removal',async()=>{
    const calls=mock({ok:true},{ok:true},optedOutTopics)
    const result=await syncUnsubscribeFromResend({contactId:'c1'})
    assert.equal(result.ok,true)
    assert.equal(calls[0].options.method,'PATCH')
    assert.deepEqual(JSON.parse(calls[0].options.body),{topics:[{id:'topic-test',subscription:'opt_out'}]})
    assert.equal(calls[1].options.method,'DELETE')
  })
  await run('Unknown provider contact ID can be safely resolved by email before opt-out',async()=>{
    const calls=mock(goodContact,goodContact,{ok:true},{ok:true},optedOutTopics)
    const result=await syncUnsubscribeFromResend({contactId:null,email:valid.email})
    assert.equal(result.ok,true)
    assert.equal(result.contactId,'c1')
    assert.equal(calls.length,5)
    assert.equal(calls[0].options.method,'GET')
    assert.ok(calls[0].url.includes('test%40example.invalid'))
    assert.equal(calls[1].options.method,'GET')
    assert.equal(calls[2].options.method,'PATCH')
    assert.equal(calls[3].options.method,'DELETE')
  })
  await run('Mismatched provider email never results in opt-out of another contact',async()=>{
    const calls=mock({ok:true,data:{id:'c1',email:'someone-else@example.invalid'}})
    const result=await syncUnsubscribeFromResend({contactId:null,email:valid.email})
    assert.equal(result.ok,false)
    assert.equal(calls.length,1)
  })
  await run('Stale stored provider ID may not opt out a different email',async()=>{
    const calls=mock({ok:true,data:{id:'c1',email:'wrong@example.invalid'}})
    const result=await syncUnsubscribeFromResend({contactId:'c1',email:valid.email})
    assert.equal(result.ok,false)
    assert.match(result.error,/identity mismatch/)
    assert.equal(calls.length,1)
  })
  await run('Unsubscribe still attempts segment removal when topic opt-out fails',async()=>{
    const calls=mock({ok:false,status:503})
    const result=await syncUnsubscribeFromResend({contactId:'c1'})
    assert.equal(result.ok,false)
    // Best-effort independent segment removal must still be attempted.
    assert.equal(calls.length,2)
    assert.equal(calls[1].options.method,'DELETE')
  })
  await run('Unverified provider opt-out remains pending after successful requests',async()=>{
    const calls=mock({ok:true},{ok:true},{ok:true,data:{data:[]}})
    const result=await syncUnsubscribeFromResend({contactId:'c1'})
    assert.equal(result.ok,false)
    assert.match(result.error,/could not be verified/)
    assert.equal(calls.length,3)
  })
  console.log(`${passed}/${passed} offline Resend safety tests passed. No provider was contacted.`)
}finally{
  globalThis.fetch=priorFetch
  for(const key of keys){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key]}
}
