/** Owner-confirmed bulk evidence preparation (never delivery).
 * Bounded parallelism lets a human-reviewed audience reach short-lived
 * evidence readiness without manually submitting 50 independent forms.
 * Every contact still receives an independent current provider permission check.
 */
import {isConfiguredMarketingOwner} from './marketing-owner-approval'
import {validRecipientEvidenceReview,recordReviewedEmailRecipientEvidence,
 type ReviewRecipientInput} from './marketing-email-recipient-evidence'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export type RecipientBatchReviewInput={planId:string;approvalId:string;recipients:{memberId:number;
 recipientTimezone:string;jurisdictionEvidenceRef:string;confirmLegalReview:true}[]}
export type BatchEvidenceResult={planId:string;requested:number;prepared:number;rejected:number;
 readyForSend:false;recipientResults:({memberId:number;prepared:true;evidenceId:string;messageSha256:string;expiresInSeconds:240}|
 {memberId:number;prepared:false;reason:'verification_failed'})[]}
export const MAX_REVIEW_BATCH_RECIPIENTS=50
export function validBatchEvidenceReview(input:unknown):input is RecipientBatchReviewInput{
 if(!input||typeof input!=='object'||Array.isArray(input))return false
 const v=input as Record<string,unknown>
 if(Object.keys(v).length!==3||!Object.keys(v).every(k=>['planId','approvalId','recipients'].includes(k))||
  typeof v.planId!=='string'||!UUID.test(v.planId)||typeof v.approvalId!=='string'||!UUID.test(v.approvalId)||
  !Array.isArray(v.recipients)||v.recipients.length<1||v.recipients.length>MAX_REVIEW_BATCH_RECIPIENTS)return false
 const seen=new Set<number>()
 for(const raw of v.recipients){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return false
  const r=raw as Record<string,unknown>
  const candidate={planId:v.planId,approvalId:v.approvalId,...r}
  if(!validRecipientEvidenceReview(candidate)||seen.has(candidate.memberId))return false
  seen.add(candidate.memberId)
 }
 return true
}
export async function prepareReviewedEmailAudienceBatch(input:RecipientBatchReviewInput,ownerEmail:string):Promise<BatchEvidenceResult>{
 if(process.env.MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED!=='true')throw Error('MARKETING_EMAIL_BATCH_DISABLED')
 if(!isConfiguredMarketingOwner(ownerEmail,process.env.MARKETING_OWNER_APPROVAL_EMAIL??''))throw Error('MARKETING_EMAIL_BATCH_OWNER_REQUIRED')
 if(!validBatchEvidenceReview(input))throw Error('MARKETING_EMAIL_BATCH_INVALID_REVIEW')
 const out=new Array<BatchEvidenceResult['recipientResults'][number]>(input.recipients.length)
 let next=0
 // Bounded concurrency: no more than four simultaneous, independent provider reads.
 // No retries after an error; a failed member must be freshly reviewed again.
 async function worker(){
  while(next<input.recipients.length){
   const idx=next++
   const rec=input.recipients[idx]
   const item:ReviewRecipientInput={planId:input.planId,approvalId:input.approvalId,...rec}
   try{
    const saved=await recordReviewedEmailRecipientEvidence(item,ownerEmail)
    out[idx]={memberId:rec.memberId,prepared:true,evidenceId:saved.evidenceId,
      messageSha256:saved.messageSha256,expiresInSeconds:240}
   }catch{
    // Deliberately do NOT return the recipient, contact id, provider response,
    // legal evidence, or original exception in an Admin-visible result.
    out[idx]={memberId:rec.memberId,prepared:false,reason:'verification_failed'}
   }
  }
 }
 await Promise.all(Array.from({length:Math.min(4,input.recipients.length)},()=>worker()))
 const prepared=out.filter(r=>r.prepared).length
 return {planId:input.planId,requested:out.length,prepared,rejected:out.length-prepared,
  readyForSend:false,recipientResults:out}
}
