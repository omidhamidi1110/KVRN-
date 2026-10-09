/** A no-retry one-recipient marketing execution coordinator.
 * Important: this does NOT select contacts, grant consent, authenticate an owner,
 * reserve budget or enable provider integrations. Dependencies are internal,
 * server-trusted implementations only, NEVER injected from an HTTP request.
 * This is intentionally unconnected to any cron or API route and OFF by default.
 */
export type ExecutionChannel='sms'|'email'
export type VerifiedTransportResult=
 | {kind:'provider_accepted';providerReferenceSha256:string;verificationSource:'provider_final_status'|'provider_invoice'}
 | {kind:'verified_not_submitted';providerReferenceSha256:string;verificationSource:'verified_provider_rejection'}
 | {kind:'outcome_unknown'}
export type ExecutionState='blocked'|'claimed_unknown'|'provider_accepted'|'verified_not_submitted'
export type AttemptExecutionInput={
  planId:string;memberId:number;approvalId:string;budgetReservationId:string;
  evidenceId:string;messageSha256:string;claimKey:string;
  channel:ExecutionChannel
}
export type AttemptExecutionResult={state:ExecutionState;attemptId?:string;canRetry:false;costSettled:false}
export interface TrustedExecutionDependencies {
  /** Must check brand-specific consent, provider suppression, geography, prices,
   * recipient local-time/frequency/owner approval, and exact message hash.
   * This precheck is NEVER enough without the atomic DB claim itself. */
  recheck:(input:AttemptExecutionInput)=>Promise<boolean>
  /** Atomic, serial DB claim taking the original budget + plan locks and
   * repeating consent/price/quiet-hour/approval checks, or throwing. */
  claim:(input:AttemptExecutionInput)=>Promise<string>
  /** Provider transport. Must never internally retry on timeouts or 5xx.
   * Invoke ONCE only after successful persisted DB claim. */
  submitOnce:(input:AttemptExecutionInput,attemptId:string)=>Promise<VerifiedTransportResult>
  /** Requires independent provider-authenticated evidence and exact correlation;
   * not a way to infer anything from a timeout or transport exception. */
  recordVerifiedOutcome:(attemptId:string,result:Exclude<VerifiedTransportResult,{kind:'outcome_unknown'}>)=>Promise<void>
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY=/^[A-Za-z0-9:_-]{12,120}$/
const DIGEST=/^[0-9a-f]{64}$/
export function isValidExecutionInput(input:unknown):input is AttemptExecutionInput {
 if(!input||typeof input!=='object'||Array.isArray(input))return false
 const v=input as Record<string,unknown>
 return Object.keys(v).length===8 &&
  Object.keys(v).every(k=>['planId','memberId','approvalId','budgetReservationId','evidenceId','messageSha256','claimKey','channel'].includes(k))&&
  [v.planId,v.approvalId,v.budgetReservationId,v.evidenceId].every(x=>typeof x==='string'&&UUID.test(x))&&
  typeof v.memberId==='number'&&Number.isSafeInteger(v.memberId)&&v.memberId>0&&
  typeof v.messageSha256==='string'&&DIGEST.test(v.messageSha256)&&
  typeof v.claimKey==='string'&&KEY.test(v.claimKey)&&
  (v.channel==='sms'||v.channel==='email')
}
export async function executeMarketingAttemptOnce(
 input:AttemptExecutionInput,deps:TrustedExecutionDependencies
):Promise<AttemptExecutionResult>{
 const blocked:AttemptExecutionResult={state:'blocked',canRetry:false,costSettled:false}
 // Runtime controls cannot be overridden by a request or by stale DB approval.
 if(process.env.MARKETING_SEND_ENABLED!=='true'||process.env.MARKETING_PROVIDER_DELIVERY_ENABLED!=='true' ||
   !isValidExecutionInput(input) || !deps || typeof deps.recheck!=='function' ||
   typeof deps.claim!=='function'||typeof deps.submitOnce!=='function'||
   typeof deps.recordVerifiedOutcome!=='function')return blocked
 // Any rejection/error before a claim must not call the provider.
 try{if(await deps.recheck(input)!==true)return blocked}
 catch{return blocked}
 let attemptId:string
 try{
   attemptId=await deps.claim(input)
   if(!UUID.test(attemptId))return blocked
 }catch{return blocked}
 // The DB claim is now durably unknown. There is no automatic retry even if the
 // network call never reached the provider. The only safe response is manual
 // provider verification + immutable evidence, not a second send.
 const unresolved:AttemptExecutionResult={state:'claimed_unknown',attemptId,canRetry:false,costSettled:false}
 let transport:VerifiedTransportResult
 try{transport=await deps.submitOnce(input,attemptId)}catch{return unresolved}
 if(!transport||transport.kind==='outcome_unknown')return unresolved
 if((transport.kind!=='provider_accepted'&&transport.kind!=='verified_not_submitted')||
  typeof transport.providerReferenceSha256!=='string'||!DIGEST.test(transport.providerReferenceSha256)||
  (transport.kind==='provider_accepted' && !['provider_final_status','provider_invoice'].includes(transport.verificationSource))||
  (transport.kind==='verified_not_submitted' && transport.verificationSource!=='verified_provider_rejection'))return unresolved
 try{await deps.recordVerifiedOutcome(attemptId,transport)}catch{return unresolved}
 return {state:transport.kind,attemptId,canRetry:false,costSettled:false}
}
