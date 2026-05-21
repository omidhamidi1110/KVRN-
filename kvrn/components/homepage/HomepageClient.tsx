'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { WaitlistBlock } from '@/components/homepage/WaitlistBlock'

const DARK_SLIDES = new Set([0, 1, 3])
const TOTAL_SLIDES = 5

export function HomepageClient() {
  const { t }        = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const [slide, setSlide]     = useState(0)
  const [showUp, setShowUp]   = useState(false)
  const [showDown, setShowDown] = useState(true)

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
    }
  }, [])

  // Track slide + scroll cues
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const scrollTop = el.scrollTop
      const vh        = el.clientHeight
      const idx       = Math.round(scrollTop / vh)
      setSlide(Math.min(idx, TOTAL_SLIDES - 1))
      setShowDown(scrollTop < 60)
      setShowUp(scrollTop > vh * 0.8)
      window.dispatchEvent(new CustomEvent('kvrn-slide-change', {
        detail: { dark: DARK_SLIDES.has(idx) }
      }))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const scrollToTop = () => containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })

  return (
    <div
      ref={containerRef}
      style={{
        position:              'fixed',
        inset:                 0,
        overflowY:             'scroll',
        scrollSnapType:        'y mandatory',
        scrollBehavior:        'smooth',
        WebkitOverflowScrolling:'touch',
        overscrollBehaviorY:   'none',
      }}
    >
      {/* Slide indicator — all slides */}
      <SlideIndicator current={slide} total={TOTAL_SLIDES} dark={DARK_SLIDES.has(slide)} />

      {/* ── Down arrow scroll cue ── */}
      <div
        aria-hidden="true"
        style={{
          position:   'fixed',
          bottom:     '36px',
          left:       '50%',
          transform:  'translateX(-50%)',
          zIndex:     190,
          opacity:    showDown ? 0.65 : 0,
          transition: 'opacity 0.6s ease',
          pointerEvents: 'none',
        }}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"
          style={{ animation: 'bounce 2s infinite' }}>
          <path d="M10 4v10M5 9l5 5 5-5" stroke="white" strokeWidth="1.3"
            strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* ── Up arrow scroll-to-top ── */}
      <button
        onClick={scrollToTop}
        aria-label="Return to top"
        style={{
          position:   'fixed',
          bottom:     '28px',
          right:      '24px',
          zIndex:     190,
          opacity:    showUp ? 1 : 0,
          transform:  showUp ? 'translateY(0)' : 'translateY(10px)',
          transition: 'opacity 0.3s, transform 0.3s',
          pointerEvents: showUp ? 'auto' : 'none',
          width: '36px', height: '36px',
          borderRadius: '50%',
          border: '1px solid rgba(255,255,255,0.35)',
          background: 'rgba(249,248,246,0.12)',
          backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: DARK_SLIDES.has(slide) ? '#F0EDE8' : '#1A1A1A',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 11V3M3 7l4-4 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* ── SLIDE 0: Project KVRN ─────────────────────────────────────── */}
      <FullSlide dark>
        <Image
          src="/images/campaign/fabric-macro.webp"
          alt="Project KVRN — available now"
          fill priority fetchPriority="high"
          className="object-cover object-center"
          sizes="100vw"
        />
        <div className="absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.08) 60%, transparent 100%)' }}
          aria-hidden="true"
        />
        {/* Centered copy layout */}
        <div className="absolute inset-0 flex flex-col items-center justify-end pb-24 md:pb-28 px-6 text-center">
          <p className="text-[11px] font-light tracking-[0.22em] uppercase text-[#F0EDE8]/55 mb-6">
            Available now
          </p>
          {/* Extra letter-spacing between "Project" and "KVRN" for breathing room */}
          <h1 className="font-display font-light text-[48px] sm:text-[62px] md:text-[78px] tracking-[-0.03em] text-[#F0EDE8] mb-8"
            style={{ lineHeight: 1.05 }}>
            Project
            <br />
            <span style={{ marginTop: '0.12em', display: 'block' }}>KVRN</span>
          </h1>
          <Link href="/collections/project-kvrn"
            className="inline-flex items-center h-11 px-8 border border-[#F0EDE8]/55 text-[11px] font-light tracking-[0.18em] uppercase text-[#F0EDE8] hover:bg-[#F0EDE8] hover:text-[#0E0E0E] hover:border-[#F0EDE8] transition-all duration-300">
            Discover Project KVRN
          </Link>
        </div>
      </FullSlide>

      {/* ── SLIDE 1: Campaign video ───────────────────────────────────── */}
      <FullSlide dark>
        {/* No fallback image here — poster on the video handles loading state */}
        <VideoSlide />
        <div className="absolute inset-0 bg-[#0E0E0E]/25" aria-hidden="true" />
        <div className="absolute inset-0 flex flex-col items-center justify-end pb-16 md:pb-20 px-6 text-center">
          <p className="font-display font-light text-[20px] md:text-[28px] tracking-[0.06em] text-[#F0EDE8]/80 max-w-[560px] leading-snug">
            Weight. Structure. Craft.
          </p>
        </div>
      </FullSlide>

      {/* ── SLIDE 2: Heavyweight Collection (future drop) ─────────────── */}
      <FullSlide light>
        <Image
          src="/images/campaign/hero-main.webp"
          alt="Heavyweight Collection — coming soon"
          fill
          className="object-cover object-center"
          sizes="100vw"
        />
        {/* Reduced overlay — image clear, text still readable */}
        <div className="absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(237,233,227,0.72) 0%, rgba(237,233,227,0.22) 55%, rgba(237,233,227,0.05) 100%)' }}
          aria-hidden="true"
        />
        {/* Centered copy layout */}
        <div className="absolute inset-0 flex flex-col items-center justify-end pb-16 md:pb-20 px-6 text-center">
          <p className="text-[11px] font-light tracking-[0.22em] uppercase text-[#4A4A4A] mb-4">
            Coming soon
          </p>
          <h2 className="font-display font-light text-[48px] sm:text-[62px] md:text-[78px] leading-[0.86] tracking-[-0.03em] text-[#1A1A1A] mb-5">
            Heavyweight<br />Collection
          </h2>
          <p className="text-[15px] font-light text-[#3A3A3A] leading-relaxed max-w-[400px] mb-8">
            The perfect hoodie and sweatpants. 400 GSM brushed fleece, built for structure and daily wear. Five colorways.
          </p>
          <ScrollToSlide
            targetSlide={3}
            containerRef={containerRef}
            className="inline-flex items-center h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.18em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300">
            Join the list
          </ScrollToSlide>
        </div>
      </FullSlide>

      {/* ── SLIDE 3: KVRN List ───────────────────────────────────────── */}
      <FullSlide dark>
        <WaitlistBlock />
      </FullSlide>

      {/* ── SLIDE 4: Footer ──────────────────────────────────────────── */}
      <FullSlide light>
        <HomepageFooter />
      </FullSlide>
    </div>
  )
}

