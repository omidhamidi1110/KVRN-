import Link from 'next/link'

const col1 = {
  heading: 'Shop',
  links: [
    { label: 'All Products',         href: '/shop' },
    { label: 'Heavyweight Hoodie',   href: '/products/kvrn-heavyweight-hoodie' },
    { label: 'Heavyweight Sweatpants', href: '/products/kvrn-heavyweight-sweatpants' },
    { label: 'Waitlist',             href: '/waitlist' },
  ],
}

const col2 = {
  heading: 'Brand',
  links: [
    { label: 'About',   href: '/about' },
    { label: 'Journal', href: '/journal' },
  ],
}

const col3 = {
  heading: 'Support',
  links: [
    { label: 'FAQ',               href: '/support/faq' },
    { label: 'Shipping & Returns',href: '/support/shipping-returns' },
    { label: 'Contact',           href: '/contact' },
  ],
}

const legal = [
  { label: 'Privacy',  href: '/legal/privacy' },
  { label: 'Terms',    href: '/legal/terms' },
  { label: 'Cookies',  href: '/legal/cookies' },
  { label: 'Returns',  href: '/legal/returns' },
]

export function Footer() {
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
              Engineered for permanence.
            </p>
            <div className="flex gap-5 mt-8">
              {[
                { label: 'IG', href: 'https://instagram.com/kvrn', full: 'Instagram' },
                { label: 'TT', href: 'https://tiktok.com/@kvrn',   full: 'TikTok' },
              ].map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`KVRN on ${s.full}`}
                  className="text-[11px] font-light tracking-[0.12em] text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150"
                >
                  {s.label}
                </a>
              ))}
            </div>
          </div>

          {/* Link columns */}
          {[col1, col2, col3].map((col) => (
            <div key={col.heading}>
              <p className="kvrn-label mb-5">{col.heading}</p>
              <ul className="space-y-3">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-[13px] font-light text-[var(--color-text)] hover:text-[var(--color-muted)] transition-colors duration-150"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="py-6 border-t border-[var(--color-border)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <p className="text-[11px] font-light text-[var(--color-muted)] tracking-wide">
            © {new Date().getFullYear()} KVRN. All rights reserved.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {legal.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-[11px] font-light text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150 tracking-wide"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}
