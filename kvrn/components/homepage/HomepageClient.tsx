'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { WaitlistBlock } from '@/components/homepage/WaitlistBlock'
import { HomepageProducts } from '@/components/homepage/HomepageProducts'
import type { Product } from '@/types'

interface Props { products: Product[] }

// Sections that are truly 100svh snapped
// 0: current drop (dark), 1: video (dark), 2: future drop (light), 3: list (dark), 4: footer (light)
const DARK_SLIDES = new Set([0, 1, 3])
const NAV_SLIDE_COUNT = 3  // indicator only for first 3 slides

export function HomepageClient({ products }: Props) {
  const { t }         = useI18n()
  const containerRef  = useRef<HTMLDivElement>(null)
  const [slide, setSlide] = useState(0)

  // Lock body scroll; use snap container
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
    }
  }, [])

  // Track active slide index
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const idx = Math.round(el.scrollTop / el.clientHeight)
      setSlide(idx)
      // Notify nav of current slide theme
      const event = new CustomEvent('kvrn-slide-change', {
        detail: { dark: DARK_SLIDES.has(idx) }
      })
      window.dispatchEvent(event)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Project KVRN products (phantom-* slugs = current drop)
  const currentDropProducts = products.filter(p => p.slug.includes('phantom'))
  const futureDropProducts  = products.filter(p => !p.slug.includes('phantom'))

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
      {/* ── Slide indicator (first 3 slides) ─────────────────────────────── */}
      <SlideIndicator current={slide} total={NAV_SLIDE_COUNT} darkSlide={DARK_SLIDES.has(slide)} />

      {/* ── SLIDE 0: Current drop — Project KVRN ──────────────────────────── */}
      <Slide dark aria-label="Project KVRN — current drop">
        <Image
          src="/images/campaign/hero-main.webp"
          alt="Project KVRN — current collection"
          fill priority fetchPriority="high"
          className="object-cover object-center"
          sizes="100vw"
        />
        {/* Gradient */}
        <div className="absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.1) 55%, transparent 100%)' }}
          aria-hidden="true"
        />
        <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-16 md:pb-20">
          <p className="text-[11px] font-light tracking-[0.2em] uppercase text-[#F0EDE8]/60 mb-4">
            Available now
          </p>
          <h1 className="font-display font-light text-[44px] sm:text-[58px] md:text-[72px] leading-[0.88] tracking-[-0.03em] text-[#F0EDE8] mb-8">
            Project KVRN
          </h1>
          <Link
            href="/shop?type=hoodies"
            className="inline-flex items-center h-11 px-8 border border-[#F0EDE8]/60 text-[11px] font-light tracking-[0.16em] uppercase text-[#F0EDE8] hover:bg-[#F0EDE8] hover:text-[#0E0E0E] hover:border-[#F0EDE8] transition-all duration-300"
          >
            Shop Project KVRN
          </Link>
        </div>
      </Slide>

      {/* ── SLIDE 1: Campaign video ─────────────────────────────────────────── */}
      <Slide dark aria-label="KVRN campaign">
        {/* Video placeholder — replace src when video is ready */}
        <video
          autoPlay muted loop playsInline
          className="absolute inset-0 w-full h-full object-cover"
          aria-hidden="true"
        >
          {/* <source src="/images/campaign/hero-video.mp4" type="video/mp4" /> */}
        </video>
        {/* Fallback image shown until video is uploaded */}
        <Image
          src="/images/campaign/fabric-macro.webp"
          alt="KVRN campaign"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#0E0E0E]/50" aria-hidden="true" />
        <div className="absolute bottom-0 left-0 right-0 container-kvrn pb-16 md:pb-20">
          <p className="font-display font-light text-[18px] md:text-[24px] tracking-[0.06em] text-[#F0EDE8]/80 max-w-[600px] leading-snug">
            Weight. Structure. Restraint.
          </p>
        </div>
      </Slide>

      {/* ── SLIDE 2: Future drop — Heavyweight Collection ────────────────────── */}
      <Slide light aria-label="Heavyweight collection — coming soon">
        <div className="absolute inset-0 bg-[#F3F0EB]" />
        <div className="absolute inset-0 container-kvrn flex flex-col justify-end pb-16 md:pb-20">
          <p className="text-[11px] font-light tracking-[0.2em] uppercase text-[#9B9B9B] mb-4">
            Coming soon
          </p>
          <h2 className="font-display font-light text-[44px] sm:text-[58px] md:text-[72px] leading-[0.88] tracking-[-0.03em] text-[#1A1A1A] mb-8">
            Heavyweight<br />Collection
          </h2>
          <p className="text-[15px] font-light text-[#6B6B6B] leading-relaxed max-w-[440px] mb-8">
            400 GSM brushed fleece. Dense enough to feel structural. Considered enough to be worn daily.
            Five colorways.
          </p>
          <Link
            href="/waitlist"
            className="inline-flex items-center h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300 w-fit"
          >
            Join the list
          </Link>
        </div>
      </Slide>

      {/* ── SLIDE 3: KVRN List / Subscribe ────────────────────────────────── */}
      <Slide dark aria-label="Join the KVRN list">
        <WaitlistBlock />
      </Slide>

      {/* ── SLIDE 4: Footer ────────────────────────────────────────────────── */}
      <div
        style={{
          scrollSnapAlign: 'start',
          scrollSnapStop: 'always',
          minHeight: '100svh',
        }}
        className="bg-[#F9F8F6] flex flex-col justify-end"
      >
        {/* Compact footer content */}
        <HomepageFooterContent />
      </div>
    </div>
  )
}

