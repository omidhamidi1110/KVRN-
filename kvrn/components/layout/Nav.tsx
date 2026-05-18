'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useCart } from '@/context/CartContext'
import { useHeader } from '@/context/HeaderContext'
import { CurrencySelector } from '@/components/ui/CurrencySelector'
import { cn } from '@/lib/utils'

const BAR_H = 36  // px — must match AnnouncementBar height

// Desktop nav links — curated shopping paths
const DESKTOP_LINKS = [
  { label: 'Shop',       href: '/shop' },
  { label: 'Hoodies',    href: '/shop?type=hoodies' },
  { label: 'Sweatpants', href: '/shop?type=sweatpants' },
  { label: 'About',      href: '/about' },
  { label: 'Waitlist',   href: '/waitlist' },
]

// Mobile drawer — fuller set
const MOBILE_LINKS = [
  { label: 'Shop All',   href: '/shop' },
  { label: 'Hoodies',    href: '/shop?type=hoodies' },
  { label: 'Sweatpants', href: '/shop?type=sweatpants' },
  { label: 'About',      href: '/about' },
  { label: 'Waitlist',   href: '/waitlist' },
  { label: 'Contact',    href: '/contact' },
  { label: 'Shipping & Returns', href: '/support/shipping-returns' },
  { label: 'FAQ',        href: '/support/faq' },
  { label: 'Track Order',href: '/support/track' },
]

export function Nav() {
  const { itemCount, openCart } = useCart()
  const { barVisible }          = useHeader()
  const [scrolled,   setScrolled]   = useState(false)
  const [isHero,     setIsHero]     = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      setScrolled(y > 20)
      setIsHero(y < window.innerHeight * 0.75)
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

  useEffect(() => {
    if (drawerOpen && drawerRef.current) {
      const first = drawerRef.current.querySelector('a') as HTMLElement | null
      first?.focus()
    }
  }, [drawerOpen])

  // Nav top position: below announcement bar when bar is visible
  const navTop = barVisible ? BAR_H : 0

  const onLight = scrolled || !isHero
  const textCls = onLight ? 'text-kvrn-text' : 'text-kvrn-text-on-dark'

  return (
    <>
      {/* ─── Main Nav ─── */}
      <header
        className={cn(
          'fixed left-0 right-0 z-[200] h-[56px] flex items-center',
          'transition-all duration-300',
          scrolled
            ? 'bg-[rgba(250,250,248,0.93)] backdrop-blur-[20px] border-b border-kvrn-border'
            : 'bg-transparent',
          textCls
        )}
        style={{ top: `${navTop}px` }}
        aria-label="Site header"
      >
        <div className="container-kvrn w-full flex items-center justify-between">
          {/* Logo */}
          <Link
            href="/"
            className="text-[15px] font-display font-light tracking-wider uppercase hover:opacity-70 transition-opacity"
            aria-label="KVRN — Go to homepage"
          >
            KVRN
          </Link>

          {/* Desktop links */}
          <nav className="hidden lg:flex items-center gap-8" aria-label="Main navigation">
            {DESKTOP_LINKS.map(link => (
              <Link
                key={link.href}
                href={link.href}
                className="text-[11px] font-light tracking-widest uppercase hover:opacity-60 transition-opacity duration-150"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right: currency + bag + hamburger */}
          <div className="flex items-center gap-5">
            {/* Currency selector — desktop only */}
            <div className="hidden lg:block">
              <CurrencySelector align="right" />
            </div>

            {/* Bag button */}
            <button
              onClick={openCart}
              className="flex items-center gap-1.5 hover:opacity-60 transition-opacity duration-150"
              aria-label={`Shopping bag${itemCount > 0 ? `, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}` : ', empty'}`}
            >
              {/* Bag icon */}
              <svg
                width="18" height="20" viewBox="0 0 18 20" fill="none"
                aria-hidden="true"
                className="flex-shrink-0"
              >
                <path
                  d="M4 6V5a5 5 0 1110 0v1M1 8h16l-1.5 10H2.5L1 8z"
                  stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"
                />
              </svg>
              {itemCount > 0 && (
                <span className="text-[11px] font-light tracking-wider">
                  ({itemCount})
                </span>
              )}
            </button>

            {/* Hamburger — mobile */}
            <button
              onClick={() => setDrawerOpen(true)}
              className="lg:hidden flex flex-col gap-[5px] p-1 -mr-1"
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
            >
              {[0,1].map(i => (
                <span
                  key={i}
                  className={cn(
                    'block h-px w-5 transition-colors duration-300',
                    onLight ? 'bg-kvrn-text' : 'bg-kvrn-text-on-dark'
                  )}
                />
              ))}
            </button>
          </div>
        </div>
      </header>

      {/* ─── Mobile drawer overlay ─── */}
      <div
        className={cn(
          'fixed inset-0 z-[300] bg-black/40 transition-opacity duration-300 lg:hidden',
          drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      {/* ─── Mobile drawer panel ─── */}
      <div
        id="mobile-nav"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          'fixed inset-0 z-[400] bg-kvrn-bg flex flex-col px-6',
          'pt-8 pb-10 overflow-y-auto',
          'transition-transform duration-500 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] lg:hidden',
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between mb-10">
          <Link href="/" onClick={() => setDrawerOpen(false)}
            className="text-[15px] font-display font-light tracking-wider uppercase">
            KVRN
          </Link>
          <button
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="p-2 -mr-2 text-kvrn-muted hover:text-kvrn-text transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 3l12 12M15 3L3 15" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Nav links */}
        <nav className="flex-1">
          {MOBILE_LINKS.map((link, i) => (
            <Link
              key={link.href + link.label}
              href={link.href}
              onClick={() => setDrawerOpen(false)}
              className={cn(
                'block py-4 border-b border-kvrn-border',
                'text-[26px] font-display font-light tracking-tight',
                'hover:text-kvrn-muted transition-colors duration-200',
                'opacity-0 translate-x-[-12px]',
                drawerOpen && 'animate-fade-up'
              )}
              style={{ animationDelay: `${i * 40}ms`, animationFillMode: 'forwards' }}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Drawer footer: currency + socials */}
        <div className="mt-8 pt-6 border-t border-kvrn-border flex items-center justify-between">
          <CurrencySelector align="left" />
          <div className="flex gap-5">
            <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer"
              aria-label="KVRN on Instagram"
              className="text-kvrn-muted hover:text-kvrn-text transition-colors">
              <InstagramIcon />
            </a>
            <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer"
              aria-label="KVRN on TikTok"
              className="text-kvrn-muted hover:text-kvrn-text transition-colors">
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
      <rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>
    </svg>
  )
}

function TikTokIcon() {
  return (
    <svg width="16" height="18" viewBox="0 0 24 27" fill="currentColor" aria-hidden="true">
      <path d="M19.5 3.2A5.6 5.6 0 0114 0h-3.7v18.3a2.9 2.9 0 11-2.8-3 2.9 2.9 0 011 .2V11.6a7 7 0 10.6 13.7V13.8a9.1 9.1 0 005.4 1.7V12a5.6 5.6 0 01-3.3-1.1A5.5 5.5 0 0014 12V3.7a9.3 9.3 0 005.5 1.6V1.8l-.05 1.4z"/>
    </svg>
  )
}
