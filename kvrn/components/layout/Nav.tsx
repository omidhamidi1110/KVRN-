'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useCart } from '@/context/CartContext'
import { cn } from '@/lib/utils'

const navLinks = [
  { label: 'Hoodies',    href: '/products/kvrn-heavyweight-hoodie' },
  { label: 'Sweatpants', href: '/products/kvrn-heavyweight-sweatpants' },
  { label: 'About',      href: '/about' },
]

const drawerLinks = [
  { label: 'Shop',       href: '/shop' },
  { label: 'Hoodies',    href: '/products/kvrn-heavyweight-hoodie' },
  { label: 'Sweatpants', href: '/products/kvrn-heavyweight-sweatpants' },
  { label: 'About',      href: '/about' },
  { label: 'Story',      href: '/about' },
  { label: 'Waitlist',   href: '/waitlist' },
  { label: 'Contact',    href: '/contact' },
  { label: 'Shipping & Returns', href: '/support/shipping-returns' },
  { label: 'FAQ',        href: '/support/faq' },
]

export function Nav() {
  const { itemCount, openCart } = useCart()
  const [scrolled, setScrolled]     = useState(false)
  const [isHero, setIsHero]         = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  // Detect scroll position for nav transparency
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      setScrolled(y > 20)
      setIsHero(y < window.innerHeight * 0.8)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Close drawer on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Prevent scroll when drawer open
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  // Focus first link when drawer opens
  useEffect(() => {
    if (drawerOpen && drawerRef.current) {
      const firstLink = drawerRef.current.querySelector('a') as HTMLElement
      firstLink?.focus()
    }
  }, [drawerOpen])

  const navColor = scrolled
    ? 'text-kvrn-text'
    : isHero
    ? 'text-kvrn-text-on-dark'
    : 'text-kvrn-text'

  return (
    <>
      {/* ─── Main Nav Bar ─── */}
      <header
        className={cn(
          'fixed top-0 left-0 right-0 z-[200] h-[56px] flex items-center transition-all duration-300',
          scrolled
            ? 'bg-[rgba(250,250,248,0.92)] backdrop-blur-[20px] border-b border-kvrn-border text-kvrn-text'
            : 'bg-transparent',
          !scrolled && navColor
        )}
        aria-label="Site header"
      >
        <div className="container-kvrn w-full flex items-center justify-between">
          {/* Logo */}
          <Link
            href="/"
            className="text-[15px] font-display font-light tracking-wider uppercase hover:opacity-70 transition-opacity duration-150"
            aria-label="KVRN — Go to homepage"
          >
            KVRN
          </Link>

          {/* Desktop links — hidden on mobile */}
          <nav
            className="hidden md:flex items-center gap-10"
            aria-label="Main navigation"
          >
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-[11px] font-body font-light tracking-widest uppercase hover:opacity-60 transition-opacity duration-150"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right actions */}
          <div className="flex items-center gap-6">
            {/* Cart button */}
            <button
              onClick={openCart}
              className="text-[11px] font-body font-light tracking-widest uppercase hover:opacity-60 transition-opacity duration-150"
              aria-label={`Shopping bag, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
            >
              BAG
              {itemCount > 0 && (
                <span className="ml-1">({itemCount})</span>
              )}
            </button>

            {/* Mobile hamburger */}
            <button
              onClick={() => setDrawerOpen(true)}
              className="md:hidden flex flex-col gap-[5px] p-1 -mr-1"
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav"
            >
              <span className={cn(
                'block h-px w-[22px] transition-all duration-300',
                scrolled ? 'bg-kvrn-text' : isHero ? 'bg-kvrn-text-on-dark' : 'bg-kvrn-text'
              )} />
              <span className={cn(
                'block h-px w-[22px] transition-all duration-300',
                scrolled ? 'bg-kvrn-text' : isHero ? 'bg-kvrn-text-on-dark' : 'bg-kvrn-text'
              )} />
            </button>
          </div>
        </div>
      </header>

      {/* ─── Mobile Nav Drawer ─── */}
      {/* Overlay */}
      <div
        className={cn(
          'fixed inset-0 z-[300] bg-black/40 transition-opacity duration-300 md:hidden',
          drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        id="mobile-nav"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        className={cn(
          'fixed inset-0 z-[400] bg-kvrn-bg flex flex-col px-6 pt-8 pb-10',
          'transition-transform duration-[600ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)] md:hidden',
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between mb-12">
          <Link
            href="/"
            onClick={() => setDrawerOpen(false)}
            className="text-[15px] font-display font-light tracking-wider uppercase"
          >
            KVRN
          </Link>
          <button
            onClick={() => setDrawerOpen(false)}
            className="p-2 -mr-2 text-kvrn-muted hover:text-kvrn-text transition-colors"
            aria-label="Close navigation menu"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 4L16 16M16 4L4 16" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Nav links */}
        <nav className="flex flex-col" aria-label="Mobile navigation">
          {drawerLinks.map((link, i) => (
            <Link
              key={link.href + link.label}
              href={link.href}
              onClick={() => setDrawerOpen(false)}
              className={cn(
                'py-4 border-b border-kvrn-border text-[28px] font-display font-light',
                'tracking-tight hover:text-kvrn-muted transition-colors duration-200',
                'opacity-0 translate-x-[-16px]',
                drawerOpen && 'animate-fade-up'
              )}
              style={{ animationDelay: `${i * 50}ms`, animationFillMode: 'forwards' }}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Drawer footer */}
        <div className="mt-auto flex gap-6">
          <a
            href="https://instagram.com/kvrn"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors"
          >
            Instagram
          </a>
          <a
            href="https://tiktok.com/@kvrn"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors"
          >
            TikTok
          </a>
        </div>
      </div>
    </>
  )
}
