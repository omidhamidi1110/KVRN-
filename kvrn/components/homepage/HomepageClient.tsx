'use client'

import { useEffect, useRef, useState, RefObject } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { WaitlistBlock } from '@/components/homepage/WaitlistBlock'


// Dark slides = white nav text; light slides = black nav text
const DARK_SLIDES = new Set([0, 1, 3])
const TOTAL_SLIDES = 5

export function HomepageClient() {
  const { t }        = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const [slide, setSlide] = useState(0)

  // Lock body scroll; snap container handles scrolling
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
    }
  }, [])

  // Track active slide + dispatch nav color event
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const idx = Math.round(el.scrollTop / el.clientHeight)
      setSlide(Math.min(idx, TOTAL_SLIDES - 1))
      window.dispatchEvent(new CustomEvent('kvrn-slide-change', {
        detail: { dark: DARK_SLIDES.has(idx) }
      }))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        overflowY: 'scroll',
        scrollSnapType: 'y mandatory',
        scrollBehavior: 'smooth',
        WebkitOverflowScrolling: 'touch',
        overscrollBehaviorY: 'none',
      }}
    >
      {/* Slide indicator — first 3 slides only */}
      {slide < 3 && (
        <SlideIndicator current={slide} total={3} dark={DARK_SLIDES.has(slide)} />
      )}

      {/* ── SLIDE 0: Project KVRN (current drop) ─────────────────────────── */}
      <FullSlide dark>
        <Image
          src="/images/campaign/hero-main.webp"
          alt="Project KVRN — available now"
          fill priority fetchPriority="high"
          className="object-cover object-center"
          sizes="100vw"
        />
        <div className="absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.08) 60%, transparent 100%)' }}
          aria-hidden="true"
        />
        <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-16 md:pb-20">
          <p className="text-[11px] font-light tracking-[0.22em] uppercase text-[#F0EDE8]/55 mb-4">
            Available now
          </p>
          <h1 className="font-display font-light text-[48px] sm:text-[62px] md:text-[78px] leading-[0.86] tracking-[-0.03em] text-[#F0EDE8] mb-8">
            Project<br />KVRN
          </h1>
          <Link href="/shop?type=hoodies"
            className="inline-flex items-center h-11 px-8 border border-[#F0EDE8]/55 text-[11px] font-light tracking-[0.18em] uppercase text-[#F0EDE8] hover:bg-[#F0EDE8] hover:text-[#0E0E0E] hover:border-[#F0EDE8] transition-all duration-300">
            Shop Project KVRN
          </Link>
        </div>
      </FullSlide>

      {/* ── SLIDE 1: Campaign video ───────────────────────────────────────── */}
      <FullSlide dark>
        <video
          autoPlay muted loop playsInline
          className="absolute inset-0 w-full h-full object-cover"
          poster="/images/campaign/fabric-macro.webp"
        >
          <source src="/images/campaign/hero-video.webm" type="video/webm" />
          <source src="/images/campaign/hero-video.mp4"  type="video/mp4"  />
        </video>
        {/* Fallback image — shows until video loads; hidden once video plays */}
        <Image
          src="/images/campaign/fabric-macro.webp"
          alt="KVRN — weight, structure, restraint"
          fill
          className="object-cover"
          sizes="100vw"
          style={{ zIndex: -1 }}
        />
        <div className="absolute inset-0 bg-[#0E0E0E]/40" aria-hidden="true" />
        <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-16 md:pb-20">
          <p className="font-display font-light text-[20px] md:text-[28px] tracking-[0.04em] text-[#F0EDE8]/75 max-w-[560px] leading-snug">
            Weight. Structure. Restraint.
          </p>
        </div>
      </FullSlide>

      {/* ── SLIDE 2: Future drop — Heavyweight Collection ─────────────────── */}
      <FullSlide light>
        {/* Background fill — warm light, not blank white */}
        <div className="absolute inset-0 bg-[#EDE9E3]" />
        <div className="absolute inset-0 container-kvrn flex flex-col justify-end pb-16 md:pb-20">
          <p className="text-[11px] font-light tracking-[0.22em] uppercase text-[#9B9B9B] mb-4">
            Coming soon
          </p>
          <h2 className="font-display font-light text-[48px] sm:text-[62px] md:text-[78px] leading-[0.86] tracking-[-0.03em] text-[#1A1A1A] mb-6">
            Heavyweight<br />Collection
          </h2>
          <p className="text-[15px] font-light text-[#6B6B6B] leading-relaxed max-w-[440px] mb-8">
            400 GSM brushed fleece. Dense enough to feel structural.
            Considered enough to be worn without thinking. Five colorways.
          </p>
          <ScrollToSlide targetSlide={3} containerRef={containerRef}
            className="inline-flex items-center h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.18em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300">
            Join the list
          </ScrollToSlide>
        </div>
      </FullSlide>

      {/* ── SLIDE 3: KVRN List ────────────────────────────────────────────── */}
      <FullSlide dark>
        <WaitlistBlock />
      </FullSlide>

      {/* ── SLIDE 4: Footer ───────────────────────────────────────────────── */}
      <FullSlide light>
        <HomepageFooter />
      </FullSlide>
    </div>
  )
}


