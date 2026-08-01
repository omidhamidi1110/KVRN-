'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useCart }          from '@/context/CartContext'
import { useWishlist }      from '@/context/WishlistContext'
import { useCookiePrefs }   from '@/context/CookiePrefsContext'
import { useCurrency }      from '@/context/CurrencyContext'
import { useI18n, LANGUAGES, type Locale } from '@/context/I18nContext'
import { CURRENCIES, type CurrencyCode } from '@/lib/currency'
import { CurrencySelector } from '@/components/ui/CurrencySelector'
import { LanguageSelector } from '@/components/ui/LanguageSelector'
import { cn } from '@/lib/utils'

export function Nav() {
  const { itemCount, openCart }   = useCart()
  const { count: savedCount }     = useWishlist()
  const { openPreferences }       = useCookiePrefs()
  const { t }                     = useI18n()
  const pathname                  = usePathname()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  type NavbarMode = 'standard' | 'product-transparent' | 'product-cream' | 'collection-top' | 'collection-scrolled'

  const isHome       = pathname === '/'
  const isPDP        = pathname.startsWith('/products/')
  const isCollection = pathname === '/shop' || pathname.startsWith('/collections/')

  // Scroll offset for collection pages
  const [collectionScrolled, setCollectionScrolled] = useState(false)

  // Single source of truth for navbar appearance
  const [productStageMode, setProductStageMode] = useState<NavbarMode>('product-transparent')
  const effectiveMode: NavbarMode =
    isPDP        ? productStageMode :
    isCollection ? (collectionScrolled ? 'collection-scrolled' : 'collection-top') :
    isHome       ? 'product-transparent' :
                   'standard'

  // Reset on every route change — kills stale state from previous page
  useEffect(() => {
    if (isPDP) {
      setProductStageMode('product-transparent')
    }
    if (isCollection) {
      setCollectionScrolled(false)  // always start at top
    }
  }, [pathname, isPDP, isCollection])

  // Collection scroll listener
  useEffect(() => {
    if (!isCollection) return
    const onScroll = () => setCollectionScrolled(window.scrollY > 16)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [isCollection, pathname])

  // Listen for product-stage mode events
  useEffect(() => {
    const handler = (e: Event) => {
      if (!isPDP) return   // ignore events when not on a product route
      const detail = (e as CustomEvent<{ mode?: NavbarMode }>).detail
      if (detail?.mode === 'product-transparent' || detail?.mode === 'product-cream') {
        setProductStageMode(detail.mode)
      }
    }
    window.addEventListener('kvrn-navbar-mode', handler)
    return () => window.removeEventListener('kvrn-navbar-mode', handler)
  }, [isPDP, pathname])

  // Inner pages (not homepage, not PDP): watch data-nav-theme sections for text color
  const [innerDark, setInnerDark] = useState(false)
  useEffect(() => {
    if (isHome || isPDP) return
    const update = () => {
      const navY = 92
      const els = document.querySelectorAll('[data-nav-theme]')
      let dark = false
      els.forEach(el => {
        const rect = el.getBoundingClientRect()
        if (rect.top <= navY && rect.bottom > navY) {
          dark = el.getAttribute('data-nav-theme') === 'dark'
        }
      })
      setInnerDark(dark)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [isHome, isPDP, pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  // ── Nav visual state — derived from single effectiveMode ─────────────────
  const isTransparent = effectiveMode === 'product-transparent' || effectiveMode === 'collection-top'
  const isCollectionMode = effectiveMode === 'collection-top' || effectiveMode === 'collection-scrolled'
  // Collection pages: always white text/icons
  // Transparent product stages: white text
  // Standard: dark or section-aware
  // Explicit: product-cream → black text; product-transparent → white; collection → white
  const isWhiteText = isCollectionMode
    ? true                          // collection: always white
    : effectiveMode === 'product-transparent'
    ? true                          // PDP Stage 1/2: white
    : effectiveMode === 'product-cream'
    ? false                         // PDP Stage 3: BLACK (cream bg)
    : isHome
    ? false                         // homepage: dark slides handled by events
    : innerDark                     // inner pages: section-aware
  const textCls  = isWhiteText ? 'text-[#F0EDE8]' : 'text-[#1A1A1A]'
  const linesCls = isWhiteText ? 'bg-[#F0EDE8]'   : 'bg-[#1A1A1A]'

  const desktopLinks = [
    { label: t.shopAll,    href: '/shop' },
    { label: t.hoodies,    href: '/shop?type=hoodies' },
    { label: t.sweatpants, href: '/shop?type=sweatpants' },
    { label: t.trackOrder, href: '/support/track' },
    { label: t.about,      href: '/about' },
    { label: t.contact,    href: '/contact' },
  ]

  const mobileLinks = [
    { label: t.shopAll,         href: '/shop' },
    { label: t.hoodies,         href: '/shop?type=hoodies' },
    { label: t.sweatpants,      href: '/shop?type=sweatpants' },
    { label: t.about,           href: '/about' },
    { label: t.sizeGuide,       href: '/support/size-guide' },
    { label: t.trackOrder,      href: '/support/track' },
    { label: t.faq,             href: '/support/faq' },
    { label: t.shippingReturns, href: '/support/shipping-returns' },
    { label: t.contact,         href: '/contact' },
  ]

  return (
    <>
      <header
        className={cn(
          'fixed left-0 right-0 z-[200] h-[56px] flex items-center',
          // Homepage: transparent, no border — slide system controls colors
          // All other pages: solid cream bg + subtle border + black text, always
          // Transparent always — bg only for inner pages after scrolling
          // collection-top: fully transparent, no border (overlays dark hero)
          // collection-scrolled: dark translucent bg + visible border + blur
          // product-transparent: fully transparent, no border
          // standard/cream: cream bg + border
          effectiveMode === 'collection-top' || effectiveMode === 'product-transparent'
            ? 'bg-transparent border-0 shadow-none'
            : effectiveMode === 'collection-scrolled'
            ? 'border-b border-white/35'
            : 'bg-[#F9F8F6]/97 backdrop-blur-[14px] border-b border-[#E8E5E0]',
          textCls
        )}
        style={{
          top: '36px',
          backgroundColor:
            effectiveMode === 'collection-scrolled'
              ? 'rgba(8,8,8,0.72)'
              : undefined,
          backdropFilter:
            effectiveMode === 'collection-scrolled'
              ? 'blur(14px)'
              : undefined,
          WebkitBackdropFilter:
            effectiveMode === 'collection-scrolled'
              ? 'blur(14px)'
              : undefined,
          transition:
            'background-color 220ms ease, border-color 220ms ease, backdrop-filter 220ms ease',
        }}
        aria-label="Main navigation"
      >
        <div className="container-kvrn flex items-center justify-between">
          <Link href="/"
            className="text-[14px] font-light tracking-[0.18em] uppercase hover:opacity-50 transition-opacity"
            aria-label="KVRN">
            KVRN
          </Link>

          {/* Desktop links */}
          <nav className="hidden lg:flex items-center gap-6 xl:gap-8" aria-label="Main">
            {desktopLinks.map(l => (
              <Link key={l.href + l.label} href={l.href}
                className="text-[11px] font-light tracking-[0.09em] uppercase hover:opacity-50 transition-opacity whitespace-nowrap">
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3 lg:gap-4">
            {/* Language + Currency — desktop only, inherit nav text color */}
            <div className="hidden lg:flex items-center gap-3">
              <div className={cn(textCls)}>
                <LanguageSelector align="right" />
              </div>
              <span className="text-[11px] opacity-20 select-none">|</span>
              <div className={cn(textCls)}>
                <CurrencySelector align="right" />
              </div>
            </div>

            {/* Bag */}
            <button
              onClick={openCart}
              aria-label={`${t.bag}${itemCount > 0 ? `, ${itemCount}` : ''}`}
              className="flex items-center gap-1.5 hover:opacity-50 transition-opacity"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"
                  stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="3" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M16 10a4 4 0 01-8 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              {itemCount > 0 && (
                <span className="text-[11px] font-light tabular-nums">({itemCount})</span>
              )}
            </button>

            {/* Hamburger — mobile only, 3 lines */}
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu" aria-expanded={drawerOpen}
              className="lg:hidden flex flex-col justify-center gap-[5px] w-5 h-6 ml-1"
            >
              {[0,1,2].map(i => (
                <span key={i}
                  className={cn(
                    'block h-px w-5 transition-colors',
                    linesCls
                  )}
                />
              ))}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile backdrop */}
      {/* No backdrop needed — drawer is full screen */}
      <div
        className={cn(
          'fixed inset-0 z-[300] transition-opacity duration-300 lg:hidden pointer-events-none',
          drawerOpen ? 'opacity-100' : 'opacity-0'
        )}
        aria-hidden="true"
      />

      {/* Mobile drawer */}
      <div
        ref={drawerRef}
        role="dialog" aria-modal="true" aria-label="Navigation menu"
        className={cn(
          'fixed inset-0 z-[400]',
          'bg-[#0E0E0E] flex flex-col',
          'transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] lg:hidden',
          drawerOpen ? 'translate-y-0' : 'translate-y-full'
        )}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-6 pt-8 pb-6 border-b border-[#F0EDE8]/10">
          <Link href="/" onClick={() => setDrawerOpen(false)}
            className="text-[14px] font-light tracking-[0.18em] uppercase text-[#F0EDE8]">KVRN</Link>
          <button onClick={() => setDrawerOpen(false)} aria-label="Close menu"
            className="text-[#F0EDE8]/50 hover:text-[#F0EDE8] transition-colors p-1">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M3 3l12 12M15 3L3 15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Collapsible Language + Currency at top of drawer */}
        <div className="border-b border-[#F0EDE8]/10">
          <DrawerLangSelector />
          <DrawerCurrencySelector />
        </div>

        {/* Nav links */}
        <nav className="flex-1 overflow-y-auto px-6 py-2">
          {mobileLinks.map(l => (
            <Link key={l.href + l.label} href={l.href}
              onClick={() => setDrawerOpen(false)}
              className="block py-3.5 text-[16px] font-light border-b border-[#F0EDE8]/10 last:border-0 text-[#F0EDE8] hover:text-[#F0EDE8]/50 transition-colors">
              {l.label}
            </Link>
          ))}
        </nav>

        {/* Drawer footer */}
        <div className="px-6 py-5 border-t border-[#F0EDE8]/10">
          <div className="flex items-center gap-4 mb-3">
            <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer"
              aria-label="KVRN on Instagram" className="text-[#F0EDE8]/50 hover:text-[#F0EDE8] transition-colors">
              <InstagramIcon />
            </a>
            <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer"
              aria-label="KVRN on TikTok" className="text-[#F0EDE8]/50 hover:text-[#F0EDE8] transition-colors">
              <TikTokIcon />
            </a>
          </div>
          <button
            onClick={() => { openPreferences(); setDrawerOpen(false) }}
            className="text-[11px] font-light text-[#F0EDE8]/35 hover:text-[#F0EDE8]/70 transition-colors tracking-wide"
          >
            Cookie preferences
          </button>
        </div>
      </div>
    </>
  )
}

// ─── Collapsible drawer selectors ────────────────────────────────────────────

function DrawerLangSelector() {
  const { locale, setLocale } = useI18n()
  const [open, setOpen] = useState(false)
  const current = LANGUAGES.find(l => l.code === locale) ?? LANGUAGES[0]

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-6 py-3.5 hover:bg-[#F0EDE8]/5 transition-colors"
        aria-expanded={open}
      >
        <div className="text-left">
          <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/40">Language</p>
          <p className="text-[13px] font-light text-[#F0EDE8] mt-0.5">{current.nativeLabel}</p>
        </div>
        <svg width="12" height="7" viewBox="0 0 12 7" fill="none"
          className={cn('text-[#F0EDE8]/40 transition-transform duration-200', open && 'rotate-180')}>
          <path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </button>
      {open && (
        <div className="px-6 pb-3 grid grid-cols-2 gap-1.5">
          {LANGUAGES.map(l => (
            <button
              key={l.code}
              onClick={() => { setLocale(l.code as Locale); setOpen(false) }}
              className={cn(
                'px-3 py-2 text-left text-[12px] font-light border transition-all duration-150',
                l.code === locale
                  ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                  : 'border-[#F0EDE8]/20 text-[#F0EDE8]/70 hover:border-[#F0EDE8]/60'
              )}
            >
              <span className="block">{l.nativeLabel}</span>
              <span className="block text-[10px] opacity-60">{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DrawerCurrencySelector() {
  const { currencyCode, setCurrency } = useCurrency()
  const [open, setOpen] = useState(false)
  const current = CURRENCIES.find(c => c.code === currencyCode) ?? CURRENCIES[0]

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-6 py-3.5 hover:bg-[#F0EDE8]/5 transition-colors"
        aria-expanded={open}
      >
        <div className="text-left">
          <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/40">Currency</p>
          <p className="text-[13px] font-light text-[#F0EDE8] mt-0.5">{currencyCode} — {current.label.split(' — ')[1]}</p>
        </div>
        <svg width="12" height="7" viewBox="0 0 12 7" fill="none"
          className={cn('text-[#F0EDE8]/40 transition-transform duration-200', open && 'rotate-180')}>
          <path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </button>
      {open && (
        <div className="px-6 pb-3 grid grid-cols-3 gap-1.5">
          {CURRENCIES.map(c => (
            <button
              key={c.code}
              onClick={() => { setCurrency(c.code as CurrencyCode); setOpen(false) }}
              className={cn(
                'px-2 py-2 text-[12px] font-light border transition-all duration-150',
                c.code === currencyCode
                  ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                  : 'border-[#F0EDE8]/20 text-[#F0EDE8]/70 hover:border-[#F0EDE8]/60'
              )}
            >
              {c.code}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function InstagramIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/>
    </svg>
  )
}
function TikTokIcon() {
  return (
    <svg width="16" height="18" viewBox="0 0 448 512" fill="currentColor">
      <path d="M448 209.9a210.1 210.1 0 0 1-122.8-39.3v178.8A162.6 162.6 0 1 1 185 188.3v89.3a74.6 74.6 0 1 0 52.2 71.2V0h88a121.2 121.2 0 0 0 1.9 22.2A122.2 122.2 0 0 0 381 102.4a121.4 121.4 0 0 0 67 20.1z"/>
    </svg>
  )
}
