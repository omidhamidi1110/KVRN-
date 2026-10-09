/** A manually initiated *single recipient* owner release for the existing
 * strictly-claimed and consent-verified delivery pipeline. NO scheduling,
 * queue, fanout, retries, list upload, or automatic budget settlement.
 * Activation flags must be explicitly provisioned after independent staging QA.
 */
import {isValidExecutionInput,type AttemptExecutionInput} from './marketing-execution-coordinator'
export type ApprovedOwnerExecutionRequest={confirm:string;input:AttemptExecutionInput}
export const MARKETING_OWNER_SINGLE_CONFIRM='I AUTHORIZE ONE APPROVED MARKETING MESSAGE'
export function ownerApprovedExecutionAllowed(env:Record<string,string|undefined>):boolean{
 if(!['production','development'].includes(String(env.NODE_ENV)))return false
 if(env.KVRN_RUNTIME_ENV!=='staging'&&env.KVRN_RUNTIME_ENV!=='production')return false
 if(env.KVRN_RUNTIME_ENV==='production'&&env.KVRN_MARKETING_PRODUCTION_OWNER_APPROVED!=='true')return false
 return env.MARKETING_OWNER_EXECUTION_HTTP_ENABLED==='true' &&
   env.MARKETING_OWNER_SEND_RELEASE_ENABLED==='true' &&
   env.MARKETING_SEND_ENABLED==='true' && env.MARKETING_PROVIDER_DELIVERY_ENABLED==='true' &&
   env.MARKETING_CLAIM_RESOLVER_ENABLED==='true' &&
   env.MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED==='true' &&
   env.MARKETING_PROVIDER_RECEIPTS_ENABLED==='true'
}
export function validOwnerApprovedExecutionRequest(raw:unknown):raw is ApprovedOwnerExecutionRequest{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false
 const v=raw as Record<string,unknown>
 return Object.keys(v).length===2&&Object.keys(v).every(k=>k==='confirm'||k==='input')&&
  v.confirm===MARKETING_OWNER_SINGLE_CONFIRM&&isValidExecutionInput(v.input)
}
