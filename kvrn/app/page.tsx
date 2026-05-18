import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { products, getProductsByType } from '@/data/products'
import { ProductCard } from '@/components/product/ProductCard'
import { WaitlistForm } from '@/components/forms/WaitlistForm'
import { ScrollCue }   from '@/components/ui/ScrollCue'
import { Button }      from '@/components/ui/Button'

export const metadata: Metadata = {
  title:       'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
  description: 'KVRN heavyweight fleece. 400–500 GSM oversized hoodies and sweatpants. Double-layered hood. Hidden zipper pockets. No drawstrings. Quiet luxury.',
}

export default function HomePage() {
  const hoodies    = getProductsByType('hoodie')
  const sweatpants = getProductsByType('sweatpants')

  return (
    <>
      {/* ═══ HERO ════════════════════════════════════════════════════════════ */}
      <section
        className="relative w-full h-[100svh] overflow-hidden bg-kvrn-bg-dark"
        aria-label="Campaign hero"
      >
        <div className="absolute inset-0">
          <Image
            src="/images/campaign/hero-main.webp"
            alt="KVRN campaign — heavyweight oversized hoodie"
            fill priority fetchPriority="high" quality={90}
            className="object-cover object-center"
            sizes="100vw"
          />
          <div className="absolute inset-0"
            style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.5) 0%, transparent 55%)' }}
            aria-hidden="true"
          />
        </div>

        {/* Hero copy */}
        <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-12 md:pb-16">
          <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-5">
            <div>
              <p className="label-11 text-kvrn-text-on-dark/60 mb-2">Drop 001</p>
              <h1 className="font-display font-light text-[40px] md:text-[56px] leading-none tracking-tighter text-kvrn-text-on-dark">
                Quiet luxury.<br/>Premium utility.
              </h1>
            </div>
            <Link href="/shop">
              <Button variant="ghost" size="md">Shop the drop</Button>
            </Link>
          </div>
        </div>

        {/* Scroll cue overlay */}
        <ScrollCue />
      </section>

      {/* ═══ HEAVYWEIGHT COLLECTION ══════════════════════════════════════════ */}
      <section className="section-padding bg-kvrn-bg" aria-labelledby="hw-heading">
        <div className="container-kvrn">
          <div className="flex items-baseline justify-between mb-10 md:mb-14">
            <div>
              <p className="label-11 mb-1">Heavyweight Collection</p>
              <h2 id="hw-heading" className="font-display font-light text-[28px] md:text-[36px] leading-tight tracking-tighter">
                400 GSM Brushed Fleece
              </h2>
            </div>
            <Link href="/shop?type=hoodies"
              className="hidden sm:block text-[11px] font-light tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors">
              View all →
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-10">
            {[...hoodies, ...sweatpants].slice(0, 2).map((product, i) => (
              <ProductCard key={product.id} product={product} priority={i === 0} />
            ))}
          </div>
        </div>
      </section>

      {/* ═══ MATERIAL STORY ══════════════════════════════════════════════════ */}
      <section className="section-padding bg-kvrn-bg-raised" aria-labelledby="material-heading">
        <div className="container-kvrn">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-24 items-center">
            <div className="relative aspect-[4/5] bg-kvrn-bg overflow-hidden order-2 lg:order-1">
              <Image
                src="/images/campaign/fabric-macro.webp"
                alt="400 GSM brushed fleece — fabric texture detail"
                fill quality={90} className="object-cover"
                sizes="(max-width: 1024px) 100vw, 50vw"
              />
              {/* Placeholder when image not added */}
              <div className="absolute inset-0 flex items-center justify-center bg-kvrn-bg-raised opacity-70">
                <p className="label-11 text-kvrn-subtle text-center px-6">
                  Add /public/images/campaign/fabric-macro.webp
                </p>
              </div>
            </div>

            <div className="order-1 lg:order-2 space-y-7">
              <p className="label-11">The fabric</p>
              <h2 id="material-heading"
                className="font-display font-light text-[32px] md:text-[44px] leading-none tracking-tighter">
                400 GSM.<br/>Double-layered.<br/>No drawstring.
              </h2>
              <p className="text-[15px] text-kvrn-muted leading-relaxed max-w-[420px]">
                Dense enough to feel structural. Considered enough to be worn without thinking.
                The double-layered hood holds its form without support. Two hidden zipper
                compartments sit inside the kangaroo pocket — invisible from outside.
              </p>
              <div className="space-y-3">
                {[
                  ['400 GSM Brushed Fleece', '100% cotton, tested per batch'],
                  ['Double-Layered Hood',    'Holds without a drawstring'],
                  ['Hidden Zipper Pockets',  'Both sides, invisible externally'],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-4 pb-3 border-b border-kvrn-border last:border-0 last:pb-0">
                    <span className="text-[13px] font-light min-w-[160px]">{label}</span>
                    <span className="text-[13px] text-kvrn-muted">{desc}</span>
                  </div>
                ))}
              </div>
              <Link href="/about">
                <Button variant="secondary" size="md">About KVRN</Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ PHANTOM COLLECTION ══════════════════════════════════════════════ */}
      <section className="section-padding bg-kvrn-bg-dark" aria-labelledby="phantom-heading">
        <div className="container-kvrn">
          <div className="flex items-baseline justify-between mb-10 md:mb-14">
            <div>
              <p className="label-11 text-kvrn-text-on-dark/50 mb-1">Phantom Collection</p>
              <h2 id="phantom-heading"
                className="font-display font-light text-[28px] md:text-[36px] leading-tight tracking-tighter text-kvrn-text-on-dark">
                500 GSM French Terry
              </h2>
            </div>
            <Link href="/shop?type=hoodies"
              className="hidden sm:block text-[11px] font-light tracking-widest uppercase text-kvrn-text-on-dark/50 hover:text-kvrn-text-on-dark transition-colors">
              View all →
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-10">
            {products.filter(p => p.slug.includes('phantom')).map((product, i) => (
              <ProductCard key={product.id} product={product} priority={false} />
            ))}
          </div>

          <p className="text-[13px] text-kvrn-text-on-dark/40 mt-10 max-w-[480px]">
            Phantom is cut in a heavier French terry blend with an oversized, cropped
            proportion. Enzyme washed for a softer hand feel and finished for everyday wear.
          </p>
        </div>
      </section>

      {/* ═══ TRUST BLOCK ═════════════════════════════════════════════════════ */}
      <section className="py-10 md:py-12 border-y border-kvrn-border bg-kvrn-bg">
        <div className="container-kvrn">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5 md:gap-8">
            {[
              { title: 'Secure checkout',        sub: 'Encrypted payment' },
              { title: 'Store credit returns',   sub: 'Within return window' },
              { title: 'Fast order processing',  sub: 'Ships within 1–3 days' },
              { title: 'Premium materials',      sub: 'Tested per batch' },
            ].map(item => (
              <div key={item.title}>
                <p className="text-[13px] font-light">{item.title}</p>
                <p className="text-[11px] text-kvrn-muted mt-0.5">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ EDITORIAL IMAGE ═════════════════════════════════════════════════ */}
      <section className="relative overflow-hidden" aria-label="Campaign editorial">
        <div className="relative aspect-video lg:aspect-[21/9] bg-kvrn-bg-raised">
          <Image
            src="/images/campaign/fabric-macro.webp"
            alt="KVRN campaign editorial — oversized heavyweight hoodie and sweatpants"
            fill quality={85} className="object-cover"
            sizes="100vw"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="label-11 text-kvrn-subtle">
              Add /public/images/campaign/fabric-macro.webp
            </p>
          </div>
        </div>
      </section>

      {/* ═══ WAITLIST ════════════════════════════════════════════════════════ */}
      <section className="section-padding bg-kvrn-bg-dark" aria-labelledby="waitlist-heading">
        <div className="container-kvrn max-w-2xl mx-auto text-center">
          <blockquote>
            <p id="waitlist-heading"
              className="font-display font-light text-[32px] md:text-[48px] leading-none tracking-tighter text-kvrn-text-on-dark mb-12">
              Built for daily wear.<br/>Designed for permanence.
            </p>
          </blockquote>
          <WaitlistForm
            variant="dark"
            heading="Get early access."
            subheading="Drop notifications only."
            source="homepage"
            className="max-w-md mx-auto"
          />
        </div>
      </section>
    </>
  )
}
