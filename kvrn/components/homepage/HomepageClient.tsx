'use client'

import { useEffect, useRef } from 'react'
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
  const mainRef = useRef<HTMLDivElement>(null)

  // Lock body scroll; use our snap container instead
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
    }
  }, [])

  return (
    // Snap container — takes over scroll from body
    <div
      ref={mainRef}
      data-snap-page="true"
      style={{
        position: 'fixed',
        inset: 0,
        overflowY: 'scroll',
        scrollSnapType: 'y mandatory',
        scrollBehavior: 'smooth',
        WebkitOverflowScrolling: 'touch', // iOS momentum
      }}
    >
      {/* ─── HERO ─────────────────────────────────────────────────────────── */}
      <section
        data-snap-section="true"
        style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always' }}
        className="relative w-full h-[100svh] overflow-hidden bg-[#0E0E0E]"
        aria-label="Hero"
      >
        <Image
          src="/images/campaign/hero-main.webp"
          alt="KVRN — heavyweight fleece"
          fill priority fetchPriority="high"
          className="object-cover object-center"
          sizes="100vw"
        />
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.60) 0%, rgba(0,0,0,0.15) 50%, transparent 100%)' }}
          aria-hidden="true"
        />
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
        <ScrollCue scrollContainer={mainRef} />
      </section>

      {/* ─── PRODUCTS ─────────────────────────────────────────────────────── */}
      <section
        data-snap-section="true"
        style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always', minHeight: '100svh' }}
        className="bg-[#F9F8F6] flex flex-col"
      >
        <div className="flex-1">
          <HomepageProducts products={products} />
        </div>
      </section>

      {/* ─── FABRIC STORY ─────────────────────────────────────────────────── */}
      <section
        data-snap-section="true"
        style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always' }}
        className="bg-[#F3F0EB]"
        aria-labelledby="brand-heading"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 min-h-[100svh]">
          {/* Image */}
          <div className="relative h-[55svh] lg:h-auto overflow-hidden bg-[#E8E5E0]">
            <Image
              src="/images/campaign/fabric-macro.webp"
              alt="KVRN fabric texture"
              fill
              sizes="(max-width: 1024px) 100vw, 50vw"
              className="object-cover"
            />
          </div>
          {/* Copy */}
          <div className="flex items-center px-8 md:px-12 lg:px-16 xl:px-20 py-12 lg:py-0">
            <div className="space-y-6 max-w-[460px]">
              <p className="text-[11px] font-light tracking-[0.12em] uppercase text-[#9B9B9B]">
                The fabric
              </p>
              <h2 id="brand-heading"
                className="font-display font-light text-[30px] md:text-[42px] leading-[0.92] tracking-[-0.03em]">
                Built for the<br />weight of daily life.
              </h2>
              <p className="text-[15px] text-[#6B6B6B] leading-relaxed">
                Two collections. Both developed around weight, structure, and longevity.
                Each piece is made to be worn every day and hold up over time.
              </p>
              <div className="space-y-3">
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
        </div>
      </section>

      {/* ─── WAITLIST CTA (dark, snapped) ────────────────────────────────── */}
      <section
        data-snap-section="true"
        style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always', minHeight: '100svh' }}
        className="flex flex-col"
      >
        <WaitlistBlock />
      </section>
    </div>
  )
}
