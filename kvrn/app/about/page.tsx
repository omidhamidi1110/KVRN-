import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { AboutView } from '@/components/content/cms-views'
import { pageMetadata } from '@/lib/content-seo'
import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'
import { MESSAGES } from '@/lib/i18n/messages'
import type { Locale } from '@/lib/i18n/locales'
import { getRequestLocale } from '@/lib/i18n/server'
import { sql } from '@/lib/db'

const LEGACY_METADATA: Metadata = {
  title: 'About — KVRN',
  description: 'KVRN is built around weight, structure, and restraint. Quiet garments designed for daily wear.',
  alternates: { canonical: '/about' },
}

function LegacyAboutPage({ locale }: { locale: Locale }) {
  // The coded page's wording comes from the dictionary (English is byte-identical to the previous markup).
  const t = MESSAGES[locale]
  return (
    <div className="min-h-screen bg-[#F9F8F6]">
      {/* Dark intro */}
      <PageHero title={t['about.title']} breadcrumb={t['about.title']} />

      {/* Content */}
      <div data-nav-theme="light" className="container-kvrn max-w-3xl py-16 md:py-20">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-16">
          <div className="space-y-6">
            <p className="text-[11px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">{t['about.theBrand']}</p>
            <p className="text-[16px] font-light text-[#1A1A1A] leading-relaxed">
              {t['about.lead']}
            </p>
            <p className="text-[14px] text-[#6B6B6B] leading-relaxed">
              {t['about.p1']}
            </p>
            <p className="text-[14px] text-[#6B6B6B] leading-relaxed">
              {t['about.p2']}
            </p>
          </div>
          <div className="space-y-6">
            <p className="text-[11px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">{t['about.theApproach']}</p>
            <div className="space-y-4">
              {[
                [t['about.weight'],       t['about.weight.desc']],
                [t['about.construction'], t['about.construction.desc']],
                [t['about.longevity'],    t['about.longevity.desc']],
                [t['about.restraint'],    t['about.restraint.desc']],
              ].map(([title, desc]) => (
                <div key={title} className="pb-4 border-b border-[#E8E5E0] last:border-0 last:pb-0">
                  <p className="text-[13px] font-light text-[#1A1A1A] mb-1">{title}</p>
                  <p className="text-[13px] text-[#6B6B6B] leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-16 pt-10 border-t border-[#E8E5E0]">
          <Link href="/shop"
            className="inline-flex items-center h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300">
            {t['about.shopCollection']}
          </Link>
        </div>
      </div>
    </div>
  )
}

// Flag off (default): the coded About page above, unchanged. Flag on: the published Admin content slots.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  if (!cmsContentEnabled()) return LEGACY_METADATA
  const view = await contentPublic().getAbout()
  if (!view) return LEGACY_METADATA
  const seo = view.variants.en.data.seo
  return { ...pageMetadata({ title: LEGACY_METADATA.title as string, description: LEGACY_METADATA.description as string }, seo,
    seo.shareImageId ? view.media[seo.shareImageId]?.url ?? null : null), alternates: { canonical: '/about' } }
}

export default async function AboutPage() {
  if (cmsContentEnabled()) {
    const view = await contentPublic().getAbout()
    if (view) return <AboutView view={view} />
  }
  let locale: Locale = 'en'
  try { locale = await getRequestLocale(sql) } catch { /* English */ }
  return <LegacyAboutPage locale={locale} />
}
