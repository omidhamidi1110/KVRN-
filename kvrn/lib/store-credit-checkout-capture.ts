/** Read-verified test-mode Stripe payment capture of a held store-credit tender.
 * STAGING ONLY: checkout creation/fulfillment does NOT call this module.
 * It cannot create a paid order, charge Stripe, issue credit, or override the
 * canonical order's financial snapshot. Missing evidence blocks capture.
 */
import {sql} from '@/lib/db'
import {getStripe} from '@/lib/stripe-client'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY=/^[A-Za-z0-9:_-]{12,120}$/
export type CaptureVerifiedCredit={reservationId:string;requestKey:string}
export function validateCaptureVerifiedCredit(v:unknown):v is CaptureVerifiedCredit {
 if(!v||typeof v!=='object'||Array.isArray(v))return false
 const p=v as Record<string,unknown>
 return Object.keys(p).length===2&&typeof p.reservationId==='string'&&UUID.test(p.reservationId)
  &&typeof p.requestKey==='string'&&KEY.test(p.requestKey)
}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0
export async function captureVerifiedPaidCredit(input:CaptureVerifiedCredit):Promise<string>{
 if(process.env.STORE_CREDIT_CHECKOUT_CAPTURE_ENABLED!=='true'||process.env.STRIPE_MODE!=='test')
  throw Error('CREDIT_CAPTURE_DISABLED')
 if(!validateCaptureVerifiedCredit(input))throw Error('CREDIT_CAPTURE_INVALID_REQUEST')
 // Minimal internal identifiers, no order email, number, address or PI secret.
 const rows=await sql`SELECT o.id AS order_id,o.stripe_checkout_session_id AS session_id,
  o.stripe_payment_intent_id AS intent_id, o.total_cents AS cash_cents,
  (o.subtotal_cents::numeric-o.discount_cents::numeric+o.shipping_cents::numeric+o.tax_cents::numeric)::text AS gross_cents
  FROM store_credit_checkout_holds h
  JOIN orders o ON o.reservation_id=h.reservation_id
  WHERE h.reservation_id=${input.reservationId}::uuid LIMIT 1`
 if(rows.length!==1)throw Error('CREDIT_CAPTURE_PAID_ORDER_MISSING')
 const r=rows[0]
 const sessionId=String(r.session_id??''),intentId=String(r.intent_id??''),orderId=String(r.order_id??'')
 const cash=Number(r.cash_cents),gross=Number(r.gross_cents)
 if(!UUID.test(orderId)||!/^cs_test_[A-Za-z0-9_]+$/.test(sessionId)
  ||!/^pi_[A-Za-z0-9_]+$/.test(intentId)||!safe(cash)||!safe(gross)||gross<=cash)
  throw Error('CREDIT_CAPTURE_CANONICAL_AMOUNTS_INVALID')
 const stripe=getStripe()
 const session=await stripe.checkout.sessions.retrieve(sessionId)
 if(session.id!==sessionId||session.status!=='complete'||session.payment_status!=='paid'
  ||(typeof session.payment_intent==='string'?session.payment_intent:
     session.payment_intent?.id)!==intentId)
  throw Error('CREDIT_CAPTURE_SESSION_NOT_PAID')
 const intent=await stripe.paymentIntents.retrieve(intentId,{expand:['latest_charge']})
 if(intent.id!==intentId||intent.status!=='succeeded'||intent.currency!=='usd'
  ||intent.amount_received!==cash||intent.amount!==cash)
  throw Error('CREDIT_CAPTURE_STRIPE_AMOUNT_NOT_FINAL')
 const charge=intent.latest_charge
 if(!charge||typeof charge==='string'||charge.payment_intent!==intentId
  ||charge.paid!==true||charge.status!=='succeeded'||charge.disputed!==false
  ||charge.refunded!==false||charge.amount_refunded!==0||charge.amount!==cash)
  throw Error('CREDIT_CAPTURE_STRIPE_CHARGE_UNRESOLVED')
 // Function serializes the capture and checks the immutable held amount,
 // finalized paid order, original gross amount, refunds, disputes and replay.
 const result=await sql`SELECT kvrn_credit_capture_verified_checkout(
  ${input.reservationId}::uuid,${orderId}::uuid,${input.requestKey},
  ${sessionId},${intentId},${cash},${gross}
 )::text AS event_id`
 if(result.length!==1||!/^[1-9][0-9]*$/.test(String(result[0].event_id)))
  throw Error('CREDIT_CAPTURE_LEDGER_FAILED')
 return String(result[0].event_id)
}
