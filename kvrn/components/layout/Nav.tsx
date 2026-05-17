'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCart } from '@/context/CartContext'
import { cn } from '@/lib/utils'

// ─── NAV CONFIG ──────────────────────────────────────────────────────────────
// Single source of truth for all nav links.
// Add /journal here only when the page exists.

const primaryLinks = [
  { label: 'Shop',    href: '/shop' },
  { label: 'About',  href: '/about' },
  { label: 'Waitlist', href: '/waitlist' },
]

const drawerSections = [
  {
    heading: 'Shop',
    links: [
      { label: 'All Products',         href: '/shop' },
      { label: 'Heavyweight Hoodie',   href: '/products/kvrn-heavyweight-hoodie' },
      { label: 'Heavyweight Sweatpants', href: '/products/kvrn-heavyweight-sweatpants' },
    ],
  },
  {
    heading: 'Brand',
    links: [
      { label: 'About KVRN', href: '/about' },
      { label: 'Waitlist',   href: '/waitlist' },
    ],
  },
  {
    heading: 'Support',
    links: [
      { label: 'FAQ',               href: '/support/faq' },
      { label: 'Shipping & Returns', href: '/support/shipping-returns' },
      { label: 'Size Guide',        href: '/support/size-guide' },
      { label: 'Contact',           href: '/contact' },
    ],
  },
]

export function Nav() {
  const { itemCount, openCart } = useCart()
  const pathname   = usePathname()
  const [scrolled, setScrolled] = useState(false)
  const [onHero,   setOnHero]   = useState(true)
  const [open,     setOpen]     = useState(false)
  const closeRef   = useRef<HTMLButtonElement>(null)

  const isHeroPage = pathname === '/'

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      setScrolled(y > 40)
      setOnHero(y < (window.innerHeight * 0.85))
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  // Nav colour logic: transparent + white text over hero, solid otherwise
  const isTransparent = isHeroPage && onHero && !scrolled
  const navBg  = scrolled
    ? 'bg-[rgba(250,250,248,0.95)] backdrop-blur-[20px] border-b border-[var(--color-border)]'
    : isTransparent
    ? 'bg-transparent'
    : 'bg-[var(--color-bg)]'
  const textCol = isTransparent ? 'text-[var(--color-text-on-dark)]' : 'text-[var(--color-text)]'

  return (
    <>
      <header
        className={cn(
          'fixed top-0 left-0 right-0 z-[200] h-[56px] flex items-center transition-all duration-300',
          navBg, textCol
        )}
        aria-label="Site header"
      >
        <div className="kvrn-container w-full flex items-center justify-between">
          {/* Logo */}
          <Link
            href="/"
            className="text-[13px] font-light tracking-[0.2em] uppercase hover:opacity-60 transition-opacity duration-150"
            aria-label="KVRN — go to homepage"
          >
            KVRN
          </Link>

          {/* Desktop links */}
          <nav className="hidden md:flex items-center gap-10" aria-label="Primary navigation">
            {primaryLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-[11px] font-light tracking-[0.14em] uppercase hover:opacity-60 transition-opacity duration-150"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right: bag + hamburger */}
          <div className="flex items-center gap-6">
            <button
              onClick={openCart}
              className="text-[11px] font-light tracking-[0.14em] uppercase hover:opacity-60 transition-opacity duration-150"
              aria-label={`Shopping bag${itemCount > 0 ? `, ${itemCount} item${itemCount === 1 ? '' : 's'}` : ''}`}
            >
              Bag{itemCount > 0 && <span className="ml-1">({itemCount})</span>}
            </button>
            <button
              onClick={() => setOpen(true)}
              className="md:hidden flex flex-col gap-[5px] p-1 -mr-1"
              aria-label="Open menu"
              aria-expanded={open}
              aria-controls="mobile-nav"
            >
              {[0, 1].map((i) => (
                <span
                  key={i}
                  className="block h-px w-[22px] transition-colors duration-300"
                  style={{ backgroundColor: isTransparent ? 'var(--color-text-on-dark)' : 'var(--color-text)' }}
                />
              ))}
            </button>
          </div>
        </div>
      </header>

      {/* ─── Mobile overlay ─── */}
      <div
        className={cn(
          'fixed inset-0 z-[300] bg-black/40 transition-opacity duration-300 md:hidden',
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* ─── Mobile drawer ─── */}
      <div
        id="mobile-nav"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        className={cn(
          'fixed inset-y-0 left-0 z-[400] w-[min(340px,100vw)] bg-[var(--color-bg)]',
          'flex flex-col px-6 pt-7 pb-10 overflow-y-auto',
          'transition-transform duration-500 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] md:hidden',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between mb-10 flex-shrink-0">
          <Link
            href="/"
            onClick={() => setOpen(false)}
            className="text-[13px] font-light tracking-[0.2em] uppercase"
          >
            KVRN
          </Link>
          <button
            ref={closeRef}
            onClick={() => setOpen(false)}
            className="p-2 -mr-2 text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
            aria-label="Close menu"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 3L15 15M15 3L3 15" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Drawer sections */}
        <nav className="flex-1 space-y-8" aria-label="Mobile navigation">
          {drawerSections.map((section) => (
            <div key={section.heading}>
              <p className="kvrn-label text-[var(--color-muted)] mb-3">{section.heading}</p>
              <div className="space-y-1">
                {section.links.map((link) => (
                  <Link
                    key={link.href + link.label}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="block py-2.5 text-[15px] font-light text-[var(--color-text)] hover:text-[var(--color-muted)] transition-colors duration-150"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Social */}
        <div className="mt-8 pt-6 border-t border-[var(--color-border)] flex gap-5 flex-shrink-0">
          <a
            href="https://instagram.com/kvrn"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] tracking-[0.14em] uppercase text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Instagram
          </a>
        </div>
      </div>
    </>
  )
}
