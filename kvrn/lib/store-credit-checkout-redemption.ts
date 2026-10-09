/**
 * Stripe-TEST-MODE only customer redemption coordinator.
 * This binds a verified email session to an actual credit account, reads a
 * canonical ledger balance, constructs an exact cash/credit quote, and holds
 * that credit against the reserved inventory BEFORE creating Stripe Checkout.
 * The conditional SQL finalizer in migration 062 captures the credit in the
 * SAME transaction as order creation. No production activation is permitted.
 */
import {sql} from './db'
import {resolveVerifiedCreditAccount, creditIdentityCookieName} from './store-credit-customer-identity'
import {quoteStoreCreditSplitTender, type SplitTenderQuote} from './store-credit-split-tender'
import {prepareCheckoutCreditHold} from './store-credit-checkout-hold'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0
export type CustomerRedemptionRequest={
  requestedCreditCents:number; customerEmail:string; cookieValue:string|undefined;
  reservationId:string; subtotalCents:number; discountCents:number;
  shippingCents:number; taxCents:number;
}
export type PreparedCreditRedemption={quote:SplitTenderQuote; holdEventId:string; holdKey:string}

export function creditRedemptionEnabled(env:Record<string,string|undefined>=process.env):boolean{
  // IMPORTANT: NODE_ENV=development alone is not proof that Stripe is TEST.
  // Explicit flags are required to avoid ever initiating a live mixed tender.
  return env.STORE_CREDIT_SPLIT_TENDER_ENABLED==='true'&&env.STRIPE_MODE==='test'&&
    env.STORE_CREDIT_CHECKOUT_HOLD_ENABLED==='true'&&env.STORE_CREDIT_CHECKOUT_RELEASE_ENABLED==='true'&&
    env.STORE_CREDIT_IDENTITY_EMAIL_ENABLED==='true'&&
    env.STRIPE_USD_MINIMUM_VERIFIED==='true'&&
    env.STRIPE_USD_MINIMUM_CENTS!==undefined&&
    /^(?:[1-9][0-9]{0,5})$/.test(env.STRIPE_USD_MINIMUM_CENTS)
}

export function parseRequestedCredit(value:unknown):number|null{
  // Only an explicitly requested integer amount should enter the credit path.
  return safe(value)&&value>0&&value<=2147483647?value:null
}
export function storeCreditIdentityCookieName():string{
  return creditIdentityCookieName(process.env.NODE_ENV==='production')
}

/** Trusted server-only orchestration. No browser-supplied ledger/account ids. */
export async function prepareCustomerStoreCreditRedemption(p:CustomerRedemptionRequest):Promise<PreparedCreditRedemption>{
  if(!creditRedemptionEnabled())throw Error('CREDIT_REDEMPTION_DISABLED')
  if(!p||!UUID.test(p.reservationId)||!parseRequestedCredit(p.requestedCreditCents)||
     ![p.subtotalCents,p.discountCents,p.shippingCents,p.taxCents].every(safe))
    throw Error('CREDIT_REDEMPTION_INVALID_INPUT')
  // Require the same email that authenticated via the one-use email challenge.
  const accountKey=await resolveVerifiedCreditAccount(p.cookieValue,p.customerEmail)
  if(!accountKey)throw Error('CREDIT_REDEMPTION_CUSTOMER_NOT_VERIFIED')
  const rows=await sql`SELECT a.id::text AS account_id,
    COALESCE(SUM(CASE WHEN l.event_type='issue' THEN l.amount_cents ELSE 0 END),0)::text AS issued,
    COALESCE(SUM(CASE WHEN l.event_type='capture' THEN l.amount_cents ELSE 0 END),0)::text AS captured,
    COALESCE(SUM(CASE WHEN l.event_type='hold' AND NOT EXISTS (
      SELECT 1 FROM store_credit_ledger term
      WHERE term.account_id=l.account_id AND term.hold_key=l.hold_key
      AND term.event_type IN ('capture','release')) THEN l.amount_cents ELSE 0 END),0)::text AS held
    FROM store_credit_accounts a LEFT JOIN store_credit_ledger l ON l.account_id=a.id
    WHERE a.account_key=${accountKey} GROUP BY a.id`
  if(rows.length!==1||!UUID.test(String(rows[0].account_id)))
    throw Error('CREDIT_REDEMPTION_ACCOUNT_UNAVAILABLE')
  const numeric=(v:unknown):bigint=>{
    if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v))throw Error('CREDIT_REDEMPTION_LEDGER_INVALID')
    return BigInt(v)
  }
  const issued=numeric(rows[0].issued),captured=numeric(rows[0].captured),held=numeric(rows[0].held)
  if(captured>issued||held>issued-captured||issued>BigInt(Number.MAX_SAFE_INTEGER))
    throw Error('CREDIT_REDEMPTION_LEDGER_UNBALANCED')
  const available=issued-captured-held
  if(available>BigInt(Number.MAX_SAFE_INTEGER))throw Error('CREDIT_REDEMPTION_LEDGER_OVERFLOW')
  const minimum=Number(process.env.STRIPE_USD_MINIMUM_CENTS)
  const quote=quoteStoreCreditSplitTender({
    currency:'usd',subtotalCents:p.subtotalCents,merchandiseDiscountCents:p.discountCents,
    shippingCents:p.shippingCents,taxCents:p.taxCents,
    availableCreditCents:Number(available),requestedCreditCents:p.requestedCreditCents,
    authoritativeCartVerified:true,authoritativeTaxVerified:true,verifiedCustomerIdentity:true,
    verifiedStripeMinimumCents:minimum,stripeMinimumVerified:true,
  })
  // A separate second checkout gets a new reservation and new credit hold.
  // The DB serializes concurrent holds under one shared credit lock.
  const holdKey=`credit:${p.reservationId}`
  const requestKey=`checkout:${p.reservationId}`
  const holdEventId=await prepareCheckoutCreditHold({
    accountId:String(rows[0].account_id),reservationId:p.reservationId,
    holdKey,requestKey,amountCents:quote.creditTenderCents,
    verifiedAccountOwnership:true,canonicalNetTenderVerified:true,
  })
  return {quote,holdEventId,holdKey}
}

