/** Read-only pure validation for KVRN AI Admin controls.
 * An Admin session alone never authorizes paid or high-autonomy execution.
 * No provider calls or database writes in this module.
 */
export type AiAgentEdit={id:string; enabled:boolean|null;autonomyLevel:'shadow'|'approval'|'limited'|'trusted'|null}
export type AiAgentEditResult={ok:true;value:AiAgentEdit}|{ok:false;status:400|403;error:string}
const AGENT_ID=/^[a-z0-9][a-z0-9_-]{1,63}$/
const AUTONOMY=new Set(['shadow','approval','limited','trusted'])
type AiGuardEnv=Readonly<{AI_ENABLED?:string;AI_HIGH_AUTONOMY_OWNER_APPROVED?:string;AI_EXTERNAL_BUDGET_CAP_CONFIRMED?:string}>
// Narrow the Node environment explicitly; TypeScript's weak-type check does not
// consider ProcessEnv assignable to a type containing only optional known keys.
// Read at call time so runtime feature-gate changes are never cached at import.
function currentAiGuardEnv():AiGuardEnv{
 return {
  AI_ENABLED:process.env.AI_ENABLED,
  AI_HIGH_AUTONOMY_OWNER_APPROVED:process.env.AI_HIGH_AUTONOMY_OWNER_APPROVED,
  AI_EXTERNAL_BUDGET_CAP_CONFIRMED:process.env.AI_EXTERNAL_BUDGET_CAP_CONFIRMED
 }
}

export function validateAiAgentEdit(input:unknown,env:AiGuardEnv=currentAiGuardEnv()):AiAgentEditResult{
 if(!input||typeof input!=='object'||Array.isArray(input))return{ok:false,status:400,error:'Invalid agent settings.'}
 const o=input as Record<string,unknown>
 if(Object.keys(o).some(k=>!['id','enabled','autonomyLevel'].includes(k))||typeof o.id!=='string'||!AGENT_ID.test(o.id))
   return{ok:false,status:400,error:'Invalid agent reference or settings fields.'}
 const enabled=o.enabled===undefined?null:o.enabled
 const autonomy=o.autonomyLevel===undefined?null:o.autonomyLevel
 if((enabled!==null&&typeof enabled!=='boolean')||(autonomy!==null&&(typeof autonomy!=='string'||!AUTONOMY.has(autonomy)))||(enabled===null&&autonomy===null))
   return{ok:false,status:400,error:'Invalid AI agent change.'}
 if((autonomy==='limited'||autonomy==='trusted')&&!(env.AI_ENABLED==='true'&&env.AI_HIGH_AUTONOMY_OWNER_APPROVED==='true'&&env.AI_EXTERNAL_BUDGET_CAP_CONFIRMED==='true'))
   return{ok:false,status:403,error:'Higher AI autonomy is disabled pending explicit owner and budget authorization.'}
 // Changing a database `enabled` flag is not itself a model invocation. While
 // AI_ENABLED is globally OFF, reject enabling a previously disabled agent so
 // the Admin never implies that an agent is active when it cannot run.
 if(enabled===true&&env.AI_ENABLED!=='true')
   return{ok:false,status:403,error:'AI remains globally disabled; agents cannot be enabled yet.'}
 return{ok:true,value:{id:o.id,enabled,autonomyLevel:autonomy as AiAgentEdit['autonomyLevel']}}
}

export type AiBudgetLockCheck={ok:true;manuallyLocked:boolean}|{ok:false;reason:string}
export function validateAiBudgetLockInput(input:unknown,env:AiGuardEnv=currentAiGuardEnv()):AiBudgetLockCheck{
 if(!input||typeof input!=='object'||Array.isArray(input))return{ok:false,reason:'Invalid AI budget request.'}
 const o=input as Record<string,unknown>
 if(Object.keys(o).length!==1||typeof o.manuallyLocked!=='boolean')return{ok:false,reason:'Only the manual budget lock can be changed.'}
 if(o.manuallyLocked===false&&(env.AI_ENABLED!=='true'||env.AI_EXTERNAL_BUDGET_CAP_CONFIRMED!=='true'))
  return{ok:false,reason:'AI cannot be unlocked without an enabled runtime and confirmed external spending cap.'}
 return{ok:true,manuallyLocked:o.manuallyLocked}
}

export function validateAiNotificationSettings(input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input))return false
 const o=input as Record<string,unknown>
 const keys=['businessTimezone','dailyBriefHourLocal','quietHoursEnabled','quietHoursStartLocal','quietHoursEndLocal','noncriticalPushLimitDay']
 if(Object.keys(o).some(k=>!keys.includes(k))||keys.some(k=>!(k in o)))return false
 if(typeof o.businessTimezone!=='string'||o.businessTimezone.length<1||o.businessTimezone.length>100)return false
 if(typeof o.quietHoursEnabled!=='boolean')return false
 for(const k of ['dailyBriefHourLocal','quietHoursStartLocal','quietHoursEndLocal']){
  const n=o[k];if(typeof n!=='number'||!Number.isInteger(n)||n<0||n>23)return false
 }
 return typeof o.noncriticalPushLimitDay==='number'&&Number.isInteger(o.noncriticalPushLimitDay)&&o.noncriticalPushLimitDay>=0&&o.noncriticalPushLimitDay<=50
}