// ── Reusable full-screen slide ─────────────────────────────────────────────────
function Slide({
  children, dark, light, className, 'aria-label': ariaLabel,
}: {
  children:     React.ReactNode
  dark?:        boolean
  light?:       boolean
  className?:   string
  'aria-label'?: string
}) {
  return (
    <section
      style={{
        scrollSnapAlign: 'start',
        scrollSnapStop:  'always',
        minHeight:       '100svh',
        height:          '100svh',
      }}
      className={`relative overflow-hidden ${dark ? 'bg-[#0E0E0E]' : 'bg-[#F3F0EB]'} ${className ?? ''}`}
      aria-label={ariaLabel}
    >
      {children}
    </section>
  )
}

// ── Left-side vertical slide indicator ─────────────────────────────────────────
function SlideIndicator({ current, total, darkSlide }: {
  current:   number
  total:     number
  darkSlide: boolean
}) {
  if (current >= total) return null  // hide after slide 2

  return (
    <div
      className="fixed left-5 md:left-8 top-1/2 -translate-y-1/2 z-[195] flex flex-col gap-[6px]"
      role="tablist"
      aria-label="Slide navigation"
    >
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          role="tab"
          aria-selected={i === current}
          aria-label={`Slide ${i + 1}`}
          className="transition-all duration-300"
          style={{
            width:           '3px',
            height:          i === current ? '28px' : '12px',
            backgroundColor: darkSlide
              ? (i === current ? 'rgba(240,237,232,0.9)' : 'rgba(240,237,232,0.25)')
              : (i === current ? 'rgba(26,26,26,0.8)'    : 'rgba(26,26,26,0.2)'),
            transition: 'height 0.4s cubic-bezier(0.25,0.46,0.45,0.94), background-color 0.3s',
          }}
        />
      ))}
    </div>
  )
}

// ── Compact footer shown in slide 4 ─────────────────────────────────────────────
function HomepageFooterContent() {
  return (
    <div className="container-kvrn py-16">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
        <div>
          <Link href="/" className="block text-[14px] font-light tracking-[0.14em] uppercase mb-4">KVRN</Link>
          <p className="text-[12px] text-[#6B6B6B] leading-relaxed">Quiet garments.<br />Built with intention.</p>
        </div>
        <div>
          <p className="text-[10px] font-light tracking-[0.12em] uppercase text-[#9B9B9B] mb-3">Shop</p>
          {[['Shop All', '/shop'], ['Hoodies', '/shop?type=hoodies'], ['Sweatpants', '/shop?type=sweatpants']].map(([l, h]) => (
            <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2">{l}</Link>
          ))}
        </div>
        <div>
          <p className="text-[10px] font-light tracking-[0.12em] uppercase text-[#9B9B9B] mb-3">Support</p>
          {[['Shipping & Returns', '/support/shipping-returns'], ['Track Order', '/support/track'], ['Contact', '/contact']].map(([l, h]) => (
            <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2">{l}</Link>
          ))}
        </div>
        <div>
          <p className="text-[10px] font-light tracking-[0.12em] uppercase text-[#9B9B9B] mb-3">Legal</p>
          {[['Privacy', '/privacy'], ['Terms', '/terms'], ['Cookies', '/cookies']].map(([l, h]) => (
            <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2">{l}</Link>
          ))}
        </div>
      </div>
      <div className="pt-6 border-t border-[#E8E5E0] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <p className="text-[11px] text-[#9B9B9B]">© {new Date().getFullYear()} KVRN. All rights reserved.</p>
        <div className="flex gap-4">
          <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer" aria-label="KVRN on Instagram"
            className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.4"/><circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/></svg>
          </a>
          <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer" aria-label="KVRN on TikTok"
            className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
            <svg width="15" height="17" viewBox="0 0 448 512" fill="currentColor"><path d="M448 209.9a210.1 210.1 0 0 1-122.8-39.3v178.8A162.6 162.6 0 1 1 185 188.3v89.3a74.6 74.6 0 1 0 52.2 71.2V0h88a121.2 121.2 0 0 0 1.9 22.2A122.2 122.2 0 0 0 381 102.4a121.4 121.4 0 0 0 67 20.1z"/></svg>
          </a>
        </div>
      </div>
    </div>
  )
}
