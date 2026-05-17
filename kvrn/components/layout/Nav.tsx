'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCart } from '@/context/CartContext'
import { cn } from '@/lib/utils'

// ─── NAV CONFIG ──────────────────────────────────────────────────────────────
// Scalable structure: add future top-level collections here.
// The mobile drawer reads from drawerSections automatically.

const primaryLinks = [
  { label: 'Collections', href: '/shop' },
  { label: 'About',       href: '/about' },
  { label: 'Journal',     href: '/journal' },
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
      { label: 'Journal',    href: '/journal' },
      { label: 'Waitlist',   href: '/waitlist' },
    ],
  },
  {
    heading: 'Support',
    links: [
      { label: 'FAQ',                href: '/support/faq' },
      { label: 'Shipping & Returns', href: '/support/shipping-returns' },
      { label: 'Contact',            href: '/contact' },
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

  // Hero detection — only applies to pages that declare a full-height hero
  const isHeroPage = pathname === '/'

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      setScrolled(y > 40)
      setOnHero(y < window.innerHeight * 0.75)
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

  // Nav is transparent/white-text over hero, solid after scroll or on non-hero pages
  const transparent = isHeroPage && onHero && !scrolled

  return (
    <>
      <header
        className={cn(
          'fixed top-0 left-0 right-0 z-[200] h-[60px] flex items-center',
          'transition-all duration-500 ease-out',
          transparent
            ? 'bg-transparent text-[var(--color-text-on-dark)]'
            : 'bg-[rgba(249,248,246,0.93)] backdrop-blur-[24px] border-b border-[var(--color-border)] text-[var(--color-text)]'
        )}
        aria-label="Site header"
      >
        <div className="kvrn-container w-full flex items-center justify-between">

          {/* Wordmark */}
          <Link
            href="/"
            className="text-[14px] font-light tracking-[0.2em] uppercase hover:opacity-60 transition-opacity duration-200"
            aria-label="KVRN — Home"
          >
            KVRN
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-10" aria-label="Primary">
            {primaryLinks.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  'text-[11px] font-light tracking-[0.14em] uppercase',
                  'hover:opacity-60 transition-opacity duration-150',
                  pathname === l.href && 'opacity-50'
                )}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          {/* Right: bag + menu */}
          <div className="flex items-center gap-7">
            <button
              onClick={openCart}
              className="text-[11px] font-light tracking-[0.14em] uppercase hover:opacity-60 transition-opacity duration-150"
              aria-label={`Bag — ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
            >
              Bag{itemCount > 0 && ` (${itemCount})`}
            </button>

            {/* Hamburger — mobile only */}
            <button
              onClick={() => setOpen(true)}
              aria-label="Open menu"
              aria-expanded={open}
              className="md:hidden flex flex-col gap-[5px] p-1 -mr-1"
            >
              {[0,1].map(i => (
                <span
                  key={i}
                  className="block h-px w-5 transition-colors duration-200"
                  style={{ background: transparent ? 'var(--color-text-on-dark)' : 'var(--color-text)' }}
                />
              ))}
            </button>
          </div>
        </div>
      </header>

      {/* ─── Mobile drawer overlay ─── */}
      <div
        className={cn(
          'fixed inset-0 z-[300] bg-black/50 md:hidden transition-opacity duration-300',
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* ─── Mobile drawer panel ─── */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          'fixed inset-y-0 right-0 z-[400] w-full max-w-sm bg-[var(--color-bg)]',
          'flex flex-col overflow-y-auto scrollbar-thin',
          'transition-transform duration-500 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] md:hidden',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-5 border-b border-[var(--color-border)]">
          <Link
            href="/"
            onClick={() => setOpen(false)}
            className="text-[14px] font-light tracking-[0.2em] uppercase"
          >
            KVRN
          </Link>
          <button
            ref={closeRef}
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="p-2 -mr-2 opacity-50 hover:opacity-100 transition-opacity"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 3l12 12M15 3L3 15" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Sections */}
        <nav className="flex-1 px-6 py-8 space-y-10" aria-label="Mobile navigation">
          {drawerSections.map((section) => (
            <div key={section.heading}>
              <p className="kvrn-label mb-4">{section.heading}</p>
              <ul className="space-y-1">
                {section.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        'block py-2.5 text-[22px] font-light leading-tight',
                        'hover:opacity-50 transition-opacity duration-150',
                        pathname === l.href && 'opacity-40'
                      )}
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Drawer footer */}
        <div className="px-6 py-6 border-t border-[var(--color-border)] flex gap-6">
          {[
            { label: 'Instagram', href: 'https://instagram.com/kvrn' },
            { label: 'TikTok',    href: 'https://tiktok.com/@kvrn' },
          ].map((s) => (
            <a
              key={s.label}
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              className="kvrn-label text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              {s.label}
            </a>
          ))}
        </div>
      </div>
    </>
  )
}