/** Fixed-amount coupon for the exact net merchandise reduction.
 * Stripe Checkout allows only one coupon, so owner-approved promo and credit
 * are combined for Stripe display while DB persists promo and credit separately.
 */
export async function createCreditCheckoutCoupon(stripe:any,reservationId:string,
  merchandiseDiscountCents:number,creditCents:number):Promise<string>{
  if(!creditRedemptionEnabled()||!UUID.test(reservationId)||
     !safe(merchandiseDiscountCents)||!parseRequestedCredit(creditCents)||
     merchandiseDiscountCents+creditCents>2147483647)
    throw Error('CREDIT_COUPON_INVALID_OR_DISABLED')
  const coupon=await stripe.coupons.create({
    name:'KVRN store credit and applicable offers',duration:'once',currency:'usd',
    amount_off:merchandiseDiscountCents+creditCents,
    metadata:{reservation_id:reservationId,kvrn_credit_cents:String(creditCents),
      kvrn_merchandise_discount_cents:String(merchandiseDiscountCents)},
  },{idempotencyKey:`credit-coupon-${reservationId}`})
  if(typeof coupon?.id!=='string'||!/^\S{1,100}$/.test(coupon.id)||
    coupon.amount_off!==merchandiseDiscountCents+creditCents||coupon.currency!=='usd')
    throw Error('CREDIT_COUPON_PROVIDER_MISMATCH')
  return coupon.id
}

/** Durable marker written BEFORE Stripe Checkout session creation.
 * A failed/uncertain provider response cannot be retried for this reservation.
 */
export async function markCreditCheckoutProviderStarted(reservationId:string,couponId:string):Promise<void>{
 if(!creditRedemptionEnabled()||!UUID.test(reservationId)||
    typeof couponId!=='string'||couponId.length<1||couponId.length>100)
  throw Error('CREDIT_PROVIDER_MARK_DISABLED_OR_INVALID')
 const rows=await sql`SELECT kvrn_credit_mark_checkout_provider_started(
   ${reservationId}::uuid,${couponId}) AS marked`
 if(rows.length!==1||rows[0]?.marked!==true)throw Error('CREDIT_PROVIDER_MARK_NOT_COMMITTED')
}

/** Only safe BEFORE markCreditCheckoutProviderStarted is called.
 * This releases reserved credit after a failed coupon create, even when
 * inventory reservation cleanup is unsuccessful. Stripe was never asked to
 * create a payment session on this code path.
 */
export async function releaseCreditBeforeProvider(reservationId:string):Promise<void>{
 if(!creditRedemptionEnabled()||!UUID.test(reservationId))
  throw Error('CREDIT_PREPROVIDER_RELEASE_DISABLED_OR_INVALID')
 const rows=await sql`SELECT kvrn_credit_release_before_provider(
   ${reservationId}::uuid,${`prestripe:${reservationId}`})::text AS event_id`
 if(rows.length!==1||!/^[1-9][0-9]*$/.test(String(rows[0]?.event_id)))
  throw Error('CREDIT_PREPROVIDER_RELEASE_NOT_COMMITTED')
}
