import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { FaqView } from '@/components/content/cms-views'
import { pageMetadata } from '@/lib/content-seo'
import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Accordion } from '@/components/ui/Accordion'

const LEGACY_METADATA: Metadata = {
  title: 'FAQ — KVRN',
  description: 'Frequently asked questions about KVRN products, sizing, shipping and returns.',
  alternates: { canonical: '/support/faq' },
}

const FAQ_SECTIONS = [
  {
    heading: 'Products',
    items: [
      {
        id: 'gsm',
        trigger: 'What does GSM mean?',
        content: (
          <div className="space-y-3 text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>GSM stands for grams per square metre. It measures how dense and heavy a fabric is. The higher the number, the heavier the material.</p>
            <p>Most hoodies on the market sit around 280 to 320 GSM. At that weight the fabric feels light. At 400 GSM and above the structure changes noticeably — the garment holds its shape, drapes differently, and has real weight when you hold it.</p>
            <p>Full material specifications are listed on each product page.</p>
          </div>
        ),
      },
      {
        id: 'no-drawstring',
        trigger: 'Why is there no drawstring on the hoodie?',
        content: (
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            The Heavyweight hood is structured across three panels so it holds its shape on its own. A drawstring is usually needed because the hood collapses without it. The construction here eliminates that problem. There is nothing to pull, nothing to lose, and nothing to interrupt the silhouette.
          </p>
        ),
      },
      {
        id: 'zippers',
        trigger: 'How do the hidden interior pockets work?',
        content: (
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            The kangaroo pocket has two concealed zippers running inside it, one on each side. From the outside they are invisible. Open the zip and you access a secure interior compartment. They work in all positions and stay closed without looking closed.
          </p>
        ),
      },
      {
        id: 'project-kvrn',
        trigger: 'What is the Project KVRN collection?',
        content: (
          <div className="space-y-3 text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>The Project KVRN collection uses a 500 GSM French terry blend rather than the brushed fleece of the Heavyweight collection. Both are heavy. The difference is in the construction and the proportion.</p>
            <p>Project KVRN pieces are enzyme washed and pre-shrunk before shipping, so they arrive with immediate softness and a more relaxed hand feel. They are also cut with a cropped, oversized proportion rather than a longer oversized one.</p>
          </div>
        ),
      },
      {
        id: 'care',
        trigger: 'How do I care for the garments?',
        content: (
          <div className="space-y-3 text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>Machine wash cold, inside out, gentle cycle. Air dry. Do not tumble dry on high heat.</p>
            <p>The fleece will continue to soften over the first few washes. This is normal and expected. The structure of the hood and the zippers are not affected by regular washing.</p>
          </div>
        ),
      },
    ],
  },
  {
    heading: 'Sizing',
    items: [
      {
        id: 'fit',
        trigger: 'How does KVRN fit?',
        content: (
          <div className="space-y-3 text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>KVRN is designed to be oversized. The proportions are intentional, not incidental. If you want the intended silhouette, order your usual size. If you want a slightly cleaner look, size down by one.</p>
            <Link href="/support/size-guide" className="text-[#1A1A1A] underline underline-offset-2">View the size guide</Link>
          </div>
        ),
      },
      {
        id: 'measurements',
        trigger: 'Where can I find measurements?',
        content: (
          <div className="text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>The size guide has full measurements for both the hoodie and sweatpants, in centimetres and inches.</p>
            <div className="mt-3">
              <Link href="/support/size-guide" className="text-[#1A1A1A] underline underline-offset-2">Open size guide</Link>
            </div>
          </div>
        ),
      },
    ],
  },
  {
    heading: 'Shipping',
    items: [
      {
        id: 'processing',
        trigger: 'How long does processing take?',
        content: (
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            Orders are typically processed within 1–3 business days after payment confirmation. This is an estimate; launches, holidays, high-volume periods and fraud review may take longer. Pre-orders are identified on the applicable product page.
          </p>
        ),
      },
      {
        id: 'delivery',
        trigger: 'How long does delivery take?',
        content: (
          <div className="space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>Domestic orders typically arrive within 2 to 7 business days after dispatch. International orders typically take 5 to 14 business days or more, depending on the destination and customs.</p>
            <p>Delivery estimates are not guarantees. Tracking information is provided when available after a carrier tracking number is assigned.</p>
          </div>
        ),
      },
      {
        id: 'free-shipping',
        trigger: 'Is there free shipping?',
        content: (
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            Complimentary shipping is available on eligible U.S. orders over $150. Qualification and shipping rates are determined by checkout before payment.
          </p>
        ),
      },
      {
        id: 'tracking',
        trigger: 'How do I track my order?',
        content: (
          <div className="text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>When tracking is available, we email it after a shipment is prepared or dispatched. Carrier updates may take additional time. You can also use the Track Order page.</p>
            <div className="mt-3">
              <Link href="/support/track" className="text-[#1A1A1A] underline underline-offset-2">Track your order</Link>
            </div>
          </div>
        ),
      },
    ],
  },
  {
    heading: 'Returns',
    items: [
      {
        id: 'returns',
        trigger: 'What is the returns policy?',
        content: (
          <div className="space-y-3 text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>Eligible unworn, unwashed items in their original condition with original tags attached may be returned for KVRN store credit within 14 days after delivery. Damaged, defective, misdescribed, or incorrect items may qualify for other remedies required by law.</p>
            <p>Customers pay discretionary return shipping. If KVRN sent the wrong item or an item arrives damaged or defective, contact support before returning it. Approved claims may receive reasonable return shipping coverage or reimbursement.</p>
            <div className="mt-1">
              <Link href="/support/shipping-returns#returns" className="text-[#1A1A1A] underline underline-offset-2">Full returns policy</Link>
            </div>
          </div>
        ),
      },
      {
        id: 'initiate-return',
        trigger: 'How do I start a return?',
        content: (
          <div className="text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>Email <a href="mailto:support@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">support@kvrn.shop</a> with your order number, the items you want to return, and the reason. Do not mail an unapproved return. We generally respond within 1–2 business days.</p>
          </div>
        ),
      },
      {
        id: 'wrong-item',
        trigger: 'What if my order arrived wrong or damaged?',
        content: (
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            Email <a href="mailto:support@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">support@kvrn.shop</a> with your order number and photos. If approved, KVRN will provide an appropriate remedy, which may include replacement, refund, or store credit. Where applicable, we will cover or reimburse reasonable return shipping.
          </p>
        ),
      },
    ],
  },
]

