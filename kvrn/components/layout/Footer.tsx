import Link from 'next/link'

const shopLinks = [
  { label: 'Hoodies',    href: '/products/kvrn-heavyweight-hoodie' },
  { label: 'Sweatpants', href: '/products/kvrn-heavyweight-sweatpants' },
  { label: 'Shop All',   href: '/shop' },
  { label: 'Waitlist',   href: '/waitlist' },
]

const supportLinks = [
  { label: 'FAQ',               href: '/support/faq' },
  { label: 'Shipping & Returns', href: '/support/shipping-returns' },
  { label: 'Contact',           href: '/contact' },
  { label: 'Size Guide',        href: '/support/faq#sizing' },
]

const brandLinks = [
  { label: 'About',   href: '/about' },
  { label: 'Story',   href: '/about' },
]

const legalLinks = [
  { label: 'Privacy',         href: '/privacy' },
  { label: 'Terms',           href: '/terms' },
  { label: 'Cookie Policy',   href: '/cookies' },
]

export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-kvrn-border bg-kvrn-bg" aria-label="Site footer">
      <div className="container-kvrn">
        {/* Main footer grid */}
        <div className="py-16 md:py-24 grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-16">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link
              href="/"
              className="block text-[15px] font-display font-light tracking-wider uppercase mb-4"
            >
              KVRN
            </Link>
            <p className="text-[13px] text-kvrn-muted leading-relaxed max-w-[220px]">
              Quiet luxury.<br />Premium utility.
            </p>
            {/* Social */}
            <div className="flex gap-5 mt-6">
              <a
                href="https://instagram.com/kvrn"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors duration-150"
                aria-label="KVRN on Instagram"
              >
                IG
              </a>
              <a
                href="https://tiktok.com/@kvrn"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors duration-150"
                aria-label="KVRN on TikTok"
              >
                TT
              </a>
            </div>
          </div>

          {/* Shop */}
          <div>
            <p className="label-11 mb-5">Shop</p>
            <ul className="space-y-3">
              {shopLinks.map((link) => (
                <li key={link.href + link.label}>
                  <Link
                    href={link.href}
                    className="text-[13px] text-kvrn-text hover:text-kvrn-muted transition-colors duration-150"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <p className="label-11 mb-5">Support</p>
            <ul className="space-y-3">
              {supportLinks.map((link) => (
                <li key={link.href + link.label}>
                  <Link
                    href={link.href}
                    className="text-[13px] text-kvrn-text hover:text-kvrn-muted transition-colors duration-150"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Brand */}
          <div>
            <p className="label-11 mb-5">Brand</p>
            <ul className="space-y-3">
              {brandLinks.map((link) => (
                <li key={link.href + link.label}>
                  <Link
                    href={link.href}
                    className="text-[13px] text-kvrn-text hover:text-kvrn-muted transition-colors duration-150"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom row */}
        <div className="py-6 border-t border-kvrn-border flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <p className="text-[11px] text-kvrn-muted tracking-wide">
            © {year} KVRN. All rights reserved.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {legalLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-[11px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150 tracking-wide"
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
