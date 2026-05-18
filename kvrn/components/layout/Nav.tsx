'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useCart }     from '@/context/CartContext'
import { useWishlist } from '@/context/WishlistContext'
import { CurrencySelector }  from '@/components/ui/CurrencySelector'
import { LanguageSelector }  from '@/components/ui/LanguageSelector'
import { cn } from '@/lib/utils'

// Desktop nav — Track Order added, Size Guide removed
const DESKTOP_LINKS = [
  { label: 'Shop All',    href: '/shop' },
  { label: 'Hoodies',    href: '/shop?type=hoodies' },
  { label: 'Sweatpants', href: '/shop?type=sweatpants' },
  { label: 'Track Order',href: '/support/track' },
  { label: 'About',      href: '/about' },
]

const MOBILE_LINKS = [
  { label: 'Shop All',          href: '/shop' },
  { label: 'Hoodies',           href: '/shop?type=hoodies' },
  { label: 'Sweatpants',        href: '/shop?type=sweatpants' },
  { label: 'Waitlist',          href: '/waitlist' },
  { label: 'About',             href: '/about' },
  { label: 'Size Guide',        href: '/support/size-guide' },
  { label: 'Track Order',       href: '/support/track' },
  { label: 'FAQ',               href: '/support/faq' },
  { label: 'Shipping & Returns',href: '/support/shipping-returns' },
  { label: 'Contact',           href: '/contact' },
]

// Pages that start with a light/white background — nav text must be dark even when transparent
const LIGHT_TOP_PAGES = [
  '/shop', '/about', '/contact', '/waitlist', '/support', '/privacy', '/terms', '/cookies',
  '/checkout', '/order-confirmation', '/admin', '/products',
]

function pageHasLightTop(path: string): boolean {
  return LIGHT_TOP_PAGES.some(p => path.startsWith(p))
}