// ── Scroll-to-slide ───────────────────────────────────────────────────────────
function ScrollToSlide({
  targetSlide, containerRef, children, className,
}: {
  targetSlide:  number
  containerRef: React.RefObject<HTMLDivElement | null>
  children:     React.ReactNode
  className?:   string
}) {
  const go = () => {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ top: targetSlide * el.clientHeight, behavior: 'smooth' })
  }
  return <button onClick={go} className={className}>{children}</button>
}

// ── Video with desktop zoom fix + mute toggle ─────────────────────────────────
function VideoSlide() {
  const [muted, setMuted] = useState(true)
  const ref = useRef<HTMLVideoElement>(null)

  const toggleMute = () => {
    if (!ref.current) return
    ref.current.muted = !ref.current.muted
    setMuted(ref.current.muted)
  }

  return (
    <>
      <video
        ref={ref}
        autoPlay
        muted
        loop
        playsInline
        poster="/images/campaign/fabric-macro.webp"
        onError={(e) => { (e.target as HTMLVideoElement).style.display = 'none' }}
        style={{
          position:   'absolute',
          inset:      0,
          width:      '100%',
          height:     '100%',
          // Mobile: cover (fills naturally)
          // Desktop: contain-like but still fills — use objectPosition to reduce zoom feel
          objectFit:      'cover',
          objectPosition: 'center center',
        }}
        // Override objectPosition on large screens via className for desktop
        className="sm:object-[50%_35%]"
      >
        <source src="/images/campaign/hero-video.webm" type="video/webm" />
        <source src="/images/campaign/hero-video.mp4"  type="video/mp4" />
      </video>

      {/* Mute / unmute button — bottom right of video slide, minimal */}
      <button
        onClick={toggleMute}
        aria-label={muted ? 'Unmute video' : 'Mute video'}
        className="absolute bottom-6 right-6 z-10 flex items-center justify-center w-9 h-9 border border-[#F0EDE8]/30 bg-black/20 backdrop-blur-sm hover:border-[#F0EDE8]/60 transition-colors"
      >
        {muted ? (
          // Muted icon
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M11 5L6 9H2v6h4l5 4V5z" stroke="#F0EDE8" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M23 9l-6 6M17 9l6 6" stroke="#F0EDE8" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        ) : (
          // Unmuted icon
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M11 5L6 9H2v6h4l5 4V5z" stroke="#F0EDE8" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M19.07 4.93a10 10 0 010 14.14" stroke="#F0EDE8" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M15.54 8.46a5 5 0 010 7.07" stroke="#F0EDE8" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        )}
      </button>
    </>
  )
}

// ── Full-screen snap slide ────────────────────────────────────────────────────
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

// ── Slide indicator ───────────────────────────────────────────────────────────
function SlideIndicator({ current, total, dark }: {
  current: number; total: number; dark: boolean
}) {
  return (
    <div
      className="fixed left-4 md:left-7 top-1/2 -translate-y-1/2 z-[195] flex flex-col gap-[5px]"
      role="tablist" aria-label="Slide position"
    >
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          role="tab"
          aria-selected={i === current}
          style={{
            width:           '2px',
            height:          i === current ? '26px' : '10px',
            borderRadius:    '1px',
            backgroundColor: dark
              ? (i === current ? 'rgba(240,237,232,0.9)' : 'rgba(240,237,232,0.22)')
              : (i === current ? 'rgba(26,26,26,0.85)'   : 'rgba(26,26,26,0.18)'),
            transition: 'height 0.45s cubic-bezier(0.25,0.46,0.45,0.94), background-color 0.3s',
          }}
        />
      ))}
    </div>
  )
}

