/**
 * Manual, one-recipient LOCAL development harness only. This cannot be used in
 * a deployed Next.js production build (including staging deployed builds).
 * It does not authorize bulk sending or bypass DB-level recipient evidence.
 */
import {isValidExecutionInput,type AttemptExecutionInput} from './marketing-execution-coordinator'

const CONFIRM='I AUTHORIZE ONE LOCAL TEST MESSAGE'
const ALLOWED_KEYS=new Set(['confirm','input'])
export type LocalOwnerTestRequest={confirm:string;input:AttemptExecutionInput}

export function localMarketingTransportAllowed(env:Record<string,string|undefined>):boolean{
 return env.NODE_ENV==='development' && env.KVRN_RUNTIME_ENV==='local' &&
   env.MARKETING_LOCAL_ONE_RECIPIENT_TEST_ENABLED==='true' &&
   env.MARKETING_SEND_ENABLED==='true' &&
   env.MARKETING_PROVIDER_DELIVERY_ENABLED==='true' &&
   env.MARKETING_OWNER_SEND_RELEASE_ENABLED==='true' &&
   env.MARKETING_CLAIM_RESOLVER_ENABLED==='true' &&
   env.MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED==='true' &&
   env.MARKETING_PROVIDER_RECEIPTS_ENABLED==='true'
}

export function validLocalOwnerTestRequest(raw:unknown):raw is LocalOwnerTestRequest {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false
 const r=raw as Record<string,unknown>
 return Object.keys(r).length===2 && Object.keys(r).every(k=>ALLOWED_KEYS.has(k))&&
   r.confirm===CONFIRM && isValidExecutionInput(r.input)
}
