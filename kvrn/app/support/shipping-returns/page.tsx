/** Owner-reviewed draft fallback, October 6 2026, rendered until CMS policy is published.
 * No store credit issuance or redemption is implied to be technically enabled.
 */
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { PolicyView } from '@/components/content/cms-views'
import { policyMetadata } from '@/lib/content-storefront'
import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'
const FALLBACK_METADATA: Metadata = {
  title: 'Shipping & Returns — KVRN',
  description: 'KVRN shipping, delivery, and 14-day eligible store-credit return policy.',
  alternates: {canonical:'/support/shipping-returns'},
}
function Part({title,children}:{title:string,children:React.ReactNode}) {
  return <section className="space-y-3"><h3 className="text-base font-medium text-[#1A1A1A]">{title}</h3>{children}</section>
}
function Bullets({values}:{values:readonly string[]}) {
  return <ul className="list-disc space-y-1 pl-5">{values.map(v=><li key={v}>{v}</li>)}</ul>
}
function LegacyShippingReturnsPage(){
  return <div>
    <PageHero title="Shipping & Returns" breadcrumb="Shipping & Returns"/>
    <article data-nav-theme="light" className="container-kvrn max-w-3xl min-w-0 section-padding space-y-10 text-[14px] leading-relaxed text-[#6B6B6B]">
      <p className="text-xs uppercase tracking-wide">Last updated: October 6, 2026</p>
      <h2 className="text-xl font-medium text-[#1A1A1A]">SHIPPING</h2>
      <Part title="Processing">
        <p>Orders are typically processed within 1–3 business days after payment confirmation. Processing times are estimates and may be longer during launches, high-volume periods, holidays, fraud review, or other unusual circumstances.</p>
        <p>Products are not sold as pre-orders unless the applicable product page clearly states that the item is a pre-order and provides an estimated production or shipping timeline.</p>
      </Part>
      <Part title="Shipping Rates">
        <p>Available shipping methods and rates are calculated at checkout based on the destination, package, and carrier options available at that time.</p>
        <p>Complimentary shipping is available on eligible U.S. orders over $150. The qualifying subtotal and availability of free shipping are determined by the checkout system before payment.</p>
      </Part>
      <Part title="Delivery Estimates">
        <p>Typical delivery estimates after dispatch are:</p>
        <Bullets values={['United States: approximately 2–7 business days','International destinations: approximately 5–14+ business days']}/>
        <p>These are estimates, not guarantees. Delivery can be affected by carrier delays, weather, customs, local delivery conditions, address issues, or events outside KVRN’s reasonable control.</p>
      </Part>
      <Part title="Tracking">
        <p>When tracking is available, KVRN will send tracking information to the email address associated with the order after the shipment is prepared or dispatched. Carrier tracking may take time to update after a label is created.</p>
        <p>You can also use the <Link href="/support/track" className="underline">Track Order</Link> page at kvrn.shop/support/track.</p>
      </Part>
      <Part title="Address Accuracy">
        <p>Customers are responsible for providing a complete and accurate shipping address at checkout. If you notice an error, contact <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> as soon as possible.</p>
        <p>We will try to correct an address before fulfillment when reasonably possible, but we cannot guarantee that an address can be changed after an order has entered fulfillment or been transferred to a carrier.</p>
      </Part>
      <Part title="International Orders, Customs, Duties, and Taxes">
        <p>KVRN may ship to supported international destinations shown at checkout.</p>
        <p>Unless duties, taxes, import fees, or customs charges are expressly shown as prepaid or included at checkout, the recipient is responsible for any such charges imposed by the destination country, customs authority, carrier, or other authority.</p>
        <p>Customs processing may delay delivery. KVRN does not control customs decisions, inspections, or local import requirements.</p>
      </Part>
      <Part title="Lost, Delayed, or Damaged Shipments">
        <p>If a shipment appears lost, is materially delayed, or arrives damaged, contact <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> with your order number and relevant details.</p>
        <p>We will work with the carrier and customer to investigate. Available remedies depend on the circumstances, carrier findings, product availability, and applicable law.</p>
      </Part>
      <h2 id="returns" className="scroll-mt-20 border-t border-[#E8E5E0] pt-10 text-xl font-medium text-[#1A1A1A]">RETURNS</h2>
      <Part title="Return Window">
        <p>Eligible items may be returned for KVRN store credit within 14 days after delivery.</p>
        <p>To qualify, an item must be:</p>
        <Bullets values={['Unworn','Unwashed','In its original condition','Returned with original tags attached','Free from odors, stains, damage, alterations, or signs of use','Accompanied by sufficient order information for us to identify the purchase']}/>
      </Part>
      <Part title="Store-Credit Policy">
        <p>Approved discretionary returns are issued as KVRN store credit rather than a cash refund to the original payment method.</p>
        <p>This store-credit return policy applies to change-of-mind, fit, or preference-based returns and does not limit any non-waivable rights or remedies that may apply to defective, damaged, misdescribed, or incorrectly shipped goods.</p>
      </Part>
      <Part title="Final Sale">
        <p>Items clearly identified as “Final Sale” before purchase are not eligible for discretionary return or exchange, except where a remedy is required by applicable law or where the item arrives damaged, defective, or incorrect.</p>
      </Part>
      <Part title="Return Shipping">
        <p>Customers are responsible for return shipping costs for discretionary returns.</p>
        <p>If KVRN sent the wrong item or an item arrives damaged or defective, contact <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> before returning it. If the claim is approved, KVRN will provide an appropriate remedy and, when applicable, cover or reimburse reasonable return shipping.</p>
        <p>Original shipping charges are not refundable for discretionary returns unless required by applicable law.</p>
      </Part>
      <Part title="Starting a Return">
        <p>Before sending anything back, contact <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> with:</p>
        <Bullets values={['Your order number','The item(s) you want to return','The reason for the return','Photos or other information if the item arrived damaged, defective, or incorrect']}/>
        <p>Do not send an unapproved return to an address you found elsewhere. KVRN will provide the applicable return instructions after reviewing the request.</p>
      </Part>
      <Part title="Return Inspection and Store Credit">
        <p>Returned items are inspected after receipt. If the return is approved, KVRN will issue store credit for the eligible merchandise value.</p>
        <p>If an item does not meet the return requirements, KVRN may decline the return and contact you about available next steps.</p>
      </Part>
      <Part title="Exchanges">
        <p>KVRN does not currently guarantee direct exchanges. If you want another size, color, or product, the normal process is to return the eligible item for store credit and place a new order, subject to availability.</p>
      </Part>
      <Part title="Damaged, Defective, or Incorrect Items">
        <p>If an item arrives damaged, defective, or incorrect, contact <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> promptly and include your order number and clear photos or video when useful.</p>
        <p>For visible delivery issues, contacting us within 7 days of delivery helps us investigate quickly. This request for prompt notice does not limit any rights you may have under applicable law.</p>
        <p>Depending on the circumstances and availability, an approved claim may be resolved through replacement, refund to the original payment method, store credit, or another remedy required by law.</p>
      </Part>
      <Part title="Order Cancellations">
        <p>If you need to request a cancellation, contact <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> immediately.</p>
        <p>We cannot guarantee cancellation after an order has entered fulfillment or shipment. If KVRN cancels an order before shipment, any amount collected for the cancelled order will be refunded to the original payment method.</p>
      </Part>
      <h2 className="border-t border-[#E8E5E0] pt-10 text-xl font-medium text-[#1A1A1A]">QUESTIONS</h2>
      <p>For shipping, delivery, or return questions, contact:</p>
      <p><a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a></p>
      <p>We generally respond within 1–2 business days.</p>
    </article>
  </div>
}
export const dynamic='force-dynamic'
export async function generateMetadata(): Promise<Metadata> {
  if(!cmsContentEnabled()) return FALLBACK_METADATA
  const view=await contentPublic().getPolicyById('shipping-returns')
  return view?policyMetadata(view,FALLBACK_METADATA):FALLBACK_METADATA
}
export default async function ShippingReturnsPage(){
  if(cmsContentEnabled()){
    const view=await contentPublic().getPolicyById('shipping-returns')
    if(view)return <PolicyView view={view}/>
  }
  return <LegacyShippingReturnsPage/>
}
