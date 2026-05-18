'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { ScrollCue } from '@/components/ui/ScrollCue'
import { WaitlistBlock } from '@/components/homepage/WaitlistBlock'
import { HomepageProducts } from '@/components/homepage/HomepageProducts'
import type { Product } from '@/types'

interface Props { products: Product[] }

export function HomepageClient({ products }: Props) {
  const { t } = useI18n()

  return (
    <>
      {/* ─── HERO — full viewport ──────────────────────────────────────────── */}
      <section
        className="relative w-full h-[100svh] overflow-hidden bg-[#0E0E0E] snap-start"
        aria-label="Hero"
      >
        <Image
          src="/images/campaign/hero-main.webp"
          alt="KVRN — heavyweight fleece"
          fill priority fetchPriority="high"
          className="object-cover object-center"
          sizes="100vw"
        />
        {/* Bottom gradient */}
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.60) 0%, rgba(0,0,0,0.15) 45%, transparent 100%)' }}
          aria-hidden="true"
        />

        {/* Hero text */}
        <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-16 md:pb-20">
          <h1 className="font-display font-light text-[44px] sm:text-[56px] md:text-[68px] leading-[0.92] tracking-[-0.03em] text-[#F0EDE8] mb-7">
            Quiet luxury.<br />Premium utility.
          </h1>
          <Link
            href="/shop"
            className="inline-flex items-center h-11 px-8 border border-[#F0EDE8]/60 text-[11px] font-light tracking-[0.14em] uppercase text-[#F0EDE8] hover:bg-[#F0EDE8] hover:text-[#0E0E0E] hover:border-[#F0EDE8] transition-all duration-300"
          >
            {t.shopNow}
          </Link>
        </div>

        <ScrollCue />
      </section>

      {/* ─── PRODUCTS — editorial grid ─────────────────────────────────────── */}
      <HomepageProducts products={products} />

      {/* ─── FABRIC / BRAND STORY ──────────────────────────────────────────── */}
      <section
        className="relative min-h-[100svh] flex items-center bg-[#F3F0EB] snap-start overflow-hidden"
        aria-labelledby="brand-heading"
      >
        <div className="container-kvrn grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-0 items-stretch w-full py-20 lg:py-0">
          {/* Left: image */}
          <div className="relative lg:absolute lg:left-0 lg:top-0 lg:bottom-0 lg:w-[50%] aspect-[4/5] lg:aspect-auto overflow-hidden bg-[#E8E5E0]">
            <Image
              src="/images/campaign/fabric-macro.webp"
              alt="KVRN fabric texture"
              fill
              sizes="(max-width: 1024px) 100vw, 50vw"
              className="object-cover"
            />
          </div>

          {/* Right: copy */}
          <div className="lg:ml-[50%] lg:pl-16 xl:pl-24 space-y-7 lg:py-24">
            <p className="text-[11px] font-light tracking-[0.12em] uppercase text-[#9B9B9B]">
              The fabric
            </p>
            <h2 id="brand-heading"
              className="font-display font-light text-[32px] md:text-[44px] lg:text-[52px] leading-[0.92] tracking-[-0.03em]">
              Built for the<br />weight of daily life.
            </h2>
            <p className="text-[15px] text-[#6B6B6B] leading-relaxed max-w-[400px]">
              Two collections. Both developed around weight, structure, and longevity.
              Each piece is made to be worn every day and hold up over time.
            </p>
            <div className="space-y-3 pt-1 max-w-[400px]">
              {[
                ['Heavyweight', 'Dense fleece. Structured hood. Hidden zippers.'],
                ['Phantom',     'Heavier blend. Enzyme washed. Cropped proportion.'],
                ['Both',        'Oversized fit. Built to last.'],
              ].map(([label, desc]) => (
                <div key={label} className="flex gap-5 pb-3 border-b border-[#E8E5E0] last:border-0 last:pb-0">
                  <span className="text-[13px] font-light min-w-[90px] text-[#1A1A1A]">{label}</span>
                  <span className="text-[13px] text-[#6B6B6B]">{desc}</span>
                </div>
              ))}
            </div>
            <Link
              href="/shop"
              className="inline-flex items-center h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.14em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-all duration-300"
            >
              {t.shopNow}
            </Link>
          </div>
        </div>
      </section>

      {/* ─── TRUST SIGNALS ─────────────────────────────────────────────────── */}
      <section className="py-10 border-y border-[#E8E5E0] bg-[#F9F8F6]">
        <div className="container-kvrn">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {[
              { title: t.secureCheckout,        sub: 'Encrypted payment' },
              { title: t.storeCreditReturns,    sub: 'Within return window' },
              { title: 'Ships within 1–3 days', sub: 'After order confirmation' },
              { title: 'Built for longevity',   sub: 'Premium materials' },
            ].map(item => (
              <div key={item.title}>
                <p className="text-[13px] font-light text-[#1A1A1A]">{item.title}</p>
                <p className="text-[11px] text-[#6B6B6B] mt-0.5">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── WAITLIST CTA ──────────────────────────────────────────────────── */}
      <WaitlistBlock />
    </>
  )
}
