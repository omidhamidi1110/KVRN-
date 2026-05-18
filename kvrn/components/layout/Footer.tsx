import Link from 'next/link'

// ─── Columns ─────────────────────────────────────────────────────────────────

const SHOP_LINKS = [
  { label: 'Shop All',    href: '/shop' },
  { label: 'Hoodies',     href: '/shop?type=hoodies' },
  { label: 'Sweatpants',  href: '/shop?type=sweatpants' },
  { label: 'Waitlist',    href: '/waitlist' },
]

const SUPPORT_LINKS = [
  { label: 'FAQ',              href: '/support/faq' },
  { label: 'Shipping',         href: '/support/shipping-returns' },
  { label: 'Returns',          href: '/support/shipping-returns#returns' },
  { label: 'Size Guide',       href: '/support/size-guide' },
  { label: 'Track Order',      href: '/support/track' },
  { label: 'Contact',          href: '/contact' },
]

const BRAND_LINKS = [
  { label: 'About',   href: '/about' },
  { label: 'Story',   href: '/about#story' },
]

const LEGAL_LINKS = [
  { label: 'Privacy',  href: '/privacy' },
  { label: 'Terms',    href: '/terms' },
  { label: 'Cookies',  href: '/cookies' },
]

export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-kvrn-border bg-kvrn-bg" aria-label="Site footer">
      <div className="container-kvrn">

        {/* ── Desktop: 5-column grid / Mobile: 2-col then stack ── */}
        <div className="py-12 md:py-14 grid grid-cols-2 md:grid-cols-5 gap-8 md:gap-6">

          {/* Brand */}
          <div className="col-span-2 md:col-span-1 space-y-4">
            <Link href="/" className="block text-[14px] font-display font-light tracking-wider uppercase">
              KVRN
            </Link>
            <p className="text-[12px] text-kvrn-muted leading-relaxed">
              Quiet luxury.<br />Premium utility.
            </p>
            <div className="flex gap-4">
              <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on Instagram (@thekvrn)"
                className="text-kvrn-muted hover:text-kvrn-text transition-colors duration-150">
                <InstagramIcon />
              </a>
              <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on TikTok (@thekvrn)"
                className="text-kvrn-muted hover:text-kvrn-text transition-colors duration-150">
                <TikTokIcon />
              </a>
            </div>
          </div>

          {/* Shop */}
          <div>
            <p className="label-11 mb-4">Shop</p>
            <ul className="space-y-2.5">
              {SHOP_LINKS.map(l => (
                <li key={l.href}>
                  <Link href={l.href}
                    className="text-[12px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <p className="label-11 mb-4">Support</p>
            <ul className="space-y-2.5">
              {SUPPORT_LINKS.map(l => (
                <li key={l.href + l.label}>
                  <Link href={l.href}
                    className="text-[12px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Brand */}
          <div>
            <p className="label-11 mb-4">Brand</p>
            <ul className="space-y-2.5">
              {BRAND_LINKS.map(l => (
                <li key={l.href}>
                  <Link href={l.href}
                    className="text-[12px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <p className="label-11 mb-4">Legal</p>
            <ul className="space-y-2.5">
              {LEGAL_LINKS.map(l => (
                <li key={l.href}>
                  <Link href={l.href}
                    className="text-[12px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom strip */}
        <div className="py-4 border-t border-kvrn-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <p className="text-[11px] text-kvrn-muted tracking-wide">
            © {year} KVRN. All rights reserved.
          </p>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <p className="text-[11px] text-kvrn-subtle">
              Prices shown in selected currency. Conversion is approximate.
            </p>
            <span className="hidden sm:block text-[11px] text-kvrn-border" aria-hidden="true">·</span>
            <a href="mailto:support@kvrn.shop"
              className="text-[11px] text-kvrn-subtle hover:text-kvrn-muted transition-colors duration-150 tracking-wide">
              support@kvrn.shop
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}

function InstagramIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>
    </svg>
  )
}

function TikTokIcon() {
  return (
    <svg width="14" height="16" viewBox="0 0 24 27" fill="currentColor" aria-hidden="true">
      <path d="M19.5 3.2A5.6 5.6 0 0114 0h-3.7v18.3a2.9 2.9 0 11-2.8-3 2.9 2.9 0 011 .2V11.6a7 7 0 10.6 13.7V13.8a9.1 9.1 0 005.4 1.7V12a5.6 5.6 0 01-3.3-1.1A5.5 5.5 0 0014 12V3.7a9.3 9.3 0 005.5 1.6V1.8l-.05 1.4z"/>
    </svg>
  )
}
