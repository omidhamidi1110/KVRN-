/** Source-level operator checklist. Does not inspect provider secrets or claim approval. */
import {PROPOSED_MARKETING_LIMITS} from './marketing-dispatch-policy'
export type Gate={id:string,label:string,codeStatus:'present'|'blocked',reason:string}
export const MARKETING_RELEASE_GATES:readonly Gate[]=Object.freeze([
  {id:'consent',label:'Valid KVRN-only SMS/email consent history',codeStatus:'blocked',reason:'Postscript consent provenance and suppression import not verified'},
  {id:'a2p',label:'Twilio approved A2P / Advanced Opt-Out',codeStatus:'blocked',reason:'Provider-side registration and reply testing required'},
  {id:'double_optin',label:'SMS keyword double opt-in',codeStatus:'blocked',reason:'Must be proved with actual inbound webhook and sender'},
  {id:'email',label:'Resend broadcast and unsubscribe hooks',codeStatus:'blocked',reason:'Deliverability, opt-out and bounce verification pending'},
  {id:'budget',label:'Atomic worst-case budget enforcement',codeStatus:'blocked',reason:'Database budget reservation is intentionally disabled until full dispatch review'},
  {id:'owner',label:'Owner authorization for each real campaign',codeStatus:'blocked',reason:'No reusable or AI-inferred authorization'},
  {id:'ai',label:'AI marketing autonomy',codeStatus:'blocked',reason:'Draft-only AI and provider privacy decisions pending'},
])
export const MARKETING_DRAFT_CAPS=PROPOSED_MARKETING_LIMITS
