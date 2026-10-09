/** Staging-only Stripe read-verified release of previously held credit.
 * This MUST NOT release a hold on timeout or client input alone.
 * Capture of paid orders is a separate unimplemented transaction.
 */
import {sql} from '@/lib/db'
import {getStripe} from '@/lib/stripe-client'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY=/^[A-Za-z0-9:_-]{12,120}$/
export type ReleaseCreditHold={reservationId:string;requestKey:string}
export function validateReleaseCreditHold(input:unknown):input is ReleaseCreditHold{
 if(!input||typeof input!=='object'||Array.isArray(input))return false
 const p=input as Record<string,unknown>
 return Object.keys(p).length===2&&typeof p.reservationId==='string'&&UUID.test(p.reservationId)
  &&typeof p.requestKey==='string'&&KEY.test(p.requestKey)
}
export async function releaseExpiredCreditHold(input:ReleaseCreditHold):Promise<string>{
 // NEVER accidentally use the live Stripe API: this integration is not staged.
 if(process.env.STORE_CREDIT_CHECKOUT_RELEASE_ENABLED!=='true'||process.env.STRIPE_MODE!=='test')
  throw Error('CREDIT_RELEASE_DISABLED')
 if(!validateReleaseCreditHold(input))throw Error('CREDIT_RELEASE_INVALID_INPUT')
 const rows=await sql`SELECT r.stripe_checkout_session_id AS session_id
   FROM store_credit_checkout_holds h JOIN reservations r ON r.id=h.reservation_id
   WHERE h.reservation_id=${input.reservationId}::uuid`
 if(rows.length!==1||typeof rows[0].session_id!=='string'||!/^cs_test_[A-Za-z0-9_]+$/.test(rows[0].session_id))
  throw Error('CREDIT_RELEASE_SESSION_INVALID')
 const sessionId=rows[0].session_id as string
 const session=await getStripe().checkout.sessions.retrieve(sessionId,{expand:['payment_intent']})
 if(session.id!==sessionId||session.status!=='expired'||session.payment_status!=='unpaid')
  throw Error('CREDIT_RELEASE_PROVIDER_NOT_FINAL')
 const intent=session.payment_intent
 // A session that has a PaymentIntent must have its *final* canceled status
 // confirmed by Stripe. A string ID or pending/succeeded intent is not proof.
 const piFinal=intent===null?'none':typeof intent==='object'&&intent.status==='canceled'?'canceled':null
 if(piFinal===null)throw Error('CREDIT_RELEASE_PAYMENT_INTENT_UNRESOLVED')
 // DB function takes the shared financial advisory lock and checks no linked
 // orders exist, reservation terminal, exact replay identity and no capture.
 const updated=await sql`SELECT kvrn_credit_release_expired_checkout(
   ${input.reservationId}::uuid,${input.requestKey},${sessionId},${piFinal}
 )::text AS event_id`
 if(updated.length!==1||!/^[1-9][0-9]*$/.test(String(updated[0].event_id)))
  throw Error('CREDIT_RELEASE_DB_INTEGRITY')
 return String(updated[0].event_id)
}
