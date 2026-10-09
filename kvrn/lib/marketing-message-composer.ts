/** Pure FINAL SMS copy composer for preview and future owner review.
 * Does NOT authorize/schedule/send a message. Unknown opt-out instructions,
 * extended characters and multipart SMS block one-segment marketing plans.
 */
import {estimateSmsSegments,type SmsEstimate} from './sms-segment-estimate'
import {renderStaticBrandCopy} from './marketing-copy-template-tokens'
const BRAND='KVRN'
const OPT_OUT='Reply STOP to opt out.'
const MAX_SOURCE=10000
export type ComposedSms={body:string;estimate:SmsEstimate;validOneSegment:boolean;reasons:string[];canSend:false}
export function composeMarketingSms(source:unknown):ComposedSms{
 const reasons:string[]=[]
 if(typeof source!=='string'||!source.trim()||source.length>MAX_SOURCE){
  return {body:'',estimate:estimateSmsSegments(''),validOneSegment:false,reasons:['invalid_source'],canSend:false}
 }
 let text:string
 try{text=renderStaticBrandCopy(source.trim())}
 catch{return {body:'',estimate:estimateSmsSegments(''),validOneSegment:false,reasons:['unsupported_placeholder'],canSend:false}}
 // Falsy/adversarial URL text cannot become an SMS link or dynamic replacement.
 if(/[<>\u0000-\u001f]/.test(text)||/\b(?:javascript|data):/i.test(text))
  reasons.push('unsafe_message_text')
 // Require the brand in the finished outbound text. Prevent a spoofable sender.
 if(!/^KVRN\s*[:\-—]/i.test(text)) text=`${BRAND}: ${text}`
 // Do not trust a draft saying STOP anywhere as a sufficient opt-out footer.
 // Add a consistent instruction, but do not duplicate it when already present.
 const suffix=/\bReply\s+STOP\s+to\s+opt\s+out\.?\s*$/i
 if(!suffix.test(text))text=`${text.trim()} ${OPT_OUT}`
 const estimate=estimateSmsSegments(text)
 if(estimate.segments!==1)reasons.push('sms_segment_limit')
 return {body:text,estimate,validOneSegment:reasons.length===0,reasons,canSend:false}
}
