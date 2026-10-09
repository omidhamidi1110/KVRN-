import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const UUID='11a11111-1111-4111-8111-111111111111'
const execution={planId:UUID,memberId:3,approvalId:UUID,budgetReservationId:UUID,evidenceId:UUID,messageSha256:'b'.repeat(64),claimKey:'owner-manual-claim:321',channel:'email'}
const confirmation='I AUTHORIZE ONE APPROVED MARKETING MESSAGE'
const env={NODE_ENV:'production',KVRN_RUNTIME_ENV:'staging',MARKETING_OWNER_EXECUTION_HTTP_ENABLED:'true',
 MARKETING_OWNER_SEND_RELEASE_ENABLED:'true',MARKETING_SEND_ENABLED:'true',MARKETING_PROVIDER_DELIVERY_ENABLED:'true',
 MARKETING_CLAIM_RESOLVER_ENABLED:'true',MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED:'true',
 MARKETING_PROVIDER_RECEIPTS_ENABLED:'true'}
const mod={exports:{}}
const source=readFileSync('lib/marketing-owner-execution-gate.ts','utf8')
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {module:mod,exports:mod.exports,Object,String,Array,Number,Error,require:n=>{
 if(n==='./marketing-execution-coordinator')return {isValidExecutionInput:x=>JSON.stringify(x)===JSON.stringify(execution)}
 throw Error('Untrusted import '+n)
 }})
const f=mod.exports
let n=0;const test=(label,cb)=>{cb();n++;console.log('PASS',label)}
test('no owner-approved HTTP route active by default',()=>assert.equal(f.ownerApprovedExecutionAllowed({}),false))
test('deployed staging requires exact runtime and every independent release flag',()=>{
 for(const key of Object.keys(env).filter(k=>!['NODE_ENV','KVRN_RUNTIME_ENV'].includes(k)))assert.equal(f.ownerApprovedExecutionAllowed({...env,[key]:'false'}),false,key)
 for(const v of ['local','preview','dev',undefined])assert.equal(f.ownerApprovedExecutionAllowed({...env,KVRN_RUNTIME_ENV:v}),false)
 assert.equal(f.ownerApprovedExecutionAllowed(env),true)
})
test('production requires separate written release flag',()=>{
 assert.equal(f.ownerApprovedExecutionAllowed({...env,KVRN_RUNTIME_ENV:'production'}),false)
 assert.equal(f.ownerApprovedExecutionAllowed({...env,KVRN_RUNTIME_ENV:'production',KVRN_MARKETING_PRODUCTION_OWNER_APPROVED:'true'}),true)
})
test('no test/node-undefined environments can send',()=>{
 for(const v of ['test',undefined])assert.equal(f.ownerApprovedExecutionAllowed({...env,NODE_ENV:v}),false)
})
test('strict single-recipient confirmation with no contact or list supplied',()=>{
 assert.equal(f.validOwnerApprovedExecutionRequest({confirm:confirmation,input:execution}),true)
 for(const raw of [null,{},[],{confirm:'yes',input:execution},{confirm:confirmation,input:execution,recipient:'other@example.com'},
  {confirm:confirmation,input:{...execution,email:'other@example.com'}},{confirm:confirmation,input:[execution]}])assert.equal(f.validOwnerApprovedExecutionRequest(raw),false)
})
test('owner-only no-send-default route calls single-attempt trusted existing coordinator',()=>{
 const s=readFileSync('app/api/admin/marketing/execute-approved-once/route.ts','utf8')
 for(const needle of ['ownerApprovedExecutionAllowed(process.env)','requireAdmin(req)','isConfiguredMarketingOwner','readAdminMutationJson(req,2400)','validOwnerApprovedExecutionRequest','attemptTrustedMarketingDeliveryOnce'])assert.ok(s.includes(needle),needle)
 for(const term of ['sendBroadcast','sendMany','scheduleRecurring','setInterval(','email_subscriber_id','phone_e164','recipient:'])assert.equal(s.includes(term),false,term)
 assert.match(s,/canRetry:false,costSettled:false,providerDeliveryVerified:false/)
})
let adminAllowed=true,ownerAllowed=true,requestValid=true,executeCalls=0
const routeMod={exports:{}}
const routeJs=ts.transpileModule(readFileSync('app/api/admin/marketing/execute-approved-once/route.ts','utf8'),
 {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const deps={
 'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}},
 '@/lib/admin-auth':{requireAdmin:async()=>adminAllowed?{identity:{email:'owner@example.com'},error:null}:{error:{status:401}}},
 '@/lib/admin-mutation-safety':{readAdminMutationJson:async()=>requestValid?{ok:true,value:{confirm:confirmation,input:execution}}:{ok:false,status:403}},
 '@/lib/marketing-owner-approval':{isConfiguredMarketingOwner:()=>ownerAllowed},
 '@/lib/marketing-owner-execution-gate':{ownerApprovedExecutionAllowed:f.ownerApprovedExecutionAllowed,validOwnerApprovedExecutionRequest:f.validOwnerApprovedExecutionRequest},
 '@/lib/marketing-server-execution':{attemptTrustedMarketingDeliveryOnce:async()=>{executeCalls++;return {state:'claimed_unknown',attemptId:UUID}}},
}
vm.runInNewContext(routeJs,{module:routeMod,exports:routeMod.exports,process:{env:{}},require:name=>{
 if(!deps[name])throw Error('Unexpected route import '+name);return deps[name]
},Promise,Object,String,Array,Error})
const {POST}=routeMod.exports
const context={POST}
async function routeTest(label,run){await run();n++;console.log('PASS',label)}
// The production flags are injected only in this offline VM; never into the real app.
await routeTest('disabled route returns 404 with no execution',async()=>{
 const resp=await POST({})
 assert.equal(resp.status,404);assert.equal(executeCalls,0)
})
await routeTest('unauthorized and non-owner requests cannot call provider',async()=>{
 Object.assign(context,{})
 const e={...env}
 // Replace the in-memory env object, not process.env.
 const fn=routeJs
 const mount=vm.createContext({module:{exports:{}},exports:{},process:{env:e},require:name=>deps[name],Promise,Object,String,Array,Error})
 mount.exports=mount.module.exports
 vm.runInContext(fn,mount)
 adminAllowed=false;assert.equal((await mount.module.exports.POST({})).status,401)
 adminAllowed=true;ownerAllowed=false;assert.equal((await mount.module.exports.POST({})).status,403)
 assert.equal(executeCalls,0);ownerAllowed=true
 requestValid=false;assert.equal((await mount.module.exports.POST({})).status,403)
 assert.equal(executeCalls,0);requestValid=true
 const resp=await mount.module.exports.POST({})
 assert.equal(resp.status,200);assert.equal(resp.body.canRetry,false)
 assert.equal(resp.body.costSettled,false);assert.equal(resp.body.providerDeliveryVerified,false)
 assert.equal(executeCalls,1)
 assert.doesNotMatch(JSON.stringify(resp.body),/email|phone|recipient|message_body/)
})
console.log(`${n}/${n} owner-approved single-recipient execution checks passed; no sends.`)