function LegacyFAQPage() {
  return (
    <div>
      {/* Dark header band */}
      <PageHero title="FAQ" breadcrumb="FAQ" />

      <div data-nav-theme="light" className="container-kvrn max-w-3xl py-14">
        {FAQ_SECTIONS.map(section => (
          <section key={section.heading} className="mb-12 last:mb-0">
            <h2 className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-5 pb-3 border-b border-[#E8E5E0]">
              {section.heading}
            </h2>
            <Accordion items={section.items.map(item => ({
              id: item.id,
              trigger: item.trigger,
              content: item.content,
            }))} />
          </section>
        ))}

        <div className="mt-12 pt-8 border-t border-[#E8E5E0]">
          <p className="text-[14px] font-light mb-1">Still have a question?</p>
          <p className="text-[13px] text-[#6B6B6B]">
            Email <a href="mailto:support@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">support@kvrn.shop</a> and we will get back to you within 1 to 2 business days.
          </p>
        </div>
      </div>
    </div>
  )
}

// Flag off (default): the coded FAQ above, unchanged. Flag on: the published Admin FAQ
// (inactive questions/categories hidden); no published FAQ -> the coded page.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  if (!cmsContentEnabled()) return LEGACY_METADATA
  const view = await contentPublic().getFaq()
  if (!view) return LEGACY_METADATA
  const seo = view.variants.en.data.seo
  return { ...pageMetadata({ title: LEGACY_METADATA.title as string, description: LEGACY_METADATA.description as string }, seo,
    seo.shareImageId ? view.media[seo.shareImageId]?.url ?? null : null), alternates: { canonical: '/support/faq' } }
}

export default async function FAQPage() {
  if (cmsContentEnabled()) {
    const view = await contentPublic().getFaq()
    if (view) return <FaqView view={view} />
  }
  return <LegacyFAQPage />
}