// ── Scroll-to-slide helper (used by slide CTAs) ───────────────────────────────
function ScrollToSlide({
  targetSlide, containerRef, children, className,
}: {
  targetSlide:   number
  containerRef:  React.RefObject<HTMLDivElement | null>
  children:      React.ReactNode
  className?:    string
}) {
  const scrollTo = () => {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ top: targetSlide * el.clientHeight, behavior: 'smooth' })
  }
  return (
    <button onClick={scrollTo} className={className}>
      {children}
    </button>
  )
}

// ── Full-screen snap slide ─────────────────────────────────────────────────────
function FullSlide({
  children, dark, light, 'aria-label': label,
}: {
  children:      React.ReactNode
  dark?:         boolean
  light?:        boolean
  'aria-label'?: string
}) {
  return (
    <section
      aria-label={label}
      style={{
        scrollSnapAlign: 'start',
        scrollSnapStop:  'always',
        height:          '100svh',
        minHeight:       '100svh',
        maxHeight:       '100svh',
        position:        'relative',
        overflow:        'hidden',
      }}
      className={dark ? 'bg-[#0E0E0E]' : 'bg-[#EDE9E3]'}
    >
      {children}
    </section>
  )
}

// ── Slide indicator — all 5 slides, left side ──────────────────────────────────
function SlideIndicator({ current, total, dark }: {
  current: number
  total:   number
  dark:    boolean
}) {
  return (
    <div
      className="fixed left-4 md:left-7 top-1/2 -translate-y-1/2 z-[195] flex flex-col gap-[5px]"
      role="tablist"
      aria-label="Slide position"
    >
      {Array.from({ length: total }, (_, i) => {
        const active = i === current
        return (
          <div
            key={i}
            role="tab"
            aria-selected={active}
            aria-label={`Slide ${i + 1} of ${total}`}
            style={{
              width:           '2px',
              height:          active ? '26px' : '10px',
              borderRadius:    '1px',
              backgroundColor: dark
                ? (active ? 'rgba(240,237,232,0.9)' : 'rgba(240,237,232,0.22)')
                : (active ? 'rgba(26,26,26,0.85)'   : 'rgba(26,26,26,0.18)'),
              transition: 'height 0.45s cubic-bezier(0.25,0.46,0.45,0.94), background-color 0.3s',
            }}
          />
        )
      })}
    </div>
  )
}

// ── Compact footer for slide 4 ─────────────────────────────────────────────────
function HomepageFooter() {
  const year = new Date().getFullYear()
  return (
    <div className="absolute inset-0 flex flex-col justify-between bg-[#F9F8F6]">
      {/* Giant KVRN wordmark — background decoration */}
      <div
        className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none select-none"
        aria-hidden="true"
      >
        <span
          className="font-display font-light text-[#1A1A1A]/[0.03] whitespace-nowrap"
          style={{ fontSize: 'clamp(120px, 22vw, 260px)', letterSpacing: '-0.04em', lineHeight: 1 }}
        >
          KVRN
        </span>
      </div>

      <div className="container-kvrn relative z-10 pt-14 flex-1 flex flex-col justify-between">
        {/* Top: brand statement + nav columns */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand block */}
          <div className="col-span-2 md:col-span-1 space-y-5">
            <div className="space-y-0.5">
              <p className="text-[13px] font-light text-[#1A1A1A] leading-relaxed">Quiet garments.</p>
              <p className="text-[13px] font-light text-[#1A1A1A] leading-relaxed">Built with intention.</p>
              <p className="text-[13px] font-light text-[#6B6B6B] leading-relaxed">Designed with restraint.</p>
              <p className="text-[13px] font-light text-[#6B6B6B] leading-relaxed">Made to endure.</p>
            </div>
            <div className="flex gap-4">
              <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on Instagram" className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.4"/><circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/></svg>
              </a>
              <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on TikTok" className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                <svg width="15" height="17" viewBox="0 0 448 512" fill="currentColor"><path d="M448 209.9a210.1 210.1 0 0 1-122.8-39.3v178.8A162.6 162.6 0 1 1 185 188.3v89.3a74.6 74.6 0 1 0 52.2 71.2V0h88a121.2 121.2 0 0 0 1.9 22.2A122.2 122.2 0 0 0 381 102.4a121.4 121.4 0 0 0 67 20.1z"/></svg>
              </a>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B] mb-4">Shop</p>
            {[['Shop All','/shop'],['Hoodies','/shop?type=hoodies'],['Sweatpants','/shop?type=sweatpants']].map(([l,h]) => (
              <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2.5">{l}</Link>
            ))}
          </div>
          <div>
            <p className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B] mb-4">Support</p>
            {[['Shipping & Returns','/support/shipping-returns'],['Track Order','/support/track'],['Contact','/contact']].map(([l,h]) => (
              <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2.5">{l}</Link>
            ))}
          </div>
          <div>
            <p className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B] mb-4">Legal</p>
            {[['Privacy','/privacy'],['Terms','/terms'],['Cookies','/cookies']].map(([l,h]) => (
              <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2.5">{l}</Link>
            ))}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-[#E8E5E0] py-5 flex items-center justify-between">
          <p className="text-[11px] text-[#9B9B9B]">© {year} KVRN. All rights reserved.</p>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('kvrn-open-cookie-prefs'))}
            className="text-[11px] text-[#9B9B9B] hover:text-[#6B6B6B] transition-colors"
          >
            Cookie preferences
          </button>
        </div>
      </div>
    </div>
  )
}