export function Nav() {
  const { itemCount, openCart }   = useCart()
  const { count: savedCount, openWishlist } = useWishlist()
  const [scrolled,   setScrolled]   = useState(false)
  const [onHero,     setOnHero]     = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState('')
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCurrentPath(window.location.pathname)
    const onScroll = () => {
      const y = window.scrollY
      setScrolled(y > 24)
      setOnHero(y < window.innerHeight * 0.7)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  // Force dark text on light-top pages even when transparent
  const lightTop    = pageHasLightTop(currentPath)
  const transparent = !scrolled && onHero && !lightTop
  const darkText    = !transparent

  const textColor = darkText ? 'text-[#1A1A1A]' : 'text-[#F0EDE8]'
  const lineColor = darkText ? 'bg-[#1A1A1A]'   : 'bg-[#F0EDE8]'

  return (
    <>
      <header
        className={cn(
          'fixed left-0 right-0 z-[200] h-[56px] flex items-center transition-all duration-300',
          scrolled
            ? 'bg-[rgba(249,248,246,0.95)] backdrop-blur-[16px] border-b border-[#E8E5E0]'
            : lightTop ? 'bg-[rgba(249,248,246,0.95)] border-b border-[#E8E5E0]' : 'bg-transparent',
          textColor
        )}
        style={{ top: '36px' }}
        aria-label="Main navigation"
      >
        <div className="container-kvrn flex items-center justify-between">
          {/* Logo */}
          <Link href="/"
            className="text-[15px] font-light tracking-[0.15em] uppercase hover:opacity-60 transition-opacity"
            aria-label="KVRN home">
            KVRN
          </Link>

          {/* Desktop links */}
          <nav className="hidden lg:flex items-center gap-7" aria-label="Primary navigation">
            {DESKTOP_LINKS.map(l => (
              <Link key={l.href} href={l.href}
                className="text-[11px] font-light tracking-[0.1em] uppercase hover:opacity-50 transition-opacity duration-150">
                {l.label}
              </Link>
            ))}
          </nav>

          {/* Right cluster */}
          <div className="flex items-center gap-4">
            <div className="hidden lg:flex items-center gap-4">
              <LanguageSelector align="right" />
              <CurrencySelector align="right" />
            </div>

            {/* Wishlist / saved */}
            <button
              onClick={openWishlist}
              aria-label={`Saved items${savedCount > 0 ? `, ${savedCount}` : ''}`}
              className="flex items-center gap-1 hover:opacity-50 transition-opacity"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
                  stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
                  fill={savedCount > 0 ? 'currentColor' : 'none'}
                />
              </svg>
              {savedCount > 0 && (
                <span className="text-[11px] font-light tabular-nums">({savedCount})</span>
              )}
            </button>

            {/* Bag */}
            <button
              onClick={openCart}
              aria-label={`Bag${itemCount > 0 ? `, ${itemCount} item${itemCount > 1 ? 's' : ''}` : ', empty'}`}
              className="flex items-center gap-1.5 hover:opacity-50 transition-opacity"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="3" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <path d="M16 10a4 4 0 01-8 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {itemCount > 0 && (
                <span className="text-[11px] font-light tabular-nums">({itemCount})</span>
              )}
            </button>

            {/* Hamburger */}
            <button onClick={() => setDrawerOpen(true)} aria-label="Open menu"
              aria-expanded={drawerOpen} className="lg:hidden flex flex-col gap-[6px] p-1">
              <span className={cn('block h-px w-[22px] transition-colors', lineColor)} />
              <span className={cn('block h-px w-[22px] transition-colors', lineColor)} />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile overlay */}
      <div
        className={cn('fixed inset-0 z-[300] bg-black/40 transition-opacity duration-300 lg:hidden',
          drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none')}
        onClick={() => setDrawerOpen(false)} aria-hidden="true"
      />

      {/* Mobile drawer */}
      <div
        ref={drawerRef} role="dialog" aria-modal="true" aria-label="Navigation"
        className={cn(
          'fixed inset-y-0 left-0 z-[400] w-[85vw] max-w-[340px] bg-[#F9F8F6] flex flex-col',
          'transition-transform duration-500 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] lg:hidden',
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex items-center justify-between px-6 pt-8 pb-6 border-b border-[#E8E5E0]">
          <Link href="/" onClick={() => setDrawerOpen(false)}
            className="text-[15px] font-light tracking-[0.15em] uppercase">KVRN</Link>
          <button onClick={() => setDrawerOpen(false)} aria-label="Close menu"
            className="text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-6 py-4" aria-label="Mobile navigation">
          {MOBILE_LINKS.map(l => (
            <Link key={l.href + l.label} href={l.href} onClick={() => setDrawerOpen(false)}
              className="block py-3.5 text-[15px] font-light border-b border-[#E8E5E0] last:border-0 hover:text-[#9B9B9B] transition-colors">
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="px-6 py-5 border-t border-[#E8E5E0] space-y-4">
          <div className="flex items-center gap-4">
            <LanguageSelector align="left" />
            <CurrencySelector align="left" />
          </div>
          <div className="flex gap-4">
            <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer"
              aria-label="KVRN on Instagram" className="text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
              <InstagramIcon />
            </a>
            <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer"
              aria-label="KVRN on TikTok" className="text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
              <TikTokIcon />
            </a>
          </div>
        </div>
      </div>
    </>
  )
}

function InstagramIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/>
    </svg>
  )
}

function TikTokIcon() {
  return (
    <svg width="16" height="18" viewBox="0 0 448 512" fill="currentColor" aria-hidden="true">
      <path d="M448 209.9a210.1 210.1 0 0 1-122.8-39.3v178.8A162.6 162.6 0 1 1 185 188.3v89.3a74.6 74.6 0 1 0 52.2 71.2V0h88a121.2 121.2 0 0 0 1.9 22.2h0A122.2 122.2 0 0 0 381 102.4a121.4 121.4 0 0 0 67 20.1z"/>
    </svg>
  )
}
