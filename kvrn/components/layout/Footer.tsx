import Link from 'next/link'

// ─── FOOTER LINK CONFIG ───────────────────────────────────────────────────────
// All hrefs must point to pages that exist.
// /journal: add back only when app/journal/page.tsx exists.
// /legal/*: pages live at /privacy, /terms, /cookies — no /legal/ prefix.

const col1 = {
  heading: 'Shop',
  links: [
    { label: 'All Products',           href: '/shop' },
    { label: 'Heavyweight Hoodie',     href: '/products/kvrn-heavyweight-hoodie' },
    { label: 'Heavyweight Sweatpants', href: '/products/kvrn-heavyweight-sweatpants' },
    { label: 'Waitlist',               href: '/waitlist' },
  ],
}

const col2 = {
  heading: 'Brand',
  links: [
    { label: 'About', href: '/about' },
  ],
}

const col3 = {
  heading: 'Support',
  links: [
    { label: 'FAQ',                href: '/support/faq' },
  { label: 'Track order',        href: '/support/track' },
    { label: 'Shipping & Returns', href: '/support/shipping-returns' },
    { label: 'Size Guide',         href: '/support/size-guide' },
    { label: 'Contact',            href: '/contact' },
  ],
}

// Legal links — point to actual page routes (no /legal/ prefix)
const legal = [
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms',   href: '/terms' },
  { label: 'Cookies', href: '/cookies' },
]

export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-[var(--color-border)] bg-[var(--color-bg)]" aria-label="Site footer">
      <div className="kvrn-container">

        {/* Main grid */}
        <div className="py-16 md:py-24 grid grid-cols-2 md:grid-cols-[2fr_1fr_1fr_1fr] gap-10 md:gap-16">

          {/* Brand statement */}
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="block text-[14px] font-light tracking-[0.2em] uppercase mb-5">
              KVRN
            </Link>
            <p className="text-[13px] text-[var(--color-muted)] leading-relaxed max-w-[200px]">
              Designed slowly.
              <br />
              Built to remain.
            </p>
            <div className="flex gap-5 mt-6">
              <a
                href="https://instagram.com/kvrn"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] tracking-[0.14em] uppercase text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150"
                aria-label="KVRN on Instagram"
              >
                Instagram
              </a>
            </div>
          </div>

          {/* Shop */}
          <div>
            <p className="kvrn-label mb-5">{col1.heading}</p>
            <ul className="space-y-3">
              {col1.links.map((link) => (
                <li key={link.href + link.label}>
                  <Link
                    href={link.href}
                    className="text-[13px] font-light text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Brand */}
          <div>
            <p className="kvrn-label mb-5">{col2.heading}</p>
            <ul className="space-y-3">
              {col2.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-[13px] font-light text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <p className="kvrn-label mb-5">{col3.heading}</p>
            <ul className="space-y-3">
              {col3.links.map((link) => (
                <li key={link.href + link.label}>
                  <Link
                    href={link.href}
                    className="text-[13px] font-light text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom row */}
        <div className="py-6 border-t border-[var(--color-border)] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <p className="text-[11px] text-[var(--color-muted)] tracking-wide">
            © {year} KVRN. All rights reserved.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {legal.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150 tracking-wide"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}
