import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { products } from '@/data/products'
import { ProductCard } from '@/components/product/ProductCard'
import { WaitlistForm } from '@/components/forms/WaitlistForm'
import { ScrollCue }   from '@/components/ui/ScrollCue'
import { Button }      from '@/components/ui/Button'

export const metadata: Metadata = {
  title: 'KVRN — Premium Heavyweight Fleece',
  description: 'KVRN heavyweight hoodies and sweatpants. 400–500 GSM. Quiet luxury built for daily wear.',
}

export default function HomePage() {
  return (
    <>
      {/* ─── HERO ───────────────────────────────────────────────────────────── */}
      <section className="relative w-full h-[100svh] overflow-hidden bg-[#0E0E0E]" aria-label="Hero">
        <Image
          src="/images/campaign/hero-main.webp"
          alt="KVRN — heavyweight fleece"
          fill priority fetchPriority="high"
          className="object-cover object-center"
          sizes="100vw"
        />
        {/* Gradient overlay */}
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.1) 50%, transparent 100%)' }}
          aria-hidden="true"
        />

        {/* Hero copy */}
        <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-12 md:pb-20">
          <h1 className="font-display font-light text-[42px] md:text-[60px] leading-none tracking-[-0.03em] text-[#F0EDE8] mb-6">
            Quiet luxury.<br />Premium utility.
          </h1>
          <Link href="/shop">
            <Button variant="ghost" size="md">Shop now</Button>
          </Link>
        </div>

        <ScrollCue />
      </section>

      {/* ─── ALL PRODUCTS ────────────────────────────────────────────────────── */}
      <section className="section-padding bg-[#F9F8F6]" aria-labelledby="collection-heading">
        <div className="container-kvrn">
          <div className="flex items-baseline justify-between mb-10 md:mb-14">
            <h2 id="collection-heading"
              className="font-display font-light text-[26px] md:text-[34px] leading-tight tracking-[-0.02em]">
              The Collection
            </h2>
            <Link href="/shop"
              className="hidden sm:block text-[11px] font-light tracking-[0.1em] uppercase text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
              View all
            </Link>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            {products.map((product, i) => (
              <ProductCard key={product.id} product={product} priority={i < 2} />
            ))}
          </div>

          {/* Founder note */}
          <p className="mt-8 text-[12px] text-[#6B6B6B]">
            Founder pricing — permanently increases after initial release.
          </p>
        </div>
      </section>

      {/* ─── MATERIAL STORY ─────────────────────────────────────────────────── */}
      <section className="section-padding bg-[#F3F0EB]" aria-labelledby="material-heading">
        <div className="container-kvrn">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-20 items-center">
            {/* Image — left */}
            <div className="relative aspect-[4/5] overflow-hidden bg-[#E8E5E0]">
              <Image
                src="/images/campaign/fabric-macro.webp"
                alt="KVRN fabric — 400 GSM brushed fleece texture"
                fill
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="object-cover"
              />
            </div>

            {/* Copy — right */}
            <div className="space-y-6">
              <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#6B6B6B]">The fabric</p>
              <h2 id="material-heading"
                className="font-display font-light text-[30px] md:text-[40px] leading-none tracking-[-0.02em]">
                Built for the<br />weight of daily life.
              </h2>
              <p className="text-[15px] text-[#6B6B6B] leading-relaxed max-w-[420px]">
                Two collections. Both built from premium fleece with the structure and weight to last.
                The Heavyweight is 100% cotton, brushed inside. The Phantom is a French terry blend, enzyme washed for immediate softness.
              </p>
              <div className="space-y-3 pt-2">
                {[
                  ['Heavyweight', '400 GSM brushed fleece, 100% cotton'],
                  ['Phantom',     '500 GSM French terry, enzyme washed'],
                  ['Both',        'Oversized fit, designed for daily wear'],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-5 pb-3 border-b border-[#E8E5E0] last:border-0 last:pb-0">
                    <span className="text-[13px] font-light min-w-[100px] text-[#1A1A1A]">{label}</span>
                    <span className="text-[13px] text-[#6B6B6B]">{desc}</span>
                  </div>
                ))}
              </div>
              <Link href="/shop">
                <Button variant="secondary" size="md">Shop all</Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ─── TRUST / BRAND VALUES ───────────────────────────────────────────── */}
      <section className="py-10 border-y border-[#E8E5E0] bg-[#F9F8F6]">
        <div className="container-kvrn">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
            {[
              { title: 'Secure checkout',         sub: 'Encrypted payment' },
              { title: 'Store credit returns',    sub: 'Within return window' },
              { title: 'Ships within 1–3 days',   sub: 'After order confirmation' },
              { title: 'Built for longevity',      sub: 'Premium materials' },
            ].map(item => (
              <div key={item.title}>
                <p className="text-[13px] font-light text-[#1A1A1A]">{item.title}</p>
                <p className="text-[11px] text-[#6B6B6B] mt-0.5">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── WAITLIST ────────────────────────────────────────────────────────── */}
      <section className="section-padding bg-[#0E0E0E]" aria-labelledby="waitlist-heading">
        <div className="container-kvrn max-w-xl mx-auto text-center">
          <h2 id="waitlist-heading"
            className="font-display font-light text-[32px] md:text-[44px] leading-none tracking-[-0.02em] text-[#F0EDE8] mb-10">
            Built for daily wear.<br />Designed for permanence.
          </h2>
          <WaitlistForm
            variant="dark"
            heading="Get early access."
            subheading="Drop notifications only. No spam."
            source="homepage"
          />
        </div>
      </section>
    </>
  )
}
