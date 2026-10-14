'use client'

import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { useCookiePrefs } from '@/context/CookiePrefsContext'
import type { ShellData } from '@/lib/content-shell'
import { resolveGroupHeading, resolveLinkLabel, copyrightLine } from '@/lib/content-shell'

// [dictionary key, href] — the label is looked up in the visitor's language (English text is unchanged).
const SHOP_LINKS    = [['shopAll','/shop'],['hoodies','/shop?type=hoodies'],['sweatpants','/shop?type=sweatpants']] as const
const SUPPORT_LINKS = [['shippingReturns','/support/shipping-returns'],['trackOrder','/support/track'],['contact','/contact']] as const
const LEGAL_LINKS   = [['privacy','/privacy'],['terms','/terms'],['cookies','/cookies']] as const

interface View {
  brandName: string; taglines: string[]
  groups: Array<{ id: string; heading: string; links: Array<{ id: string; label: string; href: string; newTab?: boolean }> }>
  social: Array<{ id: string; platform: 'instagram' | 'tiktok' | 'other'; label: string; href: string }>
  copyright: string
}

/** `shell` is provided only when Admin-managed content is enabled; without it this is the coded footer. */
export function Footer({ shell }: { shell?: ShellData | null } = {}) {
  const { t, locale }       = useI18n()
  const { openPreferences } = useCookiePrefs()
  const year                = new Date().getFullYear()

  const f = shell?.footer
  const view: View = f ? {
    brandName: f.brandName, taglines: f.taglines,
    groups: f.groups.map(g => ({
      id: g.id, heading: resolveGroupHeading(g, locale, shell!.tr.footer, t),
      links: g.links.map(l => ({ id: l.id, label: resolveLinkLabel(l, locale, shell!.tr.footer, t), href: l.href, newTab: l.newTab })),
    })),
    social: f.social,
    copyright: copyrightLine(f, year, locale, shell!.tr.footer, t),
  } : {
    brandName: 'KVRN', taglines: [t['footer.tagline1'], t['footer.tagline2']],
    groups: [
      { id: 'shop',    heading: t.shop,    links: SHOP_LINKS.map(([k, href]) => ({ id: href, label: t[k], href })) },
      { id: 'support', heading: t.support, links: SUPPORT_LINKS.map(([k, href]) => ({ id: href, label: t[k], href })) },
      { id: 'legal',   heading: t.legal,   links: LEGAL_LINKS.map(([k, href]) => ({ id: href, label: t[k], href })) },
    ],
    social: [
      { id: 'instagram', platform: 'instagram', label: t['nav.onInstagram'], href: 'https://instagram.com/thekvrn' },
      { id: 'tiktok',    platform: 'tiktok',    label: t['nav.onTikTok'],    href: 'https://tiktok.com/@thekvrn' },
    ],
    copyright: `© ${year} KVRN. ${t.allRightsReserved}`,
  }
  const socialLinks = (cls: string) => view.social.map(sx => (
    <a key={sx.id} href={sx.href} target="_blank" rel="noopener noreferrer"
      aria-label={sx.label} className={cls}>
      {sx.platform === 'instagram' ? <InstagramIcon /> : sx.platform === 'tiktok' ? <TikTokIcon /> : <LinkIcon />}
    </a>
  ))

  return (
    // No overflow-hidden, no giant wordmark, no decorative background
    <footer className="border-t border-[#E8E5E0] bg-[#F9F8F6]" aria-label={t['footer.siteFooter']}>
      <div className="container-kvrn">

        {/* ── Main columns ─────────────────────────────────────────── */}
        <div className={`py-10 md:py-12 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-10 md:gap-8 text-center items-start`}>

          {/* Same two-by-two mobile hierarchy as the homepage footer. */}
          <div className="space-y-4">
            <div className="space-y-1">
              {view.taglines.map((line, i) => <p key={`${i}:${line}`} className={`text-[13px] font-light ${i ? 'text-[#6B6B6B]' : 'text-[#1A1A1A]'}`}>{line}</p>)}
            </div>
            <div className="flex justify-center gap-5 pt-2">
              {socialLinks('text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors')}
            </div>
            <Link href="/admin" className="inline-block text-[9px] uppercase tracking-[0.16em] text-[#9B9B9B] hover:text-[#1A1A1A]">Admin Login</Link>
          </div>

          {view.groups.map(g => (
            <div key={g.id}>
              <p className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B] mb-4">{g.heading}</p>
              <ul className="space-y-2.5">
                {g.links.map(l => (
                  <li key={l.id}>
                    <Link href={l.href} {...(l.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                      className="text-[13px] text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors">{l.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* ── Bottom bar ────────────────────────────────────────────── */}
        {/* One compact horizontal row at every width (320px up): © · Cookie Preferences · Your Privacy Choices. Phones show the
            short © line; the full line returns from 640px. whitespace-nowrap + min-w-0 + small gaps keep it inside 320–390px. */}
        <div className="flex flex-nowrap items-center justify-between gap-x-3 border-t border-[#E8E5E0] py-4 text-[10px] text-[#9B9B9B] min-[390px]:text-[11px] sm:gap-x-6">
          <p className="min-w-0 whitespace-nowrap">
            <span className="sm:hidden">{view.copyright.split(/(?<=\.)\s/)[0].replace(/\.$/, '')}</span>
            <span className="hidden sm:inline">{view.copyright}</span>
          </p>
          <button type="button" onClick={openPreferences}
            className="flex-shrink-0 whitespace-nowrap transition-colors hover:text-[#6B6B6B] focus-visible:text-[#1A1A1A]">
            {t['nav.cookiePreferences']}
          </button>
          <Link href="/privacy-choices" className="flex-shrink-0 whitespace-nowrap transition-colors hover:text-[#6B6B6B] focus-visible:text-[#1A1A1A]">Your Privacy Choices</Link>
        </div>
      </div>
    </footer>
  )
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
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
