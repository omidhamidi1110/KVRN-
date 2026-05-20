'use client'

import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { useCookiePrefs } from '@/context/CookiePrefsContext'

const SHOP_LINKS = [
  { label: 'Shop All',   href: '/shop' },
  { label: 'Hoodies',    href: '/shop?type=hoodies' },
  { label: 'Sweatpants', href: '/shop?type=sweatpants' },
]

const SUPPORT_LINKS = [
  { label: 'Shipping & Returns', href: '/support/shipping-returns' },
  { label: 'Track Order',        href: '/support/track' },
  { label: 'Contact',            href: '/contact' },
]

const LEGAL_LINKS = [
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms',   href: '/terms' },
  { label: 'Cookies', href: '/cookies' },
]

export function Footer() {
  const { t }               = useI18n()
  const { openPreferences } = useCookiePrefs()
  const year                = new Date().getFullYear()

  return (
    <footer className="border-t border-[#E8E5E0] bg-[#F9F8F6]" aria-label="Site footer">
      <div className="container-kvrn">
        {/* 4-col desktop / 3-col mobile grid */}
        <div className="py-10 md:py-12 grid grid-cols-3 md:grid-cols-4 gap-6">

          {/* Brand */}
          <div className="col-span-3 md:col-span-1 space-y-4 pb-6 border-b border-[#E8E5E0] md:border-0 md:pb-0">
            <Link href="/" className="block text-[14px] font-light tracking-[0.14em] uppercase">
              KVRN
            </Link>
            <p className="text-[12px] text-[#6B6B6B] leading-relaxed">
              Quiet garments.<br className="hidden md:block" />Built with intention.
            </p>
            <div className="flex gap-4">
              <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on Instagram" className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                <InstagramIcon />
              </a>
              <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on TikTok" className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                <TikTokIcon />
              </a>
            </div>
          </div>

          {/* Shop */}
          <div>
            <p className="text-[10px] font-light tracking-[0.12em] uppercase text-[#9B9B9B] mb-4">{t.shop}</p>
            <ul className="space-y-2.5">
              {SHOP_LINKS.map(l => (
                <li key={l.href}>
                  <Link href={l.href} className="text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <p className="text-[10px] font-light tracking-[0.12em] uppercase text-[#9B9B9B] mb-4">{t.support}</p>
            <ul className="space-y-2.5">
              {SUPPORT_LINKS.map(l => (
                <li key={l.href}>
                  <Link href={l.href} className="text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <p className="text-[10px] font-light tracking-[0.12em] uppercase text-[#9B9B9B] mb-4">{t.legal}</p>
            <ul className="space-y-2.5">
              {LEGAL_LINKS.map(l => (
                <li key={l.href}>
                  <Link href={l.href} className="text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="py-4 border-t border-[#E8E5E0] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <p className="text-[11px] text-[#9B9B9B]">© {year} KVRN. {t.allRightsReserved}</p>
          <button
            onClick={openPreferences}
            className="text-[11px] text-[#9B9B9B] hover:text-[#6B6B6B] transition-colors"
          >
            Cookie preferences
          </button>
        </div>
      </div>
    </footer>
  )
}

function InstagramIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/>
    </svg>
  )
}
function TikTokIcon() {
  return (
    <svg width="15" height="17" viewBox="0 0 448 512" fill="currentColor" aria-hidden="true">
      <path d="M448 209.9a210.1 210.1 0 0 1-122.8-39.3v178.8A162.6 162.6 0 1 1 185 188.3v89.3a74.6 74.6 0 1 0 52.2 71.2V0h88a121.2 121.2 0 0 0 1.9 22.2A122.2 122.2 0 0 0 381 102.4a121.4 121.4 0 0 0 67 20.1z"/>
    </svg>
  )
}
