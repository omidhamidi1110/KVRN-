/** Exact integer split-tender quote for future KVRN store-credit checkout.
 * Pure, no Stripe calls, no account lookup, no DB writes.
 * A credit redemption is PAYMENT, not a merchandise discount or refund.
 * Taxes must come from the authoritative tax calculation BEFORE tender, not
 * recomputed from the reduced cash portion. Credit may cover merchandise only.
 * This quote NEVER authorizes a customer to redeem or creates a hold/capture.
 */
export type SplitTenderInput={
  currency:'usd'
  subtotalCents:number
  merchandiseDiscountCents:number
  shippingCents:number
  taxCents:number
  availableCreditCents:number
  requestedCreditCents:number
  /** Canonical server-verified inputs, not values copied from the client. */
  authoritativeCartVerified:boolean
  authoritativeTaxVerified:boolean
  verifiedCustomerIdentity:boolean
  /** Account/currency minimum must be independently validated from Stripe.
   * Never infer a minimum from browser input or assume that any >0 amount is chargeable.
   */
  verifiedStripeMinimumCents:number
  stripeMinimumVerified:boolean
}
export type SplitTenderQuote={
  currency:'usd';netMerchandiseCents:number;subtotalCents:number;discountCents:number
  shippingCents:number;taxCents:number;grossOrderCents:number
  creditTenderCents:number;cashDueCents:number;balanceAfterHoldCents:number
  creditLiabilityToCaptureCents:number
  /** Zero-dollar Stripe checkouts need a separately designed and verified path. */
  supportedForStripeCheckout:boolean
}
const MAX=BigInt(Number.MAX_SAFE_INTEGER)
const int=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
const safe=(value:bigint):number=>{
 if(value<0n||value>MAX)throw Error('SPLIT_TENDER_OVERFLOW')
 return Number(value)
}
export function quoteStoreCreditSplitTender(p:SplitTenderInput):SplitTenderQuote{
 if(!p || typeof p!=='object' || p.currency!=='usd')throw Error('SPLIT_TENDER_UNSUPPORTED_CURRENCY')
 for(const v of [p.subtotalCents,p.merchandiseDiscountCents,p.shippingCents,p.taxCents,p.availableCreditCents,p.requestedCreditCents,p.verifiedStripeMinimumCents]){
  if(!int(v))throw Error('SPLIT_TENDER_UNSAFE_CENTS')
 }
 if(p.authoritativeCartVerified!==true||p.authoritativeTaxVerified!==true||p.verifiedCustomerIdentity!==true||p.stripeMinimumVerified!==true||p.verifiedStripeMinimumCents<1)
  throw Error('SPLIT_TENDER_UNVERIFIED_CANONICAL_EVIDENCE')
 const subtotal=BigInt(p.subtotalCents),discount=BigInt(p.merchandiseDiscountCents)
 const credit=BigInt(p.requestedCreditCents),available=BigInt(p.availableCreditCents)
 const shipping=BigInt(p.shippingCents),tax=BigInt(p.taxCents)
 if(discount>subtotal)throw Error('SPLIT_TENDER_DISCOUNT_EXCEEDS_MERCHANDISE')
 const netMerchandise=subtotal-discount
 if(credit>available)throw Error('SPLIT_TENDER_INSUFFICIENT_CREDIT')
 if(credit>netMerchandise)throw Error('SPLIT_TENDER_CREDIT_EXCEEDS_NET_MERCHANDISE')
 const gross=netMerchandise+shipping+tax
 const cashDue=gross-credit
 // Stripe minimum amount for a given currency/region must be verified separately.
 // For now fail closed on zero cash due; an all-credit order needs a distinct path.
 if(cashDue===0n)throw Error('SPLIT_TENDER_ZERO_CASH_CHECKOUT_NOT_SUPPORTED')
 if(cashDue<BigInt(p.verifiedStripeMinimumCents))throw Error('SPLIT_TENDER_BELOW_VERIFIED_STRIPE_MINIMUM')
 // No credit tender can lower the canonical merchandise price/discount or tax.
 return {currency:'usd',netMerchandiseCents:safe(netMerchandise),subtotalCents:safe(subtotal),discountCents:safe(discount),
   shippingCents:safe(shipping),taxCents:safe(tax),grossOrderCents:safe(gross),
   creditTenderCents:safe(credit),cashDueCents:safe(cashDue),
   balanceAfterHoldCents:safe(available-credit),creditLiabilityToCaptureCents:safe(credit),
   supportedForStripeCheckout:true}
}
