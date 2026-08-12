'use client'

import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { useCookiePrefs } from '@/context/CookiePrefsContext'

const SHOP_LINKS    = [['Shop All','/shop'],['Hoodies','/shop?type=hoodies'],['Sweatpants','/shop?type=sweatpants']] as const
const SUPPORT_LINKS = [['Shipping & Returns','/support/shipping-returns'],['Track Order','/support/track'],['Contact','/contact']] as const
const LEGAL_LINKS   = [['Privacy','/privacy'],['Terms','/terms'],['Cookies','/cookies']] as const

export function Footer() {
  const { t }               = useI18n()
  const { openPreferences } = useCookiePrefs()
  const year                = new Date().getFullYear()

  return (
    // No overflow-hidden, no giant wordmark, no decorative background
    <footer className="border-t border-[#E8E5E0] bg-[#F9F8F6]" aria-label="Site footer">
      <div className="container-kvrn">

        {/* ── Main columns ─────────────────────────────────────────── */}
        <div className="py-10 md:py-12 grid grid-cols-3 md:grid-cols-4 gap-6 md:gap-8">

          {/* Brand block — desktop only */}
          <div className="hidden md:block space-y-3">
            <p className="text-[12px] font-light tracking-[0.14em] uppercase text-[#1A1A1A]">KVRN</p>
            <div className="space-y-0.5">
              <p className="text-[12px] font-light text-[#6B6B6B]">Quiet garments.</p>
              <p className="text-[12px] font-light text-[#6B6B6B]">Built with intention.</p>
            </div>
            <div className="flex gap-4 pt-1">
              <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on Instagram" className="text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
                <InstagramIcon />
              </a>
              <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on TikTok" className="text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
                <TikTokIcon />
              </a>
            </div>
          </div>

          {/* Shop */}
          <div>
            <p className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B] mb-4">{t.shop}</p>
            <ul className="space-y-2.5">
              {SHOP_LINKS.map(([label, href]) => (
                <li key={href}>
                  <Link href={href} className="text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">{label}</Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <p className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B] mb-4">{t.support}</p>
            <ul className="space-y-2.5">
              {SUPPORT_LINKS.map(([label, href]) => (
                <li key={href}>
                  <Link href={href} className="text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">{label}</Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal + mobile social */}
          <div>
            <p className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B] mb-4">{t.legal}</p>
            <ul className="space-y-2.5">
              {LEGAL_LINKS.map(([label, href]) => (
                <li key={href}>
                  <Link href={href} className="text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">{label}</Link>
                </li>
              ))}
            </ul>
            {/* Social icons — mobile only (desktop shows in brand block) */}
            <div className="flex md:hidden gap-4 mt-5">
              <a href="https://instagram.com/thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on Instagram" className="text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
                <InstagramIcon />
              </a>
              <a href="https://tiktok.com/@thekvrn" target="_blank" rel="noopener noreferrer"
                aria-label="KVRN on TikTok" className="text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
                <TikTokIcon />
              </a>
            </div>
          </div>
        </div>

        {/* ── Bottom bar ────────────────────────────────────────────── */}
        <div className="py-4 border-t border-[#E8E5E0] flex flex-row items-center justify-between gap-4">
          <p className="text-[11px] text-[#9B9B9B]">© {year} KVRN. {t.allRightsReserved}</p>
          <button
            onClick={openPreferences}
            className="text-[11px] text-[#9B9B9B] hover:text-[#6B6B6B] transition-colors flex-shrink-0"
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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/>
    </svg>
  )
}
function TikTokIcon() {
  return (
    <svg width="14" height="16" viewBox="0 0 448 512" fill="currentColor" aria-hidden="true">
      <path d="M448 209.9a210.1 210.1 0 0 1-122.8-39.3v178.8A162.6 162.6 0 1 1 185 188.3v89.3a74.6 74.6 0 1 0 52.2 71.2V0h88a121.2 121.2 0 0 0 1.9 22.2A122.2 122.2 0 0 0 381 102.4a121.4 121.4 0 0 0 67 20.1z"/>
    </svg>
  )
}
