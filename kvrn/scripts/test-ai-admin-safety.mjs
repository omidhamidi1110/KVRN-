/** Offline, pure AI mutation authorization tests — NO AI providers or DB. */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const req=createRequire(import.meta.url)
const ts=req('typescript')
const compiled=ts.transpileModule(readFileSync('lib/ai/admin-control-safety.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}
}).outputText
const exports={}
vm.runInNewContext(compiled,{exports,process:{env:{}},Number,Object,Set,RegExp}, {filename:'lib/ai/admin-control-safety.ts'})
const {validateAiAgentEdit:agent,validateAiBudgetLockInput:budget,validateAiNotificationSettings:settings}=exports
let passed=0
function test(name,body){body();passed++;console.log('PASS',name)}
const off={AI_ENABLED:'false',AI_HIGH_AUTONOMY_OWNER_APPROVED:'false',AI_EXTERNAL_BUDGET_CAP_CONFIRMED:'false'}
const ready={AI_ENABLED:'true',AI_HIGH_AUTONOMY_OWNER_APPROVED:'true',AI_EXTERNAL_BUDGET_CAP_CONFIRMED:'true'}
test('agent reference validated',()=>{
 for(const id of ['','BAD','a','a'.repeat(80),'chief;drop'])assert.equal(agent({id,enabled:false},off).ok,false)
 assert.equal(agent({id:'chief',enabled:false},off).ok,true)
})
test('unknown agent inputs and invalid autonomy blocked',()=>{
 for(const payload of [{id:'chief',enabled:'false'},{id:'chief',autonomyLevel:'unbounded'},{id:'chief',enabled:true,extra:true},{id:'chief'},{id:'chief',enabled:1}])assert.equal(agent(payload,ready).ok,false)
})
test('global AI switch off prevents agent reenable',()=>assert.equal(agent({id:'chief',enabled:true},off).ok,false))
test('low-autonomy configuration remains editable while global AI off',()=>{
 assert.equal(agent({id:'chief',autonomyLevel:'shadow'},off).ok,true)
 assert.equal(agent({id:'chief',autonomyLevel:'approval'},off).ok,true)
})
test('trusted/limited require three simultaneous explicit gates',()=>{
 for(const key of Object.keys(ready)){
  const bad={...ready,[key]:'false'}
  assert.equal(agent({id:'chief',autonomyLevel:'trusted'},bad).ok,false)
  assert.equal(agent({id:'chief',autonomyLevel:'limited'},bad).ok,false)
 }
 assert.equal(agent({id:'chief',autonomyLevel:'trusted'},ready).ok,true)
})
test('locking budget is permitted while AI disabled',()=>assert.equal(budget({manuallyLocked:true},off).ok,true))
test('unlock never bypasses external cap or global off',()=>{
 assert.equal(budget({manuallyLocked:false},off).ok,false)
 assert.equal(budget({manuallyLocked:false},{AI_ENABLED:'true',AI_EXTERNAL_BUDGET_CAP_CONFIRMED:'false'}).ok,false)
 assert.equal(budget({manuallyLocked:false},ready).ok,true)
})
test('budget disallows extra keys and coercion',()=>{
 for(const payload of [{manuallyLocked:'false'},{manuallyLocked:true,limitUsd:9999},{},null])assert.equal(budget(payload,ready).ok,false)
})
const valid={businessTimezone:'America/Los_Angeles',dailyBriefHourLocal:19,quietHoursEnabled:true,quietHoursStartLocal:22,quietHoursEndLocal:8,noncriticalPushLimitDay:3}
test('notification settings exact expected payload',()=>assert.equal(settings(valid),true))
test('notification settings reject unauthorized keys and coerced booleans',()=>{
 for(const payload of [{...valid,quietHoursEnabled:'false'},{...valid,dailyBriefHourLocal:'19'},{...valid,unlimitedMessages:true},{...valid,businessTimezone:'x'.repeat(101)},{...valid,noncriticalPushLimitDay:1000}])assert.equal(settings(payload),false)
})
test('AI mutating routes use bounded origin-protected requests',()=>{
 for(const f of ['agents','settings','budget']){
  const source=readFileSync(`app/api/admin/ai/${f}/route.ts`,'utf8')
  assert.match(source,/readAdminMutationJson\(req,\d+\)/)
  assert.doesNotMatch(source,/\breq\.json\(/)
 }
})
console.log(`${passed}/${passed} offline AI mutation guards pass`)
