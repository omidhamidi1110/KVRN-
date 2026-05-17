import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { products } from '@/data/products'
import { ProductCard } from '@/components/product/ProductCard'
import { WaitlistForm } from '@/components/forms/WaitlistForm'
import { TrustBlock } from '@/components/sections/TrustBlock'
import { Button } from '@/components/ui/Button'

export const metadata: Metadata = {
  title: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
  description:
    'KVRN heavyweight fleece. 400 GSM+ oversized hoodies and sweatpants. Structured 3-panel hood. Concealed interior zippers. No drawstrings.',
}

export default function HomePage() {
  return (
    <>
      {/* ═══════════════════════════════════════════════════════════
          SECTION 1 — HERO (full viewport)
          V3 Blueprint: Launch phase → include wordmark + CTA
          Transition to no-CTA version at 1,000+ customers
      ═══════════════════════════════════════════════════════════ */}
      <section
        className="relative w-full h-[100svh] overflow-hidden bg-kvrn-bg-dark"
        aria-label="Campaign hero"
      >
        {/* Hero image — replace src with actual campaign image */}
        <div className="absolute inset-0">
          <Image
            src="/images/campaign/hero-drop001.webp"
            alt="KVRN Drop 001 campaign — heavyweight oversized hoodie in Stone"
            fill
            priority
            fetchPriority="high"
            quality={90}
            className="object-cover object-center"
            sizes="100vw"
          />
          {/* Subtle gradient for text legibility */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(to top, rgba(0,0,0,0.45) 0%, transparent 50%)',
            }}
            aria-hidden="true"
          />
        </div>

        {/* Hero content — bottom aligned */}
        <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-10 md:pb-14">
          <p
            className="text-[11px] font-light tracking-widest uppercase text-kvrn-text-on-dark/70 mb-3"
            aria-hidden="true"
          >
            Drop 001
          </p>

          {/* Launch-phase CTA — remove when brand is established */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <Link href="/shop">
              <Button variant="ghost" size="md">
                Shop the drop
              </Button>
            </Link>
            <Link
              href="/waitlist"
              className="text-[11px] font-light tracking-widest uppercase text-kvrn-text-on-dark/60 hover:text-kvrn-text-on-dark transition-colors duration-150"
            >
              Join the waitlist →
            </Link>
          </div>
        </div>

        {/* Placeholder shown when image not yet added */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center opacity-20">
            <p className="label-11 text-kvrn-text-on-dark mb-2">Campaign Hero Image</p>
            <p className="text-[11px] text-kvrn-text-on-dark/60">
              Add to /public/images/campaign/hero-drop001.webp
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 2 — PRODUCTS
      ═══════════════════════════════════════════════════════════ */}
      <section
        className="section-padding bg-kvrn-bg"
        aria-labelledby="products-heading"
      >
        <div className="container-kvrn">
          <p id="products-heading" className="label-11 mb-10 md:mb-14">
            Drop 001
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-10">
            {products.map((product, i) => (
              <ProductCard
                key={product.id}
                product={product}
                priority={i === 0}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 3 — MATERIAL STORY (launch phase — establishes brand)
          V3 Blueprint: Remove or reduce after brand equity is built
      ═══════════════════════════════════════════════════════════ */}
      <section
        className="section-padding bg-kvrn-bg-raised"
        aria-labelledby="material-heading"
      >
        <div className="container-kvrn">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-center">
            {/* Image */}
            <div className="relative aspect-[4/5] bg-kvrn-bg overflow-hidden order-2 lg:order-1">
              <Image
                src="/images/campaign/fabric-macro.webp"
                alt="400 GSM heavyweight fleece fabric detail — triple-brushed interior texture"
                fill
                quality={90}
                className="object-cover"
                sizes="(max-width: 1024px) 100vw, 50vw"
              />
              {/* Placeholder */}
              <div className="absolute inset-0 flex items-center justify-center bg-kvrn-bg opacity-60">
                <p className="label-11 text-kvrn-subtle text-center px-6">
                  Add fabric macro image<br />
                  /public/images/campaign/fabric-macro.webp
                </p>
              </div>
            </div>

            {/* Copy */}
            <div className="order-1 lg:order-2 space-y-8">
              <p className="label-11">The fabric</p>

              <h2 className="font-display font-light text-[32px] md:text-[40px] lg:text-[48px] leading-none tracking-tighter">
                400 GSM.
                <br />
                Heavyweight
                <br />
                Fleece.
              </h2>

              <p className="text-[15px] text-kvrn-muted leading-relaxed max-w-[440px]">
                Triple-brushed interior. Dense, cold-resist face. The weight is
                structural — immediately perceptible the moment you lift it. Built
                to last years and look better for the wear.
              </p>

              {/* Feature list */}
              <ul className="space-y-4" aria-label="Key product features">
                {[
                  { label: '400 GSM+',         desc: 'Tested per batch' },
                  { label: '3-Panel Hood',      desc: 'Holds without drawstrings' },
                  { label: 'Hidden Zippers',    desc: 'Both pocket sides' },
                  { label: 'No Drawstring',     desc: 'Engineered to hold its form' },
                ].map((feat) => (
                  <li key={feat.label} className="flex items-baseline gap-3 pb-4 border-b border-kvrn-border last:border-0 last:pb-0">
                    <span className="text-[13px] font-light min-w-[130px]">{feat.label}</span>
                    <span className="text-[13px] text-kvrn-muted">{feat.desc}</span>
                  </li>
                ))}
              </ul>

              <Link href="/about">
                <Button variant="secondary" size="md">
                  About KVRN
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 4 — TRUST BLOCK (launch phase only)
          V3: Remove after 18 months when brand carries trust
      ═══════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16 border-y border-kvrn-border bg-kvrn-bg">
        <div className="container-kvrn">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            {[
              { label: 'Ships in 3–5 days',   sub: 'UK & International',     icon: '↑' },
              { label: 'Free returns',         sub: '30 days, no questions',  icon: '↺' },
              { label: 'Tracked delivery',     sub: 'Every order',            icon: '◈' },
            ].map((item) => (
              <div key={item.label} className="flex flex-col gap-1 text-center sm:text-left">
                <p className="text-[13px] font-light">{item.label}</p>
                <p className="text-[12px] text-kvrn-muted">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 5 — EDITORIAL IMAGE
      ═══════════════════════════════════════════════════════════ */}
      <section className="w-full" aria-label="Campaign editorial image">
        <div className="relative aspect-video lg:aspect-[21/9] bg-kvrn-bg-raised overflow-hidden">
          <Image
            src="/images/campaign/editorial-drop001.webp"
            alt="KVRN Drop 001 editorial — oversized heavyweight hoodie and sweatpants"
            fill
            quality={85}
            className="object-cover object-center"
            sizes="100vw"
          />
          {/* Placeholder */}
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="label-11 text-kvrn-subtle text-center px-6">
              Editorial image<br/>
              /public/images/campaign/editorial-drop001.webp
            </p>
          </div>
          {/* Overlay caption */}
          <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-8 flex items-end justify-between">
            <p className="label-11 text-kvrn-text-on-dark/70">
              Drop 001 — Available now
            </p>
            <Link
              href="/shop"
              className="text-[11px] font-light tracking-widest uppercase text-kvrn-text-on-dark/70 hover:text-kvrn-text-on-dark transition-colors duration-150"
            >
              Shop →
            </Link>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 6 — PULL QUOTE + WAITLIST
      ═══════════════════════════════════════════════════════════ */}
      <section className="section-padding bg-kvrn-bg-dark">
        <div className="container-kvrn max-w-3xl mx-auto text-center">
          <blockquote>
            <p className="font-display font-light text-[32px] md:text-[48px] lg:text-[56px] leading-none tracking-tighter text-kvrn-text-on-dark mb-12 md:mb-16">
              Built for daily wear.
              <br />
              Designed for permanence.
            </p>
          </blockquote>

          <WaitlistForm
            variant="dark"
            heading="Get early access."
            subheading="Drop notifications only. No spam."
            source="homepage_waitlist"
            className="max-w-md mx-auto"
          />
        </div>
      </section>
    </>
  )
}