// ── Homepage footer slide ─────────────────────────────────────────────────────
function HomepageFooter() {
  const year = new Date().getFullYear()
  return (
    <div className="absolute inset-0 bg-[#F9F8F6] flex flex-col pt-[92px]">
      <div className="flex-1 flex items-center justify-center px-6 pb-10 pointer-events-none select-none" aria-hidden="true">
        <span
          className="font-display font-light text-[#1A1A1A]/[0.13] whitespace-nowrap"
          style={{ fontSize: 'clamp(130px, 22vw, 320px)', letterSpacing: '-0.04em', lineHeight: 1 }}
        >KVRN</span>
      </div>
      <div className="container-kvrn relative z-10 pb-2">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-y-10 gap-x-8 md:gap-x-14 text-center items-start">
          <div className="order-1 space-y-4">
            <div className="space-y-1">
              <p className="text-[13px] font-light text-[#1A1A1A]">Quiet garments.</p>
              <p className="text-[13px] font-light text-[#6B6B6B]">Built with intention.</p>
            </div>
            <div className="flex justify-center gap-5 pt-2">
              <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer" aria-label="KVRN on Instagram" className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.4"/><circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/></svg>
              </a>
              <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer" aria-label="KVRN on TikTok" className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                <svg width="15" height="17" viewBox="0 0 448 512" fill="currentColor"><path d="M448 209.9a210.1 210.1 0 0 1-122.8-39.3v178.8A162.6 162.6 0 1 1 185 188.3v89.3a74.6 74.6 0 1 0 52.2 71.2V0h88a121.2 121.2 0 0 0 1.9 22.2A122.2 122.2 0 0 0 381 102.4a121.4 121.4 0 0 0 67 20.1z"/></svg>
              </a>
            </div>
          </div>
          <div>
            <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] mb-4">Shop</p>
            {[['Shop All','/shop'],['Hoodies','/shop?type=hoodies'],['Sweatpants','/shop?type=sweatpants']].map(([l,h]) => (
              <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2.5">{l}</Link>
            ))}
          </div>
          <div>
            <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] mb-4">Support</p>
            {[['Shipping & Returns','/support/shipping-returns'],['Track Order','/support/track'],['Contact','/contact']].map(([l,h]) => (
              <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2.5">{l}</Link>
            ))}
          </div>
          <div>
            <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] mb-4">Legal</p>
            {[['Privacy','/privacy'],['Terms','/terms'],['Cookies','/cookies']].map(([l,h]) => (
              <Link key={h} href={h} className="block text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors mb-2.5">{l}</Link>
            ))}
          </div>
        </div>
        <div className="border-t border-[#E8E5E0] mt-5 pt-3 pb-0 flex items-center justify-between gap-4">
          <p className="text-[11px] text-[#9B9B9B]">© {year} KVRN. All rights reserved.</p>
          <button onClick={() => window.dispatchEvent(new CustomEvent('kvrn-open-cookie-prefs'))}
            className="text-[11px] text-[#9B9B9B] hover:text-[#6B6B6B] transition-colors">
            Cookie preferences
          </button>
        </div>
      </div>
    </div>
  )
}
