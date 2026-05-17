import type { Metadata } from 'next'
import Link from 'next/link'
import { Accordion } from '@/components/ui/Accordion'

export const metadata: Metadata = {
  title: 'FAQ — KVRN',
  description: 'Frequently asked questions about KVRN products, sizing, shipping, and returns.',
}

const faqSections = [
  {
    heading: 'Product',
    items: [
      {
        id:      'what-is-400-gsm',
        trigger: 'What does 400 GSM mean?',
        content: (
          <div className="space-y-3">
            <p>GSM stands for grams per square metre — the standard measurement of fabric weight. A higher number means a denser, heavier fabric.</p>
            <p>Most hoodies on the market are 280–320 GSM. At 300 GSM, a hoodie feels light and somewhat provisional. At 400 GSM+, the fabric becomes structural — it holds its shape, drapes differently, and has a perceptible weight when you hold it.</p>
            <p>KVRN tests every batch to confirm the GSM meets our minimum standard. We do not accept batches below 390 GSM.</p>
          </div>
        ),
      },
      {
        id:      'why-no-drawstring',
        trigger: 'Why is there no drawstring?',
        content: (
          <p>The 3-panel hood is engineered to hold its form without a drawstring. A drawstring is typically added because the hood collapses without it — the hood requires external support to maintain shape. KVRN&apos;s hood structure eliminates that requirement. There is nothing to pull, nothing to lose, and nothing to interrupt the silhouette.</p>
        ),
      },
      {
        id:      'hidden-zippers',
        trigger: 'How do the hidden zippers work?',
        content: (
          <p>Each kangaroo pocket opening has a concealed YKK coil zipper running parallel behind it — one on each side. From the outside, with the zipper closed, the pockets appear completely standard. Open the zipper and you have access to a secure interior compartment. They are invisible in all positions.</p>
        ),
      },
      {
        id:      'care',
        trigger: 'How should I wash and care for the hoodie?',
        content: (
          <div className="space-y-3">
            <p>Machine wash cold (30°C), inside out. Use a gentle cycle. Air dry — do not tumble dry. Do not iron the rubber patch.</p>
            <p>The fleece will soften over the first 3–5 washes. This is expected behaviour — the fabric continues to improve with regular wear and care. The structure of the hood and the integrity of the zippers are not affected by washing.</p>
          </div>
        ),
      },
      {
        id:      'fabric',
        trigger: 'What is the fabric composition?',
        content: (
          <p>100% ring-spun combed cotton. No polyester blend. Ring-spun cotton is stronger and softer than standard spun cotton due to the way the fibres are twisted. Combing removes short fibres and impurities, resulting in a cleaner, more durable yarn.</p>
        ),
      },
    ],
  },
  {
    heading: 'Sizing',
    id: 'sizing',
    items: [
      {
        id:      'sizing-guide',
        trigger: 'How does KVRN fit?',
        content: (
          <div className="space-y-4">
            <p>KVRN is designed to be oversized. This is not a standard fit with extra room — it is a considered oversized silhouette where the proportions are deliberate.</p>
            <p>If you want the intended silhouette, buy your normal size. If you prefer a cleaner, more fitted oversized look, size down.</p>
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-[13px]" aria-label="Size guide measurements">
                <thead>
                  <tr className="border-b border-kvrn-border">
                    <th className="text-left py-2 font-light label-11">Size</th>
                    <th className="text-left py-2 font-light label-11">Chest (cm)</th>
                    <th className="text-left py-2 font-light label-11">Length (cm)</th>
                    <th className="text-left py-2 font-light label-11">Sleeve (cm)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-kvrn-border">
                  {[
                    { size: 'XS',  chest: 60, length: 72, sleeve: 63 },
                    { size: 'S',   chest: 64, length: 74, sleeve: 64 },
                    { size: 'M',   chest: 68, length: 76, sleeve: 65 },
                    { size: 'L',   chest: 72, length: 78, sleeve: 66 },
                    { size: 'XL',  chest: 76, length: 80, sleeve: 67 },
                    { size: 'XXL', chest: 80, length: 82, sleeve: 68 },
                  ].map((row) => (
                    <tr key={row.size}>
                      <td className="py-2.5 font-light">{row.size}</td>
                      <td className="py-2.5 text-kvrn-muted">{row.chest}</td>
                      <td className="py-2.5 text-kvrn-muted">{row.length}</td>
                      <td className="py-2.5 text-kvrn-muted">{row.sleeve}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[12px] text-kvrn-muted mt-3">All measurements in centimetres, taken flat. ±1.5cm tolerance.</p>
            </div>
          </div>
        ),
      },
      {
        id:      'between-sizes',
        trigger: 'I am between sizes — what should I do?',
        content: (
          <p>Size down for a cleaner oversized silhouette. The oversized cut means even a smaller size will have substantial volume. If you are unsure, email us at hello@kvrn.com with your height and usual size — we will give you a specific recommendation.</p>
        ),
      },
    ],
  },
  {
    heading: 'Orders & Shipping',
    items: [
      {
        id:      'order-time',
        trigger: 'When will my order ship?',
        content: (
          <p>Orders placed before 1pm GMT ship the same day (Monday–Friday, excluding bank holidays). Orders placed after 1pm ship the following working day. You will receive a tracking number by email once dispatched.</p>
        ),
      },
      {
        id:      'international-duties',
        trigger: 'Will I pay import duties on international orders?',
        content: (
          <p>Orders shipped outside the UK may be subject to import duties and taxes levied by the destination country&apos;s customs authority. These charges are the responsibility of the recipient and are not included in the shipping cost. For EU orders, we ship DDU (Delivered Duty Unpaid) — you will be contacted by your local customs authority if duties apply.</p>
        ),
      },
      {
        id:      'order-tracking',
        trigger: 'How do I track my order?',
        content: (
          <p>Once your order ships, you will receive an email with your tracking number and a direct link to track your parcel. If you have not received a shipping confirmation within 2 business days of ordering, check your spam folder or contact us at hello@kvrn.com.</p>
        ),
      },
    ],
  },
  {
    heading: 'Returns',
    items: [
      {
        id:      'returns-window',
        trigger: 'What is the return window?',
        content: (
          <p>30 days from the date of delivery, on unworn, unwashed items with tags attached. To initiate a return, email hello@kvrn.com with your order number.</p>
        ),
      },
      {
        id:      'faulty',
        trigger: 'What if my item is faulty?',
        content: (
          <p>Faulty items are covered under your statutory consumer rights regardless of the 30-day window. Contact us immediately with photos of the fault at hello@kvrn.com. We will arrange a replacement or full refund — whichever you prefer.</p>
        ),
      },
    ],
  },
]

export default function FAQPage() {
  return (
    <div className="pt-[56px]">
      <div className="container-kvrn section-padding max-w-3xl">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">FAQ</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[56px] leading-none tracking-tighter mb-16">
          Questions
        </h1>

        <div className="space-y-16">
          {faqSections.map((section) => (
            <section key={section.heading} id={section.id} aria-labelledby={`section-${section.heading}`}>
              <h2
                id={`section-${section.heading}`}
                className="label-11 mb-6"
              >
                {section.heading}
              </h2>
              <Accordion items={section.items} />
            </section>
          ))}
        </div>

        {/* Still have questions */}
        <div className="mt-20 pt-10 border-t border-kvrn-border">
          <p className="text-[15px] font-light mb-2">Still have a question?</p>
          <p className="text-[14px] text-kvrn-muted mb-4">
            Email us at{' '}
            <a href="mailto:hello@kvrn.com" className="text-kvrn-text underline underline-offset-2 hover:opacity-70 transition-opacity">
              hello@kvrn.com
            </a>
            . We respond within 24 hours.
          </p>
          <Link
            href="/contact"
            className="text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150 underline underline-offset-2"
          >
            Send a message →
          </Link>
        </div>
      </div>
    </div>
  )
}
