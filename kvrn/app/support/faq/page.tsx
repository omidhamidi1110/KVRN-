import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Accordion } from '@/components/ui/Accordion'

export const metadata: Metadata = {
  title: 'FAQ — KVRN',
  description: 'Frequently asked questions about KVRN products, sizing, shipping and returns.',
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
            Orders are processed within approximately 1 to 3 business days of payment. Products are in stock and ship promptly unless a product page states otherwise.
          </p>
        ),
      },
      {
        id: 'delivery',
        trigger: 'How long does delivery take?',
        content: (
          <div className="space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>Domestic orders typically arrive within 2 to 7 business days after dispatch. International orders typically take 5 to 14 business days or more, depending on the destination and customs.</p>
            <p>Delivery estimates are not guarantees. All orders include tracking, sent when your order dispatches.</p>
          </div>
        ),
      },
      {
        id: 'free-shipping',
        trigger: 'Is there free shipping?',
        content: (
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            Complimentary shipping is available on U.S. orders over $150. Shipping costs for all other orders are calculated at checkout based on destination and method selected.
          </p>
        ),
      },
      {
        id: 'tracking',
        trigger: 'How do I track my order?',
        content: (
          <div className="text-[13px] text-[#6B6B6B] leading-relaxed">
            <p>You will receive a tracking number by email once your order ships. You can also use the track order page.</p>
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
            <p>We accept returns for store credit on unworn, unwashed items with tags still attached, within our return window. The return window is shown in your order confirmation.</p>
            <p>Customer covers return shipping unless the item arrives damaged, faulty, or incorrect.</p>
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
            <p>Email <a href="mailto:returns@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">returns@kvrn.shop</a> with your order number and the items you would like to return. We will respond within 24 hours with next steps.</p>
          </div>
        ),
      },
      {
        id: 'wrong-item',
        trigger: 'What if my order arrived wrong or damaged?',
        content: (
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            Email <a href="mailto:support@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">support@kvrn.shop</a> with your order number and photos. If the item is faulty, incorrect, or damaged on arrival, we will cover the return shipping and resolve it at no cost to you.
          </p>
        ),
      },
    ],
  },
]

export default function FAQPage() {
  return (
    <div className="pt-[calc(36px+56px)]">
      {/* Dark header band */}
      <PageHero title="FAQ" breadcrumb="FAQ" />

      <div className="container-kvrn max-w-3xl py-14">
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
