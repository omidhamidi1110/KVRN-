/** Concrete single-request marketing provider connectors.
 * No API/cron imports this module. NEVER invoke without the persisted claim and
 * just-in-time approval checks in marketing-claimed-provider-transport.
 * These helpers are not an alternative path to owner approval or consent.
 */
import {sendSms} from './twilio'
import {createResendAdapter} from './resend-adapter'
import {recordProvisionalProviderReceipt,type ProvisionalReceiptInput} from './marketing-provider-receipts'
import type {TrustedClaimedTransportDependencies} from './marketing-claimed-provider-transport'
import {oneClickMarketingUrl} from './marketing-one-click-unsubscribe'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FROM=/^[A-Za-z0-9 ._-]{1,64}\s*<[a-z0-9._%+-]+@kvrn\.shop>$/i

/** Wiring only. The trusted DB resolver must be separately implemented and audited. */
export function makeOneShotProviderBindings(attemptId:string):Pick<TrustedClaimedTransportDependencies,
 'sendOneSms'|'sendOneEmail'|'recordProvisional'> {
 if(!UUID.test(attemptId))throw Error('INVALID_MARKETING_CLAIM_ID')
 const gates=()=>process.env.MARKETING_SEND_ENABLED==='true'&&
    process.env.MARKETING_PROVIDER_DELIVERY_ENABLED==='true'&&
    process.env.MARKETING_OWNER_SEND_RELEASE_ENABLED==='true'&&
    process.env.MARKETING_PROVIDER_RECEIPTS_ENABLED==='true'
 return {
  async sendOneSms(recipient,body){
   if(!gates()||process.env.TWILIO_A2P_APPROVED!=='true'||
      process.env.TWILIO_MARKETING_SEND_ENABLED!=='true')throw Error('MARKETING_SMS_SEND_BLOCKED')
   const result=await sendSms({to:recipient,body})
   return {ok:result.ok===true,providerMessageId:result.messageSid}
  },
  async sendOneEmail(recipient,subject,html,unsubscribeUrl){
   if(!gates()||process.env.RESEND_MARKETING_SEND_ENABLED!=='true')throw Error('MARKETING_EMAIL_SEND_BLOCKED')
   const apiKey=process.env.RESEND_MARKETING_API_KEY??''
   const from=process.env.RESEND_MARKETING_FROM??''
   if(!apiKey||!FROM.test(from)||!unsubscribeUrl.startsWith('https://kvrn.shop/email-preferences?token=v1.'))
      throw Error('MARKETING_EMAIL_PROVIDER_UNCONFIGURED')
   // Separate RFC 8058 POST target; a scanner GET never revokes consent.
   // Keep the human-facing confirmation page in the email body.
   const oneClickUrl=oneClickMarketingUrl(unsubscribeUrl)
   const result=await createResendAdapter(apiKey).send({
    from,replyTo:'support@kvrn.shop',to:recipient,subject,html,
    idempotencyKey:`kvrn-marketing-${attemptId}`,
    headers:{'List-Unsubscribe':`<${oneClickUrl}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},
   })
   if(result.ok)return {ok:true,providerMessageId:result.providerMessageId}
   return {ok:false}
  },
  async recordProvisional(receipt){
   if(receipt.attemptId!==attemptId)throw Error('MARKETING_CLAIM_RECEIPT_MISMATCH')
   await recordProvisionalProviderReceipt(receipt as ProvisionalReceiptInput)
  },
 }
}
